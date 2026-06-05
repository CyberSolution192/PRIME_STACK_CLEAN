// ============================================================
// supabase/functions/reset-password/index.ts
// ============================================================
// Handles user password reset via SMS OTP using Arkesel.
//
// ACTIONS:
//   request-otp  — verify email exists, send OTP to their phone
//   verify-otp   — verify OTP then update password + kill sessions
//
// Deploy:
//   supabase functions deploy reset-password --no-verify-jwt
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ARKESEL_API_KEY  = Deno.env.get('ARKESEL_API_KEY')!;
const ARKESEL_SENDER   = Deno.env.get('ARKESEL_SENDER_ID') ?? 'PRIMECONNECT';
const IS_PRODUCTION    = Deno.env.get('ENVIRONMENT') === 'production';

const ALLOWED_ORIGINS = new Set([
  'https://primeconnect.site',
  ...(!IS_PRODUCTION ? [
    'http://127.0.0.1:5500', 'http://127.0.0.1:5501',
    'http://localhost:5500',  'http://localhost:5501',
    'http://localhost:3000',
  ] : []),
]);

function getAllowedOrigin(req: Request): string {
  const o = req.headers.get('Origin') ?? '';
  return ALLOWED_ORIGINS.has(o) ? o : 'https://no-cors';
}

function corsHeaders(req: Request) {
  return {
    'Access-Control-Allow-Origin':      getAllowedOrigin(req),
    'Access-Control-Allow-Headers':     'Content-Type, apikey',
    'Access-Control-Allow-Methods':     'POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(req ? corsHeaders(req) : {}) },
  });
}

function formatPhone(raw: string): string {
  let phone = String(raw).replace(/\D/g, '');
  if (phone.startsWith('0')) phone = '233' + phone.substring(1);
  if (!phone.startsWith('233')) phone = '233' + phone;
  return phone;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, req);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400, req); }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── ACTION: request-otp ───────────────────────────────────────────────────
  if (body.action === 'request-otp') {
    const email = (body.email as string ?? '').toLowerCase().trim();
    if (!email) return json({ success: false, error: 'Email is required' }, 400, req);

    // Look up user by email
    const { data: user } = await db
      .from('users').select('id, phone, email').eq('email', email).maybeSingle();

    // Always return same message whether user exists or not — prevents email enumeration
    if (!user || !user.phone) {
      return json({
        success: true,
        message: 'If that email is registered, an OTP has been sent to the associated phone number.',
      }, 200, req);
    }

    const phone = formatPhone(user.phone);

    // Send OTP via Arkesel
    const otpRes = await fetch('https://sms.arkesel.com/api/otp/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': ARKESEL_API_KEY },
      body: JSON.stringify({
        expiry:    5,
        length:    6,
        medium:    'sms',
        message:   'PrimeConnect: Your password reset code is %otp_code%. Expires in %expiry% minutes. If you did not request this, ignore it.',
        number:    phone,
        sender_id: ARKESEL_SENDER,
        type:      'numeric',
      }),
    });
    const otpData = await otpRes.json() as Record<string, unknown>;

    if (otpData.code !== '1000') {
      console.error('[reset-password] OTP send failed:', otpData);
      // Still return same message to prevent enumeration
      return json({
        success: true,
        message: 'If that email is registered, an OTP has been sent to the associated phone number.',
      }, 200, req);
    }

    // Return masked phone hint
    const phoneHint = '***' + phone.slice(-4);
    return json({
      success:    true,
      phone_hint: phoneHint,
      message:    `OTP sent to ${phoneHint}`,
    }, 200, req);
  }

  // ── ACTION: verify-otp ────────────────────────────────────────────────────
  if (body.action === 'verify-otp') {
    const email       = (body.email       as string ?? '').toLowerCase().trim();
    const otp         = (body.otp         as string ?? '').trim();
    const newPassword = (body.newPassword as string ?? '').trim();

    if (!email || !otp || !newPassword) {
      return json({ success: false, error: 'Email, OTP, and new password are required' }, 400, req);
    }

    if (newPassword.length < 8) {
      return json({ success: false, error: 'Password must be at least 8 characters' }, 400, req);
    }

    // Look up user
    const { data: user } = await db
      .from('users').select('id, phone').eq('email', email).maybeSingle();

    if (!user || !user.phone) {
      return json({ success: false, error: 'Invalid request' }, 400, req);
    }

    const phone = formatPhone(user.phone);

    // Verify OTP with Arkesel
    const verifyRes = await fetch('https://sms.arkesel.com/api/otp/verify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': ARKESEL_API_KEY },
      body: JSON.stringify({ code: otp, number: phone }),
    });
    const verifyData = await verifyRes.json() as Record<string, unknown>;

    if (verifyData.code !== '1100') {
      const error = verifyData.code === '1105' ? 'OTP has expired. Please request a new one.' :
                    verifyData.code === '1104' ? 'Invalid code. Please check and try again.' :
                    'Verification failed. Please try again.';
      return json({ success: false, error }, 401, req);
    }

    // OTP valid — update password via Supabase Admin API
    const { error: updateErr } = await db.auth.admin.updateUserById(user.id, {
      password: newPassword,
    });

    if (updateErr) {
      console.error('[reset-password] Password update failed:', updateErr);
      return json({ success: false, error: 'Failed to update password. Please try again.' }, 500, req);
    }

    // Kill ALL active sessions for this user so old sessions are dead
    await db.from('user_sessions').delete().eq('user_id', user.id).catch(() => {});

    return json({ success: true, message: 'Password updated successfully. Please login with your new password.' }, 200, req);
  }

  return json({ error: 'Unknown action' }, 400, req);
});