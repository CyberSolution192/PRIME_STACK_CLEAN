/**
 * _shared/paystack-verify.ts
 *
 * Shared helper for calling Paystack's own transaction-verify endpoint
 * directly, independent of whether a webhook ever fired for a reference.
 * Mirrors the reVerifyWithPaystack() pattern already used inside
 * paystack-webhook/index.ts, extracted here so reconcile-pending-payments
 * can reuse the exact same call shape.
 */

export interface PaystackVerifyResult {
  ok: boolean;          // true if we got a well-formed response from Paystack
  status?: string;       // Paystack's transaction status: 'success' | 'failed' | 'abandoned' | ...
  httpStatus?: number;   // raw HTTP status code, useful to spot 429 (rate limited) vs 404 (unknown reference)
  message?: string;      // Paystack's own error message when the call isn't ok
  data?: any;
}

export async function verifyPaystackTransaction(
  reference: string,
  secretKey: string
): Promise<PaystackVerifyResult> {
  try {
    const res = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } }
    );
    const body = await res.json();
    return {
      ok: !!body?.status,
      status: body?.data?.status,
      httpStatus: res.status,
      message: body?.message,
      data: body?.data,
    };
  } catch (err) {
    console.error("[paystack-verify] fetch/parse error:", err);
    return { ok: false };
  }
}