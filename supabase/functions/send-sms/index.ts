import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

// ─── Arkesel v1 API helpers ────────────────────────────────────────────────────
const ARKESEL_BASE = "https://sms.arkesel.com/sms/api";

async function arkeselSend(
  apiKey: string,
  sender: string,
  recipients: string[],
  message: string,
): Promise<{ success: boolean; message: string; data?: unknown }> {
  const to = recipients.join(",");
  const url = new URL(ARKESEL_BASE);
  url.searchParams.set("action",   "send-sms");
  url.searchParams.set("api_key",  apiKey);
  url.searchParams.set("to",       to);
  url.searchParams.set("from",     sender);
  url.searchParams.set("sms",      message);
  url.searchParams.set("response", "json");

  const res  = await fetch(url.toString());
  const raw  = await res.text();
  console.log("📤 Arkesel send raw response:", raw);

  let data: any = {};
  try { data = JSON.parse(raw); } catch { data = { status: raw.trim() }; }

  const statusStr = (data?.status || "").toString().toUpperCase();
  const messageStr = (data?.message || "").toString().toLowerCase();
  const isSuccess =
    statusStr === "OK" ||
    statusStr === "SUCCESS" ||
    messageStr.includes("successfully sent") ||
    messageStr.includes("success") ||
    (res.ok && !data?.error && statusStr !== "ERROR" && statusStr !== "FAILED");

  if (isSuccess) {
    return { success: true, message: "SMS sent successfully", data };
  }

  return {
    success: false,
    message: data?.message || data?.status || raw || `Arkesel error (HTTP ${res.status})`,
    data,
  };
}

async function arkeselBalance(
  apiKey: string,
): Promise<{ success: boolean; balance?: string; message: string }> {
  const url = new URL(ARKESEL_BASE);
  url.searchParams.set("action",   "check-balance");
  url.searchParams.set("api_key",  apiKey);
  url.searchParams.set("response", "json");

  const res = await fetch(url.toString());
  const raw = await res.text();
  console.log("💰 Arkesel balance raw response:", raw);

  let data: any = {};
  try { data = JSON.parse(raw); } catch { data = { status: raw.trim() }; }

  if (data?.balance !== undefined && data?.balance !== null) {
    return { success: true, balance: String(data.balance), message: "OK" };
  }

  if ((data?.status || "").toString().toUpperCase() === "OK") {
    return { success: true, balance: String(data?.balance ?? "N/A"), message: "OK" };
  }

  return {
    success: false,
    message: data?.message || data?.status || raw || `Could not fetch balance (HTTP ${res.status})`,
  };
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

  const ARKESEL_API_KEY   = Deno.env.get("ARKESEL_API_KEY")?.trim();
  const ARKESEL_SENDER_ID = Deno.env.get("ARKESEL_SENDER_ID") ?? "PRIMECONNECT";
  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SRK      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!ARKESEL_API_KEY) {
    return json({ success: false, message: "SMS service not configured. Contact admin." }, 500);
  }

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

  const { action, recipients, message, target } = body;

  // ── balance ────────────────────────────────────────────────────────────────
  if (action === "balance") {
    const result = await arkeselBalance(ARKESEL_API_KEY);
    return json(result);
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

    console.log(`📨 Admin ${user.id} sending SMS to ${finalRecipients.length} recipient(s)`);

    const result = await arkeselSend(ARKESEL_API_KEY, ARKESEL_SENDER_ID, finalRecipients, message.trim());

    // Audit log
    await supabase.from("sms_logs").insert({
      sent_by:    user.id,
      recipients: finalRecipients,
      message:    message.trim(),
      success:    result.success,
      provider:   "arkesel",
      target_type: target?.type ?? "manual",
      recipient_count: finalRecipients.length,
      response:   result.data ?? { message: result.message },
    }).then(({ error }) => {
      if (error) console.warn("⚠️ sms_logs insert failed (non-fatal):", error.message);
    });

    return json({ ...result, recipientCount: finalRecipients.length });
  }

  // ── logs ───────────────────────────────────────────────────────────────────
  if (action === "logs") {
    const limit = 50;

    const { data: logs, error: logsError } = await supabase
      .from("sms_logs")
      .select("id, sent_by, message, success, target_type, recipient_count, created_at")
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