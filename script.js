/* ============================================================
 * script.js — Prime Connect Admin Portal
 * ============================================================ */

/* ── Fallback Navigation ─────────────────────────────────────── */
  window.admin = window.admin || {
    navigateTo: function(page) {
      console.log('Fallback navigation to:', page);
      // Basic navigation fallback
        const pages = ['dashboard', 'all-orders', 'guest-orders', 'user-orders', 'store-sales', 'pending-deposits', 'users', 'bundles', 'custom-pricing', 'settings', 'send-sms', 'new-resellers'];      if (pages.includes(page)) {
        // Hide all pages
        document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
        // Show selected page
        const pageEl = document.getElementById(page + '-page');
        if (pageEl) pageEl.classList.remove('hidden');
        // Update page titles
        const titles = {
          dashboard: 'Admin Dashboard',
          'all-orders': 'All Orders',
          'guest-orders': 'Guest Orders',
          'pending-deposits': 'Pending Deposits',
          users: 'User Management',
          bundles: 'Bundle Management',
          settings: 'System Settings',
          'send-sms': 'Send SMS'
        };
        const mobileTitle = document.getElementById('mobile-page-title');
        const desktopTitle = document.getElementById('desktop-page-title');
        if (mobileTitle) mobileTitle.textContent = titles[page] || '';
        if (desktopTitle) desktopTitle.textContent = titles[page] || '';
        
        // Load SMS balance
        if (page === 'send-sms') {
          checkSMSBalance();
        }
      }
    }
  };

/* ── SMS & Deposit Tab Functions ────────────────────────────── */
// Supabase project URL 
const _SUPABASE_FUNCTIONS_URL = (window._supabaseProjectUrl || 'https://rpolemxgussziexdmdxe.supabase.co') + '/functions/v1';

// ─── Helper: authenticated POST to send-sms via admin-proxy ────────────────
// v4: Zero-credential architecture.
// The browser holds no token. We route through admin-proxy which validates the
// HttpOnly session cookie server-side and injects the bearer token itself.
// We wait for adminFetch to be registered by the module script (same approach
// as before, just waiting for adminFetch instead of _getAdminToken).
async function _smsPost(body) {
  // Wait for the module script to register adminFetch (up to 10s)
  let attempts = 0;
  while (!window._adminFetchReady && attempts++ < 100) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (!window._adminFetchReady) {
    console.warn('_smsPost: adminFetch not available, aborting request');
    return { success: false, message: 'Not authenticated. Please sign in.' };
  }
  const _SUPABASE_ANON_KEY = window._supabaseAnon || '';
  const _SUPABASE_PROJECT_URL = window._supabaseProjectUrl || 'https://rpolemxgussziexdmdxe.supabase.co';
  const response = await fetch(`${_SUPABASE_PROJECT_URL}/functions/v1/admin-proxy`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'apikey': _SUPABASE_ANON_KEY,
      'x-target-function': 'send-sms',
    },
    body: JSON.stringify(body),
  });
  return response.json();
}

// ─── Check SMS Balance ─────────────────────────────────────────────────────
async function checkSMSBalance() {
  const balanceEl = document.getElementById('sms-balance');
  if (!balanceEl) return;
  try {
    balanceEl.textContent = 'Loading...';
    const result = await _smsPost({ action: 'balance' });
    if (result.success && result.balance !== undefined) {
      balanceEl.textContent = result.balance;
    } else {
      balanceEl.textContent = 'Error';
      showToast(result.message || 'Failed to check balance', 'error');
    }
  } catch (error) {
    console.error('Error checking SMS balance:', error);
    balanceEl.textContent = '--';
  }
}

// ─── Tab switching ─────────────────────────────────────────────────────────
function switchSMSTab(tab) {
  ['compose', 'logs'].forEach(t => {
    const btn   = document.getElementById(`sms-tab-${t}`);
    const panel = document.getElementById(`sms-panel-${t}`);
    const active = t === tab;
    btn.classList.toggle('bg-white',    active);
    btn.classList.toggle('text-slate-800', active);
    btn.classList.toggle('shadow',      active);
    btn.classList.toggle('text-slate-500', !active);
    panel.classList.toggle('hidden', !active);
  });
  if (tab === 'logs') loadSMSLogs();
}

