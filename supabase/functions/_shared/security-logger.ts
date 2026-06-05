/**
 * _shared/security-logger.ts
 *
 * Shared security event writer imported by any Edge Function.
 * Fire-and-forget — never throws or blocks the caller.
 *
 * IP PRIORITY (most reliable → least):
 *   1. cf-connecting-ip  — set by Cloudflare CDN, cannot be spoofed by client
 *   2. x-real-ip         — set by reverse proxy
 *   3. x-forwarded-for   — first entry (can be spoofed if no CDN)
 *   4. 'unknown'
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface SecurityLogPayload {
  severity:         Severity;
  event_type:       string;
  account_name?:    string;
  account_email?:   string;
  action?:          string;
  ip_address?:      string;
  details?:         Record<string, unknown>;
  source_function?: string;
}

/**
 * Extract the real client IP from the request.
 * Uses Cloudflare's cf-connecting-ip header when available (cannot be spoofed).
 * Falls back to x-real-ip, then x-forwarded-for first entry, then 'unknown'.
 */
export function getClientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip')                          // Cloudflare — spoofproof
    ?? req.headers.get('x-real-ip')                             // Reverse proxy
    ?? req.headers.get('x-forwarded-for')?.split(',')[0].trim() // Standard forwarding
    ?? 'unknown'
  );
}

/**
 * Write a security event to the security_logs table.
 * Fire-and-forget — errors are swallowed so a logging failure
 * never blocks or crashes the main request flow.
 */
export function logSecurityEvent(payload: SecurityLogPayload): void {
  void (async () => {
    try {
      const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { error } = await db.from('security_logs').insert({
        severity:        payload.severity,
        event_type:      payload.event_type,
        account_name:    payload.account_name    ?? null,
        account_email:   payload.account_email   ?? null,
        action:          payload.action           ?? null,
        ip_address:      payload.ip_address       ?? null,
        details:         payload.details          ?? {},
        source_function: payload.source_function  ?? null,
        created_at:      new Date().toISOString(),
      });

      if (error) {
        console.error('[security-logger] DB insert error:', error.message);
      }
    } catch (err) {
      // Never let logging crash the caller
      console.error('[security-logger] Unexpected error:', err);
    }
  })();
}