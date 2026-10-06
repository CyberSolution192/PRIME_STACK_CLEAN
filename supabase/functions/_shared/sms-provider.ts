// ============================================================
// _shared/sms-provider.ts
//
// Single place for every outbound *plain* SMS (admin broadcasts, test sends,
// security alerts). Two providers are supported and the admin switches
// between them manually from the SMS Gateway tab:
//
//   arkesel  → https://sms.arkesel.com   (secrets: ARKESEL_API_KEY, ARKESEL_SENDER_ID)
//   bms      → https://app.bms.africa    (secrets: BMS_API_KEY,     BMS_SENDER_ID)
//
// The active provider lives in system_settings (key = 'sms_provider').
// There is deliberately NO automatic fallback: whatever the admin selected is
// the only provider used, so billing and sender-ID behaviour stay predictable.
//
// NOTE: OTP flows (admin-auth, reset-password, reset-transactions-pin) use
// Arkesel's OTP generate/verify API, which is stateful and Arkesel-specific.
// They are NOT routed through this module.
//
// Secrets are read from Deno.env only, never logged, never returned to a client.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type SmsProviderId = 'arkesel' | 'bms';

export const SMS_PROVIDER_SETTING_KEY = 'sms_provider';
export const DEFAULT_SMS_PROVIDER: SmsProviderId = 'arkesel';

export const SMS_PROVIDERS: Record<SmsProviderId, { label: string; secrets: string }> = {
  arkesel: { label: 'Arkesel',     secrets: 'ARKESEL_API_KEY' },
  bms:     { label: 'BMS Africa',  secrets: 'BMS_API_KEY and BMS_SENDER_ID' },
};

export function isSmsProviderId(v: unknown): v is SmsProviderId {
  return v === 'arkesel' || v === 'bms';
}

// ─── Config (env only) ────────────────────────────────────────────────────────
interface ProviderConfig { apiKey: string; senderId: string }

function getConfig(id: SmsProviderId): ProviderConfig | null {
  if (id === 'arkesel') {
    const apiKey = Deno.env.get('ARKESEL_API_KEY')?.trim();
    if (!apiKey) return null;
    return { apiKey, senderId: Deno.env.get('ARKESEL_SENDER_ID')?.trim() || 'ESTECH' };
  }
  // BMS needs a *registered* sender ID, so there is no safe default.
  const apiKey   = Deno.env.get('BMS_API_KEY')?.trim();
  const senderId = Deno.env.get('BMS_SENDER_ID')?.trim();
  if (!apiKey || !senderId) return null;
  return { apiKey, senderId };
}

export function isProviderConfigured(id: SmsProviderId): boolean {
  return getConfig(id) !== null;
}

// ─── Active provider (system_settings) ────────────────────────────────────────
export async function getActiveSmsProvider(supabase: SupabaseClient): Promise<SmsProviderId> {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', SMS_PROVIDER_SETTING_KEY)
      .maybeSingle();
    if (error) {
      console.warn('[sms-provider] could not read active provider, using default:', error.message);
      return DEFAULT_SMS_PROVIDER;
    }
    return isSmsProviderId(data?.value) ? data!.value : DEFAULT_SMS_PROVIDER;
  } catch (e) {
    console.warn('[sms-provider] active provider lookup threw, using default:', (e as Error).message);
    return DEFAULT_SMS_PROVIDER;
  }
}

// ─── Result types ─────────────────────────────────────────────────────────────
export interface SmsSendResult {
  success:  boolean;
  message:  string;
  provider: SmsProviderId;
  data?:    unknown;
}
export interface SmsBalanceResult {
  success:  boolean;
  message:  string;
  provider: SmsProviderId;
  balance?: string;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 20_000;

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function parseJson(raw: string): Record<string, any> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : { status: String(v) };
  } catch {
    return { status: raw.trim() };
  }
}

/** Short, single-line, tag-free excerpt of a provider response; the API key is redacted. */
function snippet(raw: string, secret?: string): string {
  let t = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (secret) t = t.split(secret).join('***');
  return t.slice(0, 160);
}

/** 233XXXXXXXXX → 0XXXXXXXXX (the format BMS documents). Anything else passes through. */
function toLocalGhana(msisdn: string): string {
  return msisdn.startsWith('233') && msisdn.length === 12 ? '0' + msisdn.slice(3) : msisdn;
}

// ─── Arkesel (v1 API — behaviour unchanged from the original send-sms) ───────
const ARKESEL_BASE = 'https://sms.arkesel.com/sms/api';

async function arkeselSend(cfg: ProviderConfig, recipients: string[], message: string): Promise<SmsSendResult> {
  const url = new URL(ARKESEL_BASE);
  url.searchParams.set('action',   'send-sms');
  url.searchParams.set('api_key',  cfg.apiKey);
  url.searchParams.set('to',       recipients.join(','));
  url.searchParams.set('from',     cfg.senderId);
  url.searchParams.set('sms',      message);
  url.searchParams.set('response', 'json');

  const res  = await timedFetch(url.toString());
  const raw  = await res.text();
  const data = parseJson(raw);
  console.log('[sms-provider] arkesel send http', res.status);

  const statusStr  = (data?.status  || '').toString().toUpperCase();
  const messageStr = (data?.message || '').toString().toLowerCase();
  const ok =
    statusStr === 'OK' ||
    statusStr === 'SUCCESS' ||
    messageStr.includes('successfully sent') ||
    messageStr.includes('success') ||
    (res.ok && !data?.error && statusStr !== 'ERROR' && statusStr !== 'FAILED');

  if (ok) return { success: true, message: 'SMS sent successfully', provider: 'arkesel', data };
  return {
    success:  false,
    message:  data?.message || data?.status || raw || `Arkesel error (HTTP ${res.status})`,
    provider: 'arkesel',
    data,
  };
}