// ─── Target audience selector UI ──────────────────────────────────────────
function updateSMSTargetUI() {
  const target = document.querySelector('input[name="sms-target"]:checked')?.value || 'all';
  const opts = ['network', 'activity', 'balance', 'manual'];
  opts.forEach(o => {
    const el = document.getElementById(`sms-opt-${o}`);
    if (el) el.classList.toggle('hidden', o !== target);
  });

  const preview = document.getElementById('sms-recipient-preview');
  const listEl  = document.getElementById('sms-recipient-list');
  if (preview) {
    preview.classList.toggle('hidden', target === 'manual');
    if (target !== 'manual') {
      document.getElementById('sms-recipient-count').textContent = '—';
      if (listEl) listEl.innerHTML = '<div class="py-5 text-center text-slate-400 text-xs"><i class="fas fa-spinner fa-spin block mb-1"></i>Loading...</div>';
      previewSMSRecipients();
    }
  }

  if (target === 'manual') updatePhoneCount();
}

// ─── Preview recipient count ───────────────────────────────────────────────
async function previewSMSRecipients() {
  const countEl = document.getElementById('sms-recipient-count');
  const listEl  = document.getElementById('sms-recipient-list');
  if (!countEl || !listEl) return;

  countEl.textContent = 'loading...';
  listEl.innerHTML = '<div class="py-5 text-center text-slate-400 text-xs"><i class="fas fa-spinner fa-spin block mb-1"></i>Loading recipients...</div>';

  try {
    const target = buildSMSTarget();
    const result = await _smsPost({ action: 'preview', target });

    if (!result.success) {
      countEl.textContent = 'Error';
      listEl.innerHTML = `<div class="py-4 text-center text-red-400 text-xs">${esc(result.message) || 'Failed to load'}</div>`;
      return;
    }

    const users = result.users || [];
    countEl.textContent = result.count;

    if (users.length === 0) {
      listEl.innerHTML = '<div class="py-6 text-center text-slate-400 text-xs"><i class="fas fa-user-slash block mb-1 opacity-40"></i>No users match this filter</div>';
      return;
    }

    const networkColors = {
      mtn:       'bg-yellow-100 text-yellow-700',
      airteltigo:'bg-red-100 text-red-700',
      telecel:   'bg-blue-100 text-blue-700',
    };

    listEl.innerHTML = users.map(u => {
      const name    = u.fullname || u.email || u.phone;
      const sub     = u.fullname ? (u.email || u.phone) : u.phone;
      const bal = u.balance !== null && u.balance !== undefined
        ? `<span class="text-xs text-slate-500">GH₵ ${parseFloat(u.balance).toFixed(2)}</span>`
        : '';

      return `
        <div class="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50 transition-colors">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-7 h-7 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center flex-shrink-0 text-xs font-bold">
              ${esc((u.fullname || u.email || '?')[0].toUpperCase())}
            </div>
            <div class="min-w-0">
              <p class="text-sm font-medium text-slate-800 truncate">${esc(name)}</p>
              <p class="text-xs text-slate-400 truncate">${sub !== name ? esc(sub) : ''}</p>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0 ml-2">
            ${bal}
          </div>
        </div>`;
    }).join('');

    if (result.count > users.length) {
      listEl.innerHTML += `
        <div class="px-4 py-2 bg-slate-50 text-xs text-slate-500 text-center border-t border-slate-100">
          Showing ${users.length} of ${result.count} recipients
        </div>`;
    }

  } catch (err) {
    console.error('Preview error:', err);
    countEl.textContent = '?';
    listEl.innerHTML = '<div class="py-4 text-center text-red-400 text-xs">Failed to load recipients</div>';
  }
}

// ─── Build target object from current form state ──────────────────────────
function buildSMSTarget() {
  const type = document.querySelector('input[name="sms-target"]:checked')?.value || 'all';
  const target = { type };

  if (type === 'network') {
    target.network = document.querySelector('input[name="sms-network"]:checked')?.value || 'mtn';
  }
  if (type === 'activity') {
    target.activityDays = parseInt(document.querySelector('input[name="sms-activity-days"]:checked')?.value || '30', 10);
  }
  if (type === 'balance') {
    const minVal = document.getElementById('sms-balance-min')?.value;
    const maxVal = document.getElementById('sms-balance-max')?.value;
    if (minVal) target.balanceMin = parseFloat(minVal);
    if (maxVal) target.balanceMax = parseFloat(maxVal);
  }
  if (type === 'manual') {
    const phonesText = document.getElementById('multiple-phones')?.value || '';
    target.manualNumbers = phonesText.split('\n').map(p => p.trim()).filter(Boolean);
  }
  return target;
}

// ─── Format phone number ──────────
function formatPhoneNumber(phone) {
  phone = phone.replace(/\D/g, '');
  if (phone.startsWith('0')) phone = '233' + phone.substring(1);
  if (!phone.startsWith('233')) phone = '233' + phone;
  return phone;
}

// ─── Update phone count (manual mode) ─────────────────────────────────────
function updatePhoneCount() {
  const textarea = document.getElementById('multiple-phones');
  if (!textarea) return;
  const phones = textarea.value.split('\n').filter(p => p.trim().length > 0);
  const el = document.getElementById('phone-count');
  if (el) el.textContent = phones.length;
}

