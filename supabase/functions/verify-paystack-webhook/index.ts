// ============================================================
// supabase/functions/verify-paystack/index.ts
// ============================================================
// SECURITY FIXES:
//   [1] CORS — replaced wildcard * with explicit origin whitelist
//   [2] Amount — creditAmount now derived from Paystack-verified
//       data server-side, never from client-supplied bundle_amount
//   [3] RPC argument order updated to match new secure signature
//       (p_reference before p_amount)
//
// Deploy: supabase functions deploy verify-paystack --no-verify-jwt
// ============================================================

import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PAYSTACK_SECRET_KEY       = Deno.env.get('PAYSTACK_SECRET_KEY')!;

// [1] Explicit origin whitelist — replaces the previous wildcard *
const ALLOWED_ORIGINS = new Set([
  'https://primeconnect.site',
  // Remove before final production launch:
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
  // CORS preflight
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
    // [2] Only extract reference — bundle_amount and processing_charge
    // are no longer accepted from the client. The amount to credit is
    // derived exclusively from what Paystack confirms server-side.
    const body = await req.json();
    const reference = (body.reference as string | undefined)?.trim();

    if (!reference) {
      return jsonResponse({ success: false, message: 'Missing payment reference' }, 400, req);
    }

    // Verify caller identity from Bearer token
    const supabase    = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const authHeader  = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonResponse({ success: false, message: 'Missing Authorization header' }, 401, req);
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return jsonResponse({ success: false, message: 'Invalid or expired token' }, 401, req);
    }

    console.log(`Verifying payment — user: ${user.id}, ref: ${reference}`);

    // Atomic idempotency claim — unique constraint on reference prevents
    // two concurrent requests from both proceeding past this point
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
        .select('processed, status')
        .eq('reference', reference)
        .single();

      if (existing?.processed) {
        return jsonResponse({ success: false, duplicate: true, message: 'Payment already processed' }, 200, req);
      }

      return jsonResponse({
        success: false,
        message: 'Payment is being processed. Please wait a moment and refresh.',
      }, 409, req);
    }

    // Verify with Paystack — this is the authoritative source of the amount
    const paystackRes  = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } },
    );
    const verifyData   = await paystackRes.json();

    if (!verifyData.status || verifyData.data?.status !== 'success') {
      await supabase
        .from('paystack_verifications')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('reference', reference);

      return jsonResponse({
        success: false,
        message: 'Payment not successful or could not be verified',
      }, 400, req);
    }

    // [2] Amount comes from Paystack's verified response only.
    // The DB function also extracts this independently from p_paystack_data
    // as a second layer — neither layer trusts the client for the amount.
    const paystackAmountGHS = verifyData.data.amount / 100;

    console.log(`Paystack confirmed: GH₵${paystackAmountGHS} for ref: ${reference}`);

    await supabase
      .from('paystack_verifications')
      .update({
        amount:            paystackAmountGHS,
        status:            'success',
        paystack_response: verifyData,
        updated_at:        new Date().toISOString(),
      })
      .eq('reference', reference);

    // [3] RPC called with new parameter order — p_reference before p_amount.
    // p_amount is passed for record-keeping but the DB function derives the
    // credit amount from p_paystack_data independently and ignores p_amount.
    const { data: result, error: rpcError } = await supabase.rpc('process_paystack_payment', {
      p_user_id:      user.id,
      p_reference:    reference,
      p_amount:       paystackAmountGHS,
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

    await supabase
      .from('paystack_verifications')
      .update({ processed: true, status: 'credited', updated_at: new Date().toISOString() })
      .eq('reference', reference);

    console.log(`Wallet credited — user: ${user.id}, amount: GH₵${paystackAmountGHS}`);

    return jsonResponse({
      success:     true,
      message:     'Payment verified & wallet credited successfully',
      amount:      paystackAmountGHS,
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