// ============================================================
// supabase/functions/admin-security-logs/index.ts
// ============================================================
// Handles all security log operations for the admin portal.
//
// ACTIONS (routed via admin-proxy):
//   list  — paginated log viewer (admin-only, auth-gated)
//   clear — delete all logs (superadmin only)
//
// Direct server-to-server writes go through security-logger.ts
// (imported by admin-auth, admin-proxy, etc.)
//
// Deploy:
//   supabase functions deploy admin-security-logs --no-verify-jwt
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';
import { logSecurityEvent, getClientIp } from '../_shared/security-logger.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const IS_PRODUCTION    = Deno.env.get('ENVIRONMENT') === 'production';

const ALLOWED_ORIGINS = new Set([
  'https://primeconnect.site',
  ...(!IS_PRODUCTION ? [
    'http://127.0.0.1:5500',
    'http://127.0.0.1:5501',
    'http://localhost:5500',
    'http://localhost:5501',
    'http://localhost:3000',
  ] : []),
]);

function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('Origin') ?? '';
  return ALLOWED_ORIGINS.has(origin) ? origin : 'https://no-cors';
}

function corsHeaders(req: Request) {
  return {
    'Access-Control-Allow-Origin':      getAllowedOrigin(req),
    'Access-Control-Allow-Headers':     'Content-Type, apikey, authorization, x-session-id',
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

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k.trim() === name) return rest.join('=').trim();
  }
  return null;
}

async function verifyAdmin(req: Request): Promise<{ valid: boolean; role?: string; userId?: string }> {
  // Validate directly from admin_sessions table using service role key.
  // This avoids JWT token validation issues and mirrors how admin-proxy works.
  const sessionId =
    parseCookie(req.headers.get('Cookie'), 'admin_sid') ||
    req.headers.get('x-session-id') ||
    null;

  if (!sessionId) return { valid: false };

  const db = serviceClient();
  const { data: session, error } = await db
    .from('admin_sessions')
    .select('user_id, role, expires_at')
    .eq('session_id', sessionId)
    .not('session_id', 'like', 'PENDING_%')
    .single();

  if (error || !session) return { valid: false };
  if (new Date(session.expires_at) < new Date()) {
    await db.from('admin_sessions').delete().eq('session_id', sessionId);
    return { valid: false };
  }
  if (!['admin', 'superadmin'].includes(session.role)) return { valid: false };

  return { valid: true, role: session.role, userId: session.user_id };
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, req);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400, req);
  }

  // ── Internal secret — only admin-proxy knows this value ─────────────────
  const internalSecret = req.headers.get('x-internal-secret');
  if (!internalSecret || internalSecret !== Deno.env.get('ADMIN_INTERNAL_SECRET')) {
    return json({ error: 'Forbidden' }, 403, req);
  }

  const { action } = body;

  // ── ACTION: list ──────────────────────────────────────────────────────────
  if (action === 'list') {
    const admin = await verifyAdmin(req);
    if (!admin.valid) {
      logSecurityEvent({
        severity:        'HIGH',
        event_type:      'admin_access_denied',
        ip_address:      getClientIp(req),
        action:          'list_security_logs',
        details:         { reason: 'not_admin' },
        source_function: 'admin-security-logs',
      });
      return json({ error: 'Unauthorized' }, 403, req);
    }

    const db         = serviceClient();
    const page       = Math.max(1, Number(body.page)     || 1);
    const pageSize   = Math.min(100, Number(body.pageSize) || 50);
    const severity   = body.severity   as string | undefined;
    const event_type = body.event_type as string | undefined;
    const ip_filter  = body.ip_address as string | undefined;

    const from = (page - 1) * pageSize;
    const to   = from + pageSize - 1;

    let query = db
      .from('security_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (severity   && severity   !== 'ALL') query = query.eq('severity',   severity);
    if (event_type && event_type !== 'ALL') query = query.eq('event_type', event_type);
    if (ip_filter)                          query = query.ilike('ip_address', `%${ip_filter}%`);

    const { data, count, error } = await query;
    if (error) return json({ error: 'Failed to fetch logs' }, 500, req);

    // Log that admin viewed security events (LOW — normal operation)
    void logSecurityEvent({
      severity:        'LOW',
      event_type:      'admin_security_events_viewed',
      action:          'record_admin_client_event',
      ip_address:      getClientIp(req),
      details:         { role: admin.role, page, pageSize, filters: { severity, event_type } },
      source_function: 'admin-security-logs',
    });

    return json({ success: true, data, total: count ?? 0, page, pageSize }, 200, req);
  }

  // ── ACTION: clear (superadmin only) ──────────────────────────────────────
  if (action === 'clear') {
    const admin = await verifyAdmin(req);
    if (!admin.valid) return json({ error: 'Unauthorized' }, 403, req);

    if (admin.role !== 'superadmin') {
      logSecurityEvent({
        severity:        'MEDIUM',
        event_type:      'admin_access_denied',
        ip_address:      getClientIp(req),
        action:          'clear_security_logs',
        details:         { reason: 'insufficient_role', role: admin.role },
        source_function: 'admin-security-logs',
      });
      return json({ error: 'Superadmin only' }, 403, req);
    }

    const db = serviceClient();
    const { error } = await db
      .from('security_logs')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // delete all rows

    if (error) return json({ error: 'Failed to clear logs' }, 500, req);

    // Write a fresh entry noting the clear
    await logSecurityEvent({
      severity:        'LOW',
      event_type:      'security_logs_cleared',
      ip_address:      getClientIp(req),
      action:          'clear_all_logs',
      details:         { cleared_by_role: admin.role, cleared_by_user: admin.userId },
      source_function: 'admin-security-logs',
    });

    return json({ success: true }, 200, req);
  }

  return json({ error: 'Unknown action' }, 400, req);
});