// store-lock-check.js
// CSP-safe ES module — covered by 'self' in script-src.
// Imports SUPABASE_PROJECT_URL and SUPABASE_ANON from supabase-config.js
// so credentials are never hardcoded here.
//
// Sets window.__storeLockReady (Promise<bool>) immediately on module parse.
// The module script in store.html awaits this before calling loadStore().
//
// Loaded in store.html as:
//   <script type="module" src="store-lock-check.js"></script>
//   <script type="module"> ... loadStore() ... </script>

import { SUPABASE_PROJECT_URL, SUPABASE_ANON } from './supabase-config.js';

const ICON_MAP = {
  clock:    'fas fa-clock',
  wrench:   'fas fa-wrench',
  ban:      'fas fa-ban',
  bullhorn: 'fas fa-bullhorn',
};

window.__storeLockReady = fetch(
  SUPABASE_PROJECT_URL + '/functions/v1/get-site-status',
  { headers: { 'apikey': SUPABASE_ANON, 'Content-Type': 'application/json' } }
)
.then(res => res.json())
.then(data => {
  if (!data.success) return false;

  const lock = data.store;
  if (!lock || !lock.locked) return false;

  const overlay = document.getElementById('storeLockOverlay');
  if (!overlay) return false;

  const titleEl   = document.getElementById('storeLockTitle');
  const messageEl = document.getElementById('storeLockMessage');
  const footerEl  = document.getElementById('storeLockFooter');
  const iconEl    = document.getElementById('storeLockIcon');

  if (titleEl)   titleEl.textContent   = lock.title   || 'Store Temporarily Closed';
  if (messageEl) messageEl.textContent = lock.message || '';
  if (footerEl)  footerEl.textContent  = lock.footer  || 'Check back later.';
  if (iconEl)    iconEl.className      = (ICON_MAP[lock.icon] || 'fas fa-clock') + ' text-3xl text-slate-400';

  overlay.classList.remove('hidden');
  overlay.classList.add('flex');

  return true; // LOCKED
})
.catch(() => false); // fail open — never block the store on a network error