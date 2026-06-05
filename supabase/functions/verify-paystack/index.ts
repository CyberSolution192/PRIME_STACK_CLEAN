// ============================================================
// supabase/functions/verify-paystack/index.ts
// ============================================================
// SECURITY MODEL:
//   - bundle_amount and processing_charge ARE accepted from client body
//     but are VALIDATED server-side against the Paystack-verified gross.
//     The client cannot inflate the credit amount because:
//       bundle_amount + processing_charge must equal paystackGross ± GH₵0.02
//     If they don't match, we fall back to reversing the 4% fee from gross.
//   - Credit amount can NEVER exceed what Paystack confirmed (hard cap).
//   - CORS uses explicit origin whitelist (no wildcard).
//   - PAYSTACK_SECRET_KEY trimmed to guard against env var whitespace.
//   - RPC arg order: p_user_id, p_reference, p_amount, p_paystack_data.
//
// Deploy: supabase functions deploy verify-paystack --no-verify-jwt
// ============================================================

import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PAYSTACK_SECRET_KEY       = (Deno.env.get('PAYSTACK_SECRET_KEY') ?? '').trim();

const ALLOWED_ORIGINS = new Set([
  'https://primeconnect.site',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:5501',
  'http://localhost:5500',
  'http://localhost:5501',
]);

function getAllowedOrigin(req: Request): string {
  const origin = req.headers.get('Origin') ?? '';
  return ALLOWED_ORIGINS.has(origin) ? origin : 'https://no-cors-for-you';
}

