// ============================================================
// _shared/source-domain.ts
//
// Works out which of our domains a record came from, so orders, payments,
// users and stores can be tagged in the `source_domain` column and reported
// per domain in the admin portal.
//
// A value is only returned for a domain in KNOWN_HOSTS. Anything else
// (local dev, unknown origin, missing header) returns `undefined`, which
// supabase-js omits from the insert/upsert — so tagging can never make an
// order fail, and an existing tag is never overwritten with a blank.
//
// To add a domain: add it to KNOWN_HOSTS below AND insert it into the
// public.domains table (source_domain has a foreign key to domains.host).
// ============================================================

const KNOWN_HOSTS = new Set<string>([
  'primeconnect.site',
  'www.richsondatahub.store',
]);

/**
 * Domain the request came from.
 *  1. A browser calling a function directly sends an Origin header (not editable by page code).
 *  2. A request forwarded by user-proxy has no Origin (it is a server-to-server call), so the proxy
 *     passes the customer's browser domain in `x-source-domain` after validating it itself.
 * Anything not on the known list returns undefined.
 */
export function sourceDomainFromRequest(req: Request): string | undefined {
  const origin = req.headers.get('Origin');
  if (origin) {
    try {
      const host = new URL(origin).host.toLowerCase();
      if (KNOWN_HOSTS.has(host)) return host;
    } catch { /* fall through */ }
  }
  return sourceDomainFromValue(req.headers.get('x-source-domain'));
}

/** Validate a domain value that arrived some other way (e.g. Paystack metadata on a webhook). */
export function sourceDomainFromValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const host = value.trim().toLowerCase();
  return KNOWN_HOSTS.has(host) ? host : undefined;
}

/** For server-to-server calls with no Origin (e.g. the reseller API): use the key owner's own domain. */
export async function sourceDomainForUser(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string | null | undefined,
): Promise<string | undefined> {
  if (!userId) return undefined;
  try {
    const { data } = await supabase
      .from('users')
      .select('source_domain')
      .eq('id', userId)
      .maybeSingle();
    return sourceDomainFromValue(data?.source_domain);
  } catch {
    return undefined;
  }
}
