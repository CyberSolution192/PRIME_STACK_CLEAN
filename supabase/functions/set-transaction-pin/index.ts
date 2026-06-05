// ============================================================
// supabase/functions/set-transaction-pin/index.ts  — v2
// ============================================================
// FIX: Replaced bcrypt (requires Worker API, unavailable in
// Supabase Edge Runtime) with PBKDF2 via Web Crypto API.
// PBKDF2 is natively available in Deno — no imports needed.
// Uses 310,000 iterations of SHA-256 (OWASP 2023 recommendation).
// Stored format: "pbkdf2$<hex_salt>$<hex_derived_key>"
//
// Actions:
//   set    — set or change PIN (requires new_pin + confirm_pin)
//   verify — check PIN is correct (called before withdrawal)
//   status — returns { pin_set: bool } without revealing hash
//
// Deploy: supabase functions deploy set-transaction-pin --no-verify-jwt
// ============================================================

import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const PIN_MAX_ATTEMPTS  = 5;
const PIN_LOCKOUT_MIN   = 30;
const PBKDF2_ITERATIONS = 310_000;  // OWASP 2023 minimum for PBKDF2-SHA256
const PBKDF2_KEYLEN     = 32;       // 256-bit derived key

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

// ── PBKDF2 helpers ────────────────────────────────────────────────────────────

function hexEncode(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexDecode(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

// Hash a PIN using PBKDF2-SHA256 with a random 16-byte salt.
// Returns "pbkdf2$<hex_salt>$<hex_key>" — safe to store in DB.
async function hashPin(pin: string): Promise<string> {
  const salt      = crypto.getRandomValues(new Uint8Array(16));
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

// Constant-time comparison to prevent timing attacks.
// Returns true if pin matches stored hash.
async function verifyPin(pin: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
    const salt    = hexDecode(parts[1]);
    const expected = hexDecode(parts[2]);

    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'],
    );
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      keyMaterial,
      PBKDF2_KEYLEN * 8,
    );
    const actual = new Uint8Array(derived);

    // Constant-time comparison — never short-circuit
    if (actual.length !== expected.length) return false;
    let mismatch = 0;
    for (let i = 0; i < actual.length; i++) {
      mismatch |= actual[i] ^ expected[i];
    }
    return mismatch === 0;
  } catch {
    return false;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ success: false, message: 'Method not allowed' }, 405);

  // Auth — Bearer token injected by user-proxy
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

  // Load user profile
  const { data: profile, error: profileErr } = await db
    .from('users')
    .select('store_unlocked, transaction_pin_hash, pin_failed_attempts, pin_locked_until')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) {
    return json({ success: false, message: 'Profile not found' }, 404);
  }

  // Gate: only unlocked resellers can use this function
  if (!profile.store_unlocked) {
    return json({ success: false, message: 'Store not unlocked' }, 403);
  }

  // ── STATUS ────────────────────────────────────────────────────────────────
  if (action === 'status') {
    return json({ success: true, pin_set: !!profile.transaction_pin_hash });
  }

  // ── SET / CHANGE PIN ──────────────────────────────────────────────────────
  if (action === 'set') {
    const newPin     = String(body.new_pin     ?? '').trim();
    const confirmPin = String(body.confirm_pin ?? '').trim();

    if (!/^\d{4,6}$/.test(newPin)) {
      return json({ success: false, message: 'PIN must be 4-6 digits' }, 400);
    }
    if (newPin !== confirmPin) {
      return json({ success: false, message: 'PINs do not match' }, 400);
    }

    // Changing existing PIN — require old PIN first
    if (profile.transaction_pin_hash) {
      const oldPin = String(body.old_pin ?? '').trim();
      if (!oldPin) {
        return json({ success: false, message: 'Current PIN required to set a new one' }, 400);
      }

      // Check lockout
      if (profile.pin_locked_until && new Date(profile.pin_locked_until) > new Date()) {
        const mins = Math.ceil(
          (new Date(profile.pin_locked_until).getTime() - Date.now()) / 60000,
        );
        return json({ success: false, message: `PIN locked. Try again in ${mins} minute(s).`, locked: true }, 429);
      }

      const oldValid = await verifyPin(oldPin, profile.transaction_pin_hash);
      if (!oldValid) {
        const newAttempts = (profile.pin_failed_attempts ?? 0) + 1;
        const upd: Record<string, unknown> = { pin_failed_attempts: newAttempts };
        if (newAttempts >= PIN_MAX_ATTEMPTS) {
          upd.pin_locked_until   = new Date(Date.now() + PIN_LOCKOUT_MIN * 60000).toISOString();
          upd.pin_failed_attempts = 0;
        }
        await db.from('users').update(upd).eq('id', user.id);
        const rem = PIN_MAX_ATTEMPTS - newAttempts;
        return json({
          success: false,
          message: rem > 0
            ? `Incorrect PIN. ${rem} attempt(s) remaining.`
            : `Too many attempts. PIN locked for ${PIN_LOCKOUT_MIN} minutes.`,
        }, 400);
      }
    }

    const hash = await hashPin(newPin);
    await db.from('users').update({
      transaction_pin_hash:  hash,
      pin_set_at:            new Date().toISOString(),
      pin_failed_attempts:   0,
      pin_locked_until:      null,
    }).eq('id', user.id);

    // Audit log — non-fatal, wrapped in try/catch
    // Note: Supabase query builder does not support .catch() chaining
    try {
      await db.from('audit_logs').insert({
        user_id:    user.id,
        action:     profile.transaction_pin_hash ? 'pin_changed' : 'pin_set',
        ip_address: req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown',
        metadata:   {},
        created_at: new Date().toISOString(),
      });
    } catch (_) { /* audit log failure is non-fatal */ }

    return json({ success: true, message: 'PIN set successfully' });
  }

  // ── VERIFY PIN ────────────────────────────────────────────────────────────
  if (action === 'verify') {
    const pin = String(body.pin ?? '').trim();
    if (!pin) return json({ success: false, message: 'PIN required' }, 400);

    if (!profile.transaction_pin_hash) {
      return json({ success: false, message: 'PIN not set', pin_not_set: true }, 400);
    }

    if (profile.pin_locked_until && new Date(profile.pin_locked_until) > new Date()) {
      const mins = Math.ceil(
        (new Date(profile.pin_locked_until).getTime() - Date.now()) / 60000,
      );
      return json({ success: false, message: `PIN locked. Try again in ${mins} minute(s).`, locked: true }, 429);
    }

    const valid = await verifyPin(pin, profile.transaction_pin_hash);
    if (!valid) {
      const newAttempts = (profile.pin_failed_attempts ?? 0) + 1;
      const upd: Record<string, unknown> = { pin_failed_attempts: newAttempts };
      if (newAttempts >= PIN_MAX_ATTEMPTS) {
        upd.pin_locked_until   = new Date(Date.now() + PIN_LOCKOUT_MIN * 60000).toISOString();
        upd.pin_failed_attempts = 0;
      }
      await db.from('users').update(upd).eq('id', user.id);
      const rem = PIN_MAX_ATTEMPTS - newAttempts;
      return json({
        success: false,
        message: rem > 0
          ? `Incorrect PIN. ${rem} attempt(s) remaining.`
          : `Too many incorrect attempts. PIN locked for ${PIN_LOCKOUT_MIN} minutes.`,
      }, 400);
    }

    await db.from('users').update({ pin_failed_attempts: 0 }).eq('id', user.id);
    return json({ success: true, message: 'PIN verified' });
  }

  return json({ success: false, message: 'Unknown action' }, 400);
});