function jsonResponse(body: unknown, status = 200, req?: Request): Response {
  const origin = req ? getAllowedOrigin(req) : 'https://no-cors-for-you';
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type':                     'application/json',
      'Access-Control-Allow-Origin':      origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods':     'POST, OPTIONS',
      'Access-Control-Allow-Headers':     'authorization, x-client-info, apikey, content-type',
      'Vary':                             'Origin',
    },
  });
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    const origin = getAllowedOrigin(req);
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':      origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods':     'POST, OPTIONS',
        'Access-Control-Allow-Headers':     'authorization, x-client-info, apikey, content-type',
        'Vary':                             'Origin',
      },
    });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, message: 'Method not allowed' }, 405, req);
  }

  if (!PAYSTACK_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing env vars');
    return jsonResponse({ success: false, message: 'Server configuration error' }, 500, req);
  }

  try {
    const body            = await req.json();
    const reference       = (body.reference as string | undefined)?.trim();
    const clientBundleAmt = body.bundle_amount;
    const clientCharge    = body.processing_charge;

    if (!reference) {
      return jsonResponse({ success: false, message: 'Missing payment reference' }, 400, req);
    }

    // Verify caller identity from Bearer token
    const supabase   = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonResponse({ success: false, message: 'Missing Authorization header' }, 401, req);
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return jsonResponse({ success: false, message: 'Invalid or expired token' }, 401, req);
    }

    console.log(`Verifying payment — user: ${user.id}, ref: ${reference}`);

    // Atomic idempotency claim — unique constraint on reference blocks
    // concurrent requests from both proceeding past this point.
    const { error: claimError } = await supabase
      .from('paystack_verifications')
      .insert({
        user_id:                   user.id,
        reference,
        status:                    'pending',
        processed:                 false,
        verification_attempts:     1,
        last_verification_attempt: new Date().toISOString(),
        updated_at:                new Date().toISOString(),
      });

    if (claimError) {
     const { data: existing } = await supabase
   .from('paystack_verifications')
   .select(`
    processed,
    status,
     verification_attempts
    `)
   .eq('reference', reference)
  .single();

await supabase
  .from('paystack_verifications')
  .update({
    verification_attempts:
      (existing?.verification_attempts || 1) + 1,

    last_verification_attempt:
      new Date().toISOString(),

    updated_at:
      new Date().toISOString(),
  })
  .eq('reference', reference);
      if (existing?.processed) {
        console.log(`Already processed: ${reference}`);
        return jsonResponse(
          { success: false, duplicate: true, message: 'Payment already processed' },
          200,
          req,
        );
      }

      console.warn(`Reference already claimed but not yet processed: ${reference}`);
      return jsonResponse({
        success: false,
        message: 'Payment is being processed. Please wait a moment and refresh.',
      }, 409, req);
    }

    // ── Verify with Paystack — authoritative source of gross amount ───────────
    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } },
    );
    const verifyData = await paystackRes.json();

    console.log('Paystack verify status:', verifyData?.data?.status);

    if (!verifyData.status || verifyData.data?.status !== 'success') {
      console.error('Paystack verification failed:', verifyData?.message ?? verifyData);
      await supabase
        .from('paystack_verifications')
.update({
  status: 'failed',

  paystack_response: {
    verification_error:
      verifyData?.message ?? 'Verification failed',

    full_response: verifyData,
  },

  updated_at: new Date().toISOString(),
})        .eq('reference', reference);

      return jsonResponse({
        success: false,
        message: 'Payment not successful or could not be verified',
      }, 400, req);
    }

    const paystackGross = verifyData.data.amount / 100; // kobo → GHS (e.g. 1.04)
    const TOLERANCE     = 0.02; // GH₵ rounding tolerance

    // ── Derive credit amount — always validated against Paystack gross ─────────
    //
    // Priority:
    //   1. Client bundle_amount + processing_charge — must sum to gross ± 0.02
    //   2. Client bundle_amount alone               — must be <= gross
    //   3. Paystack metadata bundle_amount          — must be <= gross
    //   4. Last resort: reverse the 4% fee          — round(gross / 1.04, 2)
    //
    // Hard cap: creditAmount can NEVER exceed paystackGross.

    let creditAmount: number;

    const parsedBundleAmt = (clientBundleAmt !== undefined && clientBundleAmt !== null && clientBundleAmt !== '')
      ? parseFloat(String(clientBundleAmt))
      : NaN;

    const parsedCharge = (clientCharge !== undefined && clientCharge !== null && clientCharge !== '')
      ? parseFloat(String(clientCharge))
      : NaN;

    if (!isNaN(parsedBundleAmt) && parsedBundleAmt > 0 && !isNaN(parsedCharge) && parsedCharge >= 0) {
      // Path 1: both provided — validate they reconcile with Paystack gross
      const clientTotal = parseFloat((parsedBundleAmt + parsedCharge).toFixed(2));
      const diff        = Math.abs(clientTotal - paystackGross);

      if (diff <= TOLERANCE) {
        creditAmount = parsedBundleAmt;
        console.log(`Credit from client bundle_amount (validated): GH₵${creditAmount} | gross: GH₵${paystackGross} | charge: GH₵${parsedCharge} | diff: GH₵${diff}`);
      } else {
        // Values don't reconcile — possible tampering or config mismatch
        console.warn(`bundle_amount(${parsedBundleAmt}) + charge(${parsedCharge}) = ${clientTotal} != gross(${paystackGross}) diff=${diff} — falling back to fee reversal`);
        creditAmount = Math.round((paystackGross / 1.04) * 100) / 100;
      }

    } else if (!isNaN(parsedBundleAmt) && parsedBundleAmt > 0) {
      // Path 2: only bundle_amount, no charge
      if (parsedBundleAmt <= paystackGross + TOLERANCE) {
        creditAmount = parsedBundleAmt;
        console.log(`Credit from client bundle_amount only: GH₵${creditAmount} | gross: GH₵${paystackGross}`);
      } else {
        console.warn(`bundle_amount(${parsedBundleAmt}) exceeds gross(${paystackGross}) — falling back to fee reversal`);
        creditAmount = Math.round((paystackGross / 1.04) * 100) / 100;
      }

    } else {
      // Path 3: check Paystack-echoed metadata
      const meta         = verifyData.data.metadata ?? {};
      const customFields = Array.isArray(meta.custom_fields) ? meta.custom_fields : [];
      const findField    = (key: string) => customFields.find((f: any) => f.variable_name === key)?.value;
      const metaBundle   = meta.bundle_amount ?? findField('bundle_amount');

      if (metaBundle !== undefined && metaBundle !== null && metaBundle !== '') {
        const parsed = parseFloat(String(metaBundle));
        if (!isNaN(parsed) && parsed > 0 && parsed <= paystackGross + TOLERANCE) {
          creditAmount = parsed;
          console.log(`Credit from Paystack metadata bundle_amount: GH₵${creditAmount} | gross: GH₵${paystackGross}`);
        } else {
          creditAmount = Math.round((paystackGross / 1.04) * 100) / 100;
          console.warn(`Metadata bundle_amount invalid (${metaBundle}) — reversed 4% fee: GH₵${creditAmount}`);
        }
      } else {
        // Path 4: no hints anywhere — reverse the 4% fee
        creditAmount = Math.round((paystackGross / 1.04) * 100) / 100;
        console.warn(`No bundle_amount from any source — reversed 4% fee: GH₵${creditAmount} | gross: GH₵${paystackGross}`);
      }
    }

    // Hard cap — credit can never exceed what Paystack confirmed
    if (creditAmount > paystackGross) {
      console.error(`creditAmount (${creditAmount}) exceeds paystackGross (${paystackGross}) — capping`);
      creditAmount = paystackGross;
    }

    if (isNaN(creditAmount) || creditAmount <= 0) {
      console.error(`Invalid creditAmount (${creditAmount}) — aborting`);
      await supabase
        .from('paystack_verifications')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('reference', reference);
      return jsonResponse({
        success: false,
        message: 'Could not determine credit amount. Contact support.',
      }, 500, req);
    }

    // Update verification record with Paystack-confirmed data
    await supabase
      .from('paystack_verifications')
      .update({
        amount:            paystackGross,
        status:            'success',
        paystack_response: verifyData,
        updated_at:        new Date().toISOString(),
      })
      .eq('reference', reference);

    // Credit the wallet via DB RPC
    const { data: result, error: rpcError } = await supabase.rpc('process_paystack_payment', {
      p_user_id:       user.id,
      p_reference:     reference,
      p_amount:        creditAmount,
      p_paystack_data: verifyData.data,
    });

    if (rpcError) {
      console.error('RPC error:', rpcError);
      await supabase
        .from('paystack_verifications')
        .update({ status: 'rpc_failed', updated_at: new Date().toISOString() })
        .eq('reference', reference);
      throw new Error('Database error: ' + rpcError.message);
    }

    if (!result?.success) {
      console.error('process_paystack_payment returned failure:', result);
      await supabase
        .from('paystack_verifications')
        .update({ status: 'rpc_failed', updated_at: new Date().toISOString() })
        .eq('reference', reference);
      throw new Error(result?.message || 'Payment could not be processed');
    }

    // Mark fully processed — paystack-webhook idempotency check will skip this ref
    await supabase
      .from('paystack_verifications')
      .update({ processed: true, status: 'credited', updated_at: new Date().toISOString() })
      .eq('reference', reference);

    console.log(`Wallet credited — user: ${user.id} | credited: GH₵${creditAmount} | gross: GH₵${paystackGross}`);

    return jsonResponse({
      success:     true,
      message:     'Payment verified & wallet credited successfully',
      amount:      creditAmount,     // net amount credited to wallet
      gross:       paystackGross,    // what Paystack actually charged
      new_balance: result.new_balance,
    }, 200, req);

  } catch (err) {
    console.error('Unhandled error:', err);
    return jsonResponse({
      success: false,
      message: err instanceof Error ? err.message : 'Verification failed',
    }, 500, req);
  }
});