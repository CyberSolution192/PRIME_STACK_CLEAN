// ============================================================
// supabase/functions/send-sms/index.ts
// ============================================================
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SMS_PROVIDERS,
  SMS_PROVIDER_SETTING_KEY,
  getActiveSmsProvider,
  getSmsBalance,
  isProviderConfigured,
  isSmsProviderId,
  sendSms,
  type SmsProviderId,
} from "../_shared/sms-provider.ts";

// ─── CORS ─────────────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ─── Fetch recipients by target audience ─────────────────────────────────────
async function resolveRecipients(
  supabase: ReturnType<typeof createClient>,
  target: {
    type: "all" | "network" | "activity" | "balance" | "manual";
    network?: string;
    activityDays?: number;
    balanceMin?: number;
    balanceMax?: number;
    manualNumbers?: string[];
  },
): Promise<{ phones: string[]; count: number; users: any[]; error?: string }> {

  if (target.type === "manual") {
    const phones = (target.manualNumbers || [])
      .map(p => normalizePhone(p))
      .filter(Boolean) as string[];
    const userRows = phones.map(p => ({ phone: p, fullname: null, email: null, balance: null }));
    return { phones, count: phones.length, users: userRows };
  }

  // Fetch all registered users with phone + wallet balance
  const { data: allUsers, error } = await supabase
    .from("users")
    .select("id, fullname, email, phone, wallets(balance)")
    .not("phone", "is", null)
    .neq("phone", "");

  if (error) return { phones: [], count: 0, users: [], error: error.message };

  let users = allUsers || [];

  // By Network — filter by the network column on adminorders
  if (target.type === "network" && target.network) {
    const { data: netOrders } = await supabase
      .from("adminorders")
      .select("userid")
      .eq("network", target.network.toLowerCase())
      .not("userid", "is", null);
    const netSet = new Set((netOrders || []).map((r: any) => r.userid));
    users = users.filter((u: any) => netSet.has(u.id));
  }

  // By Activity — filter by recent transaction
  if (target.type === "activity" && target.activityDays) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - target.activityDays);
    const { data: activeRows } = await supabase
      .from("transactions")
      .select("userid")
      .gte("created_at", cutoff.toISOString());
    const activeSet = new Set((activeRows || []).map((r: any) => r.userid));
    users = users.filter((u: any) => activeSet.has(u.id));
  }

  // By Balance — filter by wallet balance range
  if (target.type === "balance") {
    users = users.filter((u: any) => {
      const bal = u.wallets?.balance ?? 0;
      const min = target.balanceMin ?? 0;
      const max = target.balanceMax ?? Infinity;
      return bal >= min && bal <= max;
    });
  }

  const phones = users
    .map((u: any) => normalizePhone(u.phone))
    .filter(Boolean) as string[];

  const userRows = users.map((u: any) => ({
    fullname: u.fullname || null,
    email:    u.email    || null,
    phone:    normalizePhone(u.phone) || u.phone,
    balance:  u.wallets?.balance ?? null,
  }));

  return { phones, count: phones.length, users: userRows };
}

function normalizePhone(phone: string): string | null {
  if (!phone) return null;
  phone = phone.replace(/\D/g, "");
  if (!phone) return null;
  if (phone.startsWith("0") && phone.length >= 9) phone = "233" + phone.substring(1);
  if (!phone.startsWith("233")) phone = "233" + phone;
  if (phone.length < 12) return null;
  return phone;
}

