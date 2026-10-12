// ============================================================
// _shared/partner-access.ts
//
// What a "partner" admin account (e.g. the owner of a second domain) may call.
// This is the single source of truth: admin-proxy checks it before forwarding,
// and each admin-manage-* function checks it again (defence in depth).
//
// Every action listed here is domain-scoped on the server (see domain-scope.ts): each
// looks up its row through the domain filter first, so a row outside the partner's
// domain simply comes back "not found". Anything not listed is refused — add actions
// here only after confirming that.
// ============================================================

export const PARTNER_ALLOWED_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  'admin-manage-orders': [
    'list', 'get-stats', 'get-dashboard-stats', 'get-analytics', 'export-csv', 'export-pdf',
    'update-status',          // write — the order is looked up through the domain filter first
  ],
  'admin-manage-users': [
    'list', 'get-stats', 'list-full', 'get-reseller-profits', 'get-my-profile', 'get-master-data',
    'get-user-prices',
    'set-bundle-prices',      // write — target user must be on the partner's domain; price >= base price
    'reset-bundle-price',     // write — target user must be on the partner's domain
  ],
  'admin-manage-withdrawals': [
    'list',
    'approve', 'reject', 'mark-sent',   // write — the request is looked up through the domain filter first
  ],
  'admin-manage-stores':   ['list'],
  'admin-manage-checkers': ['list-orders'],
};

/** Writes a partner may perform (everything else on the list above is a read). */
export const PARTNER_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'admin-manage-orders:update-status',
  'admin-manage-users:set-bundle-prices',
  'admin-manage-users:reset-bundle-price',
  'admin-manage-withdrawals:approve',
  'admin-manage-withdrawals:reject',
  'admin-manage-withdrawals:mark-sent',
]);

export function partnerAllowed(targetFunction: string, action: unknown): boolean {
  if (typeof action !== 'string' || typeof targetFunction !== 'string') return false;
  // Own keys only: names like "constructor" or "__proto__" must never resolve to inherited values.
  if (!Object.prototype.hasOwnProperty.call(PARTNER_ALLOWED_ACTIONS, targetFunction)) return false;
  return PARTNER_ALLOWED_ACTIONS[targetFunction].includes(action);
}
