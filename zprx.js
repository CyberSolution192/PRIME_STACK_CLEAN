/* ============================================================
 * admin.js — Prime Connect Admin Portal (ES Module)
 * ============================================================ */

  import {
    supabase,
    adminFetch,
    adminLogin,
    adminVerifyOTP,
    adminLogout,
    tryRestoreSession,
    SUPABASE_PROJECT_URL,
    SUPABASE_ANON,
  } from './ac-9ae690d2f5e8.js';
  window._supabaseProjectUrl = SUPABASE_PROJECT_URL;
  window._supabaseAnon = SUPABASE_ANON;

  // Every fetch call is rewritten to use adminFetch() below.
  // This shim exists only so any overlooked call fails loudly rather than silently.
  window._getAdminToken = async function() {
    console.warn('[v4] _getAdminToken() called — this should not happen. All requests must use adminFetch().');
    if (_adminReady) {
      _adminReady = false;
      if (typeof window.showAdminLoginForm === 'function') window.showAdminLoginForm();
    }
    return null;
  };

  // script.js polls this flag before making its first proxied request.
  window._adminFetchReady = true;

  // Expose _adminFetch on window so non-module inline scripts (e.g. SMS panel
  // in zprx.html) can use it without managing headers or session IDs manually.
  // This is safe — _adminFetch already handles credentials, apikey, and the
  // x-session-id fallback via adminFetch() from ac-9ae690d2f5e8.js.
  window._adminFetch = _adminFetch;

  // has expired, we drop back to the login form immediately.
  async function _adminFetch(targetFunction, body) {
    const res = await adminFetch(targetFunction, body);
    if (res.status === 401) {
      let data = {};
      try { data = await res.clone().json(); } catch {}
      if (data.requiresLogin) {
        console.warn('[admin] Session expired — showing login form');
        _adminReady = false;
        if (typeof window.showAdminLoginForm === 'function') window.showAdminLoginForm();
      }
    }
    return res;
  }

  
  window.esc = function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };
  // Local alias so module-internal callers are unchanged.
  const esc = window.esc;

  // ── Session guard ─────────────────────────────────────────────────────────
  let _adminReady = false;

  try {
    // Define admin namespace
    const admin = (function () {
      // Initialize Supabase
      const supabaseClient = supabase;

    // Application State
    const state = {
      user: null,
      profile: null,
      allOrders: [],
      guestOrders: [],
      storeSales: [],
      userOrders: [],
      filteredOrders: [],
      pendingDeposits: [],
      users: [],
      bundles: [],
      ordersPage: 1,
      guestOrdersPage: 1,
      storeSalesPage: 1,
      userOrdersPage: 1,
      usersPage: 1,
      pageSize: 15,
      currentOrderId: null,
      currentOrderType: null,
      currentUserId: null,
      currentUserBalance: 0,
      currentAction: null,
      currentBundleId: null,
      isEditingBundle: false,
      stats: {
        totalRevenue: 0,
        totalUsers: 0,
        totalOrders: 0,
        guestOrders: 0,
        pendingOrders: 0,
        completedOrders: 0
      }
    };

    // DOM Elements
    const elements = {
      loadingOverlay: document.getElementById('loading-overlay'),
      toastContainer: document.getElementById('toast-container')
    };

    // Utility Functions
    function showToast(message, type = 'success') {
      const toast = document.createElement('div');
      const colors = {
        success: 'bg-green-50 text-green-800 border-green-200',
        error: 'bg-red-50 text-red-800 border-red-200',
        info: 'bg-blue-50 text-blue-800 border-blue-200',
        warning: 'bg-yellow-50 text-yellow-800 border-yellow-200'
      };

      toast.className = `toast ${colors[type]} border rounded-lg p-4 shadow-lg`;
      toast.innerHTML = `
        <div class="flex items-center">
          <i class="fas fa-${
            type === 'success'
              ? 'check-circle'
              : type === 'error'
              ? 'exclamation-circle'
              : 'info-circle'
          } mr-3"></i>
<span class="font-medium">${esc(message)}</span>
        </div>
      `;

      elements.toastContainer.appendChild(toast);
      setTimeout(() => toast.classList.add('show'), 10);
      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }

    function formatCurrency(amount) {
      return `GH₵ ${parseFloat(amount || 0).toFixed(2)}`;
    }

    function formatPhone(phone) {
      return (phone || '').replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
    }

    function formatDate(dateString) {
      if (!dateString) return '';
      const date = new Date(dateString);
      return (
        date.toLocaleDateString() +
        ' ' +
        date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      );
    }

    function updateLastUpdated(elementId) {
      const element = document.getElementById(elementId);
      if (element) {
        element.textContent = `Last updated: ${new Date().toLocaleTimeString(
          [],
          { hour: '2-digit', minute: '2-digit' }
        )}`;
      }
    }

    // Navigation
    function navigateTo(page) {
      // Stop analytics auto-refresh whenever admin leaves the analytics page
      stopAnalyticsAutoRefresh();
      if (_adminReady) loadOrderStats(); 
      
      // Scroll the main content area back to top so page content is immediately visible
      const contentArea = document.querySelector('.flex-1.overflow-y-auto');
      if (contentArea) contentArea.scrollTop = 0;

      // Hide all pages
      document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));

      // Show selected page
      const pageEl = document.getElementById(`${page}-page`);
      if (pageEl) pageEl.classList.remove('hidden');

      // Update page titles
      const titles = {
        dashboard: 'Admin Dashboard',
        'all-orders': 'All Orders',
        'guest-orders': 'Guest Orders',
        'user-orders': 'User Orders',
        'pending-deposits': 'Pending Deposits',
        users: 'User Management',
        settings: 'System Settings',
        'send-sms': 'Send SMS',
        'store-sales': 'Store Sales',
        'user-profits': 'User Profits',
        withdrawals: 'Withdrawals',
       bundles: 'Bundle Management',
        'custom-pricing': 'Custom Pricing',
        analytics: 'Sales Analytics',
        'api-keys': 'API Keys',
        'api-orders': 'API Orders',
        'security-logs': 'System Logs',
      };
      const mobileTitle = document.getElementById('mobile-page-title');
      const desktopTitle = document.getElementById('desktop-page-title');
      if (mobileTitle) mobileTitle.textContent = titles[page] || '';
      if (desktopTitle) desktopTitle.textContent = titles[page] || '';

      // Update active navigation
      document.querySelectorAll('.admin-nav-btn').forEach((btn) => {
        btn.classList.remove('admin-nav-active');
        if (btn.dataset.page === page) {
          btn.classList.add('admin-nav-active');
        }
      });

      // Load page-specific data
      switch (page) {
    case 'dashboard':
        loadDashboardData();
        break;
    case 'all-orders':
        loadAllOrders();
        break;
    case 'guest-orders':
        loadGuestOrders();
        break;
    case 'pending-deposits':
        loadPendingDeposits();
        break;
    case 'users':
        loadUsers();
        break;
    case 'bundles':
        loadBundles();
        break;
    case 'send-sms':
        checkSMSBalance();
        break;
    
    // NEW PAGES
  case 'store-sales':
        loadStoreSales();
        loadOrderStats();
        break;
    case 'user-orders':
        loadUserOrders();
        break;
    case 'user-profits':
        loadUserProfits();
        break;
    case 'withdrawals':
        loadWithdrawals();
        break;
    case 'manage-stores':
        loadManageStores();
        break;
    
   case 'custom-pricing':
        loadCustomPricing();
        break;
    case 'settings':
        loadSettings();
        loadProviderSettings();
        loadSiteLock();
        break;
    case 'analytics':
        loadAnalytics();
        startAnalyticsAutoRefresh();
        break;
    case 'api-keys':
        loadApiKeysPage();
        break;
    case 'api-orders':
        loadApiOrdersPage();
        break;
    case 'security-logs':
        loadSecurityLogs();
        break;
}
    }
    // Dashboard Functions
    async function loadDashboardData() {
      try {
        await Promise.all([
          loadRevenueStats(),
          loadUserStats(),
          loadOrderStats(),
          loadRecentOrders()
        ]);
        updateLastUpdated('stats-last-updated');
      } catch (error) {
        console.error('Error loading dashboard data:', error);
        showToast('Failed to load dashboard data', 'error');
      }
    }

   async function loadRevenueStats() { /* merged into loadOrderStats via edge fn */ }
   async function loadUserStats()    { /* merged into loadOrderStats via edge fn */ }

   async function loadOrderStats() {
      try {
        const res = await _adminFetch('admin-manage-orders', { action: 'get-dashboard-stats' });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);

        const { revenue, orders, users, manualPending } = result;

        // Revenue
        const totalEl = document.getElementById('total-revenue');
        const todayEl = document.getElementById('today-revenue');
        if (totalEl) totalEl.textContent = formatCurrency(revenue.total);
        if (todayEl) todayEl.textContent = formatCurrency(revenue.today);
        state.stats.totalRevenue = revenue.total;

        // Order counts
        const totalOrdersEl    = document.getElementById('total-orders');
        const guestOrdersEl    = document.getElementById('guest-orders');
        const completedEl      = document.getElementById('completed-orders');
        const pendingEl        = document.getElementById('pending-orders');
        const storeSalesStatEl = document.getElementById('store-sales-stat');
        const storeSalesBadge  = document.getElementById('store-sales-count');
        const userOrdersStatEl = document.getElementById('user-orders-stat');
        const userOrdersBadge  = document.getElementById('user-orders-count');
        const guestOrdersBadge = document.getElementById('guest-orders-count');
        if (totalOrdersEl)    totalOrdersEl.textContent    = orders.total;
        if (guestOrdersEl)    guestOrdersEl.textContent    = orders.guest;
        if (completedEl)      completedEl.textContent      = orders.completed;
        if (pendingEl)        pendingEl.textContent        = orders.pending;
        if (storeSalesStatEl) storeSalesStatEl.textContent = orders.store;
        if (userOrdersStatEl) userOrdersStatEl.textContent = orders.user ?? 0;
        if (storeSalesBadge) {
          if (orders.pendingStore > 0) {
            storeSalesBadge.textContent = orders.pendingStore;
            storeSalesBadge.classList.remove('hidden');
          } else { storeSalesBadge.classList.add('hidden'); }
        }
        if (userOrdersBadge) {
          if ((orders.pendingUser ?? 0) > 0) {
            userOrdersBadge.textContent = orders.pendingUser;
            userOrdersBadge.classList.remove('hidden');
          } else { userOrdersBadge.classList.add('hidden'); }
        }
        if (guestOrdersBadge) {
          if ((orders.pendingGuest ?? 0) > 0) {
            guestOrdersBadge.textContent = orders.pendingGuest;
            guestOrdersBadge.classList.remove('hidden');
          } else { guestOrdersBadge.classList.add('hidden'); }
        }

        // User counts
        const totalUsersEl = document.getElementById('total-users');
        const activeEl = document.getElementById('orders-today');
        if (totalUsersEl) totalUsersEl.textContent = users.total;
        if (activeEl)     activeEl.textContent     = orders.today;
        state.stats.totalUsers  = users.total;
        state.stats.totalOrders = orders.total;
        state.stats.guestOrders = orders.guest;
        state.stats.storeSales  = orders.store;
        state.stats.completedOrders = orders.completed;
        state.stats.pendingOrders   = orders.pending;

        // Manual pending warning banner
        {
          const warningBanner = document.getElementById('sparkdata-warning');
          const countEl       = document.getElementById('sparkdata-pending-count');
          const listEl        = document.getElementById('sparkdata-pending-list');

          if (manualPending && manualPending.length > 0) {
            if (warningBanner) warningBanner.classList.remove('hidden');
            if (countEl) countEl.textContent = manualPending.length;
            if (listEl) listEl.innerHTML = manualPending.map(o => `
              <div class="bg-white border border-red-100 rounded-lg px-3 py-2 flex justify-between items-center">
                <div>
                  <span class="font-mono text-xs text-red-700">${esc(o.order_reference)}</span>
                  <span class="text-red-600 ml-2">${esc((o.network||'').toUpperCase())} ${esc(String(o.package_size))}GB → ${esc(o.recipient)}</span>
                </div>
                <span class="font-bold text-red-800">GH₵${parseFloat(o.amount).toFixed(2)}</span>
              </div>
            `).join('');
          } else {
            if (warningBanner) warningBanner.classList.add('hidden');
          }
        }
      } catch (error) {
        console.error('Error loading dashboard stats:', error);
      }
    }
    function updateNotificationBadges(pendingOrders, guestOrders) {
      const pendingBadge = document.getElementById('pending-orders-count');
      const guestBadge = document.getElementById('guest-orders-count');

      if (pendingBadge) {
        if (pendingOrders > 0) {
          pendingBadge.textContent = pendingOrders;
          pendingBadge.classList.remove('hidden');
        } else {
          pendingBadge.classList.add('hidden');
        }
      }

      if (guestBadge) {
        if (guestOrders > 0) {
          guestBadge.textContent = guestOrders;
          guestBadge.classList.remove('hidden');
        } else {
          guestBadge.classList.add('hidden');
        }
      }
    }

   async function loadRecentOrders() {
      try {
        const res = await _adminFetch('admin-manage-orders', { action: 'list', pageSize: 10, page: 1 });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);
        const transactions = result.orders || [];

        const tbody = document.getElementById('recent-orders-body');
        if (!tbody) return;

        if (!transactions || transactions.length === 0) {
          tbody.innerHTML = `
            <tr>
              <td colspan="4" class="px-5 py-8 text-center text-slate-400">
                <i class="fas fa-shopping-cart text-2xl mb-2 opacity-30"></i>
                <p>No recent orders</p>
              </td>
            </tr>
          `;
          return;
        }

        tbody.innerHTML = transactions
          .map((tx) => {
            const statusClass = `status-${tx.status
              .toLowerCase()
              .replace(/\s+/g, '-')}`;
           const customer = esc(tx.users?.fullname || tx.users?.email ||
              (tx.external_response?.storeownerid ? '🏪 Store Sale' : 'Guest'));
            const phone = esc(tx.users?.phone || tx.recipient || 'N/A');
            return `
              <tr>
                <td class="px-5 py-4">
                  <div class="text-sm font-medium text-slate-900">${
                    esc(tx.description || 'Data Bundle')
                  }</div>
                  ${esc(tx.id.substring(0,8)
                  )}...</div>
                </td>
                <td class="px-5 py-4 text-sm text-slate-600 hidden md:table-cell">
                  <div>${customer}</div>
                  <div class="text-xs text-slate-500">${phone}</div>
                </td>
                <td class="px-5 py-4 whitespace-nowrap text-sm font-medium ${
                  tx.amount > 0 ? 'text-green-600' : 'text-slate-800'
                }">
                  ${formatCurrency(Math.abs(tx.amount))}
                </td>
                <td class="px-5 py-4 whitespace-nowrap">
                  <span class="px-2.5 py-1 rounded-full text-xs font-medium ${statusClass}">
                ${(tx.status || 'pending')
                 .replace(/_/g, ' ')
               .replace(/\b\w/g, c => c.toUpperCase())}            
                 </span>
                </td>
              </tr>
            `;
          })
          .join('');
      } catch (error) {
        console.error('Error loading recent orders:', error);
      }
    }

    // All Orders
  async function loadAllOrders() {
      try {
        const res = await _adminFetch('admin-manage-orders', { action: 'list', pageSize: 500, page: 1 });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);
        state.allOrders = result.orders || [];
        applyOrderFilters();
      } catch (error) {
        console.error('Error loading all orders:', error);
        showToast('Failed to load orders', 'error');
      }
    }

    function applyOrderFilters() {
      const searchInput = document.getElementById('orders-search');
      const filterSelect = document.getElementById('orders-filter');
      const searchTerm = (searchInput?.value || '').toLowerCase();
      const statusFilter = filterSelect?.value || 'all';

      let filtered = state.allOrders;

    if (statusFilter !== 'all') {

  if (statusFilter === 'manual_review') {
    filtered = filtered.filter(
      order => order.external_response?.manual_fallback === true
    );
  } else {
    filtered = filtered.filter(
      order => order.status === statusFilter
    );
  }

}
      if (searchTerm) {
        filtered = filtered.filter((order) => {
          const searchable = [
            order.id,
            order.description,
            order.users?.fullname,
            order.users?.email,
            order.users?.phone,
            order.details?.phoneNumber,
            order.details?.network,
            order.status
          ]
            .join(' ')
            .toLowerCase();

          return searchable.includes(searchTerm);
        });
      }

      state.filteredOrders = filtered;
      renderOrders();
    }

    function renderOrders() {
      const tbody = document.getElementById('all-orders-body');
      const startElement = document.getElementById('orders-start');
      const endElement = document.getElementById('orders-end');
      const totalElement = document.getElementById('orders-total');
      const prevBtn = document.getElementById('orders-prev');
      const nextBtn = document.getElementById('orders-next');

      if (!tbody || !startElement || !endElement || !totalElement) return;

      const total = state.filteredOrders.length;
      const start = (state.ordersPage - 1) * state.pageSize;
      const end = Math.min(start + state.pageSize, total);
      const pageData = state.filteredOrders.slice(start, end);

      startElement.textContent = total > 0 ? start + 1 : 0;
      endElement.textContent = end;
      totalElement.textContent = total;
      if (prevBtn) prevBtn.disabled = state.ordersPage <= 1;
      if (nextBtn) nextBtn.disabled = end >= total;

      if (pageData.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7" class="px-5 py-8 text-center text-slate-400">
              <i class="fas fa-search text-2xl mb-2 opacity-30"></i>
              <p>No orders found</p>
              <p class="text-sm text-slate-500 mt-1">Try adjusting your search or filter</p>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = pageData
        .map((order) => {
          const statusClass = `status-${(order.status || 'pending')
            .toLowerCase()
            .replace(/\s+/g, '-')}`;

          return `
            <tr>
              <td class="px-5 py-4">
                <div class="text-sm font-medium text-slate-900">${esc(order.order_reference || order.orderreference || `GST-${order.id.substring(0, 8)}`)}</div>
                <div class="text-xs text-slate-500">${formatDate(
                  order.createdat || order.created_at
                )}</div>
                ${order.external_response?.manual_fallback ? '<span class="text-xs text-orange-500 font-semibold"> Manual</span>' : ''}
              </td>
              <td class="px-5 py-4 text-sm text-slate-600">
                <div class="font-medium">${esc(order.users?.fullname || order.users?.email || (order.external_response?.storeownerid ? '🏪 Store' : 'Guest'))}</div>
                <div class="text-xs text-slate-400">${esc(order.recipient || order.guest_phone || '')}</div>
              </td>
              <td class="px-5 py-4 text-sm text-slate-700">
                <span class="px-2 py-1 rounded text-xs ${
                  (order.network || 'unknown').toLowerCase()
                }-bg text-white">
                  ${esc((order.network || 'UNKNOWN').toUpperCase())}
                </span>
              </td>
              <td class="px-5 py-4 text-sm text-slate-700">${esc(order.description || `${(order.network||'').toUpperCase()} ${order.package_size || ''}GB`)}</td>
              <td class="px-5 py-4 whitespace-nowrap text-sm font-medium text-slate-800">
                ${formatCurrency(order.amount)}
              </td>
              <td class="px-5 py-4 whitespace-nowrap">
               <span class="px-2.5 py-1 rounded-full text-xs font-medium ${statusClass}">
               ${(order.status || 'unknown')
               .replace(/_/g, ' ')
               .replace(/\b\w/g, c => c.toUpperCase())}
               </span>
              </td>
              <td class="px-5 py-4 whitespace-nowrap text-sm font-medium">
                <button class="text-brand-600 hover:text-brand-800 mr-3 view-order-btn"
                        data-order-id="${esc(order.id)}"
                        data-order-type="guest">
                  View
                </button>
              </td>
            </tr>
          `;
        })
        .join('');
    }

    // Guest Orders
async function loadGuestOrders() {
      try {
        const activeFilter = document.querySelector('.filter-tab.active[data-guest-filter]');
        const filterStatus = activeFilter?.dataset.guestFilter || 'all';

        const res = await _adminFetch('admin-manage-orders', {
            action: 'list',
            pageSize: 500,
            page: 1,
            prefixFilter: 'GST',
            ...(filterStatus !== 'all' ? { status: filterStatus } : {}),
          });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);

        // Client-side guard: only GST- rows (defence-in-depth)
        state.guestOrders = (result.orders || []).filter(o =>
          (o.order_reference || '').startsWith('GST-')
        );
        state.guestOrdersPage = 1;
        renderGuestOrders();
      } catch (error) {
        console.error('Error loading guest orders:', error);
        showToast('Failed to load guest orders', 'error');
      }
    }

    function renderGuestOrders() {
      const tbody = document.getElementById('guest-orders-body');
      const startElement = document.getElementById('guest-orders-start');
      const endElement = document.getElementById('guest-orders-end');
      const totalElement = document.getElementById('guest-orders-total');
      const prevBtn = document.getElementById('guest-orders-prev');
      const nextBtn = document.getElementById('guest-orders-next');

      if (!tbody || !startElement || !endElement || !totalElement) return;

      const total = state.guestOrders.length;
      const start = (state.guestOrdersPage - 1) * state.pageSize;
      const end = Math.min(start + state.pageSize, total);
      const pageData = state.guestOrders.slice(start, end);

      startElement.textContent = total > 0 ? start + 1 : 0;
      endElement.textContent = end;
      totalElement.textContent = total;
      if (prevBtn) prevBtn.disabled = state.guestOrdersPage <= 1;
      if (nextBtn) nextBtn.disabled = end >= total;

      if (pageData.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7" class="px-5 py-8 text-center text-slate-400">
              <i class="fas fa-user-clock text-2xl mb-2 opacity-30"></i>
              <p>No guest orders found</p>
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = pageData
        .map((order) => {
          const statusClass = `status-${order.status
            .toLowerCase()
            .replace(/\s+/g, '-')}`;

          return `
            <tr>
              <td class="px-5 py-4">
                <div class="text-sm font-medium text-slate-900">${esc(order.order_reference || `GST-${order.id.substring(0, 8)}`)}</div>
                <div class="text-xs text-slate-500">${formatDate(order.created_at)}</div>
                ${order.external_response?.webhook_recovery ? '<span class="text-xs text-purple-600 font-semibold">Recovery</span>' : ''}
                ${(order.external_response?.webhook_recovery && (order.recipient === 'unknown' || !order.package_size || order.package_size == 0)) ? '<span class="text-xs text-red-600 font-bold ml-1">⚠️ Incomplete</span>' : ''}
              </td>
              <td class="px-5 py-4 text-sm text-slate-700">
                <span class="px-2 py-1 rounded text-xs ${
                  order.network?.toLowerCase() || 'unknown'
                }-bg text-white">
                  ${esc(order.network?.toUpperCase() || 'UNKNOWN')}
                </span>
              </td>
             <td class="px-5 py-4 text-sm text-slate-700">${esc(order.description || ((order.network||'').toUpperCase() + ' ' + (order.package_size||'') + 'GB'))}</td>
              <td class="px-5 py-4 text-sm text-slate-600 hidden md:table-cell">${esc(order.recipient || 'N/A')}</td>
              <td class="px-5 py-4 whitespace-nowrap text-sm font-medium text-slate-800">
                ${formatCurrency(order.amount)}
              </td>
              <td class="px-5 py-4 whitespace-nowrap">
                <span class="px-2.5 py-1 rounded-full text-xs font-medium ${statusClass}">
             ${(order.status || 'pending')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())}                </span>
              </td>
              <td class="px-5 py-4 whitespace-nowrap text-sm font-medium">
                <button class="text-brand-600 hover:text-brand-800 mr-3 view-order-btn"
                        data-order-id="${esc(order.id)}"
                        data-order-type="guest">
                  View
                </button>
              </td>
            </tr>
          `;
        })
        .join('');
    }

    // Pending Deposits
   // ── Deposit tab switcher ──────────────────────────────────────────────────
    window.switchDepositTab = function switchDepositTab(tabName) {
      // Update tab button styles
      document.querySelectorAll('.deposit-tab').forEach(btn => {
        btn.classList.remove('bg-white', 'text-slate-800', 'shadow');
        btn.classList.add('text-slate-600');
      });
      const activeBtn = document.getElementById('dep-tab-' + tabName.replace('-payments','').replace('paystack-history','paystack').replace('direct-purchase','direct').replace('manual-deposits','manual'));
      if (activeBtn) {
        activeBtn.classList.add('bg-white', 'text-slate-800', 'shadow');
        activeBtn.classList.remove('text-slate-600');
      }

      // Show the matching panel, hide the rest
      document.querySelectorAll('.deposit-panel').forEach(p => p.classList.add('hidden'));
      const panel = document.getElementById('dep-panel-' + tabName);
      if (panel) panel.classList.remove('hidden');

      // Lazy-load data for the tab being shown
      if (tabName === 'manual-deposits')    loadManualDeposits();
      if (tabName === 'paystack-history')   loadPaystackHistory();
      if (tabName === 'direct-purchase')    loadDirectPurchasePayments();
      if (tabName === 'orphaned-payments')  admin.loadOrphanedPayments();
    }

    async function loadPendingDeposits() {
      // Only load the currently visible tab (default: manual-deposits)
      const visiblePanel = [...document.querySelectorAll('.deposit-panel')]
        .find(p => !p.classList.contains('hidden'));
      if (!visiblePanel || visiblePanel.id === 'dep-panel-manual-deposits') {
        loadManualDeposits();
      }
      updateLastUpdated('deposits-last-updated');
    }

    // ── Manual Deposits (bank/MoMo — admin must approve) ──────────────────
    async function loadManualDeposits() {
      const container = document.getElementById('manual-deposits-list');
      if (!container) return;
      try {
        const res = await _adminFetch('admin-manage-orders', { action: 'get-manual-deposits' });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);
        const deposits = result.deposits;

        if (!deposits || deposits.length === 0) {
          container.innerHTML = `
            <div class="text-center py-10">
              <i class="fas fa-check-circle text-4xl text-green-300 mb-3"></i>
              <p class="text-slate-600 font-medium">No pending manual deposits</p>
              <p class="text-slate-500 text-sm">All caught up!</p>
            </div>`;
          return;
        }

        // Update both the sidebar nav badge and the in-tab badge
        const sidebarBadge = document.getElementById('pending-deposits-count');
        const tabBadge     = document.getElementById('pending-deposits-count-tab');
        if (deposits.length > 0) {
          if (sidebarBadge) { sidebarBadge.textContent = deposits.length; sidebarBadge.classList.remove('hidden'); }
          if (tabBadge)     { tabBadge.textContent = deposits.length;     tabBadge.classList.remove('hidden'); }
        } else {
          if (sidebarBadge) sidebarBadge.classList.add('hidden');
          if (tabBadge)     tabBadge.classList.add('hidden');
        }

        container.innerHTML = deposits.map(deposit => {
          const user = deposit.users;
          return `
            <div class="card p-4 border-l-4 border-amber-500">
              <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div class="flex-1">
                  <div class="flex items-center gap-3 mb-2">
                    <div class="w-10 h-10 rounded-full bg-brand-100 flex items-center justify-center text-brand-600">
                      <i class="fas fa-user"></i>
                    </div>
                    <div>
                      <h4 class="font-bold text-slate-800">${esc(user?.fullname || user?.email || 'Unknown')}</h4>
                      <p class="text-sm text-slate-500">${esc(user?.phone || 'No phone')}</p>
                    </div>
                  </div>
                  <div class="text-sm text-slate-600 mt-2 space-y-1">
                    <p>Reference: <span class="font-mono">${esc(deposit.reference || 'N/A')}</span></p>
                    <p>Method: <span class="font-medium">${esc(deposit.payment_method || 'Mobile Money')}</span></p>
                    ${deposit.notes ? `<p>Note: <span class="text-slate-500">${esc(deposit.notes)}</span></p>` : ''}
                  </div>
                </div>
                <div class="text-right">
                  <p class="text-2xl font-bold text-slate-800">${formatCurrency(deposit.amount)}</p>
                  <p class="text-sm text-slate-500">${formatDate(deposit.created_at)}</p>
                  <div class="flex gap-2 mt-3 justify-end">
                    <button class="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium approve-manual-deposit-btn"
                            data-deposit-id="${esc(deposit.id)}">
                      <i class="fas fa-check mr-1"></i>Approve
                    </button>
                    <button class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium decline-manual-deposit-btn"
                            data-deposit-id="${esc(deposit.id)}">
                      <i class="fas fa-times mr-1"></i>Decline
                    </button>
                  </div>
                </div>
              </div>
            </div>`;
        }).join('');

      } catch (error) {
        console.error('Error loading manual deposits:', error);
        container.innerHTML = `<p class="text-red-500 text-center py-8">Failed to load: ${esc(error.message)}</p>`;
      }
    }

    // ── Direct Purchase Payments (Guest GST- and Store STORE- orders) ─────
    async function loadDirectPurchasePayments() {
      const container = document.getElementById('direct-purchase-payments-list');
      if (!container) return;
      try {
        const res = await _adminFetch('admin-manage-orders', { action: 'list', prefixFilter: null, pageSize: 100 });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed');
        const orders = (result.orders || []).filter(o =>
          o.order_reference?.startsWith('GST-') ||
          o.order_reference?.startsWith('STORE-') ||
          o.order_reference?.startsWith('PAY-')
        );

        if (!orders || orders.length === 0) {
          container.innerHTML = `
            <div class="text-center py-10">
              <i class="fas fa-receipt text-4xl text-slate-300 mb-3"></i>
              <p class="text-slate-600 font-medium">No direct purchase payments yet</p>
            </div>`;
          return;
        }

        container.innerHTML = orders.map(order => {
          const ext = order.external_response || {};
          const payRef = ext.payment_reference || '—';
          const isStore = order.order_reference?.startsWith('STORE-') || order.order_reference?.startsWith('PAY-');
          const isGuest = order.order_reference?.startsWith('GST-');
          const typeLabel = isStore ? 'Store Purchase' : isGuest ? 'Guest Purchase' : 'Direct Purchase';
          const typeColor = isStore ? 'border-purple-400' : 'border-green-400';
          const badgeColor = isStore ? 'bg-purple-100 text-purple-800' : 'bg-green-100 text-green-800';
          const iconColor = isStore ? 'bg-purple-100 text-purple-600' : 'bg-green-100 text-green-600';
          const effectiveStatus = order.status || 'unknown';
          const displayStatus =
          effectiveStatus === 'manual_review'
          ? 'Requires Attention'
         : effectiveStatus.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const statusColor =
  effectiveStatus === 'completed'
    ? 'bg-green-100 text-green-800'
    : effectiveStatus === 'processing'
    ? 'bg-blue-100 text-blue-800'
    : effectiveStatus === 'manual_review'
    ? 'bg-yellow-100 text-yellow-800'
    : effectiveStatus === 'failed_provider'
    ? 'bg-red-100 text-red-800'
    : effectiveStatus === 'failed'
    ? 'bg-red-100 text-red-800'
    : 'bg-slate-100 text-slate-600';

          return `
            <div class="card p-4 border-l-4 ${typeColor}">
              <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div class="flex-1">
                  <div class="flex items-center gap-3 mb-2">
                    <div class="w-10 h-10 rounded-full ${iconColor} flex items-center justify-center">
                      <i class="fas fa-shopping-cart"></i>
                    </div>
                    <div>
                      <h4 class="font-bold text-slate-800">${esc(order.recipient || '—')}</h4>
                      <span class="text-xs px-2 py-0.5 rounded-full font-medium ${badgeColor}">${typeLabel}</span>
                    </div>
                  </div>
                  <div class="text-sm text-slate-600 mt-2 space-y-1">
                    <p>Order Ref: <span class="font-mono text-xs">${esc(order.order_reference || '—')}</span></p>
                    <p>Pay Ref: <span class="font-mono text-xs">${esc(payRef)}</span></p>
                    <p>Network: <span class="font-medium uppercase">${esc(order.network || '—')}</span> · ${esc(order.package_size || '—')}GB</p>
                  </div>
                </div>
                <div class="text-right">
                  <p class="text-2xl font-bold text-slate-800">${formatCurrency(order.amount)}</p>
                  <p class="text-sm text-slate-500">${formatDate(order.created_at)}</p>
                  <span class="mt-2 inline-block px-3 py-1 rounded-full text-xs font-medium ${statusColor}">
                    ${esc(displayStatus)}
              </span>
                </div>
              </div>
            </div>`;
        }).join('');

      } catch (error) {
        console.error('Error loading direct purchase payments:', error);
        container.innerHTML = `<p class="text-red-500 text-center py-8">Failed to load: ${esc(error.message)}</p>`;
      }
    }


    // ── Paystack History (auto-verified, read-only) ────────────────────────
    async function loadPaystackHistory() {
      const container = document.getElementById('paystack-deposits-list');
      if (!container) return;
      try {
        const res = await _adminFetch('admin-manage-orders', { action: 'get-paystack-history', limit: 50 });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);
        const deposits = result.deposits;

        if (!deposits || deposits.length === 0) {
          container.innerHTML = `
            <div class="text-center py-10">
              <i class="fas fa-receipt text-4xl text-slate-300 mb-3"></i>
              <p class="text-slate-600 font-medium">No Paystack payments yet</p>
            </div>`;
          return;
        }

        container.innerHTML = deposits.map(deposit => {
          const user = deposit.users;
          return `
            <div class="card p-4 border-l-4 border-blue-400">
              <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div class="flex-1">
                  <div class="flex items-center gap-3 mb-2">
                    <div class="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600">
                      <i class="fas fa-credit-card"></i>
                    </div>
                    <div>
                      <h4 class="font-bold text-slate-800">${esc(user?.fullname || user?.email || 'Unknown')}</h4>
                      <p class="text-sm text-slate-500">${esc(user?.phone || 'No phone')}</p>
                    </div>
                  </div>
                  <div class="text-sm text-slate-600 mt-2">
                    <p>Reference: <span class="font-mono text-xs">${esc(deposit.reference || 'N/A')}</span></p>
                    <p>Status: <span class="font-medium">${esc(deposit.status || 'pending')}</span></p>
                  </div>
                </div>
                <div class="text-right">
                  <p class="text-2xl font-bold text-slate-800">${formatCurrency(deposit.amount)}</p>
                  <p class="text-sm text-slate-500">${formatDate(deposit.created_at)}</p>
                  <span class="mt-2 inline-block px-3 py-1 rounded-full text-xs font-medium ${
                    deposit.processed ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                  }">
                    ${deposit.processed ? '✓ Verified' : '⏳ Pending'}
                  </span>
                </div>
              </div>
            </div>`;
        }).join('');

      } catch (error) {
        console.error('Error loading Paystack history:', error);
        container.innerHTML = `<p class="text-red-500 text-center py-8">Failed to load: ${esc(error.message)}</p>`;
      }
    }

    async function approveManualDeposit(depositId) {
      try {
        const res = await _adminFetch('admin-manage-orders', { action: 'approve-manual-deposit', depositId });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Failed');
        showToast(`✅ Approved! ${formatCurrency(data.amount)} credited to user wallet`, 'success');
        loadManualDeposits();
      } catch (err) {
        console.error('Approve error:', err);
        showToast(`Failed: ${err.message}`, 'error');
      }
    }

    async function declineManualDeposit(depositId) {
      const reason = prompt('Reason for declining (optional):') || 'Declined by admin';
      try {
        const res = await _adminFetch('admin-manage-orders', { action: 'decline-manual-deposit', depositId, reason });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Failed');
        showToast('Deposit declined', 'info');
        loadManualDeposits();
      } catch (err) {
        console.error('Decline error:', err);
        showToast(`Failed: ${err.message}`, 'error');
      }
    }
    // Users
 async function loadUsers() {
      try {
        const res = await _adminFetch('admin-manage-users', { action: 'list-full' });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed to load users');

        // result.users has _store and _spend already computed server-side
        state.users = result.users || [];
        state.userTypeFilter = state.userTypeFilter || 'all';
        renderUsers();
      } catch (error) {
        console.error('Error loading users:', error);
        showToast('Failed to load users', 'error');
      }
    }

   function renderUsers() {
      const tbody    = document.getElementById('users-body');
      const cards    = document.getElementById('users-cards');
      const searchInput = document.getElementById('user-search');
      if (!tbody && !cards) return;

      // Render top spenders (top 5 by total spend, with at least 1 order)
      const topSpendersBar  = document.getElementById('top-spenders-bar');
      const topSpendersList = document.getElementById('top-spenders-list');
      if (topSpendersBar && topSpendersList) {
        const top5 = [...state.users]
          .filter(u => u._spend.total > 0)
          .sort((a, b) => b._spend.total - a._spend.total)
          .slice(0, 5);
        if (top5.length > 0) {
          topSpendersBar.classList.remove('hidden');
          topSpendersList.innerHTML = top5.map((u, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '★';
            const name  = esc(u.fullname || u.email || 'Unknown').split(' ')[0];
            return `<div class="flex items-center gap-1.5 bg-white border border-amber-200 rounded-full px-3 py-1.5 text-xs shadow-sm">
              <span>${medal}</span>
              <span class="font-semibold text-slate-700">${name}</span>
              <span class="text-amber-600 font-bold">${formatCurrency(u._spend.total)}</span>
              <span class="text-slate-400">${u._spend.count} orders</span>
            </div>`;
          }).join('');
        } else {
          topSpendersBar.classList.add('hidden');
        }
      }

      const searchTerm = (searchInput?.value || '').toLowerCase();
      const typeFilter = state.userTypeFilter || 'all';
      let filtered = state.users;

      if (searchTerm) {
        filtered = filtered.filter(user => {
          const s = [user.fullname, user.email, user.phone, user.first_name, user.last_name, user._store?.name]
            .join(' ').toLowerCase();
          return s.includes(searchTerm);
        });
      }

      // Update tab counts
      const storeOwnerCount = state.users.filter(u => u._store).length;
      const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
      el('user-count-all', state.users.length);
      el('user-count-store', storeOwnerCount);
      el('user-count-regular', state.users.length - storeOwnerCount);

      if (typeFilter === 'store_owner') filtered = filtered.filter(u => u._store);
      else if (typeFilter === 'regular') filtered = filtered.filter(u => !u._store);

      // helpers
      function badgeHTML(user) {
        const store = user._store;
        if (!store) return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200"><i class="fas fa-user" style="font-size:10px"></i>Regular</span>`;
        const cls = store.status === 'active' ? 'bg-green-100 text-green-700 border-green-200' : 'bg-amber-100 text-amber-700 border-amber-200';
        const ico = store.status === 'active' ? 'fa-store' : 'fa-store-slash';
        return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${cls} border"><i class="fas ${ico}" style="font-size:10px"></i>Store Owner</span>`;
      }

      function actionsHTML(user) {
        const store = user._store;
        return `
          <button class="edit-balance-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-50 text-brand-700 border border-brand-200 hover:bg-brand-100 transition-colors"
            data-user-id="${esc(user.id)}"
            data-user-name="${esc(user.fullname || user.email)}"
            data-user-balance="${user.wallets?.balance || 0}">
            <i class="fas fa-wallet" style="font-size:11px"></i>Edit Balance
          </button>
          ${store ? `<button onclick="admin.navigateTo('custom-pricing')"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition-colors">
            <i class="fas fa-tags" style="font-size:11px"></i>Pricing
          </button>` : ''}`;
      }

      // empty state
      if (filtered.length === 0) {
        const empty = `<div class="py-12 text-center text-slate-400"><i class="fas fa-users text-3xl mb-3 opacity-30 block"></i><p class="text-sm">No users found</p></div>`;
        if (cards) cards.innerHTML = empty;
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="px-4 py-12 text-center text-slate-400"><i class="fas fa-users text-3xl mb-3 opacity-30 block"></i><p class="text-sm">No users found</p></td></tr>`;
        return;
      }

      // MOBILE cards
      if (cards) {
        cards.innerHTML = filtered.map(user => {
          const store = user._store;
          const isStore = !!store;
          const rowBg = isStore ? 'border-green-200 bg-green-50/40' : 'border-slate-200 bg-white';
          const avatarBg = isStore ? 'bg-green-100 text-green-600' : 'bg-brand-100 text-brand-600';
          const avatarIcon = isStore ? 'fa-user-tie' : 'fa-user';
          const storeDot = isStore
            ? `<div class="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-green-500 border-2 border-white flex items-center justify-center"><i class="fas fa-store text-white" style="font-size:6px"></i></div>`
            : '';
          const storeTag = isStore && store.name
            ? `<div class="text-xs text-green-600 font-medium mt-0.5"><i class="fas fa-link mr-1" style="font-size:9px"></i>${esc(store.name)}</div>` : '';

          return `
            <div class="rounded-xl border ${rowBg} p-4 shadow-sm">
              <div class="flex items-start justify-between gap-3 mb-3">
                <div class="flex items-center gap-3 min-w-0">
                  <div class="relative flex-shrink-0 w-10 h-10 rounded-full ${avatarBg} flex items-center justify-center">
                    <i class="fas ${avatarIcon} text-sm"></i>
                    ${storeDot}
                  </div>
                  <div class="min-w-0">
                    <div class="font-semibold text-slate-900 text-sm truncate">${esc(user.fullname || user.email)}</div>
                    <div class="text-xs text-slate-500 truncate">${esc(user.email)}</div>
                    ${storeTag}
                  </div>
                </div>
                ${badgeHTML(user)}
              </div>
              <div class="grid grid-cols-2 gap-2 mb-3 text-xs">
                <div class="bg-slate-50 rounded-lg p-2.5">
                  <div class="text-slate-400 mb-0.5">Balance</div>
                  <div class="font-semibold text-slate-800">${formatCurrency(user.wallets?.balance || 0)}</div>
                </div>
                <div class="bg-slate-50 rounded-lg p-2.5">
                  <div class="text-slate-400 mb-0.5">Phone</div>
                  <div class="font-medium text-slate-700">${esc(user.phone || "—")}</div>
                </div>
                <div class="bg-slate-50 rounded-lg p-2.5">
                  <div class="text-slate-400 mb-0.5">Total Spent</div>
                  <div class="font-bold ${user._spend.total >= 100 ? 'text-amber-600' : user._spend.total >= 50 ? 'text-brand-600' : 'text-slate-800'}">${formatCurrency(user._spend.total)}</div>
                  <div class="text-slate-400 mt-0.5">${user._spend.count} order${user._spend.count !== 1 ? 's' : ''}${user._spend.total >= 200 ? ' ★' : ''}</div>
                </div>
                <div class="bg-slate-50 rounded-lg p-2.5">
                  <div class="text-slate-400 mb-0.5">Joined</div>
                  <div class="font-medium text-slate-700">${formatDate(user.created_at)}</div>
                </div>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                ${actionsHTML(user)}
              </div>
            </div>`;
        }).join('');
      }

      // DESKTOP table rows
      if (tbody) {
        tbody.innerHTML = filtered.map(user => {
          const store = user._store;
          const isStore = !!store;
          const rowBg = isStore ? 'bg-green-50/20 hover:bg-green-50' : 'hover:bg-slate-50';
          const avatarBg = isStore ? 'bg-green-100 text-green-600' : 'bg-brand-100 text-brand-600';
          const avatarIcon = isStore ? 'fa-user-tie' : 'fa-user';
          const storeDot = isStore
            ? `<div class="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-green-500 border-2 border-white flex items-center justify-center"><i class="fas fa-store text-white" style="font-size:6px"></i></div>`
            : '';
          const storeTag = isStore && store.name
            ? `<div class="text-xs text-green-600 font-medium mt-0.5"><i class="fas fa-link mr-1" style="font-size:9px"></i>${esc(store.name)}</div>` : '';
          const storeStatus = isStore
            ? `<div class="text-xs text-slate-400 mt-0.5">${store.status === 'active' ? 'Active' : 'Inactive'}</div>` : '';

          return `
            <tr class="${rowBg} transition-colors">
              <td class="px-4 py-3.5">
                <div class="flex items-center gap-3">
                  <div class="relative flex-shrink-0 w-9 h-9 rounded-full ${avatarBg} flex items-center justify-center">
                    <i class="fas ${avatarIcon} text-sm"></i>
                    ${storeDot}
                  </div>
                  <div class="min-w-0">
                    <div class="font-medium text-slate-900 text-sm">${esc(user.fullname || user.email)}</div>
                    <div class="text-xs text-slate-500">${esc(user.role || 'user')}</div>
                    ${storeTag}
                  </div>
                </div>
              </td>
              <td class="px-4 py-3.5">
                ${badgeHTML(user)}
                ${storeStatus}
              </td>
              <td class="px-4 py-3.5 text-sm text-slate-600 max-w-[180px] truncate">${esc(user.email)}</td>
              <td class="px-4 py-3.5 text-sm text-slate-600">${esc(user.phone || "—")}</td>
              <td class="px-4 py-3.5 text-sm font-semibold text-slate-800 whitespace-nowrap">${formatCurrency(user.wallets?.balance || 0)}</td>
              <td class="px-4 py-3.5">
                <div class="text-sm font-bold ${user._spend.total >= 100 ? 'text-amber-600' : user._spend.total >= 50 ? 'text-brand-600' : 'text-slate-700'} whitespace-nowrap">
                  ${formatCurrency(user._spend.total)}
                </div>
                <div class="text-xs text-slate-400 mt-0.5">${user._spend.count} order${user._spend.count !== 1 ? 's' : ''}${user._spend.total >= 200 ? ' <span class=\'text-amber-500 font-semibold\'>★ Loyal</span>' : ''}</div>
              </td>
              <td class="px-4 py-3.5 text-sm text-slate-600 whitespace-nowrap">${formatDate(user.created_at)}</td>
              <td class="px-4 py-3.5">
                <div class="flex items-center gap-2">
                  ${actionsHTML(user)}
                </div>
              </td>
            </tr>`;
        }).join('');
      }
    }

    // ── Provider Settings ─────────────────────────────────────────────────────
    const PROVIDER_LABELS = {
      justicedata:  'Justice Data Shop',
      pensite:      'Pensite GH',
      hubnet:       'Hubnet',
      sparkdata:    'Spark Data GH',
      databosshub:  'DataBossHub',
    };

    async function loadProviderSettings() {
      try {
        const res = await _adminFetch('admin-manage-orders', { action: 'get-setting', key: 'active_provider' });
        const result = await res.json();
        const activeProvider = result.value || 'justicedata';
        renderProviderCards(activeProvider);
      } catch (err) {
        console.error('Error loading provider settings:', err);
        renderProviderCards('justicedata');
      }
    }

    function renderProviderCards(activeProvider) {
      // Update banner
      const bannerName = document.getElementById('active-provider-name');
      if (bannerName) bannerName.textContent = PROVIDER_LABELS[activeProvider] || activeProvider;

      // Update each provider card
      document.querySelectorAll('.provider-card').forEach(card => {
        const p = card.dataset.provider;
        const isActive = p === activeProvider;
        card.classList.toggle('is-active', isActive);

        const btn = card.querySelector('.switch-provider-btn');
        if (btn) {
          if (isActive) {
            btn.textContent = '✓ Currently Active';
            btn.disabled = true;
          } else {
            btn.textContent = `Switch to ${PROVIDER_LABELS[p] || p}`;
            btn.disabled = false;
          }
        }
      });
    }

    async function switchProvider(provider) {
      const statusEl = document.getElementById('provider-status');
      const allBtns = document.querySelectorAll('.switch-provider-btn');

      // Disable all buttons during switch
      allBtns.forEach(b => { b.disabled = true; });
      if (statusEl) { statusEl.textContent = ''; }

      try {
        const res = await _adminFetch('admin-manage-orders', { action: 'set-setting', key: 'active_provider', value: provider });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);

        renderProviderCards(provider);

        if (statusEl) {
          statusEl.textContent = `✓ Switched to ${PROVIDER_LABELS[provider]}. All new orders will use this provider.`;
          statusEl.className = 'text-sm text-green-600 mt-3 h-5';
        }
        showToast(`Provider switched to ${PROVIDER_LABELS[provider]}`, 'success');

      } catch (err) {
        console.error('Error switching provider:', err);
        if (statusEl) {
          statusEl.textContent = `✗ Failed to switch: ${err.message || 'Unknown error'}`;
          statusEl.className = 'text-sm text-red-500 mt-3 h-5';
        }
        showToast('Failed to switch provider', 'error');
        // Re-enable buttons on failure
        allBtns.forEach(b => { b.disabled = false; });
        loadProviderSettings();
      }
    }

    // Settings
    async function loadSettings() {
      try {
        // Use centralized request header
        const res = await _adminFetch('admin-manage-orders', { action: 'get-setting', key: 'deposit_method' });
        const result = await res.json();
        const method = result.value || 'automatic';
        const radio = document.querySelector(`input[name="deposit-method"][value="${method}"]`);
        if (radio) radio.checked = true;
        const statusEl = document.getElementById('settings-status');
        if (statusEl) statusEl.textContent = '';
      } catch (error) {
        console.error('Error loading settings:', error);
        const radio = document.querySelector('input[name="deposit-method"][value="automatic"]');
        if (radio) radio.checked = true;
      }

      // Load current announcement via edge function
      try {
        const res = await fetch(
          `${SUPABASE_PROJECT_URL}/functions/v1/get-announcement`,
          { method: 'GET', headers: { 'Content-Type': 'application/json' } }
        );
        const ann = await res.json();
        const annEl = document.getElementById('announcement-text');
        if (annEl && ann.announcement) {
          annEl.value = ann.announcement;
          updateAnnouncementPreview(ann.announcement);
        }
      } catch (_) { /* non-fatal */ }
    }

    function updateAnnouncementPreview(text) {
      const preview = document.getElementById('announcement-preview');
      const previewText = document.getElementById('announcement-preview-text');
      if (!preview || !previewText) return;
      if (text && text.trim()) {
        previewText.textContent = '📢 ' + text.trim();
        preview.classList.remove('hidden');
      } else {
        preview.classList.add('hidden');
      }
    }

    async function saveAnnouncement() {
      const annEl  = document.getElementById('announcement-text');
      const status = document.getElementById('announcement-status');
      const btn    = document.getElementById('save-announcement');
      const text   = annEl?.value.trim() || '';

      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Saving...'; }
      if (status) { status.textContent = ''; status.className = 'text-sm font-medium h-5'; }

      try {
        const res = await _adminFetch('set-announcement', { action: 'save', text });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed');

        if (status) {
          status.textContent = text ? '✓ Published — users will see this now' : '✓ Cleared';
          status.className = 'text-sm font-medium text-green-600 h-5';
        }
        updateAnnouncementPreview(text);
        showToast(text ? 'Announcement published!' : 'Announcement cleared', 'success');
      } catch (err) {
        console.error('Error saving announcement:', err);
        if (status) { status.textContent = '✗ Failed: ' + err.message; status.className = 'text-sm font-medium text-red-500 h-5'; }
        showToast('Failed to save announcement', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save mr-2"></i>Save &amp; Publish'; }
        setTimeout(() => { if (status) status.textContent = ''; }, 4000);
      }
    }

    async function clearAnnouncement() {
      const annEl  = document.getElementById('announcement-text');
      const status = document.getElementById('announcement-status');
      const btn    = document.getElementById('clear-announcement');

      if (annEl) annEl.value = '';
      updateAnnouncementPreview('');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Clearing...'; }

      try {
        const res = await _adminFetch('set-announcement', { action: 'clear' });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed');

        if (status) { status.textContent = '✓ Announcement hidden from users'; status.className = 'text-sm font-medium text-green-600 h-5'; }
        showToast('Announcement cleared', 'info');
      } catch (err) {
        if (status) { status.textContent = '✗ Failed: ' + err.message; status.className = 'text-sm font-medium text-red-500 h-5'; }
        showToast('Failed to clear announcement', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-times mr-2"></i>Clear / Hide'; }
        setTimeout(() => { if (status) status.textContent = ''; }, 4000);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SITE LOCK — Option C (Dashboard Lock + Store Lock independent)
    // All calls go through admin-manage-orders → set-setting / get-setting
    // Keys: site_lock_dashboard  |  site_lock_store
    // Value stored as JSON string: { locked, title, message, footer, icon, locked_at }
    // ═══════════════════════════════════════════════════════════════════════

    // Icon map for display
    const LOCK_ICONS = {
      clock:    'fas fa-clock',
      wrench:   'fas fa-wrench',
      ban:      'fas fa-ban',
      bullhorn: 'fas fa-bullhorn',
    };

    // ── Render lock status on the card ────────────────────────────────────────
    function renderLockStatus(type, lockData) {
      // type: 'dashboard' or 'store'
      const card    = document.getElementById(`${type}-lock-card`);
      const pill    = document.getElementById(`${type}-lock-status-pill`);
      const msgEl   = document.getElementById(`${type}-lock-status-msg`);
      const lockBtn = document.getElementById(`${type}-lock-btn`);
      const unlockBtn = document.getElementById(`${type}-unlock-btn`);

      if (!lockData || !lockData.locked) {
        // OPEN state
        if (card)  { card.classList.remove('is-locked'); }
        if (pill)  { pill.className = 'text-xs px-3 py-1 rounded-full font-semibold bg-green-100 text-green-700'; pill.innerHTML = '<i class="fas fa-circle text-[8px] mr-1"></i>Open'; }
        if (msgEl) { msgEl.textContent = ''; }
        if (lockBtn)   { lockBtn.disabled = false; }
        if (unlockBtn) { unlockBtn.disabled = true; unlockBtn.classList.add('opacity-50', 'cursor-not-allowed'); unlockBtn.classList.remove('bg-green-600', 'hover:bg-green-700'); unlockBtn.classList.add('bg-slate-300'); }

        // Populate fields with last saved values if present
        if (lockData) {
          const titleEl   = document.getElementById(`${type}-lock-title`);
          const messageEl = document.getElementById(`${type}-lock-message`);
          const footerEl  = document.getElementById(`${type}-lock-footer`);
          if (titleEl   && lockData.title)   titleEl.value   = lockData.title;
          if (messageEl && lockData.message) messageEl.value = lockData.message;
          if (footerEl  && lockData.footer)  footerEl.value  = lockData.footer;
          // Restore icon radio
          if (lockData.icon) {
            const radio = document.querySelector(`input[name="${type}-lock-icon"][value="${lockData.icon}"]`);
            if (radio) {
              radio.checked = true;
              radio.closest('label')?.classList.add('!border-brand-500', '!bg-blue-50');
            }
          }
        }
      } else {
        // LOCKED state
        if (card)  { card.classList.add('is-locked'); }
        if (pill)  { pill.className = 'text-xs px-3 py-1 rounded-full font-semibold bg-red-100 text-red-700'; pill.innerHTML = '<i class="fas fa-lock text-[10px] mr-1"></i>Locked'; }
        const lockedAt = lockData.locked_at ? new Date(lockData.locked_at).toLocaleTimeString() : '';
        if (msgEl) { msgEl.textContent = lockedAt ? `Locked since ${lockedAt}` : 'Currently locked'; msgEl.className = 'text-xs font-medium h-4 text-center text-red-600'; }
        if (lockBtn)   { lockBtn.disabled = true; lockBtn.classList.add('opacity-50', 'cursor-not-allowed'); }
        if (unlockBtn) { unlockBtn.disabled = false; unlockBtn.classList.remove('opacity-50', 'cursor-not-allowed', 'bg-slate-300'); unlockBtn.classList.add('bg-green-600', 'hover:bg-green-700'); }

        // Populate fields with current lock values
        const titleEl   = document.getElementById(`${type}-lock-title`);
        const messageEl = document.getElementById(`${type}-lock-message`);
        const footerEl  = document.getElementById(`${type}-lock-footer`);
        if (titleEl)   titleEl.value   = lockData.title   || '';
        if (messageEl) messageEl.value = lockData.message || '';
        if (footerEl)  footerEl.value  = lockData.footer  || '';
        if (lockData.icon) {
          const radio = document.querySelector(`input[name="${type}-lock-icon"][value="${lockData.icon}"]`);
          if (radio) radio.checked = true;
        }
      }
    }

    // ── Load current lock status for both types ────────────────────────────────
    async function loadSiteLock() {
      try {
        const [dashRes, storeRes] = await Promise.all([
          _adminFetch('admin-manage-orders', { action: 'get-setting', key: 'site_lock_dashboard' }),
          _adminFetch('admin-manage-orders', { action: 'get-setting', key: 'site_lock_store' }),
        ]);
        const dashData  = await dashRes.json();
        const storeData = await storeRes.json();

        const dashLock  = dashData.success  && dashData.value  ? (typeof dashData.value  === 'string' ? JSON.parse(dashData.value)  : dashData.value)  : null;
        const storeLock = storeData.success && storeData.value ? (typeof storeData.value === 'string' ? JSON.parse(storeData.value) : storeData.value) : null;

        renderLockStatus('dashboard', dashLock);
        renderLockStatus('store',     storeLock);
      } catch (err) {
        console.warn('loadSiteLock error:', err.message);
      }
    }

    // ── Lock a target (dashboard or store) ────────────────────────────────────
    async function siteLock(type) {
      const title   = (document.getElementById(`${type}-lock-title`)?.value   || '').trim();
      const message = (document.getElementById(`${type}-lock-message`)?.value || '').trim();
      const footer  = (document.getElementById(`${type}-lock-footer`)?.value  || '').trim();
      const iconRadio = document.querySelector(`input[name="${type}-lock-icon"]:checked`);
      const icon    = iconRadio?.value || 'clock';
      const msgEl   = document.getElementById(`${type}-lock-status-msg`);
      const lockBtn = document.getElementById(`${type}-lock-btn`);

      if (!title)   { showToast('Please enter a title before locking', 'error'); return; }
      if (!message) { showToast('Please enter a message before locking', 'error'); return; }

      const lockValue = JSON.stringify({
        locked:    true,
        title,
        message,
        footer:    footer || '',
        icon,
        locked_at: new Date().toISOString(),
      });

      if (lockBtn) { lockBtn.disabled = true; lockBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Locking...'; }

      try {
        const res    = await _adminFetch('admin-manage-orders', { action: 'set-setting', key: `site_lock_${type}`, value: lockValue });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed');

        showToast(`${type === 'dashboard' ? 'Dashboard' : 'Store'} locked successfully`, 'success');
        await loadSiteLock(); // refresh UI
      } catch (err) {
        showToast(`Lock failed: ${err.message}`, 'error');
        if (msgEl) { msgEl.textContent = '✗ ' + err.message; msgEl.className = 'text-xs font-medium h-4 text-center text-red-600'; }
      } finally {
        if (lockBtn) { lockBtn.disabled = false; lockBtn.innerHTML = `<i class="fas fa-lock mr-1"></i> Lock ${type === 'dashboard' ? 'Dashboard' : 'Store'}`; }
      }
    }

    // ── Unlock a target ────────────────────────────────────────────────────────
    async function siteUnlock(type) {
      const unlockBtn = document.getElementById(`${type}-unlock-btn`);
      const msgEl     = document.getElementById(`${type}-lock-status-msg`);

      // Keep existing title/message/footer/icon so admin can re-lock with same message
      const titleEl   = document.getElementById(`${type}-lock-title`);
      const messageEl = document.getElementById(`${type}-lock-message`);
      const footerEl  = document.getElementById(`${type}-lock-footer`);
      const iconRadio = document.querySelector(`input[name="${type}-lock-icon"]:checked`);

      const unlockValue = JSON.stringify({
        locked:      false,
        title:       titleEl?.value   || '',
        message:     messageEl?.value || '',
        footer:      footerEl?.value  || '',
        icon:        iconRadio?.value || 'clock',
        unlocked_at: new Date().toISOString(),
      });

      if (unlockBtn) { unlockBtn.disabled = true; unlockBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Unlocking...'; }

      try {
        const res    = await _adminFetch('admin-manage-orders', { action: 'set-setting', key: `site_lock_${type}`, value: unlockValue });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed');

        showToast(`${type === 'dashboard' ? 'Dashboard' : 'Store'} unlocked`, 'success');
        await loadSiteLock(); // refresh UI
      } catch (err) {
        showToast(`Unlock failed: ${err.message}`, 'error');
        if (msgEl) { msgEl.textContent = '✗ ' + err.message; msgEl.className = 'text-xs font-medium h-4 text-center text-red-600'; }
      } finally {
        if (unlockBtn) { unlockBtn.disabled = false; unlockBtn.innerHTML = '<i class="fas fa-lock-open mr-1"></i> Unlock'; }
      }
    }

    async function saveDepositSettings() {
      const btn = document.getElementById('save-deposit-settings');
      const statusEl = document.getElementById('settings-status');
      const selected = document.querySelector('input[name="deposit-method"]:checked');

      if (!selected) {
        if (statusEl) { statusEl.textContent = 'Please select an option.'; statusEl.className = 'text-sm text-red-500 mt-2 h-5'; }
        return;
      }

      const method = selected.value;
      // Map UI values to the values the edge function accepts.
      // The HTML has 3 options (automatic, paystack_only, manual_only) but the
      // edge function currently only accepts 'automatic' and 'manual'.
      // Map paystack_only → automatic, manual_only → manual until the edge
      // function is updated to accept all three.
      const methodMapped = method === 'paystack_only' ? 'automatic'
                         : method === 'manual_only'   ? 'manual'
                         : method; // 'automatic' passes through unchanged
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Saving...'; }
      if (statusEl) { statusEl.textContent = ''; statusEl.className = 'text-sm mt-2 h-5'; }

      try {
        // Use centralized request header
        const res = await _adminFetch('admin-manage-orders', { action: 'set-setting', key: 'deposit_method', value: methodMapped });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);

        if (statusEl) {
          statusEl.textContent = '✓ Deposit settings saved successfully.';
          statusEl.className = 'text-sm text-green-600 mt-2 h-5';
        }
        showToast('Deposit settings saved!', 'success');
      } catch (err) {
        console.error('Error saving deposit settings:', err);
        if (statusEl) {
          statusEl.textContent = '✗ Failed to save: ' + (err.message || 'Unknown error');
          statusEl.className = 'text-sm text-red-500 mt-2 h-5';
        }
        showToast('Failed to save settings', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Save Deposit Settings'; }
      }
    }

    // Bundle Management
    async function loadBundles() {
      try {
        const activeFilter = document.querySelector('.network-filter-tab.active[data-network-filter]');
        const filterStatus = activeFilter?.dataset.networkFilter || 'all';

        // Authorization is enforced server-side; client-side checks are informational only.
        const res = await _adminFetch('admin-manage-bundles', { action: 'list' });
        const result = await res.json();

        if (!result.success) throw new Error(result.message || 'Failed to load bundles');

        let bundles = result.bundles || [];
        if (filterStatus !== 'all') {
          bundles = bundles.filter(b => b.network === filterStatus);
        }

        state.bundles = bundles;
        renderBundles(bundles);
      } catch (error) {
        console.error('Error loading bundles:', error);
        showToast('Failed to load bundles', 'error');
      }
    }

    function renderBundles(bundles) {
      const grid = document.getElementById('bundles-grid');
      const emptyState = document.getElementById('bundles-empty-state');

      if (!grid || !emptyState) return;

      if (!bundles || bundles.length === 0) {
        grid.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
      }

      emptyState.classList.add('hidden');

      grid.innerHTML = bundles
        .map((bundle) => {
          const networkClass = `${bundle.network.toLowerCase()}-bg`;
          const networkName = bundle.network.toUpperCase();

          return `
            <div class="card p-5">
              <div class="flex items-start justify-between mb-4">
                <div class="flex items-center space-x-3">
                  <div class="w-12 h-12 rounded-lg ${networkClass} flex items-center justify-center text-white font-bold">
                    ${networkName.charAt(0)}
                  </div>
                  <div>
                    <h3 class="font-bold text-slate-800">${esc(networkName)} ${esc(String(bundle.size))}GB</h3>
                    <p class="text-sm text-slate-500">Data Bundle</p>
                  </div>
                </div>
                <div class="flex space-x-2">
                  <button class="edit-bundle-btn p-2 text-slate-400 hover:text-brand-600 transition-colors"
                          data-bundle-id="${esc(bundle.id)}"
                          title="Edit Bundle">
                    <i class="fas fa-edit"></i>
                  </button>
                  <button class="delete-bundle-btn p-2 text-slate-400 hover:text-red-600 transition-colors"
                          data-bundle-id="${esc(bundle.id)}"
                          title="Delete Bundle">
                    <i class="fas fa-trash"></i>
                  </button>
                </div>
              </div>

              <div class="space-y-3">
                <div class="flex justify-between items-center">
                  <span class="text-slate-600">Price:</span>
                  <span class="font-bold text-lg text-green-600">${formatCurrency(bundle.price)}</span>
                </div>
                <div class="flex justify-between items-center">
                  <span class="text-slate-600">Status:</span>
                  <span class="px-2 py-1 rounded-full text-xs font-medium ${
                    bundle.active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }">
                    ${bundle.active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div class="flex justify-between items-center">
                  <span class="text-slate-600">Network:</span>
                  <span class="px-2 py-1 rounded text-xs ${networkClass} text-white font-medium">
                    ${esc(networkName)}
                  </span>
                </div>
              </div>
            </div>
          `;
        })
        .join('');
    }

    // Bundle CRUD Functions
    function openBundleModal(bundleId = null) {
      const modal = document.getElementById('bundle-modal');
      const title = document.getElementById('bundle-modal-title');
      const form = document.getElementById('bundle-form');

      if (!modal || !title || !form) return;

      state.isEditingBundle = !!bundleId;
      state.currentBundleId = bundleId;

      if (bundleId) {
        // Editing existing bundle
        title.textContent = 'Edit Bundle';
        const bundle = state.bundles.find(b => b.id === bundleId);
        if (bundle) {
          document.getElementById('bundle-network').value = bundle.network;
          document.getElementById('bundle-size').value = bundle.size;
          document.getElementById('bundle-price').value = bundle.price;
          document.getElementById('bundle-active').checked = bundle.active;
        }
      } else {
        // Adding new bundle
        title.textContent = 'Add New Bundle';
        form.reset();
        document.getElementById('bundle-active').checked = true; // Default to active
      }

      modal.classList.remove('hidden');
    }

    function closeBundleModal() {
      const modal = document.getElementById('bundle-modal');
      if (modal) modal.classList.add('hidden');
      state.currentBundleId = null;
      state.isEditingBundle = false;
    }

    async function handleBundleFormSubmit() {
      const network = document.getElementById('bundle-network').value;
      const size = parseInt(document.getElementById('bundle-size').value);
      const price = parseFloat(document.getElementById('bundle-price').value);
      const active = document.getElementById('bundle-active').checked;

      // Validation
      if (!network) {
        showToast('Please select a network', 'warning');
        return;
      }

      if (!size || size <= 0) {
        showToast('Please enter a valid bundle size', 'warning');
        return;
      }

      if (price < 0) {
        showToast('Please enter a valid price', 'warning');
        return;
      }

      try {
        const bundleData = {
          network: network.toLowerCase(),
          size,
          price,
          active
        };

        // Authorization is enforced server-side for admin operations.
        const res = await _adminFetch('admin-manage-bundles',
            state.isEditingBundle
              ? { action: 'update', bundleId: state.currentBundleId, bundle: bundleData }
              : { action: 'create', bundle: bundleData }
          );
        const result = await res.json();

        if (!result.success) throw new Error(result.message || 'Failed to save bundle');

        showToast(
          state.isEditingBundle ? 'Bundle updated successfully' : 'Bundle created successfully',
          'success'
        );

        closeBundleModal();
        loadBundles();

      } catch (error) {
        console.error('Error saving bundle:', error);
        showToast('Failed to save bundle', 'error');
      }
    }

    async function deleteBundle(bundleId) {
      try {
       // Server-side authorization required.
      // Soft delete preserves historical order records.
        const res = await _adminFetch('admin-manage-bundles', { action: 'delete', bundleId });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed to delete bundle');

        showToast('Bundle deactivated successfully', 'success');
        loadBundles();

      } catch (error) {
        console.error('Error deleting bundle:', error);
        showToast('Failed to delete bundle', 'error');
      }
    }

    // Deposit approval

    // Order Details Modal
    async function openOrderDetails(orderId, orderType) {
      try {
        const res = await _adminFetch('admin-manage-orders', { action: 'get-order', orderId });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Order not found');

        const order = result.order;
        let orderData = null;

       if (orderType === 'guest') {
          orderData = {
            ...order,
            type: 'guest',
            reference: order.order_reference || `GST-${order.id}`,
            bundle_name: order.description || `${(order.network||'').toUpperCase()} ${order.package_size || ''}GB`,
            network: order.network,
            bundle_size: order.package_size,
            phone_number: order.recipient,
            email: order.users?.email || '',
            created_at: order.created_at,
            status: order.status || 'pending'
          };
       } else {
          orderData = {
            ...order,
            type: 'registered',
            reference: order.order_reference || `REG-${order.id}`,
            phone_number: order.recipient || order.users?.phone || 'N/A',
            email: order.users?.email || '',
            bundle_name: order.description || 'Data Bundle',
            network: order.network || 'Unknown',
            bundle_size: order.package_size || 0,
            manual_fallback: order.external_response?.manual_fallback || false,
            sparkdata_error: order.external_response?.sparkdata_error || null
          };
        }
        if (!orderData) {
          showToast('Order not found', 'error');
          return;
        }

       const manualWarning = document.getElementById('modal-manual-warning');
        const manualError   = document.getElementById('modal-manual-error');
        if (orderData.manual_fallback) {
          manualWarning.classList.remove('hidden');
          if (manualError) manualError.textContent = orderData.sparkdata_error || 'API unavailable';
        } else {
          manualWarning.classList.add('hidden');
        }

        document.getElementById('modal-order-name').textContent =
          orderData.bundle_name;
        document.getElementById('modal-order-ref').textContent =
          orderData.reference;

        const typeBadge = document.getElementById('modal-order-type');
        if (orderData.type === 'guest') {
          // Guest badge removed - no longer display orange badge
          typeBadge.textContent = '';
          typeBadge.className = 'hidden';
        } else {
          typeBadge.textContent = 'Registered User';
          typeBadge.className =
            'text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded';
        }

        document.getElementById('modal-order-amount').textContent =
          formatCurrency(orderData.amount);
        document.getElementById('modal-order-status').textContent =
          orderData.status.charAt(0).toUpperCase() + orderData.status.slice(1);
        document.getElementById('modal-order-network').textContent =
          orderData.network?.toUpperCase() || 'Unknown';
        document.getElementById('modal-order-size').textContent =
          orderData.bundle_size ? `${orderData.bundle_size}GB` : 'N/A';
        document.getElementById('modal-customer-phone').textContent =
          orderData.phone_number || 'N/A';
        document.getElementById('modal-customer-email').textContent =
          orderData.email || 'Not provided';
        document.getElementById('modal-customer-id').textContent =
          orderData.type === 'registered'
            ? `User ID: ${orderData.user_id || 'N/A'}`
            : 'Guest (No Account)';
        document.getElementById('modal-order-date').textContent = formatDate(
          orderData.created_at
        );

        // Rebuild status options to match server-side transition rules.
        (function populateStatusSelect(currentStatus) {
          const select = document.getElementById('status-update-select');
          const updateBtn = document.getElementById('update-order-status');
          const ALL_STATUSES = [
            { value: 'pending',    label: 'Pending' },
            { value: 'processing', label: 'Processing' },
            { value: 'completed',  label: 'Completed' },
            { value: 'failed',     label: 'Failed' },
          ];

          // For completed orders: only 'failed' is a valid transition (mirrors server rule).
          // For all other statuses: all options are available except the current one.
          const isCompleted = currentStatus === 'completed';
          const allowed = isCompleted
            ? ALL_STATUSES.filter(s => s.value === 'failed')
            : ALL_STATUSES.filter(s => s.value !== currentStatus);

          select.innerHTML = allowed
            .map(s => `<option value="${s.value}">${s.label}</option>`)
            .join('');

          if (allowed.length > 0) {
            select.value = allowed[0].value;
            select.disabled = false;
            updateBtn.disabled = false;
            updateBtn.classList.remove('opacity-50', 'cursor-not-allowed');
          } else {
            select.disabled = true;
            updateBtn.disabled = true;
            updateBtn.classList.add('opacity-50', 'cursor-not-allowed');
          }

          // Show a hint when options are restricted
          const hint = document.getElementById('status-update-hint');
          if (hint) {
            hint.textContent = isCompleted
              ? '⚠️ Completed orders can only be moved to Failed.'
              : 'Guest orders will be notified via email if provided';
          }
        })(orderData.status);

       state.currentOrderId = orderId;
        state.currentOrderType = orderType;
        state.currentOrderUserId = orderData.userid || null;

        document
          .getElementById('order-details-modal')
          .classList.remove('hidden');
      } catch (error) {
        console.error('Error loading order details:', error);
        showToast('Failed to load order details', 'error');
      }
    }

   async function updateOrderStatus(newStatus) {
      try {
      // All database updates are server-controlled.
        const res = await _adminFetch('admin-manage-orders', {
            action: 'update-status',
            orderId: state.currentOrderId,
            status: newStatus,
          });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed to update order status');

       showToast('Order status updated successfully', 'success');
        closeModal('order-details-modal');

        if (state.currentOrderType === 'guest') {
          loadGuestOrders();
        } else {
          loadAllOrders();
        }
        loadDashboardData();
        loadOrderStats();
      } catch (error) {
        console.error('Error updating order status:', error);
        showToast('Failed to update order status', 'error');
      }
    }

    // Balance Edit Modal
    function openBalanceEditModal(userId, userName, userBalance) {
      state.currentUserId = userId;
      state.currentUserBalance = userBalance;

      document.getElementById('modal-user-name').textContent = userName;
      document.getElementById('modal-current-balance').textContent =
        formatCurrency(userBalance);
      document.getElementById('balance-amount').value = '';
      document.getElementById('balance-reason').value = '';
      document.getElementById('balance-preview').classList.add('hidden');

      document.querySelectorAll('.balance-action-btn').forEach((btn) => {
        btn.classList.remove(
          'bg-brand-100',
          'border-brand-500',
          'text-brand-700'
        );
      });

      document
        .getElementById('balance-edit-modal')
        .classList.remove('hidden');
    }

    function calculateNewBalance(action, currentBalance, amount) {
      const current = parseFloat(currentBalance) || 0;
      const change = parseFloat(amount) || 0;

      switch (action) {
        case 'set':
          return change;
        case 'add':
          return current + change;
        case 'deduct':
          return current - change;
        default:
          return current;
      }
    }

    function updateBalancePreview() {
      const action = state.currentAction;
      const currentBalance = parseFloat(state.currentUserBalance) || 0;
      const amount = parseFloat(
        document.getElementById('balance-amount').value || 0
      );

      const previewEl = document.getElementById('balance-preview');
      const previewAmountEl = document.getElementById('preview-amount');
      if (!previewEl || !previewAmountEl) return;

      if (!action || amount <= 0) {
        previewEl.classList.add('hidden');
        return;
      }

      const newBalance = calculateNewBalance(action, currentBalance, amount);
      previewAmountEl.textContent = formatCurrency(newBalance);
      previewEl.classList.remove('hidden');
    }

   async function updateUserBalance(action, amount, reason) {
      try {
        const res = await _adminFetch('admin-manage-users', {
            action:  'set-wallet-balance',
            userId:  state.currentUserId,
            amount:  parseFloat(amount),
            balanceAction: action,
            reason:  reason || `Admin manual ${action}`,
          });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Update failed');

        showToast(`Balance updated to ${formatCurrency(data.new_balance)}`, 'success');
        closeModal('balance-edit-modal');
        loadUsers();
        loadDashboardData();
      } catch (error) {
        console.error('Error updating user balance:', error);
        showToast(`Failed: ${esc(error.message)}`, 'error');
      }
    }
    // Modal Functions
    function closeModal(modalId) {
      const modal = document.getElementById(modalId);
      if (modal) modal.classList.add('hidden');
    }

    // Event Listeners
    function setupEventListeners() {
      console.log('Setting up event listeners...');

      // Settings — deposit method save
      document.getElementById('save-deposit-settings')?.addEventListener('click', saveDepositSettings);

      // Announcement ticker
      document.getElementById('save-announcement')?.addEventListener('click', saveAnnouncement);
      document.getElementById('clear-announcement')?.addEventListener('click', clearAnnouncement);
      document.getElementById('announcement-text')?.addEventListener('input', (e) => {
        updateAnnouncementPreview(e.target.value);
      });

      // Site Lock — Dashboard
      document.getElementById('dashboard-lock-btn')?.addEventListener('click',   () => siteLock('dashboard'));
      document.getElementById('dashboard-unlock-btn')?.addEventListener('click', () => siteUnlock('dashboard'));

      // Site Lock — Store
      document.getElementById('store-lock-btn')?.addEventListener('click',   () => siteLock('store'));
      document.getElementById('store-unlock-btn')?.addEventListener('click', () => siteUnlock('store'));

      // Site Lock — icon radio visual toggle (add selected class)
      document.querySelectorAll('.lock-icon-opt input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', function() {
          const name = this.name;
          document.querySelectorAll(`input[name="${name}"]`).forEach(r => {
            r.closest('label')?.classList.remove('!border-brand-500', '!bg-blue-50');
          });
          this.closest('label')?.classList.add('!border-brand-500', '!bg-blue-50');
        });
      });

      // Provider switch buttons (delegated)
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('.switch-provider-btn');
        if (btn && !btn.disabled) {
          const provider = btn.dataset.provider;
          if (provider) switchProvider(provider);
        }
      });

   function openMobileSidebar() {
    const sidebar = document.getElementById('adminSidebar');
    const overlay = document.getElementById('mobileOverlay');
    
    if (sidebar && overlay) {
        // Remove hidden class if present
        sidebar.classList.remove('hidden');
        overlay.classList.remove('hidden');
        
        // Force reflow
        void sidebar.offsetHeight;
        
        // Add open class for animation
        requestAnimationFrame(() => {
            sidebar.classList.add('open');
            document.body.style.overflow = 'hidden';
        });
    }
}



function closeMobileSidebar() {
    const sidebar = document.getElementById('adminSidebar');
    const overlay = document.getElementById('mobileOverlay');
    if (sidebar && overlay) {
        sidebar.classList.remove('open');
        overlay.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

// Mobile menu button click
document.getElementById('mobile-menu-btn')?.addEventListener('click', openMobileSidebar);

// Close sidebar when clicking overlay
document.getElementById('mobileOverlay')?.addEventListener('click', closeMobileSidebar);

// Close sidebar after navigation on mobile
document.querySelectorAll('.admin-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (window.innerWidth < 768) {
            closeMobileSidebar();
        }
    });
});



      // Search / filter (use input/change events)
      const orderSearch = document.getElementById('orders-search');
      const orderFilter = document.getElementById('orders-filter');
      const userSearch = document.getElementById('user-search');
      const balanceAmountInput = document.getElementById('balance-amount');

      if (orderSearch)
        orderSearch.addEventListener('input', () => {
          state.ordersPage = 1;
          applyOrderFilters();
        });

      if (orderFilter)
        orderFilter.addEventListener('change', () => {
          state.ordersPage = 1;
          applyOrderFilters();
        });

     if (userSearch)
        userSearch.addEventListener('input', () => {
          renderUsers();
        });

      document.addEventListener('click', (e) => {
        const tab = e.target.closest('.user-type-filter-tab');
        if (!tab) return;
        const filter = tab.dataset.userTypeFilter;
        if (!filter) return;
        state.userTypeFilter = filter;
        document.querySelectorAll('.user-type-filter-tab').forEach(btn => {
          if (btn.dataset.userTypeFilter === filter) {
            btn.classList.remove('bg-white', 'border-slate-200', 'text-slate-600');
            btn.classList.add('bg-brand-600', 'text-white', 'shadow-sm');
          } else {
            btn.classList.remove('bg-brand-600', 'text-white', 'shadow-sm');
            btn.classList.add('bg-white', 'border-slate-200', 'text-slate-600');
          }
        });
        renderUsers();
      });

      if (balanceAmountInput)
        balanceAmountInput.addEventListener('input', () => {
          updateBalancePreview();
        });

      // Form submission handlers
      document.addEventListener('submit', (e) => {
        if (e.target.id === 'bundle-form') {
          e.preventDefault();
          handleBundleFormSubmit();
          return;
        }
      });

      // Global click delegation
      document.addEventListener('click', (e) => {
        const target = e.target;

        // Nav
        if (target.closest('.admin-nav-btn')) {
          e.preventDefault();
          const btn = target.closest('.admin-nav-btn');
          const page = btn.dataset.page;
          console.log('Navigation button clicked:', page);
          navigateTo(page);
          return;
        }

        // Mobile menu
        if (target.closest('#mobile-menu-btn')) {
          e.preventDefault();
          const sidebar = document.querySelector('aside');
          if (sidebar && window.innerWidth < 768) {
            openMobileSidebar();
          }
          return;
        }

        // Orders pagination
        if (target.id === 'orders-prev') {
          if (state.ordersPage > 1) {
            state.ordersPage--;
            renderOrders();
          }
          return;
        }

        if (target.id === 'orders-next') {
          state.ordersPage++;
          renderOrders();
          return;
        }

        // Guest orders pagination
        if (target.id === 'guest-orders-prev') {
          if (state.guestOrdersPage > 1) {
            state.guestOrdersPage--;
            renderGuestOrders();
          }
          return;
        }
        if (target.id === 'guest-orders-next') {
          state.guestOrdersPage++;
          renderGuestOrders();
          return;
        }

        // Guest order status filters
        if (target.closest('.filter-tab[data-guest-filter]')) {
          const tab = target.closest('.filter-tab[data-guest-filter]');
          document.querySelectorAll('.filter-tab[data-guest-filter]').forEach(t => {
            t.classList.remove('bg-white', 'text-slate-800', 'shadow');
            t.classList.add('text-slate-600', 'hover:bg-white/50');
          });
          tab.classList.remove('text-slate-600', 'hover:bg-white/50');
          tab.classList.add('bg-white', 'text-slate-800', 'shadow');
          state.guestOrdersPage = 1;
          loadGuestOrders();
          return;
        }

        // Refresh guest orders
        if (target.id === 'refresh-guest-orders') {
          loadGuestOrders();
          return;
        }

        // Store sales pagination
        if (target.id === 'store-sales-prev') {
          if ((state.storeSalesPage || 1) > 1) {
            state.storeSalesPage--;
            renderStoreSales();
          }
          return;
        }
        if (target.id === 'store-sales-next') {
          state.storeSalesPage = (state.storeSalesPage || 1) + 1;
          renderStoreSales();
          return;
        }

        // Store sales status filters
        if (target.closest('.store-filter-tab[data-store-filter]')) {
          const tab = target.closest('.store-filter-tab[data-store-filter]');
          document.querySelectorAll('.store-filter-tab[data-store-filter]').forEach(t => {
            t.classList.remove('bg-white', 'text-slate-800', 'shadow');
            t.classList.add('text-slate-600', 'hover:bg-white/50');
          });
          tab.classList.remove('text-slate-600', 'hover:bg-white/50');
          tab.classList.add('bg-white', 'text-slate-800', 'shadow');
          state.storeSalesPage = 1;
          loadStoreSales();
          return;
        }

        // Refresh store sales
        if (target.id === 'refresh-store-sales') {
          loadStoreSales();
          return;
        }

        // User orders pagination
        if (target.id === 'user-orders-prev') {
          if ((state.userOrdersPage || 1) > 1) {
            state.userOrdersPage--;
            renderUserOrders();
          }
          return;
        }
        if (target.id === 'user-orders-next') {
          state.userOrdersPage = (state.userOrdersPage || 1) + 1;
          renderUserOrders();
          return;
        }

        // User orders status filters
        if (target.closest('.user-order-filter-tab[data-user-order-filter]')) {
          const tab = target.closest('.user-order-filter-tab[data-user-order-filter]');
          document.querySelectorAll('.user-order-filter-tab[data-user-order-filter]').forEach(t => {
            t.classList.remove('bg-white', 'text-slate-800', 'shadow');
            t.classList.add('text-slate-600', 'hover:bg-white/50');
          });
          tab.classList.remove('text-slate-600', 'hover:bg-white/50');
          tab.classList.add('bg-white', 'text-slate-800', 'shadow');
          state.userOrdersPage = 1;
          loadUserOrders();
          return;
        }

        // Refresh user orders
        if (target.id === 'refresh-user-orders') {
          loadUserOrders();
          return;
        }

        // Bundle Management
        if (target.closest('.network-filter-tab[data-network-filter]')) {
          const tab = target.closest('.network-filter-tab[data-network-filter]');

          document.querySelectorAll('.network-filter-tab[data-network-filter]').forEach(t => {
            t.classList.remove('active', 'bg-white', 'text-slate-800', 'shadow');
            t.classList.add('text-slate-600', 'hover:bg-white/50');
          });

          tab.classList.remove('text-slate-600', 'hover:bg-white/50');
          tab.classList.add('active', 'bg-white', 'text-slate-800', 'shadow');

          loadBundles();
          return;
        }

        if (target.id === 'add-bundle-btn' || target.id === 'add-first-bundle-btn') {
          openBundleModal();
          return;
        }

        if (target.closest('.edit-bundle-btn')) {
          const btn = target.closest('.edit-bundle-btn');
          const bundleId = btn.dataset.bundleId;
          openBundleModal(bundleId);
          return;
        }

        if (target.closest('.delete-bundle-btn')) {
          const btn = target.closest('.delete-bundle-btn');
          const bundleId = btn.dataset.bundleId;
          if (confirm('Are you sure you want to delete this bundle? This action cannot be undone.')) {
            deleteBundle(bundleId);
          }
          return;
        }

        // Bundle modal events
        if (target.id === 'close-bundle-modal' || target.id === 'bundle-modal-backdrop' || target.id === 'cancel-bundle-edit') {
          closeBundleModal();
          return;
        }

        // View order
        if (target.closest('.view-order-btn')) {
          const btn = target.closest('.view-order-btn');
          const orderId = btn.dataset.orderId;
          const orderType = btn.dataset.orderType;
          // API orders live in a different table and have their own modal/fetch path
          if (orderType === 'api') {
            viewApiOrder(orderId, btn);   // pass btn so viewApiOrder reads dataset directly
          } else {
            openOrderDetails(orderId, orderType);
          }
          return;
        }

        // Update order status
        if (target.id === 'update-order-status') {
          const newStatus = document.getElementById('status-update-select').value;
          updateOrderStatus(newStatus);
          return;
        }

        // Edit balance
        if (target.closest('.edit-balance-btn')) {
          const btn = target.closest('.edit-balance-btn');
          const userId = btn.dataset.userId;
          const userName = btn.dataset.userName;
          const userBalance = btn.dataset.userBalance;
          openBalanceEditModal(userId, userName, userBalance);
          return;
        }

        // Balance action buttons
        if (target.closest('.balance-action-btn')) {
          const btn = target.closest('.balance-action-btn');
          document
            .querySelectorAll('.balance-action-btn')
            .forEach((b) => {
              b.classList.remove(
                'bg-brand-100',
                'border-brand-500',
                'text-brand-700'
              );
            });
          btn.classList.add(
            'bg-brand-100',
            'border-brand-500',
            'text-brand-700'
          );

          state.currentAction = btn.dataset.action;
          updateBalancePreview();
          return;
        }

        // Confirm balance edit
        if (target.id === 'confirm-balance-edit') {
          const action = state.currentAction;
          const amount = document.getElementById('balance-amount').value;
          const reason = document.getElementById('balance-reason').value;

          if (!action) {
            showToast('Please select an action type', 'warning');
            return;
          }

          if (!amount || parseFloat(amount) <= 0) {
            showToast('Please enter a valid amount', 'warning');
            return;
          }

          if (
            confirm(
              `Are you sure you want to ${action} ${formatCurrency(
                amount
              )} to this user's balance?`
            )
          ) {
            updateUserBalance(action, amount, reason);
          }
          return;
        }

       // Manual deposit approve/decline
        if (target.closest('.approve-manual-deposit-btn')) {
          const depositId = target.closest('.approve-manual-deposit-btn').dataset.depositId;
          if (confirm('Approve this deposit and credit the user wallet?')) {
            approveManualDeposit(depositId);
          }
          return;
        }

        if (target.closest('.decline-manual-deposit-btn')) {
          const depositId = target.closest('.decline-manual-deposit-btn').dataset.depositId;
          declineManualDeposit(depositId);
          return;
        }

        // Modal close buttons
        if (
          target.id === 'modal-close' ||
          target.id === 'modal-backdrop' ||
          target.id === 'close-order-modal'
        ) {
          closeModal('order-details-modal');
          return;
        }

        if (
          target.id === 'close-balance-modal' ||
          target.id === 'balance-modal-backdrop' ||
          target.id === 'cancel-balance-edit'
        ) {
          closeModal('balance-edit-modal');
          return;
        }

        if (
          target.id === 'close-api-order-modal' ||
          target.id === 'close-api-order-modal-footer' ||
          target.id === 'api-order-modal-backdrop'
        ) {
          closeModal('api-order-detail-modal');
          return;
        }

