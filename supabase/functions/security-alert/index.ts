// ============================================================
// supabase/functions/security-alert/index.ts
// ============================================================
// PURPOSE: Called every 5 minutes by pg_cron.
//          Checks for new CRITICAL security events in the last
//          5 minutes. If found, sends an SMS to the admin phone
//          number stored in the ADMIN_ALERT_PHONE env var.
//
// Uses your existing Arkesel SMS infrastructure (same API key).
//
// ENV VARS REQUIRED (add in Supabase Dashboard → Edge Functions → Secrets):
//   SUPABASE_URL              — already set by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — already set by Supabase
//   ARKESEL_API_KEY           — already used by send-sms function
//   ARKESEL_SENDER_ID         — already used by send-sms function
//   ADMIN_ALERT_PHONE         — your phone number e.g. 0241234567
//                               (the number that receives alert SMS)
//
// Deploy:
//   supabase functions deploy security-alert --no-verify-jwt
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ARKESEL_API_KEY  = Deno.env.get('ARKESEL_API_KEY')!;
const ARKESEL_SENDER   = Deno.env.get('ARKESEL_SENDER_ID') ?? 'PRIMECONNECT';
const ADMIN_PHONE      = Deno.env.get('ADMIN_ALERT_PHONE');  // e.g. 0241234567

// ── Deduplication: track last alerted event ID so we never
//    send duplicate SMS for the same event if cron fires twice ──────────────
// We use the security_logs table itself — query only events newer than
// the most recently alerted timestamp (stored as a DB setting).
const LAST_ALERTED_KEY = 'security_alert_last_sent';

serve(async (req: Request) => {
  // Accept calls from pg_cron (no Origin header) or internal orchestration.
  // Reject browser requests.
  const origin = req.headers.get('Origin');
  if (origin) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (!ADMIN_PHONE) {
    console.warn('[security-alert] ADMIN_ALERT_PHONE not set — skipping alert.');
    return new Response(JSON.stringify({ skipped: true, reason: 'no_phone_configured' }), { status: 200 });
  }

  if (!ARKESEL_API_KEY) {
    console.warn('[security-alert] ARKESEL_API_KEY not set — skipping SMS.');
    return new Response(JSON.stringify({ skipped: true, reason: 'no_sms_key' }), { status: 200 });
  }

  try {
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ── Get the timestamp of the last alert we sent ────────────────────────
    const { data: settingRow } = await db
      .from('app_settings')
      .select('value')
      .eq('key', LAST_ALERTED_KEY)
      .maybeSingle();

    // Default: check last 5 minutes if we've never alerted before
    const lastAlerted = settingRow?.value
      ? new Date(settingRow.value as string).toISOString()
      : new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // ── Query for new CRITICAL events since last alert ─────────────────────
    const { data: criticalEvents, error } = await db
      .from('security_logs')
      .select('id, event_type, ip_address, account_email, created_at, details')
      .eq('severity', 'CRITICAL')
      .gt('created_at', lastAlerted)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) {
      console.error('[security-alert] Query error:', error.message);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    if (!criticalEvents || criticalEvents.length === 0) {
      console.log('[security-alert] No new CRITICAL events since', lastAlerted);
      return new Response(JSON.stringify({ alerted: false, reason: 'no_new_critical_events' }), { status: 200 });
    }

    // ── Build SMS message ──────────────────────────────────────────────────
    const count   = criticalEvents.length;
    const latest  = criticalEvents[0];
    const evtType = latest.event_type ?? 'unknown';
    const ip      = latest.ip_address ?? 'unknown IP';
    const account = latest.account_email ?? 'unknown account';
    const time    = new Date(latest.created_at).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Accra',
    });

    // Keep under 160 chars for a single SMS credit
    const message = count === 1
      ? `PRIME ALERT: CRITICAL security event at ${time}. Type: ${evtType}. IP: ${ip}. Account: ${account}. Check admin portal immediately.`
      : `PRIME ALERT: ${count} CRITICAL security events since last check (latest at ${time}). Type: ${evtType}. IP: ${ip}. Check admin portal immediately.`;

    const smsMsg = message.length > 160 ? message.substring(0, 157) + '...' : message;

    // ── Send SMS via Arkesel ───────────────────────────────────────────────
    const smsUrl = new URL('https://sms.arkesel.com/sms/api');
    smsUrl.searchParams.set('action',   'send-sms');
    smsUrl.searchParams.set('api_key',  ARKESEL_API_KEY);
    smsUrl.searchParams.set('to',       ADMIN_PHONE);
    smsUrl.searchParams.set('from',     ARKESEL_SENDER);
    smsUrl.searchParams.set('sms',      smsMsg);
    smsUrl.searchParams.set('response', 'json');

    const smsRes  = await fetch(smsUrl.toString());
    const smsData = await smsRes.json().catch(() => ({})) as Record<string, unknown>;
    const smsOk   = smsRes.ok && (smsData?.status as string)?.toUpperCase() !== 'ERROR';

    console.log('[security-alert] SMS result:', smsOk, smsData);

    // ── Update last alerted timestamp ──────────────────────────────────────
    // Upsert into app_settings so we don't re-alert on the same events
    const nowIso = new Date().toISOString();
    await db.from('app_settings').upsert(
      { key: LAST_ALERTED_KEY, value: nowIso },
      { onConflict: 'key' }
    );

    // ── Also write a LOW log entry recording the alert was sent ───────────
    await db.from('security_logs').insert({
      severity:        'LOW',
      event_type:      'admin_alert_sms_sent',
      action:          'security_alert',
      ip_address:      null,
      details: {
        alerted_events: count,
        sms_to:         ADMIN_PHONE.replace(/\d(?=\d{4})/g, '*'), // mask all but last 4
        sms_ok:         smsOk,
        latest_event:   evtType,
      },
      source_function: 'security-alert',
      created_at:      nowIso,
    });

    return new Response(JSON.stringify({
      alerted:        true,
      events_found:   count,
      sms_sent:       smsOk,
    }), { status: 200 });

  } catch (err) {
    console.error('[security-alert] Fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});