// ─── SMS Templates ─────────────────────────────────────────────────────────
function useSMSTemplate(type) {
  const templates = {
    maintenance: 'Dear customer, Prime Connect will undergo scheduled maintenance today. Services may be temporarily unavailable. Thank you for your patience.',
    promo:       'Special offer! Get 20% bonus on all data bundles today only at Prime Connect. Visit our app to purchase now!',
    update:      'Important update from Prime Connect: We have improved our service delivery. Enjoy faster data bundles. Thank you!',
    reminder:    'Reminder: Your wallet balance is running low. Top up now to enjoy uninterrupted service at Prime Connect.',
    lowbalance:  'Hi! Your Prime Connect wallet balance is below GH₵5. Recharge now to keep your data bundles flowing. Thank you!'
  };
  const msgEl = document.getElementById('sms-message');
  if (msgEl) { msgEl.value = templates[type] || ''; updateSMSPreview(); }
}

// ─── Update preview & char count ──────────────────────────────────────────
function updateSMSPreview() {
  const message = document.getElementById('sms-message')?.value || '';
  const previewEl = document.getElementById('sms-preview-text');
  const countEl   = document.getElementById('char-count');
  if (previewEl) previewEl.textContent = message || 'Your message will appear here...';
  if (countEl) {
    countEl.textContent = `${message.length}/160`;
    countEl.classList.toggle('text-red-600', message.length > 160);
    countEl.classList.toggle('text-slate-600', message.length <= 160);
  }
}

