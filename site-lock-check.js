// site-lock-check.js
// CSP-safe ES module — covered by 'self' in script-src.
// Imports SUPABASE_PROJECT_URL and SUPABASE_ANON from supabase-config.js
// so credentials are never hardcoded here.
//
// Sets window.__siteLockReady (Promise<bool>) immediately on module parse.
// dashboard-main.js awaits this promise in its DOMContentLoaded handler.
// If locked=true the overlay is shown and init() is never called.
//
// Loaded in dashboard.html as:
//   <script type="module" src="site-lock-check.js"></script>
//   <script type="module" src="dashboard-main.js?v=3"></script>

import { SUPABASE_PROJECT_URL, SUPABASE_ANON } from './supabase-config.js';

const ICON_MAP = {
  clock:    'fas fa-clock',
  wrench:   'fas fa-wrench',
  ban:      'fas fa-ban',
  bullhorn: 'fas fa-bullhorn',
};

window.__siteLockReady = fetch(
  SUPABASE_PROJECT_URL + '/functions/v1/get-site-status',
  { headers: { 'apikey': SUPABASE_ANON, 'Content-Type': 'application/json' } }
)
.then(res => res.json())
.then(data => {
  if (!data.success) return false;

  const lock = data.dashboard;
  if (!lock || !lock.locked) return false;

  const overlay = document.getElementById('siteLockOverlay');
  if (!overlay) return false;

  const titleEl   = document.getElementById('siteLockTitle');
  const messageEl = document.getElementById('siteLockMessage');
  const footerEl  = document.getElementById('siteLockFooter');
  const iconEl    = document.getElementById('siteLockIcon');

  if (titleEl)   titleEl.textContent   = lock.title   || 'We Are Currently Closed';
  if (messageEl) messageEl.textContent = lock.message || '';
  if (footerEl)  footerEl.textContent  = lock.footer  || 'Reopens soon.';
  if (iconEl)    iconEl.className      = (ICON_MAP[lock.icon] || 'fas fa-clock') + ' text-3xl text-slate-400';

  overlay.classList.remove('hidden');
  overlay.classList.add('flex');

  // Keep loadingOverlay in place (invisible) to block content behind lock overlay
  const loading = document.getElementById('loadingOverlay');
  if (loading) {
    loading.style.display       = 'flex';
    loading.style.opacity       = '0';
    loading.style.pointerEvents = 'none';
  }

  return true; // LOCKED
})
.catch(() => false); // fail open — never block the page on a network error