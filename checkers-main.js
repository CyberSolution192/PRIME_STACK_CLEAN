/* ============================================================
 * checkers-main.js — Results Checkers page (BECE/WASSCE/SHS Placement)
 * ============================================================
 * Loaded alongside dashboard-main.js as a separate ES module. Talks to
 * the backend exclusively through userFetch() -> user-proxy -> the
 * get-checker-catalog / buy-checker / checker-order-status Edge
 * Functions, same zero-credential architecture as the rest of the
 * dashboard (browser never holds a JWT, only the HttpOnly session
 * cookie).
 *
 * Exposes window.loadCheckersPage() which dashboard-main.js calls from
 * its page switcher — see the 'checkers' case in navigateTo().
 * ============================================================ */

import { userFetch } from './supabase-config.js';

// Falls back to a plain alert if showToast isn't ready yet for any reason.
function notify(message, type = 'info') {
  if (typeof window.showToast === 'function') window.showToast(message, type);
  else alert(message);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

const state = {
  catalog: [],
  selected: null, // the currently selected product object
};

// ── Page entry point (called by dashboard-main.js's navigateTo) ────────────
async function loadCheckersPage() {
  await Promise.all([
    loadBalance(),
    loadCatalog(),
    loadOrderHistory(),
  ]);
}
window.loadCheckersPage = loadCheckersPage;

// ── Balance ──────────────────────────────────────────────────────────────
async function loadBalance() {
  try {
    const res = await userFetch('get-user-data', {}, 'section=profile');
    const json = await res.json();
    const balance = json?.success ? json.balance : 0;
    const el = document.getElementById('checkersPageBalance');
    if (el) el.textContent = `GH₵ ${parseFloat(balance || 0).toFixed(2)}`;
  } catch (err) {
    console.error('[checkers] balance load failed:', err);
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────
async function loadCatalog() {
  const container = document.getElementById('checkerTypeSelection');
  if (!container) return;

  try {
    const res = await userFetch('get-checker-catalog');
    const json = await res.json();

    if (!json.status || !Array.isArray(json.checkers)) {
      container.innerHTML = `<div class="col-span-full text-center py-8 text-gray-400 text-sm">Checkers are unavailable right now — please try again shortly.</div>`;
      return;
    }

    state.catalog = json.checkers;

    if (state.catalog.length === 0) {
      container.innerHTML = `<div class="col-span-full text-center py-8 text-gray-400 text-sm">No checker types are available yet.</div>`;
      return;
    }

    const icons = { bece: 'fa-book', wassce: 'fa-graduation-cap', shs_placement: 'fa-school' };

    container.innerHTML = state.catalog.map((p) => `
      <button data-code="${esc(p.code)}" class="checker-type-btn card p-4 text-left hover:border-brand-500 transition-colors">
        <div class="flex items-center gap-3 mb-2">
          <div class="w-12 h-12 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center text-lg">
            <i class="fas ${icons[p.code] || 'fa-file-alt'}"></i>
          </div>
          <div>
            <h4 class="font-bold text-gray-800">${esc(p.name)}</h4>
            <p class="text-xs text-gray-500">GH₵ ${parseFloat(p.price).toFixed(2)}</p>
          </div>
        </div>
        <div class="text-xs text-gray-500">${esc(p.description || '')}</div>
      </button>
    `).join('');

    container.querySelectorAll('.checker-type-btn').forEach((btn) => {
      btn.addEventListener('click', () => selectCheckerType(btn.dataset.code));
    });
  } catch (err) {
    console.error('[checkers] catalog load failed:', err);
    container.innerHTML = `<div class="col-span-full text-center py-8 text-gray-400 text-sm">Failed to load checker types.</div>`;
  }
}

function selectCheckerType(code) {
  const product = state.catalog.find((p) => p.code === code);
  if (!product) return;
  state.selected = product;

  document.querySelectorAll('.checker-type-btn').forEach((btn) => {
    btn.classList.toggle('border-brand-500', btn.dataset.code === code);
  });

  const form = document.getElementById('checkerPurchaseForm');
  document.getElementById('checkerFormTitle').textContent = `Buy ${product.name}`;
  document.getElementById('checkerFormPrice').textContent = `GH₵ ${parseFloat(product.price).toFixed(2)} per checker`;

  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Purchase ─────────────────────────────────────────────────────────────
async function buyChecker() {
  const product = state.selected;
  if (!product) return;

  const confirmed = confirm(`Buy this checker for GH₵ ${parseFloat(product.price).toFixed(2)}?`);
  if (!confirmed) return;

  const btn = document.getElementById('checkerBuyBtn');
  const btnText = document.getElementById('checkerBuyBtnText');
  btn.disabled = true;
  const originalText = btnText.textContent;
  btnText.textContent = 'Processing…';

  try {
    const res = await userFetch('buy-checker', { code: product.code });
    const json = await res.json();

    if (!json.status) {
      notify(json.message || 'Purchase failed', 'error');
      return;
    }

    if (json.manual_processing) {
      notify(json.message || 'Order queued for processing — check back shortly.', 'info');
    } else {
      showResultModal(json);
      notify('Checker purchased successfully!', 'success');
    }

    await Promise.all([loadBalance(), loadOrderHistory()]);
  } catch (err) {
    console.error('[checkers] buy failed:', err);
    notify('Something went wrong. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btnText.textContent = originalText;
  }
}

// ── Credentials reveal modal ────────────────────────────────────────────
function showResultModal(data) {
  document.getElementById('checkerResultTitle').textContent = `${data.product || 'Checker'} Purchased`;
  document.getElementById('checkerResultSerial').textContent = data.serial_number || '—';
  document.getElementById('checkerResultPin').textContent = data.pin || '—';

  const examRow = document.getElementById('checkerResultExamDateRow');
  if (data.exam_date) {
    document.getElementById('checkerResultExamDate').textContent = data.exam_date;
    examRow.classList.remove('hidden');
  } else {
    examRow.classList.add('hidden');
  }

  const link = document.getElementById('checkerResultCheckLink');
  if (data.results_link) {
    link.href = data.results_link;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }

  document.getElementById('checkerResultModal').classList.remove('hidden');
  document.getElementById('checkerResultModal').classList.add('flex');
}

function closeResultModal() {
  const modal = document.getElementById('checkerResultModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function copyResultCredentials() {
  const serial = document.getElementById('checkerResultSerial').textContent;
  const pin = document.getElementById('checkerResultPin').textContent;
  const text = `Serial: ${serial}\nPIN: ${pin}`;
  navigator.clipboard?.writeText(text).then(
    () => notify('Copied to clipboard', 'success'),
    () => notify('Could not copy — please copy manually', 'warning')
  );
}

// ── Order history ("My Purchased Checkers") ────────────────────────────
function statusMeta(status) {
  const map = {
    completed:     { icon: 'fa-circle-check', color: 'text-green-600', label: 'Purchased' },
    pending:       { icon: 'fa-clock', color: 'text-yellow-600', label: 'Processing' },
    manual_review: { icon: 'fa-hourglass-half', color: 'text-blue-600', label: 'Under Review' },
    failed:        { icon: 'fa-circle-xmark', color: 'text-red-600', label: 'Failed' },
    refunded:      { icon: 'fa-rotate-left', color: 'text-gray-500', label: 'Refunded' },
  };
  return map[status] || map.pending;
}

async function loadOrderHistory() {
  const container = document.getElementById('checkerOrdersContainer');
  if (!container) return;

  try {
    const res = await userFetch('checker-order-status', {}, 'pageSize=50');
    const json = await res.json();

    if (!json.status || !Array.isArray(json.orders) || json.orders.length === 0) {
      container.innerHTML = `<div class="text-center py-8 text-gray-400 text-sm">No checker orders yet.</div>`;
      return;
    }

    container.innerHTML = json.orders.map(renderCheckerCard).join('');

    container.querySelectorAll('.checker-copy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigator.clipboard?.writeText(btn.dataset.value || '').then(
          () => notify('Copied', 'success'),
          () => notify('Could not copy', 'warning')
        );
      });
    });
  } catch (err) {
    console.error('[checkers] history load failed:', err);
    container.innerHTML = `<div class="text-center py-8 text-gray-400 text-sm">Failed to load order history.</div>`;
  }
}

function renderCheckerCard(o) {
  const meta = statusMeta(o.status);
  const slotId = o.details?.slot_id;
  const label = slotId ? `Checker #${esc(slotId)}` : esc(o.order_reference);
  const examDate = o.details?.exam_date;
  const resultsLink = o.details?.results_link || o.checker_products?.official_check_url;
  const dateStr = new Date(o.created_at).toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).replace(',', ',');

  const hasCredentials = o.status === 'completed' && o.serial_number && o.pin;

  return `
    <div class="border border-gray-100 rounded-xl p-4 mb-3">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div class="flex items-center gap-2">
          <i class="fas ${meta.icon} ${meta.color}"></i>
          <span class="font-semibold text-gray-800 text-sm">${label} · ${meta.label}</span>
          <span class="text-xs px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 font-medium">${esc(o.checker_products?.code?.toUpperCase() || '')}</span>
        </div>
        <div class="text-xs text-gray-400">${dateStr} · GH₵ ${parseFloat(o.amount).toFixed(2)}</div>
      </div>

      ${hasCredentials ? `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <div class="bg-gray-50 rounded-lg p-3 flex items-center justify-between">
            <div>
              <p class="text-[10px] uppercase text-gray-400 font-medium mb-0.5">Serial</p>
              <p class="font-mono font-bold text-sm text-gray-800 select-all">${esc(o.serial_number)}</p>
            </div>
            <button class="checker-copy-btn text-gray-400 hover:text-brand-600 p-1" data-value="${esc(o.serial_number)}" title="Copy">
              <i class="fas fa-copy"></i>
            </button>
          </div>
          <div class="bg-gray-50 rounded-lg p-3 flex items-center justify-between">
            <div>
              <p class="text-[10px] uppercase text-gray-400 font-medium mb-0.5">PIN</p>
              <p class="font-mono font-bold text-sm text-gray-800 select-all">${esc(o.pin)}</p>
            </div>
            <button class="checker-copy-btn text-gray-400 hover:text-brand-600 p-1" data-value="${esc(o.pin)}" title="Copy">
              <i class="fas fa-copy"></i>
            </button>
          </div>
        </div>
        <div class="flex items-center justify-between text-xs">
          <span class="text-gray-400"><i class="far fa-calendar mr-1"></i>${examDate ? esc(examDate) : 'Date not specified'}</span>
          ${resultsLink ? `<a href="${esc(resultsLink)}" target="_blank" rel="noopener" class="text-brand-600 hover:text-brand-700 font-medium">Check results <i class="fas fa-arrow-up-right-from-square text-[10px]"></i></a>` : ''}
        </div>
      ` : `
        <p class="text-xs text-gray-400">
          ${o.status === 'manual_review' ? 'Your order is being processed — credentials will appear here shortly.' : ''}
          ${o.status === 'pending' ? 'Payment processing…' : ''}
          ${o.status === 'failed' ? 'This purchase failed — you were not charged.' : ''}
          ${o.status === 'refunded' ? 'This purchase was refunded to your wallet.' : ''}
        </p>
      `}
    </div>
  `;
}

// ── Wire static event listeners once at module load ─────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('checkerBuyBtn')?.addEventListener('click', buyChecker);
  document.getElementById('checkerHistoryRefreshBtn')?.addEventListener('click', loadOrderHistory);
  document.getElementById('checkerResultCloseBtn')?.addEventListener('click', closeResultModal);
  document.getElementById('checkerResultCopyBtn')?.addEventListener('click', copyResultCredentials);
});