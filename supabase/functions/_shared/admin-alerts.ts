/**
 * _shared/admin-alerts.ts
 *
 * Shared helper imported by background/cron edge functions (sync-bundle-costs,
 * reconcile-stale-orders, and any future automated checks) to raise an entry
 * in admin_alerts, and — for HIGH/CRITICAL severity — also push an SMS to the
 * admin's phone via the existing send-sms function.
 *
 * Fire-and-forget on the SMS leg: a notification failure never blocks or
 * throws back to the caller. The admin_alerts row is always written first,
 * so the alert exists even if SMS delivery fails.
 *
 * REQUIRED ENV VARS (already used elsewhere in this project):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_INTERNAL_SECRET
 *   SYSTEM_ADMIN_USER_ID  — admin UUID used as the acting identity
 *   ADMIN_ALERT_PHONE     — phone number (Ghana format, e.g. 0241234567)
 *                           to receive SMS for HIGH/CRITICAL alerts
 */

export type AlertSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface AlertPayload {
  type: string;
  severity: AlertSeverity;
  message: string;
  details?: Record<string, unknown>;
}

export async function raiseAlert(
  supabase: any,
  payload: AlertPayload
): Promise<void> {
  // 1. Always write the alert row first — this must not be lost even if SMS fails.
  const { error: insertError } = await supabase.from("admin_alerts").insert({
    type: payload.type,
    severity: payload.severity,
    message: payload.message,
    details: payload.details ?? {},
  });

  if (insertError) {
    console.error("[admin-alerts] Failed to insert alert:", insertError.message);
    return;
  }

  // 2. For HIGH/CRITICAL only, also try to notify by SMS. Non-fatal if this fails.
  if (payload.severity !== "HIGH" && payload.severity !== "CRITICAL") return;

  void (async () => {
    try {
      const SUPABASE_URL    = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      const INTERNAL_SECRET = Deno.env.get("ADMIN_INTERNAL_SECRET");
      const ADMIN_USER_ID   = Deno.env.get("SYSTEM_ADMIN_USER_ID");
      const ADMIN_PHONE     = Deno.env.get("ADMIN_ALERT_PHONE");

      if (!SUPABASE_URL || !SERVICE_KEY || !INTERNAL_SECRET || !ADMIN_USER_ID || !ADMIN_PHONE) {
        console.warn("[admin-alerts] SMS skipped — one or more required env vars not configured");
        return;
      }

      // Arkesel enforces a 160-char limit — keep it short and factual.
      const smsBody = `[${payload.severity}] ${payload.message}`.slice(0, 160);

      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_KEY}`,
          "x-internal-secret": INTERNAL_SECRET,
          "x-admin-user-id": ADMIN_USER_ID,
          "x-admin-role": "admin",
        },
        body: JSON.stringify({
          action: "send",
          target: { type: "manual", manualNumbers: [ADMIN_PHONE] },
          message: smsBody,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.warn(`[admin-alerts] SMS send failed: HTTP ${res.status} ${text}`);
      }
    } catch (err) {
      console.warn("[admin-alerts] SMS send threw:", err);
    }
  })();
}