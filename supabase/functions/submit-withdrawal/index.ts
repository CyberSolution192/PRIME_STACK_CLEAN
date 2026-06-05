// ============================================================
// supabase/functions/submit-withdrawal/index.ts — Phase 2 + 2026-05 patch
// ============================================================
// CHANGES from Phase 2 (PBKDF2 version):
//   - serve() → Deno.serve()
//   - user_note removed from withdrawal_requests queries (column deleted from DB)
//   - user_note removed from insert
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── PBKDF2 PIN verification (unchanged) ───────────────────────────────────────
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_KEYLEN     = 32;

function _hexDecode(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return arr;
}

async function verifyPinHash(pin: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
    const salt     = _hexDecode(parts[1]);
    const expected = _hexDecode(parts[2]);
    const keyMat   = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'],
    );
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      keyMat, PBKDF2_KEYLEN * 8,
    );
    const actual = new Uint8Array(derived);
    if (actual.length !== expected.length) return false;
    let mismatch = 0;
    for (let i = 0; i < actual.length; i++) mismatch |= actual[i] ^ expected[i];
    return mismatch === 0;
  } catch { return false; }
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MIN_WITHDRAWAL   = 5;
const MAX_WITHDRAWAL   = 1000;
const MAX_DAILY_TOTAL  = 3000;
const MAX_DAILY_COUNT  = 10;
const COOLDOWN_MINUTES = 30;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ success: false, message: 'Unauthorized' }, 401);

  const token    = authHeader.replace('Bearer ', '');
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return json({ success: false, message: 'Invalid or expired token' }, 401);

  let body: { amount?: number; phone?: string; network?: string; notes?: string; pin?: string; };
  try { body = await req.json(); }
  catch { return json({ success: false, message: 'Invalid JSON body' }, 400); }

  const { amount, phone, network, pin, recipient_name } = body;

  if (!amount || typeof amount !== 'number' || isNaN(amount))
    return json({ success: false, message: 'Invalid amount' }, 400);
  if (amount < MIN_WITHDRAWAL)
    return json({ success: false, message: `Minimum withdrawal is GH₵${MIN_WITHDRAWAL}` }, 400);
  if (amount > MAX_WITHDRAWAL)
    return json({ success: false, message: `Maximum withdrawal per transaction is GH₵${MAX_WITHDRAWAL}` }, 400);
  if (!phone || !/^[0-9]{10}$/.test(phone))
    return json({ success: false, message: 'Enter a valid 10-digit phone number' }, 400);
  if (!network || !['mtn', 'telecel', 'airteltigo'].includes(network.toLowerCase()))
    return json({ success: false, message: 'Invalid network' }, 400);
  if (!recipient_name || typeof recipient_name !== 'string' || recipient_name.trim().length < 2)
    return json({ success: false, message: 'Enter the name on your mobile money account' }, 400);

  try {
    const { data: profile, error: profileErr } = await supabase
      .from('users')
      .select('store_unlocked, transaction_pin_hash, pin_failed_attempts, pin_locked_until')
      .eq('id', user.id)
      .single();

    if (profileErr || !profile)
      return json({ success: false, message: 'Profile not found' }, 404);
    if (!profile.store_unlocked)
      return json({ success: false, message: 'Store not unlocked. Withdrawal not available.' }, 403);

    // ── PIN verification ───────────────────────────────────────────────────
    if (profile.transaction_pin_hash) {
      if (!pin)
        return json({ success: false, message: 'Transaction PIN required', pin_required: true }, 400);

      if (profile.pin_locked_until && new Date(profile.pin_locked_until) > new Date()) {
        const mins = Math.ceil((new Date(profile.pin_locked_until).getTime() - Date.now()) / 60000);
        return json({ success: false, message: `PIN locked. Try again in ${mins} minute(s).`, locked: true }, 429);
      }

      const pinValid = await verifyPinHash(String(pin), profile.transaction_pin_hash);
      if (!pinValid) {
        const newAttempts = (profile.pin_failed_attempts ?? 0) + 1;
        const updateData: Record<string, unknown> = { pin_failed_attempts: newAttempts };
        if (newAttempts >= 5) {
          updateData.pin_locked_until    = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          updateData.pin_failed_attempts = 0;
        }
        await supabase.from('users').update(updateData).eq('id', user.id);
        const remaining = 5 - newAttempts;
        return json({
          success: false,
          message: remaining > 0
            ? `Incorrect PIN. ${remaining} attempt(s) remaining.`
            : 'Too many incorrect attempts. PIN locked for 30 minutes.',
        }, 400);
      }

      await supabase.from('users').update({ pin_failed_attempts: 0 }).eq('id', user.id);
    }

    // ── Velocity checks ────────────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);

    const { data: dailyRow } = await supabase
      .from('withdrawal_daily_totals')
      .select('total_amount, tx_count')
      .eq('user_id', user.id)
      .eq('date', today)
      .single();

    const dailyTotal = parseFloat(String(dailyRow?.total_amount ?? 0));
    const dailyCount = parseInt(String(dailyRow?.tx_count ?? 0));

    if (dailyCount >= MAX_DAILY_COUNT)
      return json({ success: false, message: `Daily withdrawal limit reached (${MAX_DAILY_COUNT} withdrawals per day).` }, 429);

    if (dailyTotal + amount > MAX_DAILY_TOTAL) {
      const remaining = Math.max(0, MAX_DAILY_TOTAL - dailyTotal);
      return json({ success: false, message: `Daily limit would be exceeded. You can withdraw up to GH₵${remaining.toFixed(2)} more today.` }, 429);
    }

    const { data: lastWithdrawal } = await supabase
      .from('withdrawal_requests')
      .select('created_at')
      .eq('user_id', user.id)
      .in('status', ['pending', 'completed', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (lastWithdrawal?.created_at) {
      const elapsed    = Date.now() - new Date(lastWithdrawal.created_at).getTime();
      const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
      if (elapsed < cooldownMs) {
        const waitMins = Math.ceil((cooldownMs - elapsed) / 60000);
        return json({ success: false, message: `Please wait ${waitMins} more minute(s) before submitting another withdrawal.`, cooldown: true }, 429);
      }
    }

    // ── Profit calculation ─────────────────────────────────────────────────
    const [ordersRes, bundlesRes, ubpRes, completedWithdrawalsRes, pendingWithdrawalsRes] =
      await Promise.all([
        supabase
          .from('adminorders')
          .select('amount, network, package_size, external_response')
          .or('order_reference.like.STORE-%,order_reference.like.GST-%,order_reference.like.PAY-%')
          .in('status', ['completed', 'processing'])
          .filter('external_response->>storeownerid', 'eq', user.id),
        supabase.from('bundles').select('id, network, size, price').eq('active', true),
        supabase.from('user_bundle_prices').select('bundle_id, custom_price').eq('user_id', user.id),
        supabase.from('withdrawal_requests').select('amount')
          .eq('user_id', user.id).eq('status', 'completed'),
        supabase.from('withdrawal_requests').select('amount')
          .eq('user_id', user.id).eq('status', 'pending'),
      ]);

    const bundleBaseMap: Record<string, number> = {};
    const bundleIdMap: Record<string, string>   = {};
    (bundlesRes.data || []).forEach((b: any) => {
      const key = b.network.toLowerCase() + '-' + b.size;
      bundleBaseMap[key] = parseFloat(b.price);
      bundleIdMap[key]   = b.id;
    });

    const customCostMap: Record<string, number> = {};
    (ubpRes.data || []).forEach((r: any) => { customCostMap[r.bundle_id] = parseFloat(r.custom_price); });

    let totalEarned = 0;
    for (const order of (ordersRes.data || [])) {
      const ext          = order.external_response || {};
      const sellingPrice = parseFloat(String(ext.selling_price ?? order.amount ?? 0));
      const rawSavedCost = ext.base_cost;
      const bundleKey    = (order.network || '').toLowerCase() + '-' + order.package_size;
      const bundleId     = bundleIdMap[bundleKey];

      let baseCost: number;
      if (rawSavedCost !== null && rawSavedCost !== undefined) {
        baseCost = parseFloat(String(rawSavedCost));
      } else if (bundleId && customCostMap[bundleId] != null) {
        baseCost = customCostMap[bundleId];
      } else {
        baseCost = bundleBaseMap[bundleKey] || 0;
      }

      const savedProfit = (ext.profit !== undefined && ext.profit !== null)
        ? parseFloat(String(ext.profit))
        : null;

      const rowProfit = savedProfit !== null
        ? Math.max(0, savedProfit)
        : Math.max(0, sellingPrice - baseCost);

      totalEarned += rowProfit;
    }

    const totalWithdrawn = (completedWithdrawalsRes.data || [])
      .reduce((s: number, w: any) => s + parseFloat(w.amount || 0), 0);
    const pendingBalance = (pendingWithdrawalsRes.data || [])
      .reduce((s: number, w: any) => s + parseFloat(w.amount || 0), 0);
    const availableProfits = Math.max(0, totalEarned - totalWithdrawn - pendingBalance);

    if (amount > availableProfits) {
      return json({
        success: false,
        message: `Insufficient profits. Available: GH₵${availableProfits.toFixed(2)}`,
      }, 400);
    }

    // ── Duplicate pending guard ────────────────────────────────────────────
    const { data: existingPending } = await supabase
      .from('withdrawal_requests')
      .select('id')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .limit(1);

    if (existingPending && existingPending.length > 0) {
      return json({
        success: false,
        message: 'You already have a pending withdrawal. Please wait for it to be processed.',
      }, 409);
    }

    // ── Insert withdrawal request ──────────────────────────────────────────
    // FIX (2026-05): user_note removed from insert (column deleted from DB)
    const { error: insertError } = await supabase.from('withdrawal_requests').insert({
      user_id:           user.id,
      amount,
      fee:               0,
      recipient_account: phone,
      network:           network.toLowerCase(),
      method:            'mobile_money',
      recipient_name:    recipient_name.trim(),
      status:            'pending',
    });

    if (insertError) throw insertError;

    // ── Upsert velocity tracking ───────────────────────────────────────────
    await supabase.from('withdrawal_daily_totals').upsert({
      user_id:      user.id,
      date:         today,
      total_amount: dailyTotal + amount,
      tx_count:     dailyCount + 1,
    }, { onConflict: 'user_id,date' });

    // ── Audit log (non-fatal) ──────────────────────────────────────────────
    try {
      await supabase.from('audit_logs').insert({
        user_id:    user.id,
        action:     'withdrawal_submitted',
        ip_address: req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown',
        metadata:   { amount, network, phone_last4: phone.slice(-4), daily_total_after: dailyTotal + amount },
        created_at: new Date().toISOString(),
      });
    } catch (_) { /* non-fatal */ }

    console.log(`✅ Withdrawal submitted — user:${user.id} amount:GH₵${amount} daily_total:GH₵${(dailyTotal + amount).toFixed(2)}`);
    return json({ success: true, message: 'Withdrawal request submitted successfully' });

  } catch (err) {
    console.error('submit-withdrawal error:', err);
    return json({ success: false, message: 'Failed to submit withdrawal request' }, 500);
  }
});