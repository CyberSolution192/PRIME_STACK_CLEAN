// ============================================================
// _shared/user-otp.ts
//
// One-time codes for CUSTOMER flows (password reset, transaction-PIN reset),
// generated and checked by our own backend and sent through whichever SMS
// provider is active (Arkesel or BMS Africa) — instead of Arkesel's OTP service.
//
// Enabled with the secret USER_OTP_MODE=local. Without it, the functions keep
// calling Arkesel exactly as before.
//
//   • only a salted hash of the code is stored (table user_otps)
//   • one active code per (user, purpose); requesting a new one replaces it
//   • 5-minute lifetime, 5 wrong tries, then the code is destroyed
// ============================================================

import { generateOtpCode, hashOtp, safeEqual, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS } from './admin-otp.ts';
import { sendSms, getActiveSmsProvider } from './sms-provider.ts';

export const USER_OTP_MODE: 'local' | 'arkesel' =
  Deno.env.get('USER_OTP_MODE') === 'local' ? 'local' : 'arkesel';

export type OtpPurpose = 'password_reset' | 'pin_reset';
export type OtpCheck = 'ok' | 'expired' | 'invalid' | 'locked';

function pepper(): string {
  return Deno.env.get('USER_OTP_PEPPER') ?? Deno.env.get('ADMIN_INTERNAL_SECRET') ?? '';
}

/** Create a code, store its hash, and text it. `phone` may be 0XXXXXXXXX or 233XXXXXXXXX. */
export async function issueLocalOtp(
  // deno-lint-ignore no-explicit-any
  db: any,
  purpose: OtpPurpose,
  userId: string,
  phone: string,
  buildMessage: (code: string, minutes: number) => string,
): Promise<{ ok: boolean; error?: string }> {
  const key = pepper();
  if (!key) return { ok: false, error: 'OTP secret not configured' };

  const code = generateOtpCode();
  const { error: storeErr } = await db.from('user_otps').upsert({
    user_id:    userId,
    purpose,
    code_hash:  await hashOtp(code, `${purpose}:${userId}`, key),
    attempts:   0,
    expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
    created_at: new Date().toISOString(),
  }, { onConflict: 'user_id,purpose' });
  if (storeErr) return { ok: false, error: `could not store code: ${storeErr.message}` };

  const sms = await sendSms(await getActiveSmsProvider(db), [phone], buildMessage(code, OTP_TTL_MINUTES));
  if (!sms.success) {
    await db.from('user_otps').delete().eq('user_id', userId).eq('purpose', purpose);
    return { ok: false, error: `${sms.provider}: ${sms.message}` };
  }
  return { ok: true };
}

/** Check a code. Counts the attempt before comparing; destroys the code on success or lock-out. */
export async function checkLocalOtp(
  // deno-lint-ignore no-explicit-any
  db: any,
  purpose: OtpPurpose,
  userId: string,
  presented: string,
): Promise<OtpCheck> {
  const key = pepper();
  if (!key) return 'invalid';

  const { data: rec } = await db.from('user_otps')
    .select('code_hash, attempts, expires_at')
    .eq('user_id', userId).eq('purpose', purpose).maybeSingle();

  if (!rec || new Date(rec.expires_at) < new Date()) return 'expired';

  if (rec.attempts >= OTP_MAX_ATTEMPTS) {
    await db.from('user_otps').delete().eq('user_id', userId).eq('purpose', purpose);
    return 'locked';
  }

  await db.from('user_otps').update({ attempts: rec.attempts + 1 }).eq('user_id', userId).eq('purpose', purpose);

  const hash = await hashOtp(String(presented).trim(), `${purpose}:${userId}`, key);
  if (!safeEqual(hash, rec.code_hash)) return 'invalid';

  await db.from('user_otps').delete().eq('user_id', userId).eq('purpose', purpose);
  return 'ok';
}