// ─── Handle SMS Form Submit ────────────────────────────────────────────────
async function handleSMSFormSubmit(e) {
  e.preventDefault();

  const message = document.getElementById('sms-message')?.value.trim() || '';
  if (!message) { showToast('Please enter a message', 'warning'); return; }
  if (message.length > 160) { showToast('Message too long. Maximum 160 characters', 'warning'); return; }

  const target = buildSMSTarget();

  // For manual, validate at least one number entered
  if (target.type === 'manual' && (!target.manualNumbers || target.manualNumbers.length === 0)) {
    showToast('Please enter at least one phone number', 'warning');
    return;
  }

  // Preview count before confirming for audience targets
  let recipientLabel = '';
  if (target.type === 'all')      recipientLabel = 'ALL registered users';
  else if (target.type === 'network')  recipientLabel = `all ${(target.network || '').toUpperCase()} users`;
  else if (target.type === 'activity') recipientLabel = `users active in the last ${target.activityDays} days`;
  else if (target.type === 'balance')  recipientLabel = `users with wallet balance in range`;
  else recipientLabel = `${target.manualNumbers.length} phone number(s)`;

  if (!confirm(`Send SMS to ${recipientLabel}?\n\nMessage:\n"${message}"\n\nThis cannot be undone.`)) return;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const origHTML  = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Sending...';

  try {
    const result = await _smsPost({ action: 'send', target, message });

    if (result.success) {
      const count = result.recipientCount || target.manualNumbers?.length || '?';
      showToast(`✅ SMS sent successfully to ${count} recipient(s)!`, 'success');
      // Clear message + manual phones
      const msgEl = document.getElementById('sms-message');
      const phEl  = document.getElementById('multiple-phones');
      if (msgEl) msgEl.value = '';
      if (phEl)  phEl.value  = '';
      updateSMSPreview();
      updatePhoneCount();
      document.getElementById('sms-recipient-count').textContent = '—';
      checkSMSBalance();
    } else {
      showToast('Failed to send SMS: ' + (result.message || 'Unknown error'), 'error');
    }
  } catch (error) {
    console.error('SMS send error:', error);
    showToast('Failed to send SMS. Please try again.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = origHTML;
  }
}

// ─── Load SMS Logs ─────────────────────────────────────────────────────────
async function loadSMSLogs() {
  const container = document.getElementById('sms-logs-container');
  if (!container) return;
  container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fas fa-spinner fa-spin text-2xl mb-2 block"></i><p class="text-sm">Loading logs...</p></div>';

  try {
    const result = await _smsPost({ action: 'logs' });
    if (!result.success) throw new Error(result.message);

    const logs = result.logs || [];
    if (logs.length === 0) {
      container.innerHTML = '<div class="text-center py-10 text-slate-400"><i class="fas fa-inbox text-3xl mb-3 opacity-30 block"></i><p class="text-sm">No SMS sends recorded yet</p></div>';
      return;
    }

    container.innerHTML = `
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-slate-100">
              <th class="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Date</th>
              <th class="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Sent By</th>
              <th class="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Target</th>
              <th class="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Recipients</th>
              <th class="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Message</th>
              <th class="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-50">
            ${logs.map(log => {
              const date    = new Date(log.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
              const sender  = log.sender_name || log.sent_by?.slice(0,8) + '...';
              const target  = _smsTargetLabel(log.target_type);
              const count   = log.recipient_count ?? (Array.isArray(log.recipients) ? log.recipients.length : '?');
              const msg     = log.message?.length > 60 ? log.message.slice(0, 60) + '…' : (log.message || '—');
              const ok      = log.success;
              return `
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-3 py-3 text-slate-500 whitespace-nowrap text-xs">${esc(date)}</td>
                  <td class="px-3 py-3 text-slate-700 font-medium max-w-[120px] truncate" title="${esc(sender)}">${esc(sender)}</td>
                  <td class="px-3 py-3">
                    <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${_smsTargetBadgeClass(log.target_type)}">
                      ${esc(target)}
                    </span>
                  </td>
                  <td class="px-3 py-3 text-center font-semibold text-slate-700">${esc(String(count))}</td>
                  <td class="px-3 py-3 text-slate-600 max-w-[200px] truncate text-xs" title="${esc(log.message || '')}">${esc(msg)}</td>
                  <td class="px-3 py-3">
                    ${ok
                      ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700"><i class="fas fa-check-circle"></i> Sent</span>'
                      : '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700"><i class="fas fa-times-circle"></i> Failed</span>'}
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    console.error('SMS logs error:', err);
    container.innerHTML = `<div class="text-center py-8 text-red-400"><i class="fas fa-exclamation-circle text-2xl mb-2 block"></i><p class="text-sm">Failed to load logs: ${esc(err.message)}</p></div>`;
  }
}

function _smsTargetLabel(type) {
  return { all: 'All Users', network: 'By Network', activity: 'By Activity', balance: 'By Balance', manual: 'Manual' }[type] || type || '—';
}
function _smsTargetBadgeClass(type) {
  return {
    all:      'bg-brand-100 text-brand-700',
    network:  'bg-purple-100 text-purple-700',
    activity: 'bg-green-100 text-green-700',
    balance:  'bg-amber-100 text-amber-700',
    manual:   'bg-slate-100 text-slate-600',
  }[type] || 'bg-slate-100 text-slate-600';
}

// ─── Show Toast (kept here for SMS script; main app may have its own) ──────
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  const colors = {
    success: 'bg-green-50 text-green-800 border-green-200',
    error:   'bg-red-50 text-red-800 border-red-200',
    info:    'bg-blue-50 text-blue-800 border-blue-200',
    warning: 'bg-yellow-50 text-yellow-800 border-yellow-200'
  };
  toast.className = `toast ${colors[type] || colors.info} border rounded-lg p-4 shadow-lg`;
  toast.innerHTML = `
    <div class="flex items-center gap-3">
      <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
      <span class="font-medium">${esc(message)}</span>
    </div>`;
  const container = document.getElementById('toast-container');
  if (!container) { alert(message); return; }
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ─── Wire up all SMS page event listeners ─────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {

  // Form submit
  const smsForm = document.getElementById('sms-form');
  if (smsForm) smsForm.addEventListener('submit', handleSMSFormSubmit);

  // Message character counter + preview
  const smsMessage = document.getElementById('sms-message');
  if (smsMessage) smsMessage.addEventListener('input', updateSMSPreview);

  // Manual phones counter
  const multiplePhones = document.getElementById('multiple-phones');
  if (multiplePhones) multiplePhones.addEventListener('input', updatePhoneCount);

  // Target audience radio buttons
  document.querySelectorAll('input[name="sms-target"]').forEach(radio => {
    radio.addEventListener('change', updateSMSTargetUI);
  });

  // Network sub-option change → re-preview
  document.querySelectorAll('input[name="sms-network"], input[name="sms-activity-days"]').forEach(r => {
    r.addEventListener('change', () => {
      const target = document.querySelector('input[name="sms-target"]:checked')?.value;
      if (target !== 'manual') previewSMSRecipients();
    });
  });

  // Balance range inputs → re-preview on blur
  ['sms-balance-min', 'sms-balance-max'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', previewSMSRecipients);
  });

  // Initial UI state — defer the auto-preview until BOTH:
  //   a) adminFetch is ready (module script loaded)
  //   b) admin session is established (_adminSessionReady flag)
  // Without waiting for the session, the SMS preview fires before login
  // completes and hits a 401 — harmless but noisy in the console.
  function deferredUpdateSMSTargetUI() {
    if (window._adminFetchReady && window._adminSessionReady) {
      updateSMSTargetUI();
    } else {
      setTimeout(deferredUpdateSMSTargetUI, 200);
    }
  }
  deferredUpdateSMSTargetUI();
});