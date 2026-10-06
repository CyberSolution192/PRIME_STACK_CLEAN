// ============================================================
// supabase/functions/reset-transaction-pin/index.ts
// ============================================================
// "Forgot PIN" recovery flow for the withdrawal transaction PIN.
// Lets a reseller reset their PIN via SMS OTP to the phone on
// file, without needing the old PIN — closes the "permanently
// locked out if you forget it" gap in set-transaction-pin.
//
// Actions:
//   request-otp     — send a 6-digit OTP to the phone on record
//   verify-and-reset — verify OTP, then set a brand-new PIN
//
// Uses the same Arkesel OTP API (generate/verify) as admin-auth,
// and the identical PBKDF2 hash format as set-transaction-pin so
// the two functions stay interchangeable.
//
// Deploy: supabase functions deploy reset-transaction-pin --no-verify-jwt
// ============================================================

import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ARKESEL_API_KEY  = Deno.env.get('ARKESEL_API_KEY')!;
const ARKESEL_SENDER   = Deno.env.get('ARKESEL_SENDER_ID') ?? 'PRIMECONNECT';

const PBKDF2_ITERATIONS  = 310_000;
const PBKDF2_KEYLEN      = 32;
const OTP_COOLDOWN_SEC   = 60;     // min seconds between OTP requests
const OTP_EXPIRY_MIN     = 5;

function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── PBKDF2 helpers (identical format to set-transaction-pin) ──────────────────
function hexEncode(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    PBKDF2_KEYLEN * 8,
  );
  return `pbkdf2$${hexEncode(salt.buffer)}$${hexEncode(derived)}`;
}

function formatPhoneForArkesel(phone: string): string {
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) p = '233' + p.substring(1);
  if (!p.startsWith('233')) p = '233' + p;
  return p;
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, message: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ success: false, message: 'Unauthorized' }, 401);

  const db = serviceClient();
  const { data: { user }, error: authErr } =
    await db.auth.getUser(authHeader.replace('Bearer ', ''));
  if (authErr || !user) return json({ success: false, message: 'Invalid token' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); }
  catch { return json({ success: false, message: 'Invalid JSON' }, 400); }

  const action = body.action as string | undefined;

  const { data: profile, error: profileErr } = await db
    .from('users')
    .select('store_unlocked, phone, pin_reset_requested_at')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) {
    return json({ success: false, message: 'Profile not found' }, 404);
  }
  if (!profile.store_unlocked) {
    return json({ success: false, message: 'Store not unlocked' }, 403);
  }
  if (!profile.phone) {
    return json({ success: false, message: 'No phone number on file. Contact support to reset your PIN.' }, 400);
  }
  if (!ARKESEL_API_KEY) {
    return json({ success: false, message: 'SMS service not configured. Contact support.' }, 500);
  }

  // ── REQUEST OTP ────────────────────────────────────────────────────────────
  if (action === 'request-otp') {
    // Cooldown — prevent spamming SMS OTP requests
    if (profile.pin_reset_requested_at) {
      const secsSince = (Date.now() - new Date(profile.pin_reset_requested_at).getTime()) / 1000;
      if (secsSince < OTP_COOLDOWN_SEC) {
        const wait = Math.ceil(OTP_COOLDOWN_SEC - secsSince);
        return json({ success: false, message: `Please wait ${wait} second(s) before requesting another code.` }, 429);
      }
    }

    const formattedPhone = formatPhoneForArkesel(profile.phone);

    const otpRes = await fetch('https://sms.arkesel.com/api/otp/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': ARKESEL_API_KEY },
      body: JSON.stringify({
        expiry:    OTP_EXPIRY_MIN,
        length:    6,
        medium:    'sms',
        type:      'numeric',
        message:   'Your PIN reset code is %otp_code%. Expires in %expiry% minutes. Do not share this code with anyone.',
        number:    formattedPhone,
        sender_id: ARKESEL_SENDER,
      }),
    });
    const otpData = await otpRes.json() as Record<string, unknown>;

    if (otpData.code !== '1000') {
      console.error('[reset-transaction-pin] OTP send failed:', otpData);
      return json({ success: false, message: 'Failed to send OTP. Please try again.' }, 500);
    }

    await db.from('users').update({ pin_reset_requested_at: new Date().toISOString() }).eq('id', user.id);

    try {
      await db.from('audit_logs').insert({
        user_id: user.id, action: 'pin_reset_otp_requested',
        ip_address: req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown',
        metadata: {}, created_at: new Date().toISOString(),
      });
    } catch (_) { /* non-fatal */ }

    const phoneHint = '*'.repeat(Math.max(0, profile.phone.length - 4)) + profile.phone.slice(-4);
    return json({ success: true, message: 'OTP sent', phone_hint: phoneHint });
  }

  // ── VERIFY OTP + SET NEW PIN ──────────────────────────────────────────────
  if (action === 'verify-and-reset') {
    const otp        = String(body.otp ?? '').trim();
    const newPin      = String(body.new_pin ?? '').trim();
    const confirmPin  = String(body.confirm_pin ?? '').trim();

    if (!otp) return json({ success: false, message: 'OTP code is required' }, 400);
    if (!/^\d{4,6}$/.test(newPin)) return json({ success: false, message: 'PIN must be 4-6 digits' }, 400);
    if (newPin !== confirmPin) return json({ success: false, message: 'PINs do not match' }, 400);

    const formattedPhone = formatPhoneForArkesel(profile.phone);

    const verifyRes = await fetch('https://sms.arkesel.com/api/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': ARKESEL_API_KEY },
      body: JSON.stringify({ code: otp, number: formattedPhone }),
    });
    const verifyData = await verifyRes.json() as Record<string, unknown>;

    if (verifyData.code !== '1100') {
      const reason = verifyData.code === '1105' ? 'OTP has expired. Please request a new one.' :
                     verifyData.code === '1104' ? 'Invalid OTP code. Please try again.' :
                     'OTP verification failed. Please try again.';
      try {
        await db.from('audit_logs').insert({
          user_id: user.id, action: 'pin_reset_otp_failed',
          ip_address: req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown',
          metadata: { arkesel_code: verifyData.code }, created_at: new Date().toISOString(),
        });
      } catch (_) { /* non-fatal */ }
      return json({ success: false, message: reason }, 400);
    }

    // OTP verified — set the new PIN, clear any lockout/attempts state.
    const hash = await hashPin(newPin);
    await db.from('users').update({
      transaction_pin_hash:   hash,
      pin_set_at:             new Date().toISOString(),
      pin_failed_attempts:    0,
      pin_locked_until:       null,
      pin_reset_requested_at: null,
    }).eq('id', user.id);

    try {
      await db.from('audit_logs').insert({
        user_id: user.id, action: 'pin_reset_via_otp',
        ip_address: req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown',
        metadata: {}, created_at: new Date().toISOString(),
      });
    } catch (_) { /* non-fatal */ }

    return json({ success: true, message: 'PIN reset successfully' });
  }

  return json({ success: false, message: 'Unknown action' }, 400);
});