async function arkeselBalance(cfg: ProviderConfig): Promise<SmsBalanceResult> {
  const url = new URL(ARKESEL_BASE);
  url.searchParams.set('action',   'check-balance');
  url.searchParams.set('api_key',  cfg.apiKey);
  url.searchParams.set('response', 'json');

  const res  = await timedFetch(url.toString());
  const raw  = await res.text();
  const data = parseJson(raw);

  if (data?.balance !== undefined && data?.balance !== null) {
    return { success: true, balance: String(data.balance), message: 'OK', provider: 'arkesel' };
  }
  if ((data?.status || '').toString().toUpperCase() === 'OK') {
    return { success: true, balance: String(data?.balance ?? 'N/A'), message: 'OK', provider: 'arkesel' };
  }
  return {
    success:  false,
    message:  data?.message || data?.status || raw || `Could not fetch balance (HTTP ${res.status})`,
    provider: 'arkesel',
  };
}

// ─── BMS Africa (https://developer.bms.africa — quick SMS + SMS balance) ──────
// The BMS developer docs publish these endpoints (API key passed as ?key=):
//   POST /sms/quick     { recipient: string[], sender, message, is_schedule, schedule_date }
//   GET  /balance/sms
const BMS_BASE       = 'https://api.mnotify.com/api';
const BMS_BATCH_SIZE = 500;   // recipients per request

function bmsIsSuccess(data: Record<string, any>, httpOk: boolean): boolean {
  const status = (data?.status ?? '').toString().toLowerCase();
  const code   = (data?.code   ?? '').toString();
  return httpOk && (status === 'success' || code === '2000');
}

async function bmsSend(cfg: ProviderConfig, recipients: string[], message: string): Promise<SmsSendResult> {
  const local = recipients.map(toLocalGhana);
  const batches: string[][] = [];
  for (let i = 0; i < local.length; i += BMS_BATCH_SIZE) batches.push(local.slice(i, i + BMS_BATCH_SIZE));

  const endpoint = `${BMS_BASE}/sms/quick?key=${encodeURIComponent(cfg.apiKey)}`;
  let okBatches = 0;
  let firstError = '';
  const responses: unknown[] = [];

  for (const batch of batches) {
    try {
      const res = await timedFetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          recipient:     batch,
          sender:        cfg.senderId,
          message,
          is_schedule:   false,
          schedule_date: '',
        }),
      });
      const raw  = await res.text();
      const data = parseJson(raw);
      const excerpt = snippet(raw, cfg.apiKey);
      console.log('[sms-provider] bms send http', res.status, 'content-type', res.headers.get('content-type'),
                  'status', data?.status, 'code', data?.code, 'body:', excerpt || '(empty)');
      responses.push(data);
      if (bmsIsSuccess(data, res.ok)) {
        okBatches++;
      } else if (!firstError) {
        const reason = (data?.message || (typeof data?.status === 'string' ? data.status : '') || excerpt || '').toString();
        firstError = `BMS Africa error (HTTP ${res.status})${reason ? ': ' + reason.slice(0, 160) : ''}`;
      }
    } catch (e) {
      if (!firstError) firstError = `BMS Africa request failed: ${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message}`;
    }
  }

  if (okBatches === batches.length) {
    return { success: true, message: 'SMS sent successfully', provider: 'bms', data: responses };
  }
  const partial = okBatches > 0 ? ` (${okBatches} of ${batches.length} batches were accepted — some recipients may have received it)` : '';
  return { success: false, message: firstError + partial, provider: 'bms', data: responses };
}

async function bmsBalance(cfg: ProviderConfig): Promise<SmsBalanceResult> {
  const res  = await timedFetch(`${BMS_BASE}/balance/sms?key=${encodeURIComponent(cfg.apiKey)}`, {
    headers: { 'Accept': 'application/json' },
  });
  const raw  = await res.text();
  const data = parseJson(raw);

  const bal = data?.balance ?? data?.sms_balance ?? data?.data?.balance;
  if (res.ok && bal !== undefined && bal !== null && (data?.status ?? 'success').toString().toLowerCase() !== 'error') {
    return { success: true, balance: String(bal), message: 'OK', provider: 'bms' };
  }
  return {
    success:  false,
    message:  (data?.message || data?.status || `Could not fetch balance (HTTP ${res.status})`).toString(),
    provider: 'bms',
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function sendSms(provider: SmsProviderId, recipients: string[], message: string): Promise<SmsSendResult> {
  const cfg = getConfig(provider);
  if (!cfg) {
    return {
      success:  false,
      message:  `${SMS_PROVIDERS[provider].label} is not configured. Set ${SMS_PROVIDERS[provider].secrets} in the Supabase secrets.`,
      provider,
    };
  }
  try {
    return provider === 'arkesel'
      ? await arkeselSend(cfg, recipients, message)
      : await bmsSend(cfg, recipients, message);
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'request timed out' : (e as Error).message;
    return { success: false, message: `${SMS_PROVIDERS[provider].label} request failed: ${msg}`, provider };
  }
}

export async function getSmsBalance(provider: SmsProviderId): Promise<SmsBalanceResult> {
  const cfg = getConfig(provider);
  if (!cfg) {
    return { success: false, message: `${SMS_PROVIDERS[provider].label} is not configured.`, provider };
  }
  try {
    return provider === 'arkesel' ? await arkeselBalance(cfg) : await bmsBalance(cfg);
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'request timed out' : (e as Error).message;
    return { success: false, message: `${SMS_PROVIDERS[provider].label} balance check failed: ${msg}`, provider };
  }
}