// ─── Main handler ──────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // ── Verify admin auth ──────────────────────────────────────────────────────
  // ── Internal secret — only admin-proxy knows this value ─────────────────
  const internalSecret = req.headers.get("x-internal-secret");
  if (!internalSecret || internalSecret !== Deno.env.get("ADMIN_INTERNAL_SECRET")) {
    return json({ success: false, message: "Forbidden" }, 403);
  }

  const userId = req.headers.get("x-admin-user-id");
  const role   = req.headers.get("x-admin-role");
  if (!userId || !role || !["admin", "superadmin"].includes(role)) {
    return json({ success: false, message: "Forbidden: admin access required" }, 403);
  }
  const user = { id: userId };
  const supabase = createClient(SUPABASE_URL, SUPABASE_SRK);

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: {
    action?: string;
    provider?: string;
    recipients?: string[];
    message?: string;
    target?: {
      type: "all" | "network" | "activity" | "balance" | "manual";
      network?: string;
      activityDays?: number;
      balanceMin?: number;
      balanceMax?: number;
      manualNumbers?: string[];
    };
  };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, message: "Invalid JSON body" }, 400);
  }

  const { action, recipients, message, target, provider: requestedProvider } = body;

  // ── balance ────────────────────────────────────────────────────────────────
  if (action === "balance") {
    // Defaults to the active provider; admins may ask for a specific one.
    let target_provider: SmsProviderId;
    if (requestedProvider !== undefined && requestedProvider !== null && requestedProvider !== "") {
      if (!isSmsProviderId(requestedProvider)) {
        return json({ success: false, message: "Unknown SMS provider" }, 400);
      }
      target_provider = requestedProvider;
    } else {
      target_provider = await getActiveSmsProvider(supabase);
    }
    const result = await getSmsBalance(target_provider);
    return json({ ...result, providerLabel: SMS_PROVIDERS[target_provider].label });
  }

  // ── provider-status: active provider + per-provider config/balance ─────────
  if (action === "provider-status") {
    const active = await getActiveSmsProvider(supabase);
    const ids = Object.keys(SMS_PROVIDERS) as SmsProviderId[];
    const providers = await Promise.all(ids.map(async (id) => {
      const configured = isProviderConfigured(id);
      const bal = configured ? await getSmsBalance(id) : null;
      return {
        id,
        label:      SMS_PROVIDERS[id].label,
        configured,
        active:     id === active,
        balance:    bal?.success ? bal.balance : null,
        // Provider error text is safe to show to an admin; secrets are never included.
        balanceError: bal && !bal.success ? bal.message : null,
      };
    }));
    return json({ success: true, active, activeLabel: SMS_PROVIDERS[active].label, providers });
  }

  // ── set-provider: manual switch (admin / superadmin only — enforced above) ─
  if (action === "set-provider") {
    if (!isSmsProviderId(requestedProvider)) {
      return json({ success: false, message: "Unknown SMS provider" }, 400);
    }
    if (!isProviderConfigured(requestedProvider)) {
      return json({
        success: false,
        message: `${SMS_PROVIDERS[requestedProvider].label} is not configured, so it cannot be activated. Set ${SMS_PROVIDERS[requestedProvider].secrets} first.`,
      }, 400);
    }

    const previous = await getActiveSmsProvider(supabase);
    const { error: upsertErr } = await supabase
      .from("system_settings")
      .upsert(
        { key: SMS_PROVIDER_SETTING_KEY, value: requestedProvider, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    if (upsertErr) {
      console.error("set-provider upsert failed:", upsertErr.message);
      return json({ success: false, message: "Could not save the provider setting" }, 500);
    }

    await supabase.from("admin_audit_log").insert({
      admin_id:   user.id,
      action:     "sms_provider_switch",
      details:    { from: previous, to: requestedProvider },
      created_at: new Date().toISOString(),
    }).then(({ error }) => {
      if (error) console.warn("Audit log failed (non-fatal):", error.message);
    });

    return json({
      success: true,
      active:  requestedProvider,
      activeLabel: SMS_PROVIDERS[requestedProvider].label,
      message: `SMS provider switched to ${SMS_PROVIDERS[requestedProvider].label}`,
    });
  }

  // ── preview: resolve recipients without sending ───────────────────────────
  if (action === "preview") {
    if (!target) return json({ success: false, message: "No target specified" }, 400);
    const resolved = await resolveRecipients(supabase, target);
    if (resolved.error) return json({ success: false, message: resolved.error });
    return json({ success: true, count: resolved.count, users: resolved.users });
  }

  // ── send ───────────────────────────────────────────────────────────────────
  if (action === "send") {
    if (!message || !message.trim()) {
      return json({ success: false, message: "Message is empty" }, 400);
    }
    if (message.trim().length > 160) {
      return json({ success: false, message: "Message exceeds 160 characters" }, 400);
    }

    let finalRecipients: string[] = [];

    if (target) {
      const resolved = await resolveRecipients(supabase, target);
      if (resolved.error) return json({ success: false, message: resolved.error });
      finalRecipients = resolved.phones;
    } else if (recipients && recipients.length > 0) {
      finalRecipients = recipients
        .map(p => normalizePhone(p))
        .filter(Boolean) as string[];
    }

    if (finalRecipients.length === 0) {
      return json({ success: false, message: "No valid recipients found" }, 400);
    }

    // Every SMS goes through the provider the admin has activated — no fallback.
    const activeProvider = await getActiveSmsProvider(supabase);
    console.log(`📨 Admin ${user.id} sending SMS to ${finalRecipients.length} recipient(s) via ${activeProvider}`);

    if (!isProviderConfigured(activeProvider)) {
      return json({
        success: false,
        provider: activeProvider,
        message: `${SMS_PROVIDERS[activeProvider].label} is the active provider but is not configured. Switch provider or set ${SMS_PROVIDERS[activeProvider].secrets}.`,
      }, 500);
    }

    const result = await sendSms(activeProvider, finalRecipients, message.trim());

    // Audit log
    await supabase.from("sms_logs").insert({
      sent_by:    user.id,
      recipients: finalRecipients,
      message:    message.trim(),
      success:    result.success,
      provider:   result.provider,
      target_type: target?.type ?? "manual",
      recipient_count: finalRecipients.length,
      response:   result.data ?? { message: result.message },
    }).then(({ error }) => {
      if (error) console.warn("⚠️ sms_logs insert failed (non-fatal):", error.message);
    });

    return json({
      success: result.success,
      message: result.message,
      provider: result.provider,
      providerLabel: SMS_PROVIDERS[result.provider].label,
      recipientCount: finalRecipients.length,
    });
  }

  // ── logs ───────────────────────────────────────────────────────────────────
  if (action === "logs") {
    const limit = 50;

    const { data: logs, error: logsError } = await supabase
      .from("sms_logs")
      .select("id, sent_by, message, success, target_type, recipient_count, provider, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (logsError) return json({ success: false, message: logsError.message });

    const senderIds = [...new Set((logs || []).map((l: any) => l.sent_by).filter(Boolean))];
    let userMap: Record<string, { fullname?: string; email?: string }> = {};

    if (senderIds.length > 0) {
      const { data: usersData } = await supabase
        .from("users")
        .select("id, fullname, email")
        .in("id", senderIds);
      (usersData || []).forEach((u: any) => { userMap[u.id] = u; });
    }

    const enriched = (logs || []).map((log: any) => ({
      ...log,
      sender_name: userMap[log.sent_by]?.fullname || userMap[log.sent_by]?.email || null,
    }));

    return json({ success: true, logs: enriched });
  }

  return json({ success: false, message: `Unknown action: ${action}` }, 400);
});