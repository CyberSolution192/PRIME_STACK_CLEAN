// ============================================================
// _shared/admin-otp.ts
//
// Helpers for the admin login one-time code when it is generated and checked by
// our own backend (ADMIN_OTP_MODE=local) instead of Arkesel's OTP service, so
// the code can be sent by whichever SMS provider is active.
//
// Only a salted hash of the code is ever stored — never the code itself.
// ============================================================

/** Uniformly random 6-digit code (rejection sampling, no modulo bias). */
export function generateOtpCode(): string {
  const limit = 4_294_000_000; // largest multiple of 1,000,000 that fits in 32 bits
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return String(n % 1_000_000).padStart(6, '0');
}

export async function hashOtp(code: string, sessionId: string, pepper: string): Promise<string> {
  const data = new TextEncoder().encode(`${code}:${sessionId}:${pepper}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const OTP_TTL_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 5;