// Logout button
if (target.closest('#logout-btn')) {
  // v4: adminLogout() calls admin-auth Edge Function (action:'logout') which:
  //   1. Reads the session_id from the HttpOnly cookie (JS cannot do this)
  //   2. Loads the access_token from the admin_sessions DB row
  //   3. Calls supabase.auth.signOut() server-side — token revoked IMMEDIATELY
  //   4. Deletes the admin_sessions row — session cannot be replayed
  //   5. Clears the HttpOnly cookie via Set-Cookie: Max-Age=0
  //
  // After this, there is NO valid credential anywhere:
  //   - No token in JS memory (we never held one)
  //   - No token in storage (we never wrote one)
  //   - No valid session cookie (cleared by the server)
  //   - No valid server-side session (DB row deleted, Supabase token revoked)
  _adminReady = false;
  adminLogout().finally(() => {
    const overlay    = document.getElementById('loading-overlay');
    const spinner    = document.getElementById('admin-spinner');
    const loginPanel = document.getElementById('admin-login-panel');
    if (overlay) { overlay.style.display = ''; overlay.style.opacity = '1'; }
    if (spinner) spinner.classList.add('hidden');
    if (loginPanel) {
      loginPanel.classList.remove('hidden');
      const e = document.getElementById('admin-email');
      const p = document.getElementById('admin-password');
      if (e) e.value = '';
      if (p) p.value = '';
      setTimeout(() => { if (e) e.focus(); }, 50);
    }
  });
  return;
}
      });
    }

   // Initialize Admin
    async function init() {
      try {
        console.log('Starting admin initialization...');

        // v4: Zero-credential architecture.
        // tryRestoreSession() POSTs to admin-auth/verify with credentials:'include'.
        // The browser automatically sends the HttpOnly session cookie.
        // The Edge Function reads the cookie, looks up the session in the DB,
        // auto-refreshes the access token if needed, and returns the user profile.
        // The browser receives ONLY profile data — no token is ever returned here.
        const restoredUser = await tryRestoreSession();

        if (!restoredUser) {
          // No valid session cookie, or cookie exists but session row is gone/expired.
          // Show the embedded login form — admin must authenticate.
          showAdminLoginForm();
          return;
        }

        console.log('Session restored from HttpOnly cookie — verifying profile...');
        state.user = { email: restoredUser.email };

        // Role is already verified server-side by admin-auth/verify and returned
        // in restoredUser. No second proxy call needed — that was causing a 403
        // because admin-proxy requires a fully established session to forward
        // requests, and the profile fetch was racing against session setup.
        const profile = {
          role:     restoredUser.role,
          fullname: restoredUser.fullname || restoredUser.email,
          email:    restoredUser.email,
        };

        if (profile.role !== 'admin' && profile.role !== 'superadmin') {
          console.log('Non-admin session — showing access denied');
          // Immediately revoke — non-admins should not hold a session at all.
          await adminLogout().catch(() => {});
          const ol = elements.loadingOverlay;
          ol.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#f8fafc;display:flex;align-items:center;justify-content:center;pointer-events:auto;';
          ol.innerHTML = `
            <div style="text-align:center;padding:2rem;max-width:360px;width:100%;">
              <div style="width:64px;height:64px;border-radius:50%;background:#fee2e2;display:flex;align-items:center;justify-content:center;margin:0 auto 1.25rem;">
                <i class="fas fa-ban" style="font-size:1.75rem;color:#ef4444;"></i>
              </div>
              <h2 style="font-size:1.25rem;font-weight:700;color:#1e293b;margin-bottom:0.5rem;">Access Denied</h2>
              <p style="font-size:0.875rem;color:#64748b;margin-bottom:1.5rem;">You do not have admin privileges.</p>
              <button onclick="window.location.href='dashboard.html'"
                style="display:inline-flex;align-items:center;gap:0.5rem;background:#0284c7;color:#fff;font-weight:600;font-size:0.875rem;padding:0.75rem 1.5rem;border-radius:0.5rem;border:none;cursor:pointer;">
                <i class="fas fa-arrow-left" style="font-size:0.8rem;"></i>
                Go to User Dashboard
              </button>
            </div>
          `;
          return;
        }


        console.log('User is admin, proceeding with initialization');
        _adminReady = true; // unlock data-loading functions
        window._adminRole = profile?.role ?? 'admin'; // used by security logs clear button
        // Show clear button if superadmin
        const secClearBtn = document.getElementById('sec-clear-btn');
        if (secClearBtn && profile?.role === 'superadmin') secClearBtn.classList.remove('hidden');


        const adminName = profile.fullname || state.user.email;
        const sidebarName = document.getElementById('sidebar-admin-name');
        const desktopName = document.getElementById('desktop-admin-name');
        const mobileName = document.getElementById('mobile-admin-name');
        if (sidebarName) sidebarName.textContent = adminName;
        if (desktopName) desktopName.textContent = adminName;
        if (mobileName) mobileName.textContent = adminName;


        // Guard setupEventListeners — must only run once even if init() is called twice (login flow).
        if (!state._listenersBound) {
          state._listenersBound = true;
          console.log('Setting up event listeners...');
          setupEventListeners();
        }

        // ── Hide the loading overlay immediately — admin is verified ──────────
        // Dashboard data loads in the background; no need to block the UI.
        if (elements.loadingOverlay) {
          elements.loadingOverlay.style.transition = 'opacity 0.25s ease';
          elements.loadingOverlay.style.opacity = '0';
          setTimeout(() => {
            elements.loadingOverlay.style.display = 'none';
          }, 260);
        }

        // Real-time: notify admin instantly when a new store is unlocked.
        // Guard with _realtimeBound so init() being called twice (login flow)
        // never tries to subscribe the same channel twice.
        if (!state._realtimeBound) {
          state._realtimeBound = true;
          supabaseClient
            .channel('new-stores')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'stores' }, async (payload) => {
              console.log('New store unlocked:', payload.new);
              const name = payload.new.name || 'A user';
              showToast(name + ' just unlocked a reseller store! Check Manage Stores.', 'success');
            })
            .subscribe();
        }

        // Load dashboard data in the background (non-blocking)
        console.log('Loading dashboard data in background...');
        loadDashboardData().catch(e => console.error('Dashboard load error:', e));
        startSecurityLogPolling(); // real-time threat monitoring
        console.log('Admin initialization completed successfully');
      } catch (error) {
        console.error('Admin initialization error:', error);
        elements.loadingOverlay.innerHTML = `
          <div class="text-center">
            <i class="fas fa-exclamation-triangle text-3xl text-red-500 mb-4"></i>
            <p class="text-slate-600 font-medium mb-2">Failed to load admin portal</p>
            <p class="text-slate-500 text-sm mb-4">${
              error.message || 'Unknown error'
            }</p>
            <button onclick="window.location.reload()" class="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium">
              Refresh Page
            </button>
          </div>
        `;
      }
      
      // ✅ WITHDRAWAL FILTER BUTTON SETUP (ADDED HERE)
      setTimeout(() => {
        document.querySelectorAll('.withdrawal-filter-btn').forEach(btn => {
          btn.addEventListener('click', function () {
            currentWithdrawalFilter = this.dataset.status;
            document.querySelectorAll('.withdrawal-filter-btn').forEach(b => {
              b.classList.remove('bg-brand-600', 'text-white');
              b.classList.add('text-slate-600', 'hover:bg-slate-100');
            });
            this.classList.add('bg-brand-600', 'text-white');
            this.classList.remove('text-slate-600', 'hover:bg-slate-100');
            loadWithdrawals();
          });
        });
      }, 1000);
      
    }
    
  async function loadStoreSales() {
  try {
   // Server handles order queries and applies required filters.
    const activeFilter = document.querySelector('.store-filter-tab.active[data-store-filter]');
    const filterStatus = activeFilter?.dataset.storeFilter || 'all';

    const res = await _adminFetch('admin-manage-orders', {
        action: 'list',
        pageSize: 500,
        page: 1,
        prefixFilter: 'STORE',
        ...(filterStatus !== 'all' ? { status: filterStatus } : {}),
      });
    const result = await res.json();
    if (!result.success) throw new Error(result.message);

    // Client-side guard: only STORE- rows (defence-in-depth)
    state.storeSales = (result.orders || []).filter(o =>
      (o.order_reference || '').startsWith('STORE-')
    );
    state.storeSalesPage = 1;
    renderStoreSales();
  } catch (error) {
    console.error('❌ Error loading store sales:', error);
    const tbody = document.getElementById('store-sales-body');
    if (tbody) tbody.innerHTML = `
      <tr><td colspan="7" class="px-5 py-8 text-center text-red-500">
        <i class="fas fa-exclamation-triangle text-3xl mb-2"></i>
        <p class="font-medium mb-2">Failed to load store sales</p>
        <p class="text-sm text-slate-500">${esc(error.message)}</p>
      </td></tr>`;
    showToast('Failed to load store sales', 'error');
  }
}

  function renderStoreSales() {
    const tbody   = document.getElementById('store-sales-body');
    const startEl = document.getElementById('store-sales-start');
    const endEl   = document.getElementById('store-sales-end');
    const totalEl = document.getElementById('store-sales-total');
    const prevBtn = document.getElementById('store-sales-prev');
    const nextBtn = document.getElementById('store-sales-next');
    const badgeEl = document.getElementById('store-sales-count');
    const statEl  = document.getElementById('store-sales-stat');

    if (!tbody) return;

    const all   = state.storeSales || [];
    const total = all.length;
    const page  = state.storeSalesPage || 1;
    const start = (page - 1) * state.pageSize;
    const end   = Math.min(start + state.pageSize, total);
    const pageData = all.slice(start, end);

    if (startEl) startEl.textContent = total > 0 ? start + 1 : 0;
    if (endEl)   endEl.textContent   = end;
    if (totalEl) totalEl.textContent = total;
    if (prevBtn) prevBtn.disabled    = page <= 1;
    if (nextBtn) nextBtn.disabled    = end >= total;
    if (badgeEl) { badgeEl.textContent = total; badgeEl.classList.toggle('hidden', total === 0); }
    if (statEl)  statEl.textContent  = total;

    const totalProfit = all.reduce((sum, s) => {
      const ext     = s.external_response || {};
      const selling = parseFloat(ext.selling_price ?? s.amount ?? 0);
      const rawCost = ext.base_cost;
      const cost    = rawCost != null ? parseFloat(rawCost) : null;
      const saved   = ext.profit != null ? parseFloat(ext.profit) : null;

      // If both cost and profit are null (webhook-recovery order not yet resolved),
      // we have no reliable data — exclude from total rather than show selling price.
      if (cost === null && saved === null) return sum;

      const costVal = cost ?? 0;
      // A saved profit equal to the full selling price is a data-corruption artifact
      // (base_cost was 0 when the Edge Function ran). Recalculate from base_cost.
      const corrupted = saved !== null && costVal > 0 && saved === selling;
      const rowProfit = (saved !== null && !corrupted)
        ? (saved > 0 ? saved : Math.max(0, selling - costVal))
        : Math.max(0, selling - costVal);
      return sum + rowProfit;
    }, 0);
    const profitEl = document.getElementById('total-profits');
    if (profitEl) profitEl.textContent = `GH₵${totalProfit.toFixed(2)}`;

    if (pageData.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="px-5 py-8 text-center text-slate-400">
            <i class="fas fa-store text-3xl mb-2 opacity-30"></i>
            <p class="text-slate-600 font-medium mb-2">No store sales found</p>
            <p class="text-slate-500 text-sm">Sales via user store links (STORE- prefix) appear here</p>
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = pageData.map(sale => {
      const ext          = sale.external_response || {};
      // Server enriches response with related store data.
      const ownerProfile = sale.store_owner || sale.users;
      const ownerName    = ownerProfile?.fullname || ownerProfile?.email || 'Unknown Store';
      const ownerPhone   = ownerProfile?.phone || '';
      const sellingPrice = parseFloat(ext.selling_price ?? sale.amount ?? 0);
      const rawCost      = ext.base_cost;
      const baseCost     = rawCost != null ? parseFloat(rawCost) : null;
      const savedProfit  = ext.profit != null ? parseFloat(ext.profit) : null;

      // Webhook-recovery orders with no cost data — profit is genuinely unknown
      // until admin resolves them. Show "—" rather than a misleading number.
      const profitUnknown = baseCost === null && savedProfit === null;

      // A saved profit equal to the full selling price is a data-corruption artifact —
      // it means base_cost was 0 or missing when the Edge Function saved the order.
      const costVal         = baseCost ?? 0;
      const profitCorrupted = !profitUnknown && savedProfit !== null && costVal > 0 && savedProfit === sellingPrice;
      const profit = profitUnknown
        ? null
        : (savedProfit !== null && !profitCorrupted)
          ? (savedProfit > 0 ? savedProfit : Math.max(0, sellingPrice - costVal))
          : Math.max(0, sellingPrice - costVal);

      return `
      <tr class="hover:bg-slate-50">
        <td class="px-5 py-4">
          <p class="text-sm font-medium text-slate-900">${esc(sale.order_reference)}</p>
          <p class="text-xs text-slate-500">${formatDate(sale.created_at)}</p>
          ${ext.manual_fallback ? '<span class="text-xs text-orange-500 font-semibold">Manual</span>' : ''}
        </td>
        <td class="px-5 py-4">
          <p class="text-sm text-slate-700">${esc(ownerName)}</p>
          <p class="text-xs text-slate-500">${esc(ownerPhone)}</p>
        </td>
        <td class="px-5 py-4">
          <p class="text-sm text-slate-700">${esc((sale.network || '').toUpperCase())} ${esc(String(sale.package_size || ''))}GB</p>
        </td>
        <td class="px-5 py-4 text-sm text-slate-600">${esc(sale.recipient || 'N/A')}</td>
        <td class="px-5 py-4 text-sm font-medium text-slate-800">
          <p>GH₵${sellingPrice.toFixed(2)}</p>
          <p class="text-xs text-slate-400 mt-0.5">Cost: ${baseCost !== null ? `GH₵${baseCost.toFixed(2)}` : '<span class="text-orange-400">Unknown</span>'}</p>
        </td>
        <td class="px-5 py-4 text-sm font-bold ${profit !== null && profit > 0 ? 'text-green-600' : profit === null ? 'text-orange-400' : 'text-slate-400'}">
          ${profit !== null ? `GH₵${profit.toFixed(2)}` : '—'}
        </td>
        <td class="px-5 py-4">
          <span class="px-2.5 py-1 rounded-full text-xs font-medium ${
            sale.status === 'completed'  ? 'bg-green-100 text-green-800'  :
            sale.status === 'pending'    ? 'bg-yellow-100 text-yellow-800':
            sale.status === 'processing' ? 'bg-blue-100 text-blue-800'   :
            'bg-slate-100 text-slate-800'
          }">
            ${esc((sale.status || 'pending').charAt(0).toUpperCase() + (sale.status || 'pending').slice(1))}
          </span>
        </td>
      </tr>`;
    }).join('');
  }


async function loadUserOrders() {
  try {
    // Server handles transaction queries and applies required filtering rules.
    const activeFilter = document.querySelector('.user-order-filter-tab.active[data-user-order-filter]');
    const filterStatus = activeFilter?.dataset.userOrderFilter || 'all';

    const res = await _adminFetch('admin-manage-orders', {
        action: 'list',
        pageSize: 500,
        page: 1,
        prefixFilter: 'TXN',
        ...(filterStatus !== 'all' ? { status: filterStatus } : {}),
      });
    const result = await res.json();
    if (!result.success) throw new Error(result.message);

    // Client-side guard: only TXN- rows (defence-in-depth)
    state.userOrders = (result.orders || []).filter(o =>
      (o.order_reference || '').startsWith('TXN-')
    );
    state.userOrdersPage = 1;
    renderUserOrders();
  } catch (error) {
    console.error('Error loading user orders:', error);
    const tbody = document.getElementById('user-orders-body');
    if (tbody) tbody.innerHTML = `
      <tr><td colspan="8" class="px-5 py-8 text-center text-red-500">
        <i class="fas fa-exclamation-triangle text-3xl mb-2"></i>
        <p class="font-medium mb-2">Failed to load user orders</p>
        <p class="text-sm text-slate-500">${esc(error.message)}</p>
      </td></tr>`;
    showToast('Failed to load user orders', 'error');
  }
}

  function renderUserOrders() {
    const tbody   = document.getElementById('user-orders-body');
    const startEl = document.getElementById('user-orders-start');
    const endEl   = document.getElementById('user-orders-end');
    const totalEl = document.getElementById('user-orders-total');
    const prevBtn = document.getElementById('user-orders-prev');
    const nextBtn = document.getElementById('user-orders-next');
    const badgeEl = document.getElementById('user-orders-count');
    const statEl  = document.getElementById('user-orders-stat');

    if (!tbody) return;

    const all   = state.userOrders || [];
    const total = all.length;
    const page  = state.userOrdersPage || 1;
    const start = (page - 1) * state.pageSize;
    const end   = Math.min(start + state.pageSize, total);
    const pageData = all.slice(start, end);

    if (startEl) startEl.textContent = total > 0 ? start + 1 : 0;
    if (endEl)   endEl.textContent   = end;
    if (totalEl) totalEl.textContent = total;
    if (prevBtn) prevBtn.disabled    = page <= 1;
    if (nextBtn) nextBtn.disabled    = end >= total;
    if (badgeEl) { badgeEl.textContent = total; badgeEl.classList.toggle('hidden', total === 0); }
    if (statEl)  statEl.textContent  = total;

    if (pageData.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="px-5 py-8 text-center text-slate-400">
            <i class="fas fa-user-check text-2xl mb-2 opacity-30"></i>
            <p class="text-slate-600 font-medium mb-2">No user orders found</p>
            <p class="text-slate-500 text-sm">Orders placed by logged-in users (TXN- prefix) appear here</p>
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = pageData.map(order => {
      const statusClass = `status-${(order.status || 'unknown').toLowerCase().replace(/\s+/g, '-')}`;
      const userName = order.users?.fullname || order.users?.email || 'Registered User';
      return `
        <tr class="hover:bg-slate-50">
          <td class="px-5 py-4">
            <div class="text-sm font-medium text-slate-900">${esc(order.order_reference || `TXN-${(order.id||'').substring(0,8)}`)}</div>
            <div class="text-xs text-slate-500">${formatDate(order.created_at)}</div>
          </td>
          <td class="px-5 py-4">
            <div class="text-sm text-slate-700">${esc(userName)}</div>
            <div class="text-xs text-slate-400">${esc(order.users?.phone || '')}</div>
          </td>
          <td class="px-5 py-4 text-sm text-slate-700">
            <span class="px-2 py-1 rounded text-xs ${(order.network || '').toLowerCase()}-bg text-white">
              ${esc((order.network || '').toUpperCase())}
            </span>
          </td>
          <td class="px-5 py-4 text-sm text-slate-700">
            ${esc(order.description || ((order.network||'').toUpperCase() + ' ' + (order.package_size||'') + 'GB'))}
          </td>
          <td class="px-5 py-4 text-sm text-slate-600 hidden md:table-cell">${esc(order.recipient || 'N/A')}</td>
          <td class="px-5 py-4 whitespace-nowrap text-sm font-medium text-slate-800">${formatCurrency(order.amount)}</td>
          <td class="px-5 py-4 whitespace-nowrap">
            <span class="px-2.5 py-1 rounded-full text-xs font-medium ${statusClass}">
              ${esc((order.status||'pending').charAt(0).toUpperCase() + (order.status||'pending').slice(1))}
            </span>
          </td>
          <td class="px-5 py-4 whitespace-nowrap text-sm font-medium">
            <button class="text-brand-600 hover:text-brand-800 view-order-btn"
                    data-order-id="${esc(order.id)}"
                    data-order-type="user">
              View
            </button>
          </td>
        </tr>`;
    }).join('');
  }

async function loadUserProfits() {
  try {
    console.log('💰 Loading user profits (store owners only)...');

    const res = await _adminFetch('admin-manage-users', { action: 'get-reseller-profits' });
    const result = await res.json();
    if (!result.success) throw new Error(result.message || 'Failed to load profits');

    const tbody = document.getElementById('user-profits-body');
    if (!tbody) return;

    const usersWithSales = result.owners || [];

    if (!usersWithSales.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="px-5 py-8 text-center text-slate-400">
            <i class="fas fa-store text-3xl mb-2 opacity-30"></i>
            <p class="font-medium text-slate-600 mb-1">No store owners yet</p>
            <p class="text-sm text-slate-500">Only store owners appear here. Regular users are excluded.</p>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = usersWithSales.map(user => `
      <tr class="hover:bg-slate-50">
        <td class="px-5 py-4">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center text-green-600 flex-shrink-0">
              <i class="fas fa-store text-sm"></i>
            </div>
            <div>
              <p class="font-medium text-slate-800">${esc(user.fullname || 'No name')}</p>
              <p class="text-xs text-slate-500">${esc(user.email)}</p>
              ${user.store ? `<p class="text-xs text-green-600 font-medium mt-0.5"><i class="fas fa-link mr-1" style="font-size:9px"></i>${esc(user.store.name)}</p>` : ''}
            </div>
          </div>
        </td>
        <td class="px-5 py-4 text-sm font-semibold text-slate-700">${user.totalSales} order${user.totalSales !== 1 ? 's' : ''}</td>
        <td class="px-5 py-4">
          <p class="text-sm font-bold ${user.availableProfit > 0 ? 'text-green-600' : 'text-slate-400'}">GH₵${user.availableProfit.toFixed(2)}</p>
          <p class="text-xs text-slate-400 mt-0.5">Earned: GH₵${user.totalProfit.toFixed(2)} · Withdrawn: GH₵${user.totalWithdrawn.toFixed(2)}</p>
        </td>
        <td class="px-5 py-4 text-sm font-medium text-slate-800">GH₵${parseFloat(user.wallets?.balance || 0).toFixed(2)}</td>
        <td class="px-5 py-4">
          <button class="edit-balance-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-50 text-brand-700 border border-brand-200 hover:bg-brand-100 transition-colors"
            data-user-id="${esc(user.id)}"
            data-user-name="${esc(user.fullname || user.email)}"
            data-user-balance="${esc(String(user.wallets?.balance || 0))}">
            <i class="fas fa-wallet" style="font-size:11px"></i>Edit Balance
          </button>
        </td>
      </tr>
    `).join('');

    console.log('✅ User profits table populated with', usersWithSales.length, 'store owners');

  } catch (error) {
    console.error('❌ Error loading user profits:', error);
    const tbody = document.getElementById('user-profits-body');
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="px-5 py-8 text-center text-red-500">
            <i class="fas fa-exclamation-triangle text-3xl mb-2"></i>
            <p>Failed to load user profits</p>
            <p class="text-sm text-slate-400 mt-1">${esc(error.message)}</p>
          </td>
        </tr>
      `;
    }
  }
}

// Global variable for withdrawal filter
let currentWithdrawalFilter = 'pending';

 async function loadWithdrawals() {
  try {
    console.log('💸 Loading withdrawals with filter:', currentWithdrawalFilter);

    // Route through edge function for authorization and response enrichment.
    const res = await _adminFetch('admin-manage-withdrawals', {
        action: 'list',
        status: currentWithdrawalFilter !== 'all' ? currentWithdrawalFilter : undefined,
      });
    const result = await res.json();
    if (!result.success) throw new Error(result.message || 'Failed to load withdrawals');

    const withdrawals = result.withdrawals || [];
    // Normalise: edge function returns user_name, map to expected .users shape
    withdrawals.forEach(w => {
      if (!w.users && w.user_name) {
        w.users = { fullname: w.user_name, email: null, phone: null };
      }
    });

    console.log('✅ Withdrawals loaded:', withdrawals.length);

    const container = document.getElementById('withdrawals-list');
    if (!container) {
      console.error('❌ Element withdrawals-list not found');
      return;
    }

    // Update pending count badge
    const pendingCount = withdrawals?.filter(w => w.status === 'pending').length || 0;
    const countEl = document.getElementById('pending-withdrawals-count');
    if (countEl) {
      if (pendingCount > 0) {
        countEl.textContent = String(pendingCount);
        countEl.classList.remove('hidden');
      } else {
        countEl.classList.add('hidden');
      }
    }

    // Show empty state
    if (!withdrawals || withdrawals.length === 0) {
      container.innerHTML = `
        <div class="text-center py-12">
          <i class="fas fa-money-bill-transfer text-4xl text-slate-300 mb-4"></i>
          <p class="text-slate-600 font-medium mb-2">No ${currentWithdrawalFilter !== 'all' ? esc(currentWithdrawalFilter) : ''} withdrawal requests</p>
          <p class="text-slate-500 text-sm">Withdrawal requests will appear here</p>
        </div>
      `;
      return;
    }

    // Status colors
    const statusColors = {
      pending: 'bg-yellow-100 text-yellow-800',
      approved: 'bg-green-100 text-green-800',
      rejected: 'bg-red-100 text-red-800',
      completed: 'bg-blue-100 text-blue-800'    };

    // Render withdrawals
    container.innerHTML = withdrawals.map(w => `
      <div class="card p-5 hover:shadow-md transition-shadow">
        <div class="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <!-- User Info -->
          <div class="flex-1">
            <div class="flex items-center gap-3 mb-3">
              <div class="w-10 h-10 rounded-full bg-brand-100 flex items-center justify-center">
                <i class="fas fa-user text-brand-600"></i>
              </div>
              <div>
                <h4 class="font-bold text-slate-800">${esc(w.users?.fullname || 'Unknown')}</h4>
                <p class="text-sm text-slate-500">${esc(w.users?.email || 'N/A')}</p>
              </div>
              <span class="px-3 py-1 rounded-full text-xs font-medium ${statusColors[w.status] || 'bg-slate-100 text-slate-800'}">
                ${esc(w.status.toUpperCase())}
              </span>
            </div>
            
            <!-- Details Grid -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <p class="text-xs text-slate-500">Amount</p>
                <p class="text-lg font-bold text-green-600">${formatCurrency(w.amount)}</p>
              </div>
              <div>
                <p class="text-xs text-slate-500">Phone</p>
                <p class="text-sm font-medium text-slate-800">${esc(w.recipient_account || 'N/A')}</p>
              </div>
              <div>
                <p class="text-xs text-slate-500">Network</p>
                <p class="text-sm font-medium text-slate-800">${esc(w.network || 'N/A')}</p>
              </div>
              <div>
                <p class="text-xs text-slate-500">Requested</p>
              <p class="text-sm text-slate-600">${formatDate(w.created_at)}</p>
              </div>
            </div>


          </div>

          <!-- Action Buttons -->
          <div class="flex flex-col gap-2 min-w-[150px]">
            ${w.status === 'pending' ? `
              <button data-action="approve-withdrawal" data-id="${esc(w.id)}" class="w-full bg-green-600 hover:bg-green-700 text-white font-medium py-2 px-4 rounded-lg text-sm">
                <i class="fas fa-check mr-2"></i>Approve
              </button>
              <button data-action="reject-withdrawal" data-id="${esc(w.id)}" class="w-full bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-4 rounded-lg text-sm">
                <i class="fas fa-times mr-2"></i>Reject
              </button>
            ` : ''}
            ${w.status === 'approved' ? `
              <button data-action="marksent-withdrawal" data-id="${esc(w.id)}" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg text-sm">
                <i class="fas fa-check-double mr-2"></i>Mark Sent
              </button>
            ` : ''}
              ${w.status === 'completed' ? `              <span class="text-green-600 text-sm font-medium">
                <i class="fas fa-check-circle mr-1"></i>Completed
              </span>
            ` : ''}
            ${w.status === 'rejected' ? `
              <span class="text-red-600 text-sm font-medium">
                <i class="fas fa-times-circle mr-1"></i>Rejected
              </span>
            ` : ''}
          </div>
        </div>
      </div>
    `).join('');

    console.log('✅ Withdrawals rendered');

  } catch (err) {
    console.error('❌ Error loading withdrawals:', err);
    showToast('Failed to load withdrawals', 'error');
  }
}




  // ═══════════════════════════════════════
    // CUSTOM PRICING MODULE
    // ═══════════════════════════════════════
    const customPricing = (() => {
   let allBundles    = [];
      let allUsers      = [];
      let allStores     = [];
      let selectedUser  = null;
      let selectedStore = null;
      let userPriceMap  = {};
      let storePriceMap = {};   // bundleId -> custom cost price
      let userNetFilter  = 'all';
      let storeNetFilter = 'all';
      const fmt = n => 'GH₵ ' + parseFloat(n || 0).toFixed(2);

      function netColor(n) {
        return { mtn: '#f59e0b', telecel: '#ef4444', airteltigo: '#3b82f6' }[n] || '#64748b';
      }

      function initTabs() {
        const tabUser  = document.getElementById('cp-tab-user');
        const tabStore = document.getElementById('cp-tab-store');
        const ACTIVE   = 'cp-tab px-5 py-2.5 text-sm font-semibold border-b-2 -mb-px';
        const setTab = which => {
          tabUser.className  = ACTIVE + (which==='user'  ? ' text-brand-600 border-brand-600' : ' text-slate-500 border-transparent hover:text-slate-700');
          tabStore.className = ACTIVE + (which==='store' ? ' text-green-600 border-green-600'  : ' text-slate-500 border-transparent hover:text-slate-700');
          document.getElementById('cp-panel-user').classList.toggle('hidden',  which !== 'user');
          document.getElementById('cp-panel-store').classList.toggle('hidden', which !== 'store');
        };
        tabUser?.addEventListener('click',  () => setTab('user'));
        tabStore?.addEventListener('click', () => setTab('store'));
      }

     async function loadMasterData() {
        const res = await _adminFetch('admin-manage-users', { action: 'get-master-data' });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);
        allBundles = result.bundles || [];
        allUsers   = result.users  || [];
        allStores  = result.stores || [];
      }

      function initUserSearch() {
        const input = document.getElementById('cp-user-search');
        const dd    = document.getElementById('cp-user-dropdown');
        if (!input) return;
        input.addEventListener('input', () => {
          const q = input.value.toLowerCase().trim();
          if (!q) { dd.classList.add('hidden'); return; }
          const hits = allUsers.filter(u =>
            (u.fullname||'').toLowerCase().includes(q) || (u.email||'').toLowerCase().includes(q)
          ).slice(0,8);
          if (!hits.length) { dd.classList.add('hidden'); return; }
          dd.innerHTML = hits.map(u => `
            <div class="cp-user-option px-4 py-3 hover:bg-brand-50 cursor-pointer border-b border-slate-100 last:border-0 flex items-center gap-3"
                 data-id="${esc(u.id)}" data-name="${esc(u.fullname||u.email)}" data-email="${esc(u.email||'')}">
              <div class="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-600 text-xs font-bold">
                ${esc((u.fullname||u.email||'U')[0].toUpperCase())}
              </div>
              <div>
                <p class="text-sm font-medium text-slate-800">${esc(u.fullname||'No name')}</p>
                <p class="text-xs text-slate-500">${esc(u.email||'')}</p>
              </div>
            </div>`).join('');
          dd.classList.remove('hidden');
        });
        dd.addEventListener('click', async e => {
          const opt = e.target.closest('.cp-user-option');
          if (!opt) return;
          selectedUser = { id: opt.dataset.id, name: opt.dataset.name, email: opt.dataset.email };
          input.value = '';
          dd.classList.add('hidden');
          document.getElementById('cp-selected-user').classList.remove('hidden');
          document.getElementById('cp-user-name-display').textContent  = selectedUser.name;
          document.getElementById('cp-user-email-display').textContent = selectedUser.email;
          document.getElementById('cp-user-avatar').textContent        = selectedUser.name[0].toUpperCase();
          document.getElementById('cp-user-bundle-name').textContent   = selectedUser.name;
          await loadUserBundles();
        });
        document.getElementById('cp-clear-user')?.addEventListener('click', () => {
          selectedUser = null; userPriceMap = {};
          document.getElementById('cp-selected-user').classList.add('hidden');
          document.getElementById('cp-user-bundles').classList.add('hidden');
          document.getElementById('cp-user-placeholder').classList.remove('hidden');
        });
        document.addEventListener('click', e => {
          if (!input.contains(e.target) && !dd.contains(e.target)) dd.classList.add('hidden');
        });
      }

      async function loadUserBundles() {
        if (!selectedUser) return;
        const res = await _adminFetch('admin-manage-users', { action: 'get-user-prices', userId: selectedUser.id });
        const result = await res.json();
        userPriceMap = {};
        (result.prices || []).forEach(r => { userPriceMap[r.bundle_id] = r.custom_price; });
        document.getElementById('cp-user-placeholder').classList.add('hidden');
        document.getElementById('cp-user-bundles').classList.remove('hidden');
        renderUserBundles();
      }

      function renderUserBundles() {
        const tbody = document.getElementById('cp-user-bundles-body');
        if (!tbody) return;
        const list = userNetFilter === 'all' ? allBundles : allBundles.filter(b => b.network === userNetFilter);
        tbody.innerHTML = list.map(b => {
          const custom = userPriceMap[b.id] ?? b.price;
          const diff   = custom - b.price;
          const diffHtml = diff === 0 ? '<span class="text-slate-400">-</span>'
            : diff < 0 ? `<span class="text-green-600 font-medium">-${fmt(Math.abs(diff))}</span>`
                       : `<span class="text-red-500 font-medium">+${fmt(diff)}</span>`;
          const has = userPriceMap[b.id] != null;
          return `<tr class="${has?'bg-brand-50/40':''}">
            <td class="px-4 py-3 font-medium text-slate-800">${b.size}GB <span class="text-xs text-slate-400">${esc(b.label||'')}</span></td>
            <td class="px-4 py-3"><span class="px-2 py-0.5 rounded-full text-xs font-semibold text-white" style="background:${netColor(b.network)}">${esc(b.network.toUpperCase())}</span></td>
            <td class="px-4 py-3 text-slate-600">${fmt(b.price)}</td>
            <td class="px-4 py-3">
              <div class="flex items-center gap-1">
                <span class="text-slate-500 text-xs">GH₵</span>
                <input type="number" step="0.01" min="0.01" value="${parseFloat(custom).toFixed(2)}"
                       class="cp-user-price-input w-24 px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-400"
                       data-bundle-id="${esc(b.id)}" data-base="${b.price}"/>
              </div>
            </td>
            <td class="px-4 py-3">${diffHtml}</td>
            <td class="px-4 py-3">${has
              ? `<button class="cp-reset-user-btn text-xs text-red-500 border border-red-200 px-2 py-1 rounded hover:bg-red-50" data-bundle-id="${b.id}">Reset</button>`
              : `<span class="text-xs text-slate-400">Base</span>`}</td>
          </tr>`;
        }).join('');

        tbody.querySelectorAll('.cp-user-price-input').forEach(inp => {
          inp.addEventListener('input', () => {
            userPriceMap[inp.dataset.bundleId] = parseFloat(inp.value)||0;
            const diff = (parseFloat(inp.value)||0) - parseFloat(inp.dataset.base);
            const cell = inp.closest('tr').querySelector('td:nth-child(5)');
            if (cell) cell.innerHTML = diff===0 ? '<span class="text-slate-400">-</span>'
              : diff<0 ? `<span class="text-green-600 font-medium">-GH₵ ${Math.abs(diff).toFixed(2)}</span>`
                       : `<span class="text-red-500 font-medium">+GH₵ ${diff.toFixed(2)}</span>`;
          });
        });

        tbody.querySelectorAll('.cp-reset-user-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            try {
              const res = await _adminFetch('admin-manage-users', { action: 'reset-bundle-price', userId: selectedUser.id, bundleId: btn.dataset.bundleId });
              const data = await res.json();
              if (data.success) { delete userPriceMap[btn.dataset.bundleId]; showToast('Reset to base','info'); renderUserBundles(); }
              else showToast('Reset failed: ' + data.message, 'error');
            } catch(e) { showToast('Reset failed: ' + e.message, 'error'); }
          });
        });
      }

      async function saveUserPrices() {
        if (!selectedUser) return;
        const prices = [];
        document.querySelectorAll('.cp-user-price-input').forEach(inp => {
          const np = parseFloat(inp.value);
          if (!isNaN(np) && np > 0 && np !== parseFloat(inp.dataset.base)) {
            prices.push({ bundle_id: inp.dataset.bundleId, custom_price: np });
          }
        });
        if (!prices.length) { showToast('No changes to save','info'); return; }
        try {
          const res = await _adminFetch('admin-manage-users', { action: 'set-bundle-prices', userId: selectedUser.id, prices });
          const data = await res.json();
          if (!data.success) throw new Error(data.message || 'Save failed');
          showToast(`Saved ${prices.length} price(s)`,'success');
          await loadUserBundles();
        } catch(e) { showToast('Save failed: '+e.message,'error'); }
      }

      async function resetAllUserPrices() {
        if (!selectedUser || !confirm('Reset ALL custom prices for '+selectedUser.name+'?')) return;
        const res = await _adminFetch('admin-manage-users', { action: 'set-bundle-prices', userId: selectedUser.id, prices: [] });
        const result = await res.json();
        if (result.success) { userPriceMap={}; showToast('All prices reset','info'); renderUserBundles(); }
        else showToast('Reset failed: ' + esc(result.message), 'error');
      }

     function initStoreSearch() {
        const input = document.getElementById('cp-store-search');
        const dd    = document.getElementById('cp-store-dropdown');
        if (!input) return;

        input.addEventListener('input', () => {
          const q = input.value.toLowerCase().trim();
          if (!q) { dd.classList.add('hidden'); return; }
          const hits = allStores.filter(s =>
            (s.name||'').toLowerCase().includes(q) ||
            (s.users?.fullname||'').toLowerCase().includes(q) ||
            (s.users?.email||'').toLowerCase().includes(q)
          ).slice(0, 8);
          if (!hits.length) { dd.classList.add('hidden'); return; }
          dd.innerHTML = hits.map(s => `
            <div class="cp-store-option px-4 py-3 hover:bg-green-50 cursor-pointer border-b border-slate-100 last:border-0 flex items-center gap-3"
                data-id="${s.id}" data-name="${esc(s.name)}"
                 data-owner-id="${esc(s.owner_id)}"
                 data-owner="${esc(s.users?.fullname || s.users?.email || 'Unknown')}">
              <div class="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center text-green-600 text-xs">
                <i class="fas fa-store"></i>
              </div>
              <div>
                <p class="text-sm font-medium text-slate-800">${esc(s.name)}</p>
                <p class="text-xs text-slate-500">Owner: ${esc(s.users?.fullname || s.users?.email || 'Unknown')}</p>
              </div>
            </div>`).join('');
          dd.classList.remove('hidden');
        });
        dd.addEventListener('click', async e => {
          const opt = e.target.closest('.cp-store-option');
          if (!opt) return;
          selectedStore = { id: opt.dataset.id, name: opt.dataset.name, owner: opt.dataset.owner, owner_id: opt.dataset.ownerId };
          input.value = '';
          dd.classList.add('hidden');
          document.getElementById('cp-selected-store').classList.remove('hidden');
          document.getElementById('cp-store-name-display').textContent  = selectedStore.name;
          document.getElementById('cp-store-owner-display').textContent = 'Owner: ' + selectedStore.owner;
          document.getElementById('cp-store-bundle-name').textContent   = selectedStore.name;
          await loadStoreBundles();
        });

        document.getElementById('cp-clear-store')?.addEventListener('click', () => {
          selectedStore = null;
          storePriceMap = {};
          document.getElementById('cp-selected-store').classList.add('hidden');
          document.getElementById('cp-store-bundles').classList.add('hidden');
          document.getElementById('cp-store-placeholder').classList.remove('hidden');
        });

        document.addEventListener('click', e => {
          if (!input.contains(e.target) && !dd.contains(e.target)) dd.classList.add('hidden');
        });
      }

      // Load this store's existing custom cost prices (keyed by bundle UUID)
      async function loadStoreBundles() {
        if (!selectedStore) return;
        const res = await _adminFetch('admin-manage-users', { action: 'get-user-prices', userId: selectedStore.owner_id });
        const result = await res.json();

        storePriceMap = {};
        (result.prices || []).forEach(r => { storePriceMap[r.bundle_id] = parseFloat(r.custom_price); });

        document.getElementById('cp-store-placeholder').classList.add('hidden');
        document.getElementById('cp-store-bundles').classList.remove('hidden');
        renderStoreBundles();
      }

      function renderStoreBundles() {
        const tbody = document.getElementById('cp-store-bundles-body');
        if (!tbody) return;
        const list = storeNetFilter === 'all'
          ? allBundles
          : allBundles.filter(b => b.network === storeNetFilter);

        tbody.innerHTML = list.map(b => {
          const custom   = storePriceMap[b.id] ?? b.price;
          const diff     = custom - b.price;
          const diffHtml = diff === 0
            ? '<span class="text-slate-400">—</span>'
            : diff < 0
              ? `<span class="text-green-600 font-medium">-${fmt(Math.abs(diff))}</span>`
              : `<span class="text-red-500 font-medium">+${fmt(diff)}</span>`;
          const has = storePriceMap[b.id] != null;

          return `<tr class="${has ? 'bg-green-50/40' : ''}">
            <td class="px-4 py-3 font-medium text-slate-800">${b.size}GB <span class="text-xs text-slate-400">${esc(b.label||'')}</span></td>
            <td class="px-4 py-3">
              <span class="px-2 py-0.5 rounded-full text-xs font-semibold text-white" style="background:${netColor(b.network)}">${esc(b.network.toUpperCase())}</span>
            </td>
            <td class="px-4 py-3 text-slate-600">${fmt(b.price)}</td>
            <td class="px-4 py-3">
              <div class="flex items-center gap-1">
                <span class="text-slate-500 text-xs">GH₵</span>
                <input type="number" step="0.01" min="0.01" value="${parseFloat(custom).toFixed(2)}"
                       class="cp-store-price-input w-24 px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-400 focus:border-green-400"
                       data-bundle-id="${esc(b.id)}" data-base="${b.price}"/>
              </div>
            </td>
            <td class="px-4 py-3">${diffHtml}</td>
            <td class="px-4 py-3">
              ${has
                ? `<button class="cp-reset-store-btn text-xs text-red-500 border border-red-200 px-2 py-1 rounded hover:bg-red-50"
                           data-bundle-id="${b.id}">Reset</button>`
                : `<span class="text-xs text-slate-400">Base</span>`}
            </td>
          </tr>`;
        }).join('');

        // Live diff update
        tbody.querySelectorAll('.cp-store-price-input').forEach(inp => {
          inp.addEventListener('input', () => {
            storePriceMap[inp.dataset.bundleId] = parseFloat(inp.value) || 0;
            const diff = (parseFloat(inp.value) || 0) - parseFloat(inp.dataset.base);
            const cell = inp.closest('tr').querySelector('td:nth-child(5)');
            if (cell) cell.innerHTML = diff === 0
              ? '<span class="text-slate-400">—</span>'
              : diff < 0
                ? `<span class="text-green-600 font-medium">-GH₵ ${Math.abs(diff).toFixed(2)}</span>`
                : `<span class="text-red-500 font-medium">+GH₵ ${diff.toFixed(2)}</span>`;
          });
        });

        // Reset individual to base
        tbody.querySelectorAll('.cp-reset-store-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            try {
              const res = await _adminFetch('admin-manage-users', { action: 'reset-bundle-price', userId: selectedStore.owner_id, bundleId: btn.dataset.bundleId });
              const data = await res.json();
              if (data.success) {
                delete storePriceMap[btn.dataset.bundleId];
                showToast('Reset to base price', 'info');
                renderStoreBundles();
              } else {
                showToast('Reset failed: ' + data.message, 'error');
              }
            } catch(e) { showToast('Reset failed: ' + e.message, 'error'); }
          });
        });
      }

      async function saveStorePrices() {
        if (!selectedStore) return;
        const prices = [];
        document.querySelectorAll('.cp-store-price-input').forEach(inp => {
          const np = parseFloat(inp.value);
          if (!isNaN(np) && np > 0 && np !== parseFloat(inp.dataset.base)) {
            prices.push({ bundle_id: inp.dataset.bundleId, custom_price: np });
          }
        });
        if (!prices.length) { showToast('No changes to save', 'info'); return; }
        try {
          const res = await _adminFetch('admin-manage-users', { action: 'set-bundle-prices', userId: selectedStore.owner_id, prices });
          const data = await res.json();
          if (!data.success) throw new Error(data.message || 'Save failed');
          showToast(`✅ Saved ${prices.length} store cost price(s)`, 'success');
          await loadStoreBundles();
        } catch (e) {
          showToast('Save failed: ' + e.message, 'error');
        }
      }

      async function resetAllStorePrices() {
        if (!selectedStore || !confirm('Reset ALL custom cost prices for ' + selectedStore.name + '?')) return;
        const res = await _adminFetch('admin-manage-users', { action: 'set-bundle-prices', userId: selectedStore.owner_id, prices: [] });
        const result = await res.json();
        if (result.success) {
          storePriceMap = {};
          showToast('All store cost prices reset to base', 'info');
          renderStoreBundles();
        } else {
          showToast('Failed to reset prices: ' + esc(result.message), 'error');
        }
      }
     function initNetFilters() {
        document.addEventListener('click', e => {
          const ub = e.target.closest('.cp-net-filter');
          if (ub) {
            userNetFilter = ub.dataset.net;
            document.querySelectorAll('.cp-net-filter').forEach(b => {
              b.className = b.dataset.net === userNetFilter
                ? 'cp-net-filter text-xs px-3 py-1.5 rounded-full bg-brand-600 text-white font-medium'
                : 'cp-net-filter text-xs px-3 py-1.5 rounded-full bg-white border border-slate-200 text-slate-600 hover:bg-slate-50';
            });
            renderUserBundles();
          }
          const sb = e.target.closest('.cp-store-net-filter');
          if (sb) {
            storeNetFilter = sb.dataset.snet;
            document.querySelectorAll('.cp-store-net-filter').forEach(b => {
              b.className = b.dataset.snet === storeNetFilter
                ? 'cp-store-net-filter text-xs px-3 py-1.5 rounded-full bg-green-600 text-white font-medium'
                : 'cp-store-net-filter text-xs px-3 py-1.5 rounded-full bg-white border border-slate-200 text-slate-600 hover:bg-slate-50';
            });
            renderStoreBundles();
          }
        });
      }

      async function init() {
        initTabs();
        initNetFilters();
        await loadMasterData();
        initUserSearch();
        initStoreSearch();
        document.getElementById('cp-save-user-prices')?.addEventListener('click',  saveUserPrices);
        document.getElementById('cp-reset-all-user')?.addEventListener('click',    resetAllUserPrices);
        document.getElementById('cp-save-store-prices')?.addEventListener('click', saveStorePrices);
        document.getElementById('cp-reset-all-store')?.addEventListener('click',   resetAllStorePrices);
      }

      return { init };
    })();

    async function loadCustomPricing() {
      await customPricing.init();
    }

    // Expose public methods

    // ── API Keys Page ──────────────────────────────────────────────────────────
    // All data fetched via _adminFetch() → admin-proxy → admin-manage-api-keys
    // Zero direct DB calls from the frontend.

    const apiKeysState = {
      keysPage:   1,
      ordersPage: 1,
      keysFilter: '',
      ordersStatusFilter: '',
      keysTotal:  0,
      ordersTotal: 0,
      keysWired:  false,
      ordersWired: false,
    };

    async function loadApiKeysPage() {
      await Promise.all([
        loadApiStats(),
        loadApiKeysTable(),
      ]);
      wireApiKeysEvents();
    }

    async function loadApiOrdersPage() {
      await Promise.all([
        loadApiOrdersStats(),
        loadApiOrdersTable(),
      ]);
      wireApiOrdersEvents();
    }

    async function loadApiStats() {
      try {
        const res  = await _adminFetch('admin-manage-api-keys', { action: 'get-stats' });
        const data = await res.json();
        if (!data.success) return;
        const s = data.stats;
        document.getElementById('apistat-total').textContent   = s.total_keys    ?? '—';
        document.getElementById('apistat-active').textContent  = s.active_keys   ?? '—';
      } catch (err) {
        console.error('[admin-api-keys] loadApiStats error:', err);
      }
    }

    async function loadApiOrdersStats() {
      try {
        const res  = await _adminFetch('admin-manage-api-keys', { action: 'get-stats' });
        const data = await res.json();
        if (!data.success) return;
        const s = data.stats;
        document.getElementById('apistat-orders').textContent    = s.total_orders    ?? '—';
        document.getElementById('apistat-pending').textContent   = s.pending_orders  ?? '—';
        document.getElementById('apistat-completed').textContent = s.completed_orders ?? '—';
        document.getElementById('apistat-failed').textContent    = s.failed_orders    ?? '—';
        // Update sidebar badge
        const badge = document.getElementById('api-orders-count');
        if (badge) {
          const pending = parseInt(s.pending_orders) || 0;
          if (pending > 0) { badge.textContent = pending; badge.classList.remove('hidden'); }
          else { badge.classList.add('hidden'); }
        }
      } catch (err) {
        console.error('[admin-api-orders] loadApiOrdersStats error:', err);
      }
    }

    async function loadApiKeysTable() {
      const tbody = document.getElementById('apikeys-table-body');
      if (!tbody) return;
      tbody.innerHTML = `<tr><td colspan="6" class="py-10 text-center text-slate-400"><i class="fas fa-spinner fa-spin text-xl mb-2 block"></i>Loading...</td></tr>`;

      try {
        const payload = { action: 'list', page: apiKeysState.keysPage, page_size: 20 };
        if (apiKeysState.keysFilter !== '') payload.is_active = apiKeysState.keysFilter;

        const res  = await _adminFetch('admin-manage-api-keys', payload);
        const data = await res.json();

        if (!data.success) {
          tbody.innerHTML = `<tr><td colspan="6" class="py-10 text-center text-red-400">Failed to load keys</td></tr>`;
          return;
        }

        apiKeysState.keysTotal = data.total ?? 0;
        const keys = data.keys ?? [];

        if (keys.length === 0) {
          tbody.innerHTML = `<tr><td colspan="6" class="py-12 text-center text-slate-400"><i class="fas fa-key text-3xl mb-2 block opacity-30"></i>No API keys found</td></tr>`;
          updateApiKeysPagination();
          return;
        }

        tbody.innerHTML = keys.map(k => {
          const user    = k.users ?? {};
          const name    = esc(user.fullname || user.email || 'Unknown');
          const email   = esc(user.email || '');
          const prefix  = esc(k.key_prefix || '—');
          const label   = esc(k.label || '—');
          const lastUsed = k.last_used_at
            ? new Date(k.last_used_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
            : 'Never';
          const isActive   = k.is_active;
          const statusBadge = isActive
            ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700">Active</span>`
            : `<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Revoked</span>`;
          const revokeBtn = isActive
            ? `<button onclick="admin.revokeApiKey('${esc(k.id)}')"
                 class="text-xs text-red-600 hover:text-red-800 font-medium px-2 py-1 rounded hover:bg-red-50 transition-colors">
                 <i class="fas fa-times-circle mr-1"></i>Revoke
               </button>`
            : `<span class="text-xs text-slate-400">—</span>`;

          return `<tr class="border-b border-slate-100 hover:bg-slate-50 transition-colors">
            <td class="py-3 px-2">
              <p class="font-medium text-slate-800 text-xs">${name}</p>
              <p class="text-xs text-slate-400">${email}</p>
            </td>
            <td class="py-3 px-2"><code class="text-xs font-mono bg-slate-100 px-2 py-1 rounded">${prefix}••••</code></td>
            <td class="py-3 px-2 text-slate-600 text-xs">${label}</td>
            <td class="py-3 px-2 text-slate-500 text-xs">${lastUsed}</td>
            <td class="py-3 px-2">${statusBadge}</td>
            <td class="py-3 px-2">${revokeBtn}</td>
          </tr>`;
        }).join('');

        updateApiKeysPagination();
      } catch (err) {
        console.error('[admin-api-keys] loadApiKeysTable error:', err);
        tbody.innerHTML = `<tr><td colspan="6" class="py-10 text-center text-red-400">Error loading keys</td></tr>`;
      }
    }

    async function loadApiOrdersTable() {
      const tbody = document.getElementById('apiorders-table-body');
      if (!tbody) return;
      tbody.innerHTML = `<tr><td colspan="8" class="px-5 py-8 text-center text-slate-400"><i class="fas fa-spinner fa-spin text-2xl mb-2 opacity-30"></i><p>Loading API orders...</p></td></tr>`;

      try {
        const activeFilter = document.querySelector('.api-order-filter-tab.active[data-api-order-filter]');
        const filterStatus = activeFilter?.dataset.apiOrderFilter || 'all';

        const payload = { action: 'get-orders', page: apiKeysState.ordersPage, page_size: 20 };
        if (filterStatus !== 'all') payload.status = filterStatus;

        const res  = await _adminFetch('admin-manage-api-keys', payload);
        const data = await res.json();

        if (!data.success) {
          tbody.innerHTML = `<tr><td colspan="8" class="px-5 py-8 text-center text-slate-400"><i class="fas fa-exclamation-circle text-2xl mb-2 opacity-30"></i><p>Failed to load orders</p></td></tr>`;
          return;
        }

        apiKeysState.ordersTotal = data.total ?? 0;
        const orders = data.orders ?? [];

        // Update count display
        const startEl = document.getElementById('apiorders-start');
        const endEl   = document.getElementById('apiorders-end');
        const totalEl = document.getElementById('apiorders-total');
        const page    = apiKeysState.ordersPage;
        const total   = apiKeysState.ordersTotal;
        const startN  = total > 0 ? (page - 1) * 20 + 1 : 0;
        const endN    = Math.min(page * 20, total);
        if (startEl) startEl.textContent = startN;
        if (endEl)   endEl.textContent   = endN;
        if (totalEl) totalEl.textContent = total;

        // Update sidebar badge with pending count
        const pendingCount = orders.filter(o => o.status === 'pending').length;
        const badge = document.getElementById('api-orders-count');
        if (badge) {
          if (pendingCount > 0) { badge.textContent = pendingCount; badge.classList.remove('hidden'); }
          else { badge.classList.add('hidden'); }
        }

        if (orders.length === 0) {
          tbody.innerHTML = `<tr><td colspan="8" class="px-5 py-8 text-center text-slate-400"><i class="fas fa-search text-2xl mb-2 opacity-30"></i><p>No orders found</p><p class="text-sm text-slate-500 mt-1">Try adjusting the filter</p></td></tr>`;
          updateApiOrdersPagination();
          return;
        }

        tbody.innerHTML = orders.map(o => {
          const user   = o.users ?? {};
          const ref    = esc(o.order_reference || `API-${(o.id||'').substring(0,8)}`);
          const net    = (o.network || 'unknown').toLowerCase();
          const netUp  = net.toUpperCase();
          const bundle = esc(o.description || `${netUp} ${o.size ?? o.package_size ?? ''}GB`);
          const phone  = esc(o.phone || o.recipient || '');
          const date   = formatDate(o.created_at);

          const statusClass = `status-${(o.status || 'pending').toLowerCase().replace(/\s+/g, '-')}`;
          const statusLabel = (o.status || 'pending').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

          return `
            <tr>
              <td class="px-5 py-4">
                <div class="text-sm font-medium text-slate-900">${ref}</div>
                <div class="text-xs text-slate-500">${esc(date)}</div>
              </td>
              <td class="px-5 py-4 text-sm text-slate-600">
                <div class="font-medium">${esc(user.fullname || user.email || 'API Reseller')}</div>
                <div class="text-xs text-slate-400">${esc(user.email || '')}</div>
              </td>
              <td class="px-5 py-4 text-sm text-slate-700">
                <span class="px-2 py-1 rounded text-xs ${net}-bg text-white">
                  ${esc(netUp)}
                </span>
              </td>
              <td class="px-5 py-4 text-sm text-slate-700">${bundle}</td>
              <td class="px-5 py-4 whitespace-nowrap text-sm font-medium text-slate-800 hidden md:table-cell">${phone}</td>
              <td class="px-5 py-4 whitespace-nowrap text-sm font-medium text-slate-800">
                ${formatCurrency(o.amount)}
              </td>
              <td class="px-5 py-4 whitespace-nowrap">
                <span class="px-2.5 py-1 rounded-full text-xs font-medium ${esc(statusClass)}">
                  ${esc(statusLabel)}
                </span>
              </td>
              <td class="px-5 py-4 whitespace-nowrap text-sm font-medium">
                <button class="text-brand-600 hover:text-brand-800 mr-3 view-order-btn"
                        data-order-id="${esc(o.id || '')}"
                        data-order-type="api"
                        data-order-ref="${esc(o.order_reference || '')}"
                        data-order-status="${esc(o.status || 'pending')}"
                        data-order-network="${esc(net)}"
                        data-order-amount="${esc(String(o.amount || 0))}"
                        data-order-description="${esc(o.description || '')}"
                        data-order-size="${esc(String(o.size ?? o.package_size ?? ''))}"
                        data-order-phone="${esc(o.phone || o.recipient || '')}"
                        data-order-date="${esc(o.created_at || '')}"
                        data-reseller-name="${esc(user.fullname || user.email || '')}"
                        data-reseller-email="${esc(user.email || '')}">
                  View
                </button>
              </td>
            </tr>
          `;
        }).join('');

        updateApiOrdersPagination();
      } catch (err) {
        console.error('[admin-api-orders] loadApiOrdersTable error:', err);
        tbody.innerHTML = `<tr><td colspan="8" class="px-5 py-8 text-center text-slate-400"><i class="fas fa-exclamation-circle text-2xl mb-2 opacity-30"></i><p>Error loading orders</p></td></tr>`;
      }
    }

    function updateApiKeysPagination() {
      const total = apiKeysState.keysTotal;
      const page  = apiKeysState.keysPage;
      const pages = Math.ceil(total / 20) || 1;
      const start = Math.min((page - 1) * 20 + 1, total);
      const end   = Math.min(page * 20, total);
      const info  = document.getElementById('apikeys-pagination-info');
      const prev  = document.getElementById('apikeys-prev');
      const next  = document.getElementById('apikeys-next');
      if (info) info.textContent = total > 0 ? `Showing ${start}–${end} of ${total} keys` : 'No keys found';
      if (prev) prev.disabled = page <= 1;
      if (next) next.disabled = page >= pages;
    }

    function updateApiOrdersPagination() {
      const total = apiKeysState.ordersTotal;
      const page  = apiKeysState.ordersPage;
      const pages = Math.ceil(total / 20) || 1;
      const prev  = document.getElementById('apiorders-prev');
      const next  = document.getElementById('apiorders-next');
      if (prev) prev.disabled = page <= 1;
      if (next) next.disabled = page >= pages;
    }

    async function adminRevokeApiKey(keyId) {
      if (!confirm('Revoke this API key? The reseller will lose access immediately.')) return;
      try {
        const res  = await _adminFetch('admin-manage-api-keys', { action: 'revoke', key_id: keyId });
        const data = await res.json();
        if (data.success) {
          showToast('API key revoked successfully', 'success');
          loadApiKeysTable();
          loadApiStats();
        } else {
          showToast(data.message || 'Failed to revoke key', 'error');
        }
      } catch (err) {
        console.error('[admin-api-keys] revokeApiKey error:', err);
        showToast('Error revoking key', 'error');
      }
    }

    function wireApiKeysEvents() {
      if (apiKeysState.keysWired) return;
      apiKeysState.keysWired = true;

      document.getElementById('apikeys-filter')?.addEventListener('change', (e) => {
        apiKeysState.keysFilter = e.target.value;
        apiKeysState.keysPage   = 1;
        loadApiKeysTable();
      });

      document.getElementById('apikeys-refresh')?.addEventListener('click', () => loadApiKeysPage());

      document.getElementById('apikeys-prev')?.addEventListener('click', () => {
        if (apiKeysState.keysPage > 1) { apiKeysState.keysPage--; loadApiKeysTable(); }
      });
      document.getElementById('apikeys-next')?.addEventListener('click', () => {
        const pages = Math.ceil(apiKeysState.keysTotal / 20) || 1;
        if (apiKeysState.keysPage < pages) { apiKeysState.keysPage++; loadApiKeysTable(); }
      });
    }

    function wireApiOrdersEvents() {
      if (apiKeysState.ordersWired) return;
      apiKeysState.ordersWired = true;

      document.getElementById('apiorders-status-filter')?.addEventListener('change', (e) => {
        apiKeysState.ordersStatusFilter = e.target.value;
        apiKeysState.ordersPage         = 1;
        loadApiOrdersTable();
      });

      document.getElementById('apiorders-refresh')?.addEventListener('click', () => loadApiOrdersPage());

      document.getElementById('apiorders-prev')?.addEventListener('click', () => {
        if (apiKeysState.ordersPage > 1) { apiKeysState.ordersPage--; loadApiOrdersTable(); }
      });
      document.getElementById('apiorders-next')?.addEventListener('click', () => {
        const pages = Math.ceil(apiKeysState.ordersTotal / 20) || 1;
        if (apiKeysState.ordersPage < pages) { apiKeysState.ordersPage++; loadApiOrdersTable(); }
      });

      document.getElementById('api-update-order-status')?.addEventListener('click', () => {
        const newStatus = document.getElementById('api-status-update-select')?.value;
        if (newStatus) updateApiOrderStatus(newStatus);
      });
    }

    async function viewApiOrder(orderId, btn) {
      // All order data is stored as data-* attributes on the clicked button,
      // so no extra fetch is needed. The admin-manage-api-keys edge function
      // does not implement get-order, and adding one just to re-fetch data we
      // already have would be wasteful. If btn is not passed, fall back to a
      // DOM query using the stored orderId.
      if (!orderId && !btn) return;
      try {
      const safeOrderId = esc(orderId);
        const b = btn || document.querySelector(`.view-order-btn[data-order-id="${safeOrderId}"]`);
        const d = b ? b.dataset : {};

        const net    = (d.orderNetwork || '').toUpperCase();
        const size   = d.orderSize ? `${d.orderSize}GB` : '—';
        const amount = parseFloat(d.orderAmount || 0).toFixed(2);
        const status = d.orderStatus || 'pending';
        const date   = d.orderDate
          ? new Date(d.orderDate).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
          : '—';

        document.getElementById('api-modal-order-name').textContent  = d.orderDescription || `${net} Data Bundle`;
        document.getElementById('api-modal-order-ref').textContent   = d.orderRef || orderId;
        document.getElementById('api-modal-order-amount').textContent = `GH₵${amount}`;
        document.getElementById('api-modal-order-status').textContent = status.charAt(0).toUpperCase() + status.slice(1);
        document.getElementById('api-modal-order-network').textContent = net || '—';
        document.getElementById('api-modal-order-size').textContent   = size;
        document.getElementById('api-modal-reseller-name').textContent = d.resellerName || '—';
        document.getElementById('api-modal-reseller-email').textContent = d.resellerEmail || '—';
        document.getElementById('api-modal-phone').textContent         = d.orderPhone || '—';
        document.getElementById('api-modal-order-date').textContent    = date;

        // Populate status select (exclude current status)
        const ALL_STATUSES = [
          { value: 'pending',    label: 'Pending' },
          { value: 'processing', label: 'Processing' },
          { value: 'completed',  label: 'Completed' },
          { value: 'failed',     label: 'Failed' },
        ];
        const currentStatus = status;
        const isCompleted = currentStatus === 'completed';
        const allowed = isCompleted
          ? ALL_STATUSES.filter(s => s.value === 'failed')
          : ALL_STATUSES.filter(s => s.value !== currentStatus);

        const select    = document.getElementById('api-status-update-select');
        const updateBtn = document.getElementById('api-update-order-status');
        const hint      = document.getElementById('api-status-update-hint');

        select.innerHTML = allowed.map(s => `<option value="${s.value}">${s.label}</option>`).join('');
        if (allowed.length > 0) {
          select.value = allowed[0].value;
          select.disabled = false;
          updateBtn.disabled = false;
          updateBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        } else {
          select.disabled = true;
          updateBtn.disabled = true;
          updateBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }
        if (hint) {
          hint.textContent = isCompleted
            ? '⚠️ Completed orders can only be moved to Failed.'
            : 'Update order status after manual fulfilment if needed.';
        }

        // Store current order id for update
        state._currentApiOrderId = orderId;

        document.getElementById('api-order-detail-modal').classList.remove('hidden');
      } catch (err) {
        console.error('[admin-api-orders] viewApiOrder error:', err);
        showToast('Failed to load order details', 'error');
      }
    }

    async function updateApiOrderStatus(newStatus) {
      const orderId = state._currentApiOrderId;
      if (!orderId) return;
      try {
   const res = await _adminFetch(
    'admin-manage-api-keys',
    {
        action: 'update-status',
        orderId,
        status: newStatus
    }
    );        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Failed to update status');
        showToast('Order status updated successfully', 'success');
        closeModal('api-order-detail-modal');
        loadApiOrdersPage();
      } catch (err) {
        console.error('[admin-api-orders] updateApiOrderStatus error:', err);
        showToast('Failed to update order status', 'error');
      }
    }

    return {
      navigateTo,
      init,
      loadStoreSales,
      loadUserOrders,
      loadUserProfits,
      loadWithdrawals,
      revokeApiKey: adminRevokeApiKey,
      viewApiOrder,
      updateApiOrderStatus,

      // ── Tab switcher ──────────────────────────────────────────────────────────
      switchOrphanTab: function(tab) {
        ['webhook-orphans', 'unprocessed-webhooks', 'legacy-scan'].forEach(t => {
          const panel = document.getElementById(`orphan-panel-${t}`);
          const btn   = document.getElementById(`tab-${t}`);
          if (!panel || !btn) return;
          if (t === tab) {
            panel.classList.remove('hidden');
            btn.classList.add('border-orange-500', 'text-orange-600');
            btn.classList.remove('border-transparent', 'text-slate-500');
          } else {
            panel.classList.add('hidden');
            btn.classList.remove('border-orange-500', 'text-orange-600');
            btn.classList.add('border-transparent', 'text-slate-500');
          }
        });
      },

      // ── Main scan — queries all three sources ─────────────────────────────────
      loadOrphanedPayments: async function() {
        const spinner = '<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-2xl text-orange-500 mb-3"></i><p class="text-slate-500">Scanning...</p></div>';
        const webhookContainer     = document.getElementById('orphaned-payments-list');
        const unprocessedContainer = document.getElementById('unprocessed-webhooks-list');
        const legacyContainer      = document.getElementById('legacy-orphan-list');
        if (webhookContainer)     webhookContainer.innerHTML     = spinner;
        if (unprocessedContainer) unprocessedContainer.innerHTML = spinner;
        if (legacyContainer)      legacyContainer.innerHTML      = spinner;

        // Consolidated server-side verification replaces multiple data checks.
        let orphans = [], events = null, legacyOrphaned = [];
        try {
          const res = await _adminFetch('admin-manage-orders', { action: 'get-orphaned-payments' });
          const result = await res.json();
          if (!result.success) throw new Error(result.message);
          orphans        = result.orphans        || [];
          events         = result.events;          // null = webhook_events table not yet created
          legacyOrphaned = result.legacyOrphaned  || [];
        } catch(err) {
          if (webhookContainer)     webhookContainer.innerHTML     = `<div class="text-center py-8 text-red-500"><p>Failed to load: ${esc(err.message)}</p></div>`;
          if (unprocessedContainer) unprocessedContainer.innerHTML = `<div class="text-center py-8 text-red-500"><p>Failed to load: ${esc(err.message)}</p></div>`;
          if (legacyContainer)      legacyContainer.innerHTML      = `<div class="text-center py-8 text-red-500"><p>Failed to load: ${esc(err.message)}</p></div>`;
          return;
        }

        // ── 1. webhook_orphans ────────────────────────────────────────────────────
        try {
          const count = orphans?.length || 0;
          const countBadge = document.getElementById('orphan-tab-count');
          if (countBadge) { countBadge.textContent = count; countBadge.classList.toggle('hidden', count === 0); }

          if (webhookContainer) {
            if (!count) {
              webhookContainer.innerHTML = '<div class="text-center py-8 text-green-600"><i class="fas fa-check-circle text-3xl mb-3"></i><p class="font-medium">No unresolved webhook orphans — all clear!</p></div>';
            } else {
              webhookContainer.innerHTML = orphans.map(o => {  // data already fetched above
                const pd   = o.paystack_data || {};
                const meta = pd.metadata || {};
                const amt  = parseFloat(o.amount || 0).toFixed(2);
                const reasonMap = {
                  wallet_topup_no_user:     '⚠️ Wallet top-up — user could not be identified',
                  wallet_rpc_failed:        '❌ Wallet credit failed (RPC error)',
                  adminorder_insert_failed: '❌ Order insert failed (DB error)',
                  user_order_missing:       '⚠️ Registered user order not in adminorders',
                  unknown_pattern:          '❓ Unknown payment reference pattern',
                };
                const reasonLabel = reasonMap[o.reason] || o.reason || 'Unknown reason';
                const email   = pd.customer?.email || meta.email || '—';
                const network = (meta.network || '').toUpperCase() || '—';
                const size    = meta.bundle_size || '—';

                const isWalletTopup = o.reference?.startsWith('WALLET-');
                const isUserOrder   = o.reference?.startsWith('TXN-');
                const isGuestOrder  = o.reference?.startsWith('GST-') || o.reference?.startsWith('STORE-') || o.reference?.startsWith('PAY-');

                const typeBadgeHtml = isWalletTopup
                  ? '<span class="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">💳 Wallet Deposit</span>'
                  : isUserOrder
                  ? '<span class="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">👤 User Order</span>'
                  : isGuestOrder
                  ? '<span class="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">🛍️ Guest/Store Order</span>'
                  : '<span class="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">❓ Unknown</span>';

                const noteHtml = isWalletTopup
                  ? '<p class="text-xs text-blue-600 bg-blue-50 rounded px-2 py-1 mt-2"><i class="fas fa-info-circle mr-1"></i>This is a wallet deposit — check if the user wallet was credited. If not, credit it via Users then mark resolved.</p>'
                  : isUserOrder
                  ? '<p class="text-xs text-purple-600 bg-purple-50 rounded px-2 py-1 mt-2"><i class="fas fa-info-circle mr-1"></i>User wallet was debited at purchase time. Find the adminorders entry and update its status.</p>'
                  : '';

                const networkDisplay = (network !== '—' && !isWalletTopup && !isUserOrder) ? ` · ${network} ${size}GB` : '';

                const actionBtnsHtml = isGuestOrder
                  ? `<button data-action="open-manual-order" data-ref="${esc(o.reference)}" data-amt="${esc(amt)}"
                       class="bg-orange-500 hover:bg-orange-600 text-white font-semibold px-3 py-2 rounded-lg text-xs whitespace-nowrap">
                       <i class="fas fa-plus mr-1"></i>Create Order
                     </button>
                     <button data-action="resolve-orphan" data-id="${esc(o.id)}" data-ref="${esc(o.reference)}"
                       class="bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold px-3 py-2 rounded-lg text-xs whitespace-nowrap">
                       <i class="fas fa-check mr-1"></i>Resolve
                     </button>`
                  : `<button data-action="resolve-orphan" data-id="${esc(o.id)}" data-ref="${esc(o.reference)}"
                       class="bg-slate-600 hover:bg-slate-700 text-white font-semibold px-3 py-2 rounded-lg text-xs whitespace-nowrap">
                       <i class="fas fa-check mr-1"></i>Mark Resolved
                     </button>`;

                return `
                  <div class="border border-orange-200 bg-orange-50 rounded-xl p-4 mb-3">
                    <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                          <p class="font-mono text-sm font-bold text-orange-800">${o.reference}</p>
                          ${typeBadgeHtml}
                          <span class="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">${o.reason || 'unknown'}</span>
                        </div>
                        <p class="text-sm text-slate-600 mt-1">
                          Amount: <span class="font-bold">GH₵${amt}</span>
                          ${email !== '—' ? ` · ${email}` : ''}
                          ${networkDisplay}
                          · <span class="text-slate-400">${new Date(o.created_at).toLocaleString()}</span>
                        </p>
                        <p class="text-xs text-orange-600 mt-1"><i class="fas fa-exclamation-triangle mr-1"></i>${reasonLabel}</p>
                        ${noteHtml}
                      </div>
                      <div class="flex gap-2 flex-shrink-0 flex-wrap justify-end">
                        ${actionBtnsHtml}
                      </div>
                    </div>
                  </div>`;
              }).join('');
            }
          }
        } catch(err) {
          if (webhookContainer) webhookContainer.innerHTML = `<div class="text-center py-8 text-red-500"><p>Failed to load webhook orphans: ${esc(err.message)}</p></div>`;
        }

        // ── 2. Unprocessed webhook_events — already fetched via edge function above ──
        try {
          const unprocessed = events; // null = webhook_events table not yet created

          const ucount = unprocessed?.length || 0;
          const uBadge = document.getElementById('unprocessed-tab-count');
          if (uBadge) { uBadge.textContent = ucount; uBadge.classList.toggle('hidden', ucount === 0); }

          if (unprocessedContainer) {
            if (!ucount) {
              unprocessedContainer.innerHTML = '<div class="text-center py-8 text-green-600"><i class="fas fa-check-circle text-3xl mb-3"></i><p class="font-medium">All webhook events have been processed.</p></div>';
            } else {
              unprocessedContainer.innerHTML = `
                <div class="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-700">
                  <i class="fas fa-exclamation-triangle mr-2"></i>
                  <strong>${ucount} event(s)</strong> received from Paystack but not yet fully processed by the webhook function. This may indicate a server error — check your edge function logs.
                </div>` +
                unprocessed.map(e => {
                  const amt = parseFloat(e.amount || 0).toFixed(2);
                  return `
                  <div class="border border-red-200 bg-red-50 rounded-xl p-4 mb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <p class="font-mono text-sm font-bold text-red-800">${e.reference}</p>
                      <p class="text-sm text-slate-600 mt-0.5">
                        Amount: <span class="font-bold">GH₵${amt}</span>
                        ${e.email ? ` · ${e.email}` : ''}
                        · <span class="text-slate-400">${new Date(e.created_at).toLocaleString()}</span>
                      </p>
                      <p class="text-xs text-red-600 mt-1"><i class="fas fa-clock mr-1"></i>Webhook received but not processed</p>
                    </div>
                    <button data-action="open-manual-order" data-ref="${esc(e.reference)}" data-amt="${esc(amt)}"
                      class="bg-red-500 hover:bg-red-600 text-white font-semibold px-4 py-2 rounded-lg text-sm whitespace-nowrap">
                      <i class="fas fa-plus mr-1"></i>Create Order
                    </button>
                  </div>`;
                }).join('');
            }
          }
        } catch(err) {
          if (unprocessedContainer) unprocessedContainer.innerHTML = `<div class="text-center py-8 text-orange-500"><p class="text-sm">webhook_events table not found yet — deploy the migration SQL first.</p></div>`;
        }

        // ── 3. Legacy cross-check — already computed via edge function above ─────────
        try {

          if (legacyContainer) {
            if (!legacyOrphaned.length) {
              legacyContainer.innerHTML = '<div class="text-center py-8 text-green-600"><i class="fas fa-check-circle text-3xl mb-3"></i><p class="font-medium">No missing guest/store orders — all paid references are recorded.</p></div>';
            } else {
              legacyContainer.innerHTML = `
                <p class="text-sm text-slate-500 mb-3">
                  <i class="fas fa-info-circle mr-1 text-blue-500"></i>
                  ${legacyOrphaned.length} guest/store payment(s) were charged but have no matching order record. Create each one manually.
                </p>` +
                legacyOrphaned.map(p => {
                  const amt = parseFloat(p.amount||0).toFixed(2);
                  return `
                  <div class="border border-orange-200 bg-orange-50 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
                    <div>
                      <div class="flex items-center gap-2">
                        <p class="font-mono text-sm font-bold text-orange-800">${p.reference}</p>
                        <span class="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">🛍️ Guest/Store order</span>
                      </div>
                      <p class="text-sm text-slate-600 mt-0.5">Amount: <span class="font-bold">GH₵${amt}</span> · ${new Date(p.created_at).toLocaleString()}</p>
                      <p class="text-xs text-orange-600 mt-1"><i class="fas fa-exclamation-triangle mr-1"></i>Payment received but no order recorded</p>
                    </div>
                    <button data-action="open-manual-order" data-ref="${esc(p.reference)}" data-amt="${esc(amt)}"
                      class="bg-orange-500 hover:bg-orange-600 text-white font-semibold px-4 py-2 rounded-lg text-sm whitespace-nowrap">
                      <i class="fas fa-plus mr-1"></i>Create Order
                    </button>
                  </div>`;
                }).join('');
            }
          }
        } catch(err) {
          if (legacyContainer) legacyContainer.innerHTML = `<div class="text-center py-8 text-red-500"><p>Failed: ${esc(err.message)}</p></div>`;
        }
      },

      // ── Mark an orphan as resolved ────────────────────────────────────────────
      resolveOrphan: async function(id, reference) {
        if (!confirm(`Mark orphan ${reference} as resolved? Only do this if you have manually handled this payment.`)) return;
        try {
          const res = await _adminFetch('admin-manage-orders', { action: 'resolve-orphan', orphanId: id });
          const result = await res.json();
          if (!result.success) throw new Error(result.message);
          showToast('✅ Orphan marked as resolved', 'success');
          admin.loadOrphanedPayments();
        } catch(err) {
          showToast('Failed to resolve: ' + esc(err.message), 'error');
        }
      },

      openManualOrderModal: async function(reference, amount) {
        const modal = document.getElementById('manual-order-modal');
        if (!modal) return;

        document.getElementById('mo-reference').value = reference;
        document.getElementById('mo-amount').value = parseFloat(amount).toFixed(2);
        document.getElementById('mo-phone').value = '';
        document.getElementById('mo-size').value = '';
        document.getElementById('mo-network').value = 'mtn';

        const phoneInput = document.getElementById('mo-phone');
        phoneInput.placeholder = 'Loading...';
        modal.classList.remove('hidden');
        modal.classList.add('flex');

        try {
          // Server handles order prefill logic through centralized endpoint.
          const res = await _adminFetch('admin-manage-orders', { action: 'get-order-prefill', reference });
          const result = await res.json();
          if (result.success && result.prefill) {
            const p = result.prefill;
            document.getElementById('mo-phone').value   = p.phone   || '';
            document.getElementById('mo-network').value = p.network || 'mtn';
            document.getElementById('mo-size').value    = p.size    || '';
          }
        } catch(e) {
          console.warn('Could not pre-fill order details:', e);
        } finally {
          phoneInput.placeholder = '0241234567';
        }
      },

      submitManualOrder: async function() {
        const reference = document.getElementById('mo-reference').value;
        const phone = document.getElementById('mo-phone').value.trim();
        const network = document.getElementById('mo-network').value;
        const size = parseInt(document.getElementById('mo-size').value);
        const amount = parseFloat(document.getElementById('mo-amount').value);
        if (!/^[0-9]{10}$/.test(phone)) { showToast('Enter a valid 10-digit phone number', 'error'); return; }
        if (!size || size <= 0) { showToast('Enter a valid bundle size', 'error'); return; }
        if (!amount || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }
        try {
         // Route through edge function for authorization and request processing.
          const res = await _adminFetch('admin-manage-orders', { action: 'create-manual', phone, network, size, amount, reference });
          const result = await res.json();
          if (!result.success) throw new Error(result.message || 'Failed to create order');
          document.getElementById('manual-order-modal').classList.add('hidden');
          showToast('✅ Manual order created!', 'success');
          admin.loadOrphanedPayments();
          loadPendingDeposits();
        } catch(err) { showToast('Failed: ' + esc(err.message), 'error'); }
      },
     approveWithdrawal: async function(id) {
    if (!confirm('Approve this withdrawal? You will need to send the money manually via Mobile Money.')) {
        return;
    }

    try {
        const res = await _adminFetch('admin-manage-withdrawals', { action: 'approve', id });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed to approve');

        showToast('✅ Approved! Send the money manually then click "Mark Sent"', 'success');
        loadWithdrawals();

    } catch (err) {
        console.error('❌ Error:', err);
        showToast(`Failed: ${esc(err.message)}`, 'error');
    }
},

rejectWithdrawal: async function(id) {
    const reason = prompt('Enter rejection reason:');
    if (!reason) return;

    try {
        const res = await _adminFetch('admin-manage-withdrawals', { action: 'reject', id });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed to reject');

        showToast('✅ Withdrawal rejected — profits remain available to user', 'success');
        loadWithdrawals();

    } catch (err) {
        console.error('❌ Error:', err);
        showToast(`Failed: ${esc(err.message)}`, 'error');
    }
},


   markWithdrawalProcessed: async function(id) {
    if (!confirm('Confirm that you have ALREADY SENT the money via Mobile Money?')) {
        return;
    }

    try {
       // Withdrawal processing uses a server-enforced state transition flow with auditing.
        const res = await _adminFetch('admin-manage-withdrawals', { action: 'mark-sent', id });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed to mark as sent');

        showToast('✅ Withdrawal completed!', 'success');
        loadWithdrawals();

    } catch (err) {
        console.error('❌ Error:', err);
        showToast(`Failed: ${esc(err.message)}`, 'error');
    }
}

    };

  })();


    // Make admin available globally for onclick handlers
    window.admin = admin;


    // ── Admin login form — registered ONCE before init() runs ───────────────
    // showAdminLoginForm() is called by init() when no memory session exists.
    // Registered here (not inside DOMContentLoaded callback) so it exists the
    // first time init() calls it. Uses an _loginBound flag so repeated calls
    // (e.g. after a failed login attempt) never stack duplicate event listeners.
    let _loginBound = false;
    window.showAdminLoginForm = function() {
      document.getElementById('admin-spinner').classList.add('hidden');
      document.getElementById('admin-login-panel').classList.remove('hidden');

      if (_loginBound) return; // listeners already attached — don't double-bind
      _loginBound = true;

      const emailEl    = document.getElementById('admin-email');
      const passwordEl = document.getElementById('admin-password');
      const btnEl      = document.getElementById('admin-login-btn');
      const btnText    = document.getElementById('admin-login-btn-text');
      const btnSpinner = document.getElementById('admin-login-spinner');
      const errorEl    = document.getElementById('admin-login-error');

      function showLoginError(msg) {
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
      }

      // ── Device fingerprint ────────────────────────────────────────────────
      function getDeviceFingerprint() {
        const nav = window.navigator;
        const scr = window.screen;
        const raw = [nav.userAgent, nav.language, nav.platform,
          scr.width + 'x' + scr.height, scr.colorDepth,
          new Date().getTimezoneOffset(),
          nav.hardwareConcurrency || 0, nav.maxTouchPoints || 0].join('|');
        let hash = 0;
        for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash) + raw.charCodeAt(i); hash |= 0; }
        return Math.abs(hash).toString(16);
      }

      // ── Step 1: Password check — triggers OTP send ────────────────────────
      async function doAdminLogin() {
        errorEl.classList.add('hidden');
        const email    = emailEl.value.trim();
        const password = passwordEl.value;

        if (!email || !password) {
          showLoginError('Please enter your email and password.');
          return;
        }

        btnEl.disabled = true;
        btnText.textContent = 'Signing in...';
        btnSpinner.classList.remove('hidden');

        try {
          const fingerprint = getDeviceFingerprint();
          const result = await adminLogin(email, password, { fingerprint, step: 'request-otp' });

          if (!result.success) {
            showLoginError(result.error || 'Invalid credentials.');
            return;
          }

          // Password correct — switch to OTP panel.
          // pending_id is an opaque server token; we pass it to step 2 instead
          // of re-sending credentials. Password is no longer needed and is NOT
          // stored anywhere after this point.
          const pendingId = result.pending_id;
          document.getElementById('admin-login-panel').classList.add('hidden');
          const otpPanel = document.getElementById('admin-otp-panel');
          if (otpPanel) otpPanel.classList.remove('hidden');
          const subtext = document.getElementById('otp-subtext');
          if (subtext && result.phone_hint) subtext.textContent = 'Enter the 6-digit code sent to ' + result.phone_hint;
          setupOTPVerification(pendingId, fingerprint);

        } catch (err) {
          showLoginError('An unexpected error occurred. Please try again.');
        } finally {
          btnEl.disabled = false;
          btnText.textContent = 'Sign In';
          btnSpinner.classList.add('hidden');
        }
      }

      // ── Step 2: OTP verification — grants portal access ───────────────────
      // Receives only the opaque pending_id from step 1 and the device
      // fingerprint. No password is held or transmitted in this step.
      function setupOTPVerification(pendingId, fingerprint) {
        const otpInput   = document.getElementById('admin-otp-input');
        const otpBtn     = document.getElementById('admin-otp-btn');
        const otpBtnText = document.getElementById('admin-otp-btn-text');
        const otpSpinner = document.getElementById('admin-otp-spinner');
        const otpError   = document.getElementById('admin-otp-error');
        const otpBack    = document.getElementById('admin-otp-back');

        if (otpInput) { otpInput.value = ''; setTimeout(() => otpInput.focus(), 100); }

        async function doVerifyOTP() {
          const code = otpInput?.value.trim();
          if (!code || code.length !== 6) {
            if (otpError) { otpError.textContent = 'Please enter the 6-digit code.'; otpError.classList.remove('hidden'); }
            return;
          }
          if (otpError) otpError.classList.add('hidden');
          if (otpBtn) otpBtn.disabled = true;
          if (otpBtnText) otpBtnText.textContent = 'Verifying...';
          if (otpSpinner) otpSpinner.classList.remove('hidden');
          try {
            // adminVerifyOTP sends action:'verify-otp' — no email or password
            const result = await adminVerifyOTP(pendingId, code, fingerprint);
            if (!result.success) {
              if (otpError) { otpError.textContent = result.error || 'Invalid or expired code.'; otpError.classList.remove('hidden'); }
              return;
            }
            document.getElementById('admin-otp-panel').classList.add('hidden');
            document.getElementById('admin-spinner').classList.remove('hidden');
            admin.init();
          } catch (err) {
            if (otpError) { otpError.textContent = 'Verification failed. Please try again.'; otpError.classList.remove('hidden'); }
          } finally {
            if (otpBtn) otpBtn.disabled = false;
            if (otpBtnText) otpBtnText.textContent = 'Verify & Sign In';
            if (otpSpinner) otpSpinner.classList.add('hidden');
          }
        }

        if (otpBtn) { otpBtn.onclick = null; otpBtn.addEventListener('click', doVerifyOTP); }
        if (otpInput) otpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerifyOTP(); });
        if (otpBack) otpBack.addEventListener('click', () => {
          document.getElementById('admin-otp-panel').classList.add('hidden');
          document.getElementById('admin-login-panel').classList.remove('hidden');
        });
      }

      btnEl.addEventListener('click', doAdminLogin);
      passwordEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdminLogin(); });
      emailEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') passwordEl.focus(); });
      setTimeout(() => emailEl.focus(), 50);
    };

    // Initialize the admin portal
    document.addEventListener('DOMContentLoaded', () => {
      console.log('DOM loaded, initializing admin...');

      // Attempt to restore an existing session (e.g. page refresh with valid cookie).
      // If a session exists: load the portal normally via admin.init().
      // If no session: show the login form and STOP. The portal must not load
      // until the full 2FA flow is complete. admin.init() will be called again
      // by doVerifyOTP() after the OTP is verified successfully.
      (async () => {
        const restoredUser = await tryRestoreSession();
        if (restoredUser) {
          // Valid session cookie present -- skip login form and load portal.
          admin.init();
        } else {
          // No session -- show login form only. Portal stays hidden until 2FA completes.
          showAdminLoginForm();
        }
      })();

      // Safety fallback: if overlay is still visible after 8s AND neither the
      // login nor OTP panel is showing, fade it out (something stalled mid-init).
      // Never hides the overlay while authentication panels are visible.
      setTimeout(() => {
        const ol         = document.getElementById('loading-overlay');
        const loginPanel = document.getElementById('admin-login-panel');
        const otpPanel   = document.getElementById('admin-otp-panel');
        const loginVisible = loginPanel && !loginPanel.classList.contains('hidden');
        const otpVisible   = otpPanel   && !otpPanel.classList.contains('hidden');
        if (ol && ol.style.display !== 'none' && !loginVisible && !otpVisible) {
          ol.style.opacity = '0';
          setTimeout(() => { ol.style.display = 'none'; }, 300);
        }
      }, 8000);
    });

    // Replaced inline handlers with delegated events using data attributes for safe UI binding.
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id     = btn.dataset.id;
      const ref    = btn.dataset.ref;
      const amt    = btn.dataset.amt;
      switch (action) {
        case 'approve-withdrawal':    admin.approveWithdrawal(id); break;
        case 'reject-withdrawal':     admin.rejectWithdrawal(id); break;
        case 'marksent-withdrawal':   admin.markWithdrawalProcessed(id); break;
        case 'resolve-orphan':        admin.resolveOrphan(id, ref); break;
        case 'open-manual-order':     admin.openManualOrderModal(ref, amt); break;
        case 'store-suspend':         suspendStore(id, btn.dataset.name); break;
        case 'store-activate':        activateStore(id, btn.dataset.name); break;
        case 'store-verify':          verifyStore(id, btn.dataset.name); break;
        case 'store-unverify':        unverifyStore(id, btn.dataset.name); break;
      }
    });


    // ── Manage Stores ────────────────────────────────────────────────────────────

    // These utilities are defined inside the admin IIFE above and are therefore
    // out of scope for functions declared outside it (e.g. loadManageStores).
    // Re-declare them here so the outer scope can use them without duplication.
    function formatCurrency(amount) {
      return `GH₵ ${parseFloat(amount || 0).toFixed(2)}`;
    }

    function formatDate(dateString) {
      if (!dateString) return '';
      const date = new Date(dateString);
      return (
        date.toLocaleDateString() +
        ' ' +
        date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      );
    }

    function showToast(message, type = 'success') {
      if (window.admin && window.admin.showToast) {
        window.admin.showToast(message, type);
        return;
      }
      // Fallback: delegate to the IIFE's toast element if admin isn't ready yet
      console.warn('[showToast fallback]', type, message);
    }

    let _storesMgmtPage  = 1;
    let _storesMgmtTotal = 0;
    const STORES_PAGE_SIZE = 20;

    async function loadManageStores(page = 1) {
      const container  = document.getElementById('stores-mgmt-list');
      const search     = document.getElementById('store-mgmt-search')?.value.trim() || '';
      const statusFilt = document.getElementById('store-mgmt-status')?.value || '';
      if (!container) return;
      _storesMgmtPage = page;

      container.innerHTML = `
        <div class="text-center py-12">
          <i class="fas fa-spinner fa-spin text-3xl text-brand-600 mb-3"></i>
          <p class="text-slate-500">Loading stores...</p>
        </div>`;

      try {
        const res = await _adminFetch('admin-manage-stores', {
          action:   'list',
          page,
          pageSize: STORES_PAGE_SIZE,
          search:   search   || undefined,
          status:   statusFilt || undefined,
        });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed to load stores');

        const { stores, total } = result;
        _storesMgmtTotal = total || 0;

        // Stats bar
        const allActive    = stores.filter(s => s.status === 'active').length;
        const allSuspended = stores.filter(s => s.status === 'suspended').length;
        const allVerified  = stores.filter(s => s.is_verified).length;

        const el = id => document.getElementById(id);
        if (el('stores-stat-total'))     el('stores-stat-total').textContent     = total || 0;
        if (el('stores-stat-active'))    el('stores-stat-active').textContent    = allActive;
        if (el('stores-stat-suspended')) el('stores-stat-suspended').textContent = allSuspended;
        if (el('stores-stat-verified'))  el('stores-stat-verified').textContent  = allVerified;
        if (el('stores-stat-new-week'))  el('stores-stat-new-week').textContent  = result.newThisWeek ?? '—';

        // Sidebar badge — show count of suspended stores
        const badge = document.getElementById('suspended-stores-count');
        if (badge) {
          if (allSuspended > 0) { badge.textContent = allSuspended; badge.classList.remove('hidden'); }
          else badge.classList.add('hidden');
        }

        // Pagination controls
        const start   = _storesMgmtTotal ? (page - 1) * STORES_PAGE_SIZE + 1 : 0;
        const end     = Math.min(page * STORES_PAGE_SIZE, _storesMgmtTotal);
        if (el('stores-page-start')) el('stores-page-start').textContent = start;
        if (el('stores-page-end'))   el('stores-page-end').textContent   = end;
        if (el('stores-page-total')) el('stores-page-total').textContent = _storesMgmtTotal;
        const prevBtn = el('stores-prev-btn');
        const nextBtn = el('stores-next-btn');
        if (prevBtn) prevBtn.disabled = page <= 1;
        if (nextBtn) nextBtn.disabled = end >= _storesMgmtTotal;

        if (!stores.length) {
          container.innerHTML = `
            <div class="text-center py-12">
              <i class="fas fa-store text-4xl text-slate-300 mb-4"></i>
              <p class="text-slate-600 font-medium">No stores found</p>
              <p class="text-slate-400 text-sm mt-1">Try adjusting your search or filter</p>
            </div>`;
          return;
        }

        container.innerHTML = stores.map((s, idx) => {
          const owner       = s.users || {};
          const live        = s.live_stats || {};
          const isSuspended = s.status === 'suspended';
          const isActive    = s.status === 'active';
          const isVerified  = s.is_verified;
          const storeId     = esc(s.id);
          const storeName   = esc(s.name || 'Unnamed Store');
          const themeColor  = esc(s.theme_color || '#0284c7');
          const initial     = esc((s.name || '?').charAt(0).toUpperCase());

          const statusDot = isSuspended
            ? `<span class="inline-flex items-center gap-1 text-xs font-medium text-red-600">
                 <span class="w-1.5 h-1.5 rounded-full bg-red-500 inline-block"></span>Suspended
               </span>`
            : `<span class="inline-flex items-center gap-1 text-xs font-medium text-green-600">
                 <span class="w-1.5 h-1.5 rounded-full bg-green-500 inline-block"></span>Active
               </span>`;

          const suspendedBanner = isSuspended && s.suspended_reason
            ? `<div class="mx-4 mb-3 px-3 py-2 bg-red-50 border border-red-100 rounded-lg text-xs text-red-700 flex items-start gap-2">
                 <i class="fas fa-exclamation-triangle mt-0.5 flex-shrink-0"></i>
                 <span><strong>Suspended:</strong> ${esc(s.suspended_reason)}${s.suspended_at ? ` <span class="text-red-400 ml-1">(${formatDate(s.suspended_at)})</span>` : ''}</span>
               </div>`
            : '';

          return `
            <div class="store-accordion border border-slate-200 rounded-xl overflow-hidden bg-white transition-shadow hover:shadow-sm" data-store-idx="${idx}">
              <!-- Collapsed row — clickable header -->
              <button
                class="store-accordion-trigger w-full flex items-center gap-3.5 px-4 py-3.5 text-left hover:bg-slate-50 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-400"
                data-action="store-toggle"
                data-idx="${idx}"
                aria-expanded="false"
              >
                <!-- Avatar: gradient circle with large bold initial -->
                <div class="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 text-white font-extrabold text-base shadow-sm"
                     style="background: linear-gradient(135deg, ${themeColor}, ${themeColor}cc);">
                  ${initial}
                </div>
                <div class="flex-1 min-w-0">
                  <p class="font-bold text-slate-800 text-[15px] leading-tight truncate">${storeName}</p>
                  <p class="text-xs text-slate-400 truncate mt-0.5">${esc(owner.email || s.short_code || s.slug || '—')}</p>
                </div>
                <div class="flex items-center gap-3 flex-shrink-0">
                  ${statusDot}
                  ${isVerified
                    ? `<span class="hidden sm:inline-flex items-center gap-1 text-xs font-semibold text-brand-600">
                         <i class="fas fa-check-circle text-xs"></i>Verified
                       </span>`
                    : `<span class="hidden sm:inline text-xs text-slate-400">Unverified</span>`
                  }
                  <i class="fas fa-chevron-down text-slate-400 text-xs store-chevron transition-transform duration-200"></i>
                </div>
              </button>

              <!-- Expanded detail panel (hidden by default) -->
              <div class="store-accordion-body hidden border-t border-slate-100">
                ${suspendedBanner}

                <!-- Owner info card -->
                <div class="mx-4 mt-4 mb-4 rounded-xl border border-slate-200 overflow-hidden">
                  <!-- Header row with avatar + name -->
                  <div class="flex items-center gap-3 px-4 py-3 bg-slate-50 border-b border-slate-200">
                    <div class="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 text-white font-extrabold text-lg shadow"
                         style="background: linear-gradient(135deg, ${themeColor}, ${themeColor}bb);">
                      ${initial}
                    </div>
                    <div>
                      <p class="font-bold text-slate-800 text-base leading-tight">${esc(owner.fullname || 'Unknown')}</p>
                      <p class="text-xs text-slate-400 mt-0.5">${esc(s.short_code || s.slug || '—')}</p>
                    </div>
                  </div>
                  <!-- Contact details grid -->
                  <div class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-slate-100">
                    <div class="px-4 py-3 flex flex-col gap-2.5">
                      <div class="flex items-center gap-2.5">
                        <span class="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0">
                          <i class="fas fa-envelope text-xs text-brand-500"></i>
                        </span>
                        <div class="min-w-0">
                          <p class="text-xxs text-slate-400 font-semibold uppercase tracking-wide">Email</p>
                          <p class="text-sm font-semibold text-slate-700 truncate">${esc(owner.email || 'N/A')}</p>
                        </div>
                      </div>
                      <div class="flex items-center gap-2.5">
                        <span class="w-7 h-7 rounded-lg bg-green-50 flex items-center justify-center flex-shrink-0">
                          <i class="fas fa-phone text-xs text-green-500"></i>
                        </span>
                        <div>
                          <p class="text-xxs text-slate-400 font-semibold uppercase tracking-wide">Phone</p>
                          <p class="text-sm font-semibold text-slate-700">${esc(owner.phone || 'N/A')}</p>
                        </div>
                      </div>
                    </div>
                    <div class="px-4 py-3 flex flex-col gap-2.5">
                      <div class="flex items-center gap-2.5">
                        <span class="w-7 h-7 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
                          <i class="fas fa-percent text-xs text-purple-500"></i>
                        </span>
                        <div>
                        </div>
                      </div>
                      <div class="flex items-center gap-2.5">
                        <span class="w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center flex-shrink-0">
                          <i class="fas fa-calendar-alt text-xs text-amber-500"></i>
                        </span>
                        <div>
                          <p class="text-xxs text-slate-400 font-semibold uppercase tracking-wide">Member Since</p>
                          <p class="text-sm font-semibold text-slate-700">${formatDate(s.created_at) || '—'}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Status & Actions + Metrics (two-column on sm+) -->
                <div class="mx-4 mb-4 grid grid-cols-1 sm:grid-cols-2 gap-3">

                  <!-- Status & Actions -->
                  <div class="border border-slate-200 rounded-lg p-3">
                    <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2.5">Status & Actions</p>
                    <div class="flex flex-col gap-1.5 mb-3">
                      <div class="flex items-center gap-2 text-sm">
                        ${isSuspended
                          ? `<i class="fas fa-circle text-red-400 text-xs"></i><span class="text-red-600 font-medium">Suspended</span>`
                          : `<i class="fas fa-circle text-green-400 text-xs"></i><span class="text-green-600 font-medium">Active</span>`
                        }
                      </div>
                      <div class="flex items-center gap-2 text-sm">
                        ${isVerified
                          ? `<i class="fas fa-check-circle text-brand-500 text-xs"></i><span class="text-brand-600 font-medium">Verified</span>`
                          : `<i class="far fa-circle text-slate-400 text-xs"></i><span class="text-slate-500">Not Verified</span>`
                        }
                      </div>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      ${isActive
                        ? `<button data-action="store-suspend" data-id="${storeId}" data-name="${storeName}"
                               class="text-xs bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1">
                             <i class="fas fa-ban text-xs"></i>Suspend
                           </button>`
                        : `<button data-action="store-activate" data-id="${storeId}" data-name="${storeName}"
                               class="text-xs bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1">
                             <i class="fas fa-check text-xs"></i>Activate
                           </button>`
                      }
                      ${isVerified
                        ? `<button data-action="store-unverify" data-id="${storeId}" data-name="${storeName}"
                               class="text-xs bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200 px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1">
                             <i class="fas fa-times text-xs"></i>Unverify
                           </button>`
                        : `<button data-action="store-verify" data-id="${storeId}" data-name="${storeName}"
                               class="text-xs bg-brand-50 hover:bg-brand-100 text-brand-700 border border-brand-200 px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1">
                             <i class="fas fa-check-circle text-xs"></i>Verify
                           </button>`
                      }
                    </div>
                  </div>

                  <!-- Store Metrics -->
                  <div class="border border-slate-200 rounded-lg p-3">
                    <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2.5">Store Metrics</p>
                    <div class="space-y-2">
                      <div class="flex items-center justify-between text-sm">
                        <span class="text-slate-500">Total Orders</span>
                        <span class="font-semibold text-slate-800">${live.total || 0}</span>
                      </div>
                      <div class="flex items-center justify-between text-sm">
                        <span class="text-slate-500">Completed</span>
                        <span class="font-semibold text-green-600">${live.completed || 0}</span>
                      </div>
                      <div class="flex items-center justify-between text-sm">
                        <span class="text-slate-500">Pending</span>
                        <span class="font-semibold text-amber-600">${live.pending || 0}</span>
                      </div>
                      <div class="flex items-center justify-between text-sm pt-1.5 border-t border-slate-100">
                        <span class="text-slate-500 font-medium">Revenue</span>
                        <span class="font-bold text-brand-600">${formatCurrency(live.revenue || 0)}</span>
                      </div>
                    </div>
                  </div>

                </div>
              </div>
            </div>`;
        }).join('');

        // Accordion toggle logic — collapse others, expand clicked
        container.querySelectorAll('[data-action="store-toggle"]').forEach(trigger => {
          trigger.addEventListener('click', function() {
            const idx     = this.dataset.idx;
            const wrapper = this.closest('.store-accordion');
            const body    = wrapper.querySelector('.store-accordion-body');
            const chevron = wrapper.querySelector('.store-chevron');
            const isOpen  = !body.classList.contains('hidden');

            // Close all open panels first
            container.querySelectorAll('.store-accordion').forEach(el => {
              el.querySelector('.store-accordion-body').classList.add('hidden');
              el.querySelector('.store-chevron').style.transform = '';
              el.querySelector('.store-accordion-trigger').setAttribute('aria-expanded', 'false');
            });

            // If it was closed, open this one
            if (!isOpen) {
              body.classList.remove('hidden');
              chevron.style.transform = 'rotate(180deg)';
              this.setAttribute('aria-expanded', 'true');
            }
          });
        });

      } catch (err) {
        console.error('loadManageStores error:', err);
        container.innerHTML = `
          <div class="text-center py-10 text-red-500">
            <i class="fas fa-exclamation-circle text-3xl mb-3"></i>
            <p>Failed to load stores: ${esc(err.message)}</p>
          </div>`;
        showToast('Failed to load stores', 'error');
      }
    }

    async function suspendStore(storeId, storeName) {
      const reason = prompt(`Enter reason for suspending "${storeName}":`);
      if (!reason || !reason.trim()) return;
      try {
        const res    = await _adminFetch('admin-manage-stores', { action: 'suspend', storeId, reason: reason.trim() });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);
        showToast(`✅ ${result.message}`, 'success');
        loadManageStores(_storesMgmtPage);
      } catch (err) { showToast('Failed to suspend store: ' + err.message, 'error'); }
    }

    async function activateStore(storeId, storeName) {
      if (!confirm(`Reactivate store "${storeName}"?`)) return;
      try {
        const res    = await _adminFetch('admin-manage-stores', { action: 'activate', storeId });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);
        showToast(`✅ ${result.message}`, 'success');
        loadManageStores(_storesMgmtPage);
      } catch (err) { showToast('Failed to activate store: ' + err.message, 'error'); }
    }

    async function verifyStore(storeId, storeName) {
      if (!confirm(`Mark "${storeName}" as verified?`)) return;
      try {
        const res    = await _adminFetch('admin-manage-stores', { action: 'verify', storeId });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);
        showToast(`✅ ${result.message}`, 'success');
        loadManageStores(_storesMgmtPage);
      } catch (err) { showToast('Failed to verify store: ' + err.message, 'error'); }
    }

    async function unverifyStore(storeId, storeName) {
      if (!confirm(`Remove verified badge from "${storeName}"?`)) return;
      try {
        const res    = await _adminFetch('admin-manage-stores', { action: 'unverify', storeId });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);
        showToast(`✅ ${result.message}`, 'success');
        loadManageStores(_storesMgmtPage);
      } catch (err) { showToast('Failed to remove verification: ' + err.message, 'error'); }
    }

    // Search, filter, pagination
    document.getElementById('store-mgmt-search')?.addEventListener('input', () => loadManageStores(1));
    document.getElementById('store-mgmt-status')?.addEventListener('change', () => loadManageStores(1));
    document.getElementById('refresh-manage-stores')?.addEventListener('click', () => loadManageStores(1));
    document.getElementById('stores-prev-btn')?.addEventListener('click', () => {
      if (_storesMgmtPage > 1) loadManageStores(_storesMgmtPage - 1);
    });
    document.getElementById('stores-next-btn')?.addEventListener('click', () => {
      if (_storesMgmtPage * STORES_PAGE_SIZE < _storesMgmtTotal) loadManageStores(_storesMgmtPage + 1);
    });

    // ── End Manage Stores ────────────────────────────────────────────────────────

    // ── SALES ANALYTICS ──────────────────────────────────────────────────────

    // Chart instances — kept so we can destroy before re-drawing
    let _analyticsLineChart  = null;
    let _analyticsDonutChart = null;

    const NETWORK_COLORS = {
      mtn:       { bg: '#eab308', border: '#ca8a04' },
      telecel:   { bg: '#3b82f6', border: '#2563eb' },
      airteltigo:{ bg: '#ef4444', border: '#dc2626' },
      unknown:   { bg: '#8b5cf6', border: '#7c3aed' },
    };

    function getNetworkColor(network, prop) {
      const key = (network || 'unknown').toLowerCase();
      return (NETWORK_COLORS[key] || NETWORK_COLORS.unknown)[prop];
    }

    // ── Analytics auto-refresh state ────────────────────────────────────────
    let _analyticsAutoRefreshTimer   = null;
    let _analyticsCountdownTimer     = null;
    const _analyticsRefreshSeconds   = 60;
    let _analyticsCountdownRemaining = 0;

    // ── Tab switcher — Overview / Export ─────────────────────────────────────
    window.switchAnalyticsTab = function switchAnalyticsTab(tab) {
      ['overview', 'export'].forEach(t => {
        const btn = document.getElementById(`analytics-tab-${t}`);
        if (!btn) return;
        const isActive = t === tab;
        btn.classList.toggle('bg-white',            isActive);
        btn.classList.toggle('text-slate-800',       isActive);
        btn.classList.toggle('shadow',               isActive);
        btn.classList.toggle('text-slate-500',       !isActive);
        btn.classList.toggle('hover:text-slate-700', !isActive);
      });
      const exportPanel = document.getElementById('analytics-panel-export');
      if (exportPanel) exportPanel.classList.toggle('hidden', tab !== 'export');
    };

    // ── loadAnalytics — updated with live timestamp ───────────────────────────
    async function loadAnalytics() {
      const network = document.getElementById('analytics-network-filter')?.value || 'all';
      const days    = parseInt(document.getElementById('analytics-period-filter')?.value || '365');

      // Show skeleton state
      ['analytics-period-revenue','analytics-period-orders','analytics-orders-today',
       'analytics-revenue-today','analytics-orders-week','analytics-avg-order']
        .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });

      try {
        // All data fetched via adminFetch → admin-proxy → admin-manage-orders.
        // Zero direct DB access from browser. Session cookie validated server-side.
        const res    = await _adminFetch('admin-manage-orders', { action: 'get-analytics', network, days });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);

        renderAnalyticsCards(result);
        renderDailyChart(result.daily, days);
        renderDonutChart(result.byNetwork);
        renderBreakdownTable(result.byNetwork);

        const now = new Date();
        const updatedEl = document.getElementById('analytics-updated');
        if (updatedEl) {
          updatedEl.textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
        }

      } catch (err) {
        const updatedEl = document.getElementById('analytics-updated');
        if (updatedEl) updatedEl.textContent = 'Failed to load — retrying...';
        showToast('Failed to load analytics: ' + err.message, 'error');
      }
    }

    // ── Start auto-refresh polling ────────────────────────────────────────────
    function startAnalyticsAutoRefresh() {
      stopAnalyticsAutoRefresh();

      const badge = document.getElementById('analytics-live-badge');
      if (badge) { badge.classList.remove('hidden'); badge.classList.add('inline-flex'); }

      _analyticsCountdownRemaining = _analyticsRefreshSeconds;
      const countdownEl = document.getElementById('analytics-refresh-countdown');

      function updateCountdown() {
        if (countdownEl) {
          countdownEl.classList.remove('hidden');
          countdownEl.textContent = `Auto-refreshing in ${_analyticsCountdownRemaining}s`;
        }
        _analyticsCountdownRemaining--;
        if (_analyticsCountdownRemaining < 0) _analyticsCountdownRemaining = _analyticsRefreshSeconds;
      }
      updateCountdown();
      _analyticsCountdownTimer = setInterval(updateCountdown, 1000);

      _analyticsAutoRefreshTimer = setInterval(async () => {
        _analyticsCountdownRemaining = _analyticsRefreshSeconds;
        await loadAnalytics();
      }, _analyticsRefreshSeconds * 1000);
    }

    // ── Stop auto-refresh polling ─────────────────────────────────────────────
    function stopAnalyticsAutoRefresh() {
      if (_analyticsAutoRefreshTimer) { clearInterval(_analyticsAutoRefreshTimer); _analyticsAutoRefreshTimer = null; }
      if (_analyticsCountdownTimer)   { clearInterval(_analyticsCountdownTimer);   _analyticsCountdownTimer   = null; }

      const badge       = document.getElementById('analytics-live-badge');
      const countdownEl = document.getElementById('analytics-refresh-countdown');
      if (badge)       { badge.classList.add('hidden'); badge.classList.remove('inline-flex'); }
      if (countdownEl) countdownEl.classList.add('hidden');
    }

    // ── Export CSV ────────────────────────────────────────────────────────────
    // Routes through adminFetch → admin-proxy → admin-manage-orders (export-csv).
    // Edge function returns a CSV string server-side; we trigger the download here.
    // Zero direct DB access from browser.
    window.exportCSV = async function exportCSV() {
      const btn     = document.getElementById('export-csv-btn');
      const btnText = document.getElementById('export-csv-btn-text');
      const status  = document.getElementById('export-csv-status');

      const network    = document.getElementById('analytics-network-filter')?.value || 'all';
      const days       = parseInt(document.getElementById('analytics-period-filter')?.value || '365');
      const exportType = document.querySelector('input[name="csv-export-type"]:checked')?.value || 'orders';

      if (btn) btn.disabled = true;
      if (btnText) btnText.textContent = 'Fetching data...';
      if (status) { status.textContent = ''; status.className = 'text-xs text-center text-slate-400 h-4'; }

      try {
        const res    = await _adminFetch('admin-manage-orders', { action: 'export-csv', network, days, type: exportType });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Export failed');

        const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href     = url;
        link.download = result.filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        if (status) {
          status.textContent = `✓ Downloaded ${result.rowCount.toLocaleString()} rows`;
          status.className   = 'text-xs text-center text-green-600 h-4';
        }
      } catch (err) {
        console.error('exportCSV error:', err);
        if (status) {
          status.textContent = `✗ ${err.message || 'Export failed'}`;
          status.className   = 'text-xs text-center text-red-500 h-4';
        }
      } finally {
        if (btn) btn.disabled = false;
        if (btnText) btnText.textContent = 'Download CSV';
        setTimeout(() => {
          if (status) { status.textContent = ''; status.className = 'text-xs text-center text-slate-400 h-4'; }
        }, 5000);
      }
    };

    // ── Export PDF ────────────────────────────────────────────────────────────
    // Routes through adminFetch → admin-proxy → admin-manage-orders (export-pdf).
    // Edge function returns structured JSON; PDF is rendered client-side via jsPDF.
    // This keeps the edge function free of Deno binary dependencies.
    // Zero direct DB access from browser.
    window.exportPDF = async function exportPDF() {
      const btn     = document.getElementById('export-pdf-btn');
      const btnText = document.getElementById('export-pdf-btn-text');
      const status  = document.getElementById('export-pdf-status');

      const network = document.getElementById('analytics-network-filter')?.value || 'all';
      const days    = parseInt(document.getElementById('analytics-period-filter')?.value || '365');

      if (btn) btn.disabled = true;
      if (btnText) btnText.textContent = 'Fetching data...';
      if (status) { status.textContent = ''; status.className = 'text-xs text-center text-slate-400 h-4'; }

      try {
        const res    = await _adminFetch('admin-manage-orders', { action: 'export-pdf', network, days });
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Export failed');

        if (btnText) btnText.textContent = 'Building PDF...';

        if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
          throw new Error('jsPDF not loaded. Add the jsPDF CDN script to admin.html.');
        }

        const { jsPDF } = window.jspdf || window;
        const doc       = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const { reportData, filename } = result;
        const { meta, summary, byNetwork, daily, topOrders } = reportData;

        const PAGE_W = 210;
        const MARGIN = 14;
        const COL_W  = PAGE_W - MARGIN * 2;
        const LINE_H = 6;
        let   y      = MARGIN;

        function checkPageBreak(needed = 10) {
          if (y + needed > 280) { doc.addPage(); y = MARGIN; renderPageHeader(); }
        }

        function renderPageHeader() {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8);
          doc.setTextColor(150, 150, 150);
          doc.text('Prime Connect — Analytics Report', MARGIN, 8);
          doc.text(`${meta.period} | ${meta.network}`, PAGE_W - MARGIN, 8, { align: 'right' });
          doc.setDrawColor(220, 220, 220);
          doc.line(MARGIN, 10, PAGE_W - MARGIN, 10);
          doc.setTextColor(51, 51, 51);
        }

        function sectionTitle(title) {
          checkPageBreak(12);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(11);
          doc.setTextColor(2, 132, 199);
          doc.text(title, MARGIN, y);
          y += 2;
          doc.setDrawColor(2, 132, 199);
          doc.setLineWidth(0.3);
          doc.line(MARGIN, y, PAGE_W - MARGIN, y);
          y += 5;
          doc.setTextColor(51, 51, 51);
        }

        function kpiCell(x, colWidth, label, value, subValue) {
          doc.setFillColor(240, 249, 255);
          doc.roundedRect(x, y, colWidth - 3, 20, 2, 2, 'F');
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7.5);
          doc.setTextColor(100, 100, 100);
          doc.text(label, x + 3, y + 5);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(13);
          doc.setTextColor(15, 23, 42);
          doc.text(value, x + 3, y + 13);
          if (subValue) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7);
            doc.setTextColor(120, 120, 120);
            doc.text(subValue, x + 3, y + 18);
          }
        }

        function tableRow(cells, colWidths, isHeader, isAlternate) {
          checkPageBreak(8);
          if (isHeader) {
            doc.setFillColor(14, 165, 233);
            doc.rect(MARGIN, y - 1, COL_W, LINE_H + 1, 'F');
            doc.setTextColor(255, 255, 255);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
          } else {
            if (isAlternate) { doc.setFillColor(248, 250, 252); doc.rect(MARGIN, y - 1, COL_W, LINE_H + 1, 'F'); }
            doc.setTextColor(51, 51, 51);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
          }

          // colLeft tracks the LEFT edge of the current column.
          // colRight = colLeft + colWidths[i] is the RIGHT edge.
          // We use colLeft for left-aligned text and colRight for right-aligned text.
          // This way text is always contained within its own column boundaries.
          let colLeft = MARGIN + 2;

          cells.forEach((cell, i) => {
            const colRight = colLeft + colWidths[i];
            const PAD      = 3; // mm inner padding on each side
            const maxW     = colWidths[i] - PAD * 2;

            // Clip text if wider than the column
            let cellStr = String(cell ?? '');
            if (doc.getTextWidth(cellStr) > maxW) {
              while (cellStr.length > 1 && doc.getTextWidth(cellStr + '..') > maxW) {
                cellStr = cellStr.slice(0, -1);
              }
              cellStr += '..';
            }

            if (i === 0) {
              // First column always left-aligned (both header and data)
              doc.text(cellStr, colLeft + PAD, y + 4);
            } else {
              // All other columns right-aligned for both header and data rows
              // so headers sit directly above their values
              doc.text(cellStr, colRight - PAD, y + 4, { align: 'right' });
            }

            colLeft = colRight; // advance to next column's left edge
          });

          doc.setDrawColor(230, 230, 230);
          doc.setLineWidth(0.1);
          doc.line(MARGIN, y + LINE_H, PAGE_W - MARGIN, y + LINE_H);
          y += LINE_H + 1;
        }

        // Cover page
        doc.setFillColor(2, 132, 199);
        doc.rect(0, 0, PAGE_W, 40, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(22);
        doc.setTextColor(255, 255, 255);
        doc.text('PRIME CONNECT', MARGIN, 18);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        doc.text('Analytics Report', MARGIN, 27);
        doc.setFontSize(9);
        doc.setTextColor(186, 230, 253);
        doc.text(`Generated: ${meta.generatedAt}`, PAGE_W - MARGIN, 35, { align: 'right' });
        y = 50;

        doc.setFillColor(240, 249, 255);
        doc.roundedRect(MARGIN, y, COL_W, 28, 3, 3, 'F');
        doc.setDrawColor(186, 230, 253);
        doc.setLineWidth(0.3);
        doc.roundedRect(MARGIN, y, COL_W, 28, 3, 3, 'S');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(7, 89, 133);
        doc.text('Report Details', MARGIN + 5, y + 8);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(51, 51, 51);
        doc.text('Period:', MARGIN + 5, y + 16);
        doc.setFont('helvetica', 'bold');
        doc.text(meta.period, MARGIN + 28, y + 16);
        doc.setFont('helvetica', 'normal');
        doc.text('Network:', MARGIN + 5, y + 23);
        doc.setFont('helvetica', 'bold');
        doc.text(meta.network, MARGIN + 28, y + 23);
        y += 38;

        // KPI cards
        sectionTitle('Key Performance Indicators');
        const fmt     = n => `GHS ${parseFloat(n || 0).toFixed(2)}`;
        const kpiColW = COL_W / 3;
        kpiCell(MARGIN,               kpiColW, 'Period Revenue',    fmt(summary.totalRevenue),   `${summary.totalOrders} orders`);
        kpiCell(MARGIN + kpiColW,     kpiColW, 'Avg Order Value',   fmt(summary.avgOrderValue),  'Per completed order');
        kpiCell(MARGIN + kpiColW * 2, kpiColW, 'Orders This Week',  String(summary.ordersThisWeek), 'Last 7 days');
        y += 24;
        kpiCell(MARGIN,               kpiColW, "Today's Revenue",   fmt(summary.revenueToday),   'Completed orders');
        kpiCell(MARGIN + kpiColW,     kpiColW, "Today's Orders",    String(summary.ordersToday), 'All statuses');
        kpiCell(MARGIN + kpiColW * 2, kpiColW, 'Total Orders',      String(summary.totalOrders), 'In period');
        y += 28;

        // Network breakdown
        sectionTitle('Revenue by Network');
        // Cols: Network(48) | Revenue(42) | Orders(24) | Share(24) | Rank(22) = 160, leaves 22mm gutter
        const netColWidths = [48, 42, 24, 24, 22];
        tableRow(['Network','Revenue (GHS)','Orders','Share %','Rank'], netColWidths, true);
        byNetwork.forEach((row, i) => {
          tableRow([row.network, `GHS ${row.revenue.toFixed(2)}`, String(row.orders), `${row.share}%`, `#${i + 1}`], netColWidths, false, i % 2 === 1);
        });
        y += 6;

        // Daily revenue
        checkPageBreak(20);
        sectionTitle('Daily Revenue Breakdown');
        // Cols: Date(36) | Revenue(46) | Orders(22) | Cumulative(50) = 154, leaves 28mm gutter
        const dayColWidths = [36, 46, 22, 50];
        tableRow(['Date','Revenue (GHS)','Orders','Cumulative (GHS)'], dayColWidths, true);
        let cumulative = 0;
        daily.filter(d => d.revenue > 0).forEach((row, i) => {
          cumulative += row.revenue;
          tableRow([row.date, `GHS ${row.revenue.toFixed(2)}`, String(row.orders), `GHS ${cumulative.toFixed(2)}`], dayColWidths, false, i % 2 === 1);
        });
        y += 6;

        // Top orders
        if (topOrders && topOrders.length > 0) {
          checkPageBreak(20);
          sectionTitle('Top 10 Orders by Value');

          // Switch to landscape-style layout by splitting into two sub-rows per order
          // to avoid column overflow on A4 portrait (COL_W = 182mm).
          // Row 1: Reference | Network | GB | Amount | Date
          // Row 2: (indent)  Recipient label + value spanning full width
          //
          // Alternatively use a single-row layout with truncation and tighter columns.
          // Column layout (total = 182mm):
          //   #   : 8
          //   Ref : 58  (truncated to ~28 chars with ellipsis)
          //   Net : 20
          //   GB  : 14
          //   Amt : 30
          //   Date: 22  (YYYY-MM-DD, 10 chars fits fine at 8pt)
          // Recipient goes on its own indented sub-row below each order row.

          const topColWidths = [8, 58, 20, 14, 30, 22]; // total = 152, pad gives 182
          const topHeaders   = ['#', 'Reference', 'Network', 'GB', 'Amount (GHS)', 'Date'];

          // Header row
          checkPageBreak(8);
          doc.setFillColor(14, 165, 233);
          doc.rect(MARGIN, y - 1, COL_W, LINE_H + 1, 'F');
          doc.setTextColor(255, 255, 255);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8);
          let hx = MARGIN + 2;
          topHeaders.forEach((h, i) => {
            if (i > 0 && i !== 1) {
              doc.text(h, hx + topColWidths[i] - 4, y + 4, { align: 'right' });
            } else {
              doc.text(h, hx, y + 4);
            }
            hx += topColWidths[i];
          });
          doc.setDrawColor(230, 230, 230);
          doc.setLineWidth(0.1);
          doc.line(MARGIN, y + LINE_H, PAGE_W - MARGIN, y + LINE_H);
          y += LINE_H + 1;

          topOrders.forEach((o, i) => {
            checkPageBreak(14); // need room for order row + recipient sub-row

            // Truncate reference if too long (max ~28 chars at 8pt in 58mm col)
            const refRaw  = String(o.reference || '');
            const refDisp = refRaw.length > 26 ? refRaw.slice(0, 24) + '..' : refRaw;
            const amtDisp = `GHS ${String(o.amount)}`;
            const dateDisp = String(o.date || '').slice(0, 10);

            // Alternating row background spans both sub-rows
            const rowH = LINE_H * 2 + 2;
            if (i % 2 === 1) {
              doc.setFillColor(248, 250, 252);
              doc.rect(MARGIN, y - 1, COL_W, rowH, 'F');
            }

            // ── Main row ──────────────────────────────────────────────────
            doc.setTextColor(51, 51, 51);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);

            const cells    = [String(i + 1), refDisp, String(o.network || ''), String(o.bundleGb || ''), amtDisp, dateDisp];
            let cx = MARGIN + 2;
            cells.forEach((cell, ci) => {
              if (ci > 0 && ci !== 1) {
                doc.text(cell, cx + topColWidths[ci] - 4, y + 4, { align: 'right' });
              } else {
                doc.text(cell, cx, y + 4);
              }
              cx += topColWidths[ci];
            });

            // ── Recipient sub-row ─────────────────────────────────────────
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7);
            doc.setTextColor(120, 120, 120);
            const recipientLabel = `  Recipient: ${o.recipient || '—'}`;
            doc.text(recipientLabel, MARGIN + 10, y + 4 + LINE_H);

            // Divider after recipient sub-row
            doc.setDrawColor(235, 235, 235);
            doc.setLineWidth(0.1);
            doc.line(MARGIN, y + rowH, PAGE_W - MARGIN, y + rowH);
            y += rowH + 1;
          });
        }

        // Footer on every page
        const pageCount = doc.internal.getNumberOfPages();
        for (let p = 1; p <= pageCount; p++) {
          doc.setPage(p);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7);
          doc.setTextColor(150, 150, 150);
          doc.text(`Page ${p} of ${pageCount}  —  Prime Connect Admin Portal  —  Confidential`, PAGE_W / 2, 292, { align: 'center' });
        }

        doc.save(filename);

        if (status) {
          status.textContent = '✓ Report downloaded';
          status.className   = 'text-xs text-center text-green-600 h-4';
        }
      } catch (err) {
        console.error('exportPDF error:', err);
        if (status) {
          status.textContent = `✗ ${err.message || 'PDF generation failed'}`;
          status.className   = 'text-xs text-center text-red-500 h-4';
        }
      } finally {
        if (btn) btn.disabled = false;
        if (btnText) btnText.textContent = 'Download PDF';
        setTimeout(() => {
          if (status) { status.textContent = ''; status.className = 'text-xs text-center text-slate-400 h-4'; }
        }, 6000);
      }
    };

    function renderAnalyticsCards(data) {
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      set('analytics-period-revenue', formatCurrency(data.periodRevenue));
      set('analytics-period-orders',  `${data.periodOrders} orders`);
      set('analytics-orders-today',   data.ordersToday);
      set('analytics-revenue-today',  `${formatCurrency(data.revenueToday)} today`);
      set('analytics-orders-week',    data.ordersThisWeek);
      set('analytics-avg-order',      formatCurrency(data.avgOrderValue));
    }

    function renderDailyChart(daily, days) {
      const canvas  = document.getElementById('analytics-daily-chart');
      const emptyEl = document.getElementById('analytics-daily-empty');
      if (!canvas) return;

      const periodLabel = days >= 365 ? 'All time' : `Last ${days} days`;
      const labelEl = document.getElementById('analytics-chart-period-label');
      if (labelEl) labelEl.textContent = periodLabel;

      const hasData = daily && daily.length > 0 && daily.some(d => d.revenue > 0);
      if (emptyEl) { emptyEl.style.display = hasData ? 'none' : 'flex'; }
      canvas.style.display = hasData ? 'block' : 'none';

      if (!hasData) return;

      if (_analyticsLineChart) { _analyticsLineChart.destroy(); _analyticsLineChart = null; }

      // ── Helper: format a YYYY-MM-DD string to "9 Apr" style ──────────────
      function fmtDate(ymd) {
        const dt = new Date(ymd + 'T00:00:00');
        return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      }

      // ── Filter to only rows that have revenue > 0 ─────────────────────────
      // This removes the massive empty left gap caused by early zero-revenue
      // calendar-fill rows that the edge function includes.
      const active = daily.filter(d => (d.revenue || 0) > 0);
      if (!active.length) { canvas.style.display = 'none'; return; }

      // ── Decide grouping: daily (≤30 active days) vs weekly (>30) ──────────
      // We group on ACTIVE data points, not calendar days, so a sparse
      // "All time" with only 20 sale-days renders as 20 neat daily bars.
      let chartLabels, chartRevenues, chartOrders, tooltipMode;

      if (active.length <= 30) {
        // ── Daily: one bar per day that had a sale ─────────────────────────
        tooltipMode  = 'day';
        chartLabels  = active.map(d => fmtDate(d.date));
        chartRevenues = active.map(d => parseFloat((d.revenue || 0).toFixed(2)));
        chartOrders  = active.map(d => d.orders || 0);
      } else {
        // ── Weekly: aggregate by ISO week (Monday anchor) ──────────────────
        tooltipMode = 'week';
        const weekMap = new Map();
        for (const row of active) {
          const dt  = new Date(row.date + 'T00:00:00');
          const dow = dt.getDay();                          // 0=Sun
          const diff = dow === 0 ? -6 : 1 - dow;           // shift to Monday
          const mon = new Date(dt);
          mon.setDate(dt.getDate() + diff);
          const key = mon.toISOString().slice(0, 10);
          if (!weekMap.has(key)) weekMap.set(key, { revenue: 0, orders: 0 });
          const w = weekMap.get(key);
          w.revenue += row.revenue || 0;
          w.orders  += row.orders  || 0;
        }
        const sorted  = [...weekMap.keys()].sort();
        chartLabels   = sorted.map(k => fmtDate(k));
        chartRevenues = sorted.map(k => parseFloat(weekMap.get(k).revenue.toFixed(2)));
        chartOrders   = sorted.map(k => weekMap.get(k).orders);
      }

      // ── Bar sizing ────────────────────────────────────────────────────────
      const barCount = chartLabels.length;
      const barPct   = barCount <= 10 ? 0.60 : barCount <= 20 ? 0.65 : 0.70;
      const catPct   = barCount <= 10 ? 0.50 : barCount <= 20 ? 0.60 : 0.70;

      // Force canvas to fill its container before Chart.js measures it
      canvas.style.width  = '100%';
      canvas.style.height = '100%';

      _analyticsLineChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: chartLabels,
          datasets: [{
            label: 'Revenue (GHS)',
            data: chartRevenues,
            backgroundColor: 'rgba(59,130,246,0.80)',
            borderColor: '#2563eb',
            borderWidth: 1.5,
            borderRadius: 5,
            borderSkipped: false,
            barPercentage: barPct,
            categoryPercentage: catPct,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          devicePixelRatio: window.devicePixelRatio || 2,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(15,23,42,0.93)',
              titleColor: '#94a3b8',
              bodyColor: '#f1f5f9',
              padding: 12,
              cornerRadius: 8,
              displayColors: false,
              callbacks: {
                title: ctx => {
                  const lbl = ctx[0]?.label || '';
                  return tooltipMode === 'week' ? `w/c ${lbl}` : lbl;
                },
                label: ctx => {
                  const sales  = parseFloat(ctx.raw) || 0;
                  const orders = chartOrders[ctx.dataIndex] ?? 0;
                  return [
                    `Sales:  GHS ${sales.toFixed(2)}`,
                    `Orders: ${orders}`,
                  ];
                },
              },
            },
          },
          scales: {
            x: {
              // MUST be 'category' — prevents Chart.js treating date strings
              // as a time axis and leaving a huge empty gap on the left.
              type: 'category',
              grid: { display: false },
              ticks: {
                color: '#94a3b8',
                font: { size: 11 },
                maxRotation: 0,
                autoSkip: true,
                maxTicksLimit: Math.min(barCount, 14),
              },
            },
            y: {
              grid: { color: 'rgba(148,163,184,0.15)' },
              ticks: {
                color: '#94a3b8',
                font: { size: 11 },
                callback: val => `GHS ${parseFloat(val).toFixed(0)}`,
              },
              beginAtZero: true,
            },
          },
        },
      });

      // Resize twice: once on next frame (tab may have been hidden on first
      // paint) and once after 200ms (covers CSS transition delays).
      requestAnimationFrame(() => { if (_analyticsLineChart) _analyticsLineChart.resize(); });
      setTimeout(() => { if (_analyticsLineChart) _analyticsLineChart.resize(); }, 200);
    }

    function renderDonutChart(byNetwork) {
      const canvas  = document.getElementById('analytics-donut-chart');
      const emptyEl = document.getElementById('analytics-donut-empty');
      const legendEl = document.getElementById('analytics-donut-legend');
      if (!canvas) return;

      const hasData = byNetwork && byNetwork.length > 0;
      if (emptyEl)  { emptyEl.style.display  = hasData ? 'none' : 'flex'; }
      canvas.style.display = hasData ? 'block' : 'none';

      if (!hasData) return;

      if (_analyticsDonutChart) { _analyticsDonutChart.destroy(); _analyticsDonutChart = null; }

      const labels  = byNetwork.map(n => n.network.charAt(0).toUpperCase() + n.network.slice(1));
      const data    = byNetwork.map(n => n.revenue);
      const bgs     = byNetwork.map(n => getNetworkColor(n.network, 'bg'));
      const borders = byNetwork.map(n => getNetworkColor(n.network, 'border'));

      _analyticsDonutChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{ data, backgroundColor: bgs, borderColor: borders, borderWidth: 2, hoverOffset: 6 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '68%',
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => ` ${ctx.label}: GHS ${parseFloat(ctx.raw).toFixed(2)} (${byNetwork[ctx.dataIndex]?.share || 0}%)`,
              },
            },
          },
        },
      });

      // Render custom legend
      if (legendEl) {
        legendEl.innerHTML = byNetwork.map(n => `
          <span class="flex items-center gap-1.5">
            <span class="w-3 h-3 rounded-full inline-block" style="background:${getNetworkColor(n.network,'bg')}"></span>
            <span class="font-medium">${esc(n.network.charAt(0).toUpperCase()+n.network.slice(1))}</span>
            <span class="text-slate-400">${n.share}%</span>
          </span>`).join('');
      }
    }

    function renderBreakdownTable(byNetwork) {
      const tbody   = document.getElementById('analytics-breakdown-tbody');
      const emptyEl = document.getElementById('analytics-breakdown-empty');
      if (!tbody) return;

      const hasData = byNetwork && byNetwork.length > 0;
      if (emptyEl) { emptyEl.style.display = hasData ? 'none' : 'flex'; }

      if (!hasData) { tbody.innerHTML = ''; return; }

      const maxRevenue = Math.max(...byNetwork.map(n => n.revenue), 1);

      tbody.innerHTML = byNetwork.map(n => {
        const barWidth = Math.round((n.revenue / maxRevenue) * 100);
        const color    = getNetworkColor(n.network, 'bg');
        const name     = n.network.charAt(0).toUpperCase() + n.network.slice(1);
        return `
          <tr class="hover:bg-slate-50 transition-colors">
            <td class="px-5 py-4">
              <div class="flex items-center gap-2">
                <span class="w-3 h-3 rounded-full inline-block flex-shrink-0" style="background:${color}"></span>
                <span class="font-semibold text-slate-800">${esc(name)}</span>
              </div>
            </td>
            <td class="px-5 py-4 text-right font-bold text-slate-800">${formatCurrency(n.revenue)}</td>
            <td class="px-5 py-4 text-right">
              <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold text-white" style="background:#0f766e">${n.share}%</span>
            </td>
            <td class="px-4 py-4 w-32">
              <div class="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
                <div class="h-3 rounded-full transition-all duration-500" style="width:${barWidth}%;background:${color}"></div>
              </div>
              <span class="text-xs text-slate-400 mt-0.5 block text-right">${barWidth}%</span>
            </td>
          </tr>`;
      }).join('');
    }

    // Filter change listeners — restart auto-refresh on any filter change
    document.getElementById('analytics-network-filter')?.addEventListener('change', () => { loadAnalytics(); startAnalyticsAutoRefresh(); });
    document.getElementById('analytics-period-filter')?.addEventListener('change',  () => { loadAnalytics(); startAnalyticsAutoRefresh(); });
    document.getElementById('analytics-refresh-btn')?.addEventListener('click',     () => { loadAnalytics(); startAnalyticsAutoRefresh(); });

    // ── End Sales Analytics ──────────────────────────────────────────────────

    window.addEventListener('resize', () => {
      if (window.innerWidth >= 768) {
        // future responsive tweaks
      }
    });
  } catch (error) {
    console.error('Failed to import supabase-config:', error);
    // Hide loading overlay to allow fallback functionality
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
      overlay.style.display = 'none';
    }
    // Show error notification if possible
    if (window.admin && window.admin.showToast) {
      window.admin.showToast('Configuration error - using fallback mode', 'warning');
    }
  }
