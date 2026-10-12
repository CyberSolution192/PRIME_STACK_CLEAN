// ============================================================
// _shared/paystack-routing.ts
//
// Settlement routing check. Each domain can settle to its own Paystack
// subaccount (domains.paystack_subaccount). After a payment has been verified
// with Paystack, this confirms the transaction used the subaccount that
// belongs to the domain it came from:
//
//   primeconnect.site         -> expected subaccount code from the domains table
//   www.richsondatahub.store  -> none (settles to the main account)
//
// IMPORTANT — this only REPORTS. It never blocks or reverses a payment: a
// customer who has paid must still be credited. A mismatch only means the
// money settled somewhere other than planned, which the owner needs to know
// about. Mismatches are logged as "[ROUTING-MISMATCH]" in the function logs.
//
// It is switched on with the secret PAYSTACK_ROUTING_ENABLED=true, set at the
// same time as the Paystack key switch (before then, subaccount codes would
// not be valid for the old account, so nothing is checked).
// ============================================================

import { sourceDomainFromValue } from './source-domain.ts';

const ROUTING_ENABLED = Deno.env.get('PAYSTACK_ROUTING_ENABLED') === 'true';

export async function checkSubaccountRouting(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  // deno-lint-ignore no-explicit-any
  paystackData: any,
  fallbackDomain?: string,
): Promise<void> {
  if (!ROUTING_ENABLED) return;
  try {
    const domain = sourceDomainFromValue(paystackData?.metadata?.source_domain) ?? fallbackDomain;
    if (!domain) {
      console.warn(`[ROUTING-CHECK] ref ${paystackData?.reference}: no domain on the payment, cannot check routing`);
      return;
    }

    const { data: row } = await supabase
      .from('domains')
      .select('paystack_subaccount')
      .eq('host', domain)
      .maybeSingle();

    const expected: string | null = row?.paystack_subaccount ?? null;
    const actual:   string | null = paystackData?.subaccount?.subaccount_code ?? null;

    if (expected !== actual) {
      console.error(
        `[ROUTING-MISMATCH] ref ${paystackData?.reference} domain ${domain}: ` +
        `expected subaccount ${expected ?? 'none'}, Paystack shows ${actual ?? 'none'}`,
      );
    }
  } catch (e) {
    // Reporting must never interfere with crediting a payment.
    console.warn('[ROUTING-CHECK] skipped:', (e as Error).message);
  }
}
