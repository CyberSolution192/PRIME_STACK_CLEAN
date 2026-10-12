// ============================================================
// _shared/domain-scope.ts
//
// Admin portal domain filter (server side).
//
// The portal sends `domain: "<host>"` with its list / stats / export requests
// when the admin picks one domain. For those READ actions only, this wraps the
// Supabase client so every `.from(<tableWithSourceDomain>).select(...)` also
// gets `.eq("source_domain", <host>)`. Inserts, updates and deletes are never
// touched, and tables not listed are never filtered.
//
// The value is validated against the known-domain list (see source-domain.ts),
// so an unknown or malformed value simply means "no filter" (All Domains).
// ============================================================

import { sourceDomainFromValue } from './source-domain.ts';

/** Domain the admin asked to filter by, or undefined for "All Domains". */
export function requestedDomain(body: Record<string, unknown> | null | undefined): string | undefined {
  return sourceDomainFromValue(body?.domain);
}

/**
 * Returns a client whose reads on `tables` are limited to `domain`.
 * Returns the original client untouched when there is no domain.
 */
// deno-lint-ignore no-explicit-any
export function scopeReads(client: any, domain: string | undefined, tables: string[]): any {
  if (!domain) return client;
  const scoped = new Set(tables);

  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'from') {
        return (table: string) => {
          const builder = target.from(table);
          if (!scoped.has(table)) return builder;
          return new Proxy(builder, {
            get(b, p) {
              if (p === 'select') {
                // deno-lint-ignore no-explicit-any
                return (...args: any[]) => b.select(...args).eq('source_domain', domain);
              }
              const v = Reflect.get(b, p, b);
              return typeof v === 'function' ? v.bind(b) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