// ═══════════════════════════════════════════════════════════════════════════
// SECURITY LOGS MODULE
// Implements: logs viewer, real-time polling badge, clear function
// ═══════════════════════════════════════════════════════════════════════════

const secLogsState = { page: 1, pageSize: 50, total: 0 };
let   _secPollingInterval = null;

// ── Severity badge ─────────────────────────────────────────────────────────
function secSeverityBadge(severity) {
  const map = {
    CRITICAL: 'bg-red-100 text-red-800 border border-red-200',
    HIGH:     'bg-orange-100 text-orange-800 border border-orange-200',
    MEDIUM:   'bg-yellow-100 text-yellow-800 border border-yellow-200',
    LOW:      'bg-blue-100 text-blue-700 border border-blue-200',
  };
  return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${map[severity] ?? 'bg-slate-100 text-slate-600'}">${severity}</span>`;
}

// ── Format timestamp ───────────────────────────────────────────────────────
function secFormatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `<span class="text-slate-800 font-medium">${d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })}</span><br><span class="text-slate-400 text-xs">${d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' })}</span>`;
}

// ── XSS-safe HTML escape ───────────────────────────────────────────────────
function secEsc(str) {
  if (typeof str !== 'string') return str ?? '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Render details blob ────────────────────────────────────────────────────
function secRenderDetails(details) {
  if (!details || !Object.keys(details).length) return '<span class="text-slate-300">—</span>';
  try {
    return `<div class="text-xs leading-relaxed">${Object.entries(details).map(([k,v]) => `<span class="text-slate-400">${secEsc(k)}:</span> <span class="text-slate-700 font-mono">${secEsc(JSON.stringify(v))}</span>`).join('<br>')}</div>`;
  } catch { return `<span class="text-xs text-slate-500">${secEsc(String(details))}</span>`; }
}

// ── Load logs from Edge Function ───────────────────────────────────────────
async function loadSecurityLogs() {
  const tbody    = document.getElementById('sec-logs-tbody');
  const severity = document.getElementById('sec-severity-filter')?.value ?? 'ALL';

  if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400 text-sm"><i class="fas fa-spinner fa-spin text-2xl mb-2 block opacity-40"></i>Loading security events...</td></tr>`;

  try {
    const res  = await _adminFetch('admin-security-logs', {
      action: 'list', page: secLogsState.page, pageSize: secLogsState.pageSize,
      severity: severity === 'ALL' ? undefined : severity,
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error ?? 'Failed to load logs');

    secLogsState.total = data.total ?? 0;
    renderSecurityLogs(data.data ?? []);
    updateSecLogsStats(data.data ?? []);
    updateSecLogsPagination();
  } catch (err) {
    console.error('[security-logs]', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-red-400 text-sm"><i class="fas fa-exclamation-triangle text-2xl mb-2 block"></i>Failed to load: ${secEsc(err.message)}</td></tr>`;
  }
}

// ── Render rows ────────────────────────────────────────────────────────────
function renderSecurityLogs(logs) {
  const tbody = document.getElementById('sec-logs-tbody');
  if (!tbody) return;

  if (!logs.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-12 text-center text-slate-400 text-sm"><i class="fas fa-shield-alt text-3xl mb-3 block opacity-20"></i>No security events found</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map(log => {
    const account = log.account_email
      ? `<span class="text-slate-700">${secEsc(log.account_email)}</span>${log.account_name ? `<br><span class="text-xs text-slate-400">${secEsc(log.account_name)}</span>` : ''}`
      : '<span class="text-slate-300 text-xs">Unknown</span>';
    const rowBg = log.severity === 'CRITICAL' ? 'bg-red-50/40' : log.severity === 'HIGH' ? 'bg-orange-50/30' : '';
    return `<tr class="hover:bg-slate-50 transition-colors ${rowBg}">
      <td class="px-4 py-3 whitespace-nowrap text-xs">${secFormatTime(log.created_at)}</td>
      <td class="px-4 py-3 whitespace-nowrap">${secSeverityBadge(log.severity)}</td>
      <td class="px-4 py-3 text-xs"><span class="font-mono text-slate-700">${secEsc(log.event_type ?? '—')}</span>${log.source_function ? `<br><span class="text-slate-400 text-xs">${secEsc(log.source_function)}</span>` : ''}</td>
      <td class="px-4 py-3 text-xs hidden md:table-cell">${account}</td>
      <td class="px-4 py-3 text-xs font-mono text-slate-600 hidden lg:table-cell">${secEsc(log.action ?? '—')}</td>
      <td class="px-4 py-3 text-xs font-mono text-slate-600 hidden lg:table-cell">${secEsc(log.ip_address ?? '—')}</td>
      <td class="px-4 py-3 text-xs max-w-xs">${secRenderDetails(log.details)}</td>
    </tr>`;
  }).join('');
}

// ── Update stat cards + nav badge ─────────────────────────────────────────
function updateSecLogsStats(logs) {
  const el = id => document.getElementById(id);
  if (el('sec-stat-total'))    el('sec-stat-total').textContent    = secLogsState.total;
  if (el('sec-stat-critical')) el('sec-stat-critical').textContent = logs.filter(l => l.severity === 'CRITICAL').length;
  if (el('sec-stat-high'))     el('sec-stat-high').textContent     = logs.filter(l => l.severity === 'HIGH').length;
  if (el('sec-stat-ips'))      el('sec-stat-ips').textContent      = new Set(logs.map(l => l.ip_address).filter(Boolean)).size;

  const hasDanger = logs.some(l => l.severity === 'CRITICAL' || l.severity === 'HIGH');
  const badge = el('security-logs-badge');
  if (badge) badge.classList.toggle('hidden', !hasDanger);
}

// ── Pagination ─────────────────────────────────────────────────────────────
function updateSecLogsPagination() {
  const { total, page, pageSize } = secLogsState;
  const totalPgs = Math.max(1, Math.ceil(total / pageSize));
  const from = total > 0 ? (page - 1) * pageSize + 1 : 0;
  const to   = Math.min(page * pageSize, total);

  const info = document.getElementById('sec-pagination-info');
  const prev = document.getElementById('sec-prev-btn');
  const next = document.getElementById('sec-next-btn');
  if (info) info.textContent = total > 0 ? `Showing ${from}–${to} of ${total} events` : 'No events';
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page >= totalPgs;
}

function secLogsChangePage(delta) {
  const totalPgs = Math.max(1, Math.ceil(secLogsState.total / secLogsState.pageSize));
  secLogsState.page = Math.max(1, Math.min(secLogsState.page + delta, totalPgs));
  loadSecurityLogs();
}

// ── Clear logs (superadmin only) ───────────────────────────────────────────
async function clearSecurityLogs() {
  if (!confirm('Delete ALL security events? This cannot be undone.')) return;
  try {
    const res  = await _adminFetch('admin-security-logs', { action: 'clear' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error ?? 'Clear failed');
    showToast('Security events cleared', 'success');
    secLogsState.page = 1;
    loadSecurityLogs();
  } catch (err) {
    showToast('Failed to clear: ' + err.message, 'error');
  }
}

// ── Real-time background polling ───────────────────────────────────────────
// Checks silently every 60 seconds for new CRITICAL/HIGH events.
// Updates the nav badge without interrupting whatever page you're on.
// Starts automatically after admin login completes.
function startSecurityLogPolling() {
  if (_secPollingInterval) return; // already running

  async function poll() {
    try {
      const res  = await _adminFetch('admin-security-logs', {
        action: 'list', page: 1, pageSize: 20, severity: 'HIGH',
      });
      const data = await res.json();
      if (!data.success) return;

      const logs       = data.data ?? [];
      const hasDanger  = logs.some(l => l.severity === 'CRITICAL' || l.severity === 'HIGH');
      const badge      = document.getElementById('security-logs-badge');
      if (badge) badge.classList.toggle('hidden', !hasDanger);

      // Update the polling status text with last-checked time
      const statusEl = document.getElementById('sec-polling-status');
      if (statusEl) {
        const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        statusEl.textContent = hasDanger
          ? `⚠️ Threats detected — last checked ${time}`
          : `Monitoring active — last checked ${time}`;
      }
    } catch {
      // Silent fail — polling never crashes the portal
    }
  }

  // Run immediately, then every 60 seconds
  poll();
  _secPollingInterval = setInterval(poll, 60_000);
  console.log('[security-logs] Real-time polling started (60s interval)');
}

// ── Wire up severity filter ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const filter = document.getElementById('sec-severity-filter');
  if (filter) {
    filter.addEventListener('change', () => {
      secLogsState.page = 1;
      loadSecurityLogs();
    });
  }
});
// ═══════════════════════════════════════════════════════════════════════════
// END SECURITY LOGS MODULE
// ═══════════════════════════════════════════════════════════════════════════

// =============================================================================
// GLOBAL FUNCTION EXPORTS
// Functions defined in this ES module that are called from inline HTML onclick
// handlers must be explicitly assigned to window -- module scope is not global.
// =============================================================================
window.loadSecurityLogs   = loadSecurityLogs;
window.clearSecurityLogs  = clearSecurityLogs;
window.secLogsChangePage  = secLogsChangePage;