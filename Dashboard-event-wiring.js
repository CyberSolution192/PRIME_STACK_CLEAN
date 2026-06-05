// dashboard-event-wiring.js
// CSP-safe event wiring — loaded from external file, covered by 'self'.

document.addEventListener('DOMContentLoaded', function () {

  function on(id, evt, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  }
  function onAll(sel, evt, fn) {
    document.querySelectorAll(sel).forEach(function(el) { el.addEventListener(evt, fn); });
  }

  // ── PIN buttons ────────────────────────────────────────────────────────────
  on('setPinBtn',        'click', function() { submitSetPin(); });
  on('changePinBtn',     'click', function() { submitChangePin(); });
  on('closePinModalBtn', 'click', function() { closePinModal(); });
  on('pinBackspaceBtn',  'click', function() { pinBackspace(); });
  on('pinVerifySubmit',  'click', function() { submitPinVerify(); });

  // ── PIN setup banner ───────────────────────────────────────────────────────
  on('pinBannerSetupBtn', 'click', function() {
    navigateTo('settings');
    var b = document.getElementById('pinSetupBanner');
    if (b) b.classList.add('hidden');
  });
  on('pinBannerDismissBtn', 'click', function() {
    var b = document.getElementById('pinSetupBanner');
    if (b) b.classList.add('hidden');
  });

  // ── Store navigation ───────────────────────────────────────────────────────
  on('storeNavBtn',  'click', function() { navigateTo('store'); });
  on('storeMenuBtn', 'click', function() { openStoreDrawer(); });

  // ── Store stats panel ──────────────────────────────────────────────────────
  on('withdrawProfitsBtn',    'click', function() { withdrawProfits(); });
  on('openStoreBtn',          'click', function() { window._openMyStore && window._openMyStore(); });
  on('copyStoreTrackLinkBtn', 'click', function() { copyStoreTrackLink(); });

  // ── Bundle network filter ──────────────────────────────────────────────────
  onAll('[data-pricing-network]', 'click', function() { selectPricingNetwork(this.dataset.pricingNetwork); });

  // ── Store orders ───────────────────────────────────────────────────────────
  on('orderStatusFilter',     'change', function() { filterStoreOrders(); });
  on('refreshStoreOrdersBtn', 'click',  function() { loadStoreOrders(true); });
  on('storeOrdersPrevBtn',    'click',  function() { changeStoreOrdersPage(-1); });
  on('storeOrdersNextBtn',    'click',  function() { changeStoreOrdersPage(1); });

  // ── Store customization ────────────────────────────────────────────────────
  onAll('[data-action="preset-color"]', 'click', function() { selectPresetColor(this); });
  on('customColorInput',     'input', function() { selectCustomColor(this.value); });
  on('saveStoreSettingsBtn', 'click', function() { saveStoreSettings(); });

  // ── Orders portal ──────────────────────────────────────────────────────────
  on('loadStoreOrdersPortalBtn', 'click', function() { loadStoreOrdersPortal(); });
  on('portalSearchInput', 'keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); doPortalSearch(); }
  });
  on('doPortalSearchBtn',  'click',  function() { doPortalSearch(); });
  on('portalClearBtn',     'click',  function() { clearPortalFilters(); });
  onAll('.status-pill[data-status]', 'click', function() { setPortalStatus(this); });
  on('portalNetworkFilter', 'change', function() { filterPortalOrders(); });
  on('portalPrevBtn', 'click', function() { changePortalPage(-1); });
  on('portalNextBtn', 'click', function() { changePortalPage(1); });

  // ── Order detail modal ─────────────────────────────────────────────────────
  on('orderDetailBackdrop', 'click', function() { closeOrderDetailModal(); });
  on('closeOrderDetailBtn', 'click', function() { closeOrderDetailModal(); });

  // ── WhatsApp FAB ───────────────────────────────────────────────────────────
  on('waFabToggle', 'click', function() { toggleWaFab(); });

  // ── Withdrawal modal ───────────────────────────────────────────────────────
  on('withdrawMaxBtn', 'click', function() {
    var inp = document.getElementById('withdrawAmount');
    if (inp) inp.value = inp.dataset.max;
  });
  onAll('[data-net]', 'click', function() { selectWithdrawNetwork(this); });
  on('submitWithdrawal', 'click', function() { submitWithdrawalRequest(); });

  // ── Store sidebar nav ──────────────────────────────────────────────────────
  on('sidebarBtn-mystore',           'click', function() { switchStoreTab('mystore'); });
  on('sidebarBtn-bundleprices',      'click', function() { switchStoreTab('bundleprices'); });
  on('sidebarBtn-recentorders',      'click', function() { switchStoreTab('recentorders'); });
  on('sidebarBtn-withdrawalhistory', 'click', function() { switchStoreTab('withdrawalhistory'); });
  on('sidebarWithdrawBtn',           'click', function() { withdrawProfits(); });
  on('sidebarBtn-customization',     'click', function() { switchStoreTab('customization'); });

  // ── Exit store buttons ─────────────────────────────────────────────────────
  on('exitStoreBtn1', 'click', function() { exitStore(); });
  on('exitStoreBtn2', 'click', function() { exitStore(); });

  // ── Unlock store overlay ───────────────────────────────────────────────────
  on('overlayUnlockStoreBtn', 'click', function() { unlockStore(); });

  // ── Store drawer ───────────────────────────────────────────────────────────
  on('storeDrawerBackdrop', 'click', function() { closeStoreDrawer(); });
  on('closeStoreDrawerBtn', 'click', function() { closeStoreDrawer(); });
  on('openStoreDrawerBtn2', 'click', function() { openStoreDrawer(); });

  onAll('[data-drawer-tab]', 'click', function() {
    closeStoreDrawer();
    switchStoreTab(this.dataset.drawerTab);
  });

  on('drawerWithdrawBtn', 'click', function() {
    closeStoreDrawer();
    withdrawProfits();
  });

  // ── Hover effects ──────────────────────────────────────────────────────────
  onAll('[data-drawer-tab]', 'mouseover', function() {
    this.style.background = 'rgba(255,255,255,0.08)';
    this.style.color = '#fff';
  });
  onAll('[data-drawer-tab]', 'mouseout', function() {
    if (this.id !== 'drawerBtn-mystore') {
      this.style.background = 'transparent';
      this.style.color = '#94a3b8';
    }
  });
  on('drawerWithdrawBtn', 'mouseover', function() {
    this.style.background = 'rgba(255,255,255,0.08)';
    this.style.color = '#fff';
  });
  on('drawerWithdrawBtn', 'mouseout', function() {
    this.style.background = 'transparent';
    this.style.color = '#94a3b8';
  });
  on('openStoreBtn', 'mouseover', function() { this.style.background = '#dcfce7'; });
  on('openStoreBtn', 'mouseout',  function() { this.style.background = '#f0fdf4'; });
  on('exitStoreBtn1', 'mouseover', function() { this.style.background = '#991b1b'; });
  on('exitStoreBtn1', 'mouseout',  function() { this.style.background = '#7f1d1d'; });

});