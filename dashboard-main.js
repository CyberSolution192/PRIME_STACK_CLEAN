/* ============================================================
 * dashboard-main.js — Prime Connect Dashboard (ES Module).
 * ============================================================ */

/* ── Main Application Module ────────────────────────────────── */
        import {
          supabase,
          userFetch,
          userLogin,
          userLogout,
          tryRestoreUserSession,
          PAYSTACK_PUBLIC_KEY,
          SUPABASE_PROJECT_URL,
          SUPABASE_ANON,
        } from './supabase-config.js';

/* ── WhatsApp FAB ───────────────────────────────────────────── */
// Placed here (after import) so it runs inside the ES module scope.
// window.toggleWaFab is exported below so dashboard-event-wiring.js can call it.
        let _waOpen = false;
        function toggleWaFab() {
            _waOpen = !_waOpen;
            document.querySelectorAll('.wa-option').forEach(el => {
                el.classList.toggle('hidden', !_waOpen);
            });
            const icon = document.getElementById('waFabIcon');
            if (_waOpen) {
                icon.classList.remove('fa-whatsapp');
                icon.classList.add('fa-times');
            } else {
                icon.classList.remove('fa-times');
                icon.classList.add('fa-whatsapp');
            }
        }
        // Close FAB if user clicks outside
        document.addEventListener('click', function(e) {
            const bubble = document.getElementById('waBubble');
            if (_waOpen && bubble && !bubble.contains(e.target)) {
                _waOpen = true; // force toggle to close
                toggleWaFab();
            }
        });
        // Expose to window so dashboard-event-wiring.js (non-module) can call it
        window.toggleWaFab = toggleWaFab;

        // _baseUrl: resolves store.html relative to THIS file's directory.
        const _baseUrl = window.location.origin +
            window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);

        // v2: getAuthUser() now validates via the HttpOnly session cookie
        // through the user-auth Edge Function. No token is read from localStorage.
        // The result is cached for 5 seconds to prevent concurrent request storms.
        let _authUserPromise = null;
        async function getAuthUser() {
            if (_authUserPromise) return _authUserPromise;
            _authUserPromise = tryRestoreUserSession().then(session => {
                setTimeout(() => { _authUserPromise = null; }, 5000);
                if (!session) {
                    return { data: { user: null }, error: new Error('No session') };
                }
                return { data: { user: { id: session.user_id, email: session.user_email } }, error: null };
            }).catch(err => {
                _authUserPromise = null;
                throw err;
            });
            return _authUserPromise;
        }

        // ── Announcement Ticker ───────────────────────────────────────────────
        async function initTicker() {
            try {
                const res  = await fetch(`${SUPABASE_PROJECT_URL}/functions/v1/get-announcement`, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': SUPABASE_ANON,
                    }
                });
                const data = await res.json();

                // Hide ticker if no active announcement
                if (!data.success || !data.active || !data.announcement) {
                    document.getElementById('announcementTicker')?.classList.add('hidden');
                    return;
                }

                const text  = data.announcement;
                const track = document.getElementById('tickerTrack');
                const ticker = document.getElementById('announcementTicker');
                if (!track || !ticker) return;

                // Build items — 8 copies for seamless infinite loop
                const itemHTML = `
                    <span class="ticker-item">
                        <span class="ticker-dot"></span>
                        <i class="fas fa-bullhorn" style="opacity:.7;font-size:11px"></i>
                        ${esc(text)}
                    </span>`;

                track.innerHTML = itemHTML.repeat(8);
                ticker.classList.remove('hidden');

                // Adjust speed based on text length — higher = slower
                const speed = Math.max(100, Math.min(160, text.length * 1.5));
                track.style.animationDuration = speed + 's';

            } catch (err) {
                // Ticker is non-critical — fail silently
                console.warn('Ticker load failed (non-fatal):', err.message);
            }
        }

       // Ensures safe rendering by escaping dynamic content used in innerHTML.
        function esc(str) {
            if (str == null) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        const CONFIG = {
            // Payment Configuration
            PAYSTACK_PUBLIC_KEY, 

            // App Configuration
            APP_NAME: 'Prime Connect',
            SUPPORT_PHONE: '233548712699',
            SUPPORT_EMAIL: 'support@primeconnect.com',

            // Feature Flags
            FEATURES: {
                REAL_TIME_UPDATES: true,
                AUTO_TOPUP: false,
                MULTI_VENDOR: false,
                BULK_PURCHASES: true
            },

            // Defaults
            DEFAULT_CURRENCY: 'GH₵',
            MIN_TOPUP_AMOUNT: 1,
            MAX_TOPUP_AMOUNT: 5000,
            TOPUP_CHARGE_PERCENT: 4, // 4% charge on Paystack deposits
            PAGE_SIZE: 10,
            SESSION_TIMEOUT: 30 * 60 * 1000 // 30 minutes
        };

        // Application State
        let state = {
            user: null,
            balance: 0.00,
            transactions: [],
            bundles: {},
            currentPage: 'dashboard',
            historyPage: 1,
            historyTotal: 0,
            selectedNetwork: null,
            selectedBundle: null,
            lastActivity: Date.now(),
            sessionTimer: null
        };

        // API Service (Updated to use Supabase)
        const api = {
            // Auth
            async checkAuth() {
                try {
                    // v2: tryRestoreUserSession() validates via HttpOnly cookie.
                    // No token is ever read from localStorage.
                    const session = await tryRestoreUserSession();
                    if (!session) {
                        window.location.href = 'login.html';
                        throw new Error('No session');
                    }
                    // Pass through all fields returned by user-auth verify,
                    // including pin_set and store_unlocked — so init() has them
                    // immediately without waiting for getUserProfile().
                    return {
                        user: {
                            id:             session.user_id,
                            email:          session.user_email,
                            store_unlocked: session.store_unlocked ?? false,
                            pin_set:        session.pin_set        ?? false,
                        }
                    };
                } catch (error) {
                    window.location.href = 'login.html';
                    throw error;
                }
            },

            async getUserProfile() {
                try {
                    const pfRes = await userFetch('get-user-data', {}, 'section=profile');
                    const pfData = await pfRes.json();
                    if (!pfData.success) throw new Error(pfData.message || 'Failed to fetch profile');
                    const profile = pfData.profile;

                    // Parse fullname into first and last name
                    const nameParts = (profile.fullname || '').split(' ');
                    const firstName = nameParts[0] || '';
                    const lastName = nameParts.slice(1).join(' ') || '';

                    // Fetch PIN status from the Edge Function — the profile section
                    // does NOT expose transaction_pin_hash (by design, never expose hashes).
                    // set-transaction-pin?action=status returns { pin_set: bool } safely.
                    let pin_set = false;
                    try {
                        const pinRes  = await userFetch('set-transaction-pin', { action: 'status' });
                        const pinData = await pinRes.json();
                        if (pinData.success) pin_set = !!pinData.pin_set;
                    } catch { /* non-fatal — falls back to false */ }

                    return {
                        user: {
                            ...profile,
                            firstName,
                            lastName,
                            email:          profile.email || '',
                            phone:          profile.phone || '',
                            store_unlocked: profile.store_unlocked ?? false,
                            pin_set,
                        }
                    };
                } catch (error) {
                    console.error('Profile fetch error:', error);
                    throw new Error('Failed to fetch profile');
                }
            },

            async updateProfile(profileData) {
                try {
                    // FIX #1: removed stray ),  that caused a syntax error
                    const res = await userFetch('update-profile', {
                        firstName: profileData.firstName,
                        lastName:  profileData.lastName,
                        phone:     profileData.phone,
                    });
                    const result = await res.json();
                    if (!result.success) throw new Error(result.message || 'Failed to update profile');

                    return { user: result.user };
                } catch (error) {
                    console.error('Profile update error:', error);
                    throw new Error('Failed to update profile');
                }
            },

            // Wallet
           async getBalance() {
    try {
        // userFetch handles auth via HttpOnly cookie — no token needed here.
        const balRes = await userFetch('get-user-data', {}, 'section=profile');
        const balData = await balRes.json();
        if (!balData.success) throw new Error(balData.message || 'Failed to fetch balance');
        return { balance: balData.balance ?? 0 };
        } catch (error) {
            console.error('Balance fetch error:', error);
            throw new Error('Failed to fetch balance');
        }
        },

            async getTransactions(page = 1, limit = CONFIG.PAGE_SIZE, type = 'all') {
                try {
                    // Route through proxy — no token needed in the browser.
                    if (type === 'withdrawal') {
                        const wRes = await userFetch('get-user-data', {}, 'section=withdrawals');
                        const wData = await wRes.json();
                        if (!wData.success) throw new Error(wData.message || 'Failed to fetch withdrawals');
                        const normalised = (wData.withdrawals || []).map(w => ({
                            id: w.id,
                            userid: w.user_id,
                            type: 'withdrawal',
                            amount: -Math.abs(parseFloat(w.amount || 0)),
                            status: w.status,
                            description: `Withdrawal — ${w.network || w.method || 'MoMo'} (${w.recipient_account || ''})`,
                            created_at: w.created_at
                        }));
                        return { transactions: normalised, total: normalised.length };
                    }

                    const params = new URLSearchParams({ section: 'transactions', page, pageSize: limit });
                    const txRes = await userFetch('get-user-data', {}, params.toString());
                    const txData = await txRes.json();
                    if (!txData.success) throw new Error(txData.message || 'Failed to fetch transactions');

                    let transactions = txData.transactions || [];
                    if (type !== 'all') {
                        transactions = transactions.filter(t => t.type === type);
                    }
                    return { transactions, total: txData.total || 0 };
                } catch (error) {
                    console.error('Transactions fetch error:', error);
                    throw new Error('Failed to fetch transactions');
                }
            },

            // Fetch bundles via server layer with pricing applied.
            async getBundles(network) {
                try {
                    const bRes = await userFetch('get-user-data', {}, 'section=bundles');
                    const bData = await bRes.json();
                    if (!bData.success) throw new Error(bData.message || 'Failed to load bundles');

                    // Filter to requested network and reshape to match existing page format
                    const allBundles = (bData.bundles || []).filter(b =>
                        b.network.toLowerCase() === network.toLowerCase()
                    );

                    // 3. Merge — effective_price already has custom price applied by edge function
                    const formattedBundles = allBundles.map(bundle => ({
                        id:             bundle.id,
                        network:        bundle.network,
                        sizeNum:        bundle.size,
                        name:           `${bundle.network.toUpperCase()} ${bundle.size}GB`,
                        size:           `${bundle.size}GB`,
                        validity:       'NON-EXPIRY',
                        basePrice:      parseFloat(bundle.price),
                        price:          parseFloat(bundle.effective_price ?? bundle.price),
                        hasCustomPrice: bundle.effective_price != null && parseFloat(bundle.effective_price) !== parseFloat(bundle.price)
                    }));

                    return { bundles: formattedBundles };
                } catch (error) {
                    console.error('Error fetching bundles:', error);
                    return { bundles: [] };
                }
            },

           async purchaseBundle(bundleId, recipientPhone) {
                try {
                    const { data: { user }, error } = await getAuthUser();
                    if (error || !user) throw new Error('No authentication token');

                    // Get network and size from the selected bundle stored in state
                    const bundle = state.selectedBundle;
                    if (!bundle) throw new Error('No bundle selected — please try again');

                    const network = bundle.network;
                    const size    = bundle.sizeNum;

                    if (!network || !size) {
                        throw new Error('Invalid bundle — missing network or size');
                    }

                    // Call the buy-data Supabase function
                    // NOTE: custom_price is intentionally omitted — price is always
                    // sourced server-side from the DB (user_bundle_prices → base price).
                    const _buyRes = await userFetch('buy-data', {
                            network:  network.toLowerCase(),
                            phone:    recipientPhone,
                            size:     size,
                            user_id:  user.id,
                        });
                    const data = await _buyRes.json();
                    if (!_buyRes.ok) {
                        console.error('Function error:', data);
                        throw new Error(data?.message || 'Purchase failed');
                    }

                    if (!data || !data.status) {
                        throw new Error(data?.message || 'Purchase failed');
                    }

                    return {
                        success: true,
                        newBalance: data.new_balance,
                        orderReference: data.order_reference,
                        message: data.message
                    };
                } catch (error) {
                    console.error('Purchase error:', error);
                    throw new Error(error.message || 'Purchase failed');
                }
            },

            // Helper method to get bundle by ID
            async getBundleById(bundleId) {
                const networks = ['MTN', 'AIRTELTIGO', 'TELECEL'];
                for (const network of networks) {
                    const { bundles } = await this.getBundles(network);
                    const bundle = bundles.find(b => b.id === bundleId);
                    if (bundle) return bundle;
                }
                return null;
            },

            // Payment
            async initializePayment(amount, network, phone) {
                // Mock payment initialization
                return {
                    reference: `PAY_${Date.now()}`,
                    amount,
                    network,
                    phone
                };
            },

      async verifyPayment(reference, bundleAmount, charge) {
            try {
                const { data: { user }, error } = await getAuthUser();
                if (error || !user) throw new Error('No authentication token');

                // Call verify-paystack via user-proxy — no token in the browser
                const _vpRes = await userFetch('verify-paystack', {
                    reference,
                    bundle_amount: bundleAmount,
                    processing_charge: charge
                });
                const data = await _vpRes.json();
                if (!_vpRes.ok) {
                    console.error('Function error:', data);
                    throw new Error(data?.message || 'Payment verification failed');
                }

                // Ensures idempotent behavior by treating repeated confirmations as successful.
                if (data?.duplicate) {
                    console.log('ℹ️ Payment already processed (duplicate) — treating as success:', reference);
                    return { status: 'success', newBalance: null, amount: data.amount ?? null, duplicate: true };
                }

                if (!data || !data.success) {
                    throw new Error(data?.message || 'Payment verification failed');
                }

                return {
                    status: 'success',
                    newBalance: data.new_balance,
                    amount: data.amount
                };
            } catch (error) {
                console.error('Payment verification error:', error);
                throw new Error(error.message || 'Payment verification failed');
            }
        }
        };
        
        // Utility Functions
        function formatCurrency(amount) {
            return `${CONFIG.DEFAULT_CURRENCY} ${parseFloat(amount).toFixed(2)}`;
        }
        
 function formatDate(dateString) {
  if (!dateString) return 'Unknown date';
  
  const date = new Date(dateString);
  
  // Check if date is valid
  if (isNaN(date.getTime())) {
    console.error('Invalid date string:', dateString);
    return 'Invalid date';
  }
  
  return date.toLocaleDateString('en-GH', { 
    day: '2-digit', 
    month: 'short', 
    year: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit' 
  });
}

        function validatePhone(phone) {
  // Ghana phone number validation - accepts all 10-digit numbers
  const clean = phone.replace(/\s+/g, '');
  
  // Normalize +233 / 233 to leading 0
  let normalized = clean;
  if (normalized.startsWith('+233')) {
    normalized = '0' + normalized.slice(4);
  } else if (normalized.startsWith('233')) {
    normalized = '0' + normalized.slice(3);
  }

  // Accept any 0XXXXXXXXX (10 digits)
  return /^0\d{9}$/.test(normalized);
}

        function showToast(message, type = 'success') {
            const icons = {
                success: 'check-circle',
                error: 'exclamation-circle',
                warning: 'exclamation-triangle',
                info: 'info-circle'
            };
            
            const colors = {
                success: 'bg-green-50 text-green-800 border-green-200',
                error: 'bg-red-50 text-red-800 border-red-200',
                warning: 'bg-yellow-50 text-yellow-800 border-yellow-200',
                info: 'bg-blue-50 text-blue-800 border-blue-200'
            };
            
            const toast = document.createElement('div');
            toast.className = `toast ${colors[type]} border rounded-lg p-4 shadow-lg`;
            toast.innerHTML = `
                <div class="flex items-center">
                    <i class="fas fa-${icons[type]} mr-3"></i>
                    <span class="font-medium">${message}</span>
                </div>
            `;
            
            const container = document.getElementById('toastContainer');
            container.appendChild(toast);
            
            setTimeout(() => toast.classList.add('show'), 10);
            
            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 300);
            }, 5000);
        }
        
        function showLoading(element) {
            element.innerHTML = `
                <div class="flex items-center justify-center py-8">
                    <div class="w-8 h-8 rounded-full border-2 border-brand-200 border-t-brand-600 animate-spin"></div>
                </div>
            `;
        }
        
        function showError(element, message) {
            element.innerHTML = `
                <div class="text-center py-8 text-gray-500">
                    <i class="fas fa-exclamation-triangle text-2xl mb-2"></i>
                    <p>${message}</p>
                </div>
            `;
        }
        
        // UI Management
        function updateBalanceDisplay() {
            const balance = formatCurrency(state.balance);
            document.getElementById('dashboardBalance').textContent = balance;
            document.getElementById('purchasePageBalance').textContent = balance;
            document.getElementById('mobileHeaderBalance').textContent = balance;
            document.getElementById('desktopBalance').textContent = balance;
            document.getElementById('mobileSidebarBalance').textContent = balance;
        }
        
        function updateUserDisplay() {
            if (!state.user) return;

            const fullName = `${state.user.firstName} ${state.user.lastName}`;
            document.getElementById('desktopUserName').textContent = fullName;
            document.getElementById('headerUserName').textContent = fullName;
            document.getElementById('mobileSidebarUserName').textContent = fullName;

            document.getElementById('firstName').value = state.user.firstName || '';
            document.getElementById('lastName').value = state.user.lastName || '';
            document.getElementById('email').value = state.user.email || '';
            document.getElementById('phone').value = state.user.phone || '';

            if (state.user.notifications) {
                document.getElementById('emailNotifications').checked = state.user.notifications.email || false;
                document.getElementById('smsNotifications').checked = state.user.notifications.sms || false;
                document.getElementById('pushNotifications').checked = state.user.notifications.push || false;
            }
        }
        
      async function loadRecentTransactions() {
  const container = document.getElementById('transactionsList');
  showLoading(container);
  
  try {
    const { data: { user } } = await getAuthUser();
    if (!user) return;

    const [ordersRes, depositsRes] = await Promise.all([
      userFetch('get-user-data', {}, 'section=orders&pageSize=5'),
      userFetch('get-user-data', {}, 'section=transactions&pageSize=5'),
    ]);
    const ordersData   = await ordersRes.json();
    const depositsData = await depositsRes.json();

    const orders  = ordersData.success  ? (ordersData.orders        || []) : [];
    const deposits = depositsData.success ? (depositsData.transactions || []).filter(t => t.type === 'deposit') : [];

    const combined = [
      ...orders.map(o => ({
        description: o.description || 'Data Purchase',
        created_at: o.created_at,
        amount: -(parseFloat(o.amount || 0)),
        status: o.status
      })),
      ...deposits.map(d => ({
        description: d.description || 'Wallet Deposit',
        created_at: d.created_at,
        amount: parseFloat(d.amount || 0),
        status: d.status
      }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);

    if (combined.length === 0) {
      container.innerHTML = `
        <div class="text-center py-8 text-gray-400">
          <i class="fas fa-history text-3xl mb-2 opacity-30"></i>
          <p>No recent activity</p>
        </div>
      `;
      return;
    }

   container.innerHTML = combined.map(tx => `
      <div class="transaction-row">
        <div class="tx-left">
          <p class="tx-desc">${esc(tx.description)}</p>
          <p class="tx-date">${formatDate(tx.created_at)}</p>
        </div>
        <div class="tx-right">
          <span class="tx-amount ${tx.amount < 0 ? 'debit' : 'credit'}">
            ${tx.amount < 0 ? '- ' : '+ '}${formatCurrency(Math.abs(tx.amount))}
          </span>
          <span class="${getStatusClass(tx.status)}">${esc(tx.status)}</span>
        </div>
      </div>
    `).join('');
    
  } catch (error) {
    showError(container, 'Failed to load transactions');
  }
}
        function getStatusClass(status) {
            switch(status) {
                case 'completed': return 'status-success';
                case 'pending': return 'status-pending';
                case 'failed': return 'status-failed';
                default: return 'status-pending';
            }
        }
        
      // Page Navigation
async function navigateTo(page) {
    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    
    // Show selected page
    document.getElementById(`${page}Page`).classList.add('active');
    state.currentPage = page;
    
    // Update page titles
    const titles = {
        dashboard: 'Dashboard',
        purchase: 'Buy Data',
        topup: 'Add Funds',
        history: 'Transaction History',
        store: 'My Store',
        storeOrders: 'Store Orders',
        settings: 'Settings',
        'api-access': 'API Access',
    };
    
    document.getElementById('mobilePageTitle').textContent = titles[page];
    document.getElementById('desktopPageTitle').textContent = titles[page];
    
    // Update active navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('bg-gray-800');
        if (item.dataset.page === page) {
            item.classList.add('bg-gray-800');
        }
    });
    
    // Page-specific initialization
    switch(page) {
        case 'dashboard':
            await updateDashboard();
            break;
        case 'history':
            await loadHistory();
            break;
        case 'purchase':
            resetPurchasePage();
            break;
        case 'store':
            await loadStorePage();
            break;
        case 'storeOrders':
            await loadStoreOrdersPortal();
            break;
        case 'api-access':
            await loadApiAccessPage();
            break;
    }
    
    closeMobileSidebar();
}

  // Expose navigateTo globally for inline handler compatibility.
  window.navigateTo = navigateTo;

        
        async function updateDashboard() {
            try {
                const [statsData, ordersRes] = await Promise.all([
                    api.getTransactions(1, 100),
                    userFetch('get-user-data', {}, 'section=orders&pageSize=200'),
                ]);
                const ordersJson       = ordersRes ? await ordersRes.json() : { success: false };
                const allOrders        = ordersJson.success ? (ordersJson.orders || []) : [];
                const orderCount       = allOrders.length;
                const totalSpentAmount = allOrders.reduce((sum, o) => sum + parseFloat(o.amount || 0), 0);
                const purchases        = statsData.transactions.filter(tx => tx.type === 'purchase');
                const displayCount     = orderCount > 0 ? orderCount : purchases.length;
                const displaySpend     = orderCount > 0 ? totalSpentAmount
                    : purchases.reduce((s, tx) => s + Math.abs(parseFloat(tx.amount || 0)), 0);
                document.getElementById('totalPurchases').textContent = displayCount;
                const totalSpendEl = document.getElementById('totalSpend');
                if (totalSpendEl) totalSpendEl.textContent = `GH₵ ${displaySpend.toFixed(2)} spent`;
                loadRecentTransactions();
            } catch (error) {
                showToast('Failed to load dashboard data', 'error');
            }
        }
        
        // Purchase Functions
        function resetPurchasePage() {
            state.selectedNetwork = null;
            state.selectedBundle = null;
            document.querySelectorAll('.network-btn').forEach(btn => {
                btn.classList.remove('selected');
            });
            
            const container = document.getElementById('bundlesContainer');
            container.innerHTML = `
                <div class="text-center py-12 bg-gray-50 rounded-xl border-2 border-dashed border-gray-300">
                    <i class="fas fa-hand-pointer text-3xl text-gray-400 mb-3"></i>
                    <p class="text-gray-500 font-medium">Select a network to view bundles</p>
                    <p class="text-gray-400 text-sm mt-1">Tap any network card above</p>
                </div>
            `;
        }
        
        async function loadBundles(network) {
            state.selectedNetwork = network;
            const container = document.getElementById('bundlesContainer');
            showLoading(container);
            
            try {
                const data = await api.getBundles(network);
                state.bundles[network] = data.bundles;
                
                if (!data.bundles || data.bundles.length === 0) {
                    container.innerHTML = `
                        <div class="text-center py-12 bg-gray-50 rounded-xl">
                            <i class="fas fa-exclamation-circle text-3xl text-gray-400 mb-3"></i>
                            <p class="text-gray-500 font-medium">No bundles available for ${network}</p>
                            <p class="text-gray-400 text-sm mt-1">Please check back later</p>
                        </div>
                    `;
                    return;
                }
                
              container.innerHTML = `
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        ${data.bundles.map(bundle => `
                            <div class="card p-4 hover:shadow-md transition-shadow">
                                <div class="flex justify-between items-start mb-3">
                                    <div>
                                        <h4 class="font-bold text-gray-800 text-lg">${bundle.name}</h4>
                                        <p class="text-sm text-gray-500">${bundle.size} • ${bundle.validity}</p>
                                    </div>
                                    <div class="text-right">
                                        ${bundle.hasCustomPrice
                                            ? `<p class="text-xs text-slate-400 line-through">${formatCurrency(bundle.basePrice)}</p>
                                               <p class="font-bold text-green-600 text-xl">${formatCurrency(bundle.price)}</p>
                                               <span class="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Special price</span>`
                                            : `<p class="font-bold text-brand-600 text-xl">${formatCurrency(bundle.price)}</p>`
                                        }
                                    </div>
                                </div>
                                <button 
                                    class="bundle-btn w-full bg-brand-600 hover:bg-brand-700 text-white font-semibold py-2.5 rounded-xl transition-colors"
                                    data-id="${bundle.id}"
                                    data-network="${bundle.network}"
                                    data-sizenum="${bundle.sizeNum}"
                                    data-name="${bundle.name}"
                                    data-price="${bundle.price}"
                                    data-baseprice="${bundle.basePrice}"
                                    data-size="${bundle.size}"
                                    data-validity="${bundle.validity}">
                                    Buy Now
                                </button>
                            </div>
                        `).join('')}
                    </div>
                `;
                
                // Attach event listeners to bundle buttons
                document.querySelectorAll('.bundle-btn').forEach(btn => {
                    btn.addEventListener('click', function() {
                        selectBundle({
                            id:        this.dataset.id,
                            network:   this.dataset.network,
                            sizeNum:   parseInt(this.dataset.sizenum),
                            name:      this.dataset.name,
                            price:     parseFloat(this.dataset.price),
                            basePrice: parseFloat(this.dataset.baseprice),
                            size:      this.dataset.size,
                            validity:  this.dataset.validity
                        });
                    });
                });
            } catch (error) {
                showError(container, 'Failed to load bundles');
            }
        }
        
        function selectBundle(bundle) {
            state.selectedBundle = bundle;
            
            document.getElementById('selectedBundle').innerHTML = `
                <div class="flex justify-between items-center">
                    <div>
                        <p class="text-xs text-brand-600 font-medium uppercase">Selected Bundle</p>
                        <p class="font-bold text-gray-800 text-lg">${bundle.name}</p>
                        <p class="text-sm text-gray-500">${bundle.size} • ${bundle.validity}</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs text-brand-600 font-medium uppercase">Price</p>
                        <p class="font-bold text-brand-700 text-2xl">${formatCurrency(bundle.price)}</p>
                    </div>
                </div>
            `;
            
            document.getElementById('modalTotal').textContent = formatCurrency(bundle.price);
            
            const newBalance = state.balance - bundle.price;
            document.getElementById('modalNewBalance').textContent = formatCurrency(Math.max(newBalance, 0));
            
            // Show modal
            console.log('Showing purchase modal');
            const modal = document.getElementById('purchaseModal');
            if (modal) {
                modal.classList.remove('hidden');
                document.body.style.overflow = 'hidden';
                console.log('Modal should now be visible');
            } else {
                console.error('Purchase modal element not found');
            }
            
            // Clear recipient phone
            document.getElementById('recipientPhone').value = '';
        }
        
        async function processPurchase() {
            const phone = document.getElementById('recipientPhone').value.trim();
            const confirmBtn = document.getElementById('confirmPurchase');

            // Validation
            if (!validatePhone(phone)) {
                showToast('Please enter a valid Ghana phone number', 'error');
                return;
            }

            if (state.balance < state.selectedBundle.price) {
                showToast('Insufficient balance. Please add funds first.', 'error');
                return;
            }

            // Disable button during processing
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Processing...';

            try {
                const result = await api.purchaseBundle(state.selectedBundle.id, phone);

                // Update balance
                state.balance = result.newBalance;
                updateBalanceDisplay();

                // Show success message
                showToast(`Success! ${state.selectedBundle.name} sent to ${phone}`, 'success');

                // Close modal
                closeModal();

                // Refresh dashboard
                await updateDashboard();

            } catch (error) {
                showToast(error.message || 'Purchase failed. Please try again.', 'error');
            } finally {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Confirm Purchase';
            }
        }
        
        // Payment Functions
        async function initializePayment() {
            const amount = parseFloat(document.getElementById('topupAmount').value);
            const network = document.getElementById('mobileNetwork').value;
            const phone = document.getElementById('mobileNumber').value.trim();
            
           // Separate processing charge is applied; wallet credit excludes fees.
            const charge = Math.round(amount * (CONFIG.TOPUP_CHARGE_PERCENT / 100) * 100) / 100;
            const totalAmount = Math.round((amount + charge) * 100) / 100;
            
            // Validation
            if (!amount || amount < CONFIG.MIN_TOPUP_AMOUNT || amount > CONFIG.MAX_TOPUP_AMOUNT) {
                showToast(`Amount must be between ${CONFIG.DEFAULT_CURRENCY} ${CONFIG.MIN_TOPUP_AMOUNT} and ${CONFIG.DEFAULT_CURRENCY} ${CONFIG.MAX_TOPUP_AMOUNT}`, 'error');
                return;
            }
            
            if (!network) {
                showToast('Please select a mobile network', 'error');
                return;
            }
            
            if (!validatePhone(phone)) {
                showToast('Please enter a valid Ghana phone number', 'error');
                return;
            }
            
            try {
                const paymentData = await api.initializePayment(amount, network, phone);
                
                // Initialize Paystack payment with total amount (including charge)
                const handler = PaystackPop.setup({
                    key: CONFIG.PAYSTACK_PUBLIC_KEY,
                    email: state.user.email,
                    amount: totalAmount * 100,
                    currency: 'GHS',
                    ref: 'WALLET-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7).toUpperCase(),
                    channels: ['mobile_money'],
                    metadata: {
                        user_id: state.user.id,
                        phone_number: phone,
                        network: network,
                        bundle_amount: amount,         // original deposit — wallet credit amount
                        processing_charge: charge      // fee — NOT credited to wallet
                    },
                  callback: function(response) {
                        // ── RESILIENCE: Save pending top-up immediately before any network call ──
                        try {
                            localStorage.setItem(`pending_topup_${response.reference}`, JSON.stringify({
                                reference: response.reference,
                                amount: amount,
                                charge: charge,
                                userId: state.user?.id,
                                savedAt: Date.now()
                            }));
                        } catch(_) {}
                        verifyPaymentWithRetry(response.reference, amount, charge);
                    },
                    onClose: function() {
                        showToast('Payment cancelled', 'info');
                    }
                });
                
                handler.openIframe();
                
            } catch (error) {
                showToast('Payment initialization failed', 'error');
            }
        }
        
        // ── RESILIENCE: Retry wrapper with exponential back-off ──────────────────
        async function verifyPaymentWithRetry(reference, bundleAmount, charge, maxAttempts = 4) {
            let attempt = 0;
            while (attempt < maxAttempts) {
                try {
                    await verifyPayment(reference, bundleAmount, charge);
                    try { localStorage.removeItem(`pending_topup_${reference}`); } catch(_) {}
                    return;
                } catch (err) {
                    attempt++;
                    if (attempt >= maxAttempts) {
                        console.error('❌ All retry attempts exhausted for top-up:', reference);
                        showToast('Payment received — your wallet will be credited shortly. Please refresh in a moment.', 'info');
                        return;
                    }
                    const delay = Math.min(2000 * Math.pow(2, attempt - 1), 16000); // 2s, 4s, 8s
                    console.warn(`⚠️ Top-up verify attempt ${attempt} failed — retrying in ${delay}ms:`, err.message);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }

        // ── RESILIENCE: Recover pending top-ups on page load ─────────────────────
        async function recoverPendingTopups() {
            try {
                const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
                const keys = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith('pending_topup_')) keys.push(k);
                }
                for (const key of keys) {
                    // FIX #5: parse p BEFORE the try/catch so it is in scope in the catch block
                    const raw = localStorage.getItem(key);
                    if (!raw) continue;
                    let p;
                    try {
                        p = JSON.parse(raw);
                    } catch (_) {
                        localStorage.removeItem(key);
                        continue;
                    }
                    if (!p.reference) { localStorage.removeItem(key); continue; }
                    if (Date.now() - (p.savedAt || 0) > MAX_AGE_MS) { localStorage.removeItem(key); continue; }
                    // Only recover top-ups that belong to the currently logged-in user
                    if (p.userId && state.user?.id && p.userId !== state.user.id) continue;
                    try {
                        console.log('🔄 Recovering pending wallet top-up:', p.reference);
                        await verifyPayment(p.reference, p.amount, p.charge);
                        localStorage.removeItem(key);
                        console.log('✅ Recovered wallet top-up:', p.reference);
                    } catch(e) {
                        const msg = (e.message || '').toLowerCase();
                        if (msg.includes('already processed') || msg.includes('duplicate')) {
                            // Payment succeeded on a previous attempt — safe to clear
                            localStorage.removeItem(key);
                            console.log('ℹ️ Top-up already processed — cleared from localStorage:', p.reference);
                        } else {
                            console.warn('⚠️ Could not auto-recover top-up from key:', key, e);
                            // Leave in localStorage — the webhook safety net handles it server-side
                        }
                    }
                }
            } catch(e) { console.warn('recoverPendingTopups error:', e); }
        }

       async function verifyPayment(reference, bundleAmount, charge) {
            try {
                const result = await api.verifyPayment(reference, bundleAmount, charge);
                
                if (result.status === 'success') {
                    // FIX #6: only update balance display when a new balance is actually returned
                    // (duplicate payments return newBalance: null and must not zero out the display)
                    if (result.newBalance != null) {
                        state.balance = result.newBalance;
                        updateBalanceDisplay();
                    }
                    
                    showToast('Payment successful! Wallet updated.', 'success');
                    
                    // Refresh dashboard
                    await updateDashboard();
                    
                    // Navigate back to dashboard
                    navigateTo('dashboard');
                } else {
                    showToast('Payment verification failed', 'error');
                }
            } catch (error) {
                showToast('Payment verification failed', 'error');
            }
        }
        
// History Functions
 async function loadHistory() {
  const container = document.getElementById('historyList');
  const searchTerm = document.getElementById('historySearch').value.toLowerCase();
  const filter = document.getElementById('historyFilter').value;

  showLoading(container);

  try {
    const { data: { user } } = await getAuthUser();
    if (!user) return;

    let transactions = [];

    if (filter === 'all' || filter === 'purchase') {
      const oRes  = await userFetch('get-user-data', {}, 'section=orders&pageSize=200');
      const oData = await oRes.json();
      const mapped = (oData.success ? oData.orders || [] : []).map(o => ({
        id:          o.id,
        description: o.description || `${(o.network || '').toUpperCase()} ${o.package_size || ''}GB Data`,
        created_at:  o.created_at,
        amount:      -(parseFloat(o.amount || 0)),
        status:      o.status,
        type:        'purchase',
        recipient:   o.recipient
      }));
      transactions = [...transactions, ...mapped];
    }

    if (filter === 'all' || filter === 'deposit') {
      const dRes  = await userFetch('get-user-data', {}, 'section=transactions&pageSize=200');
      const dData = await dRes.json();
      const mapped = (dData.success ? dData.transactions || [] : [])
        .filter(t => t.type === 'deposit')
        .map(d => ({
          id:          d.id,
          description: d.description || 'Wallet Deposit',
          created_at:  d.created_at,
          amount:      parseFloat(d.amount || 0),
          status:      d.status,
          type:        'deposit',
          recipient:   d.details?.recipient
        }));
      transactions = [...transactions, ...mapped];
    }

    if (filter === 'withdrawal') {
      const wRes  = await userFetch('get-user-data', {}, 'section=withdrawals');
      const wData = await wRes.json();
      const mapped = (wData.success ? wData.withdrawals || [] : []).map(w => ({
        id:          w.id,
        description: `Withdrawal — ${w.network || w.method || 'MoMo'} (${w.recipient_account || ''})`,
        created_at:  w.created_at,
        amount:      -(parseFloat(w.amount || 0)),
        status:      w.status,
        type:        'withdrawal'
      }));
      transactions = [...transactions, ...mapped];
    }

    // Sort all by date descending
    transactions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Apply search filter
    if (searchTerm) {
      transactions = transactions.filter(tx =>
        tx.description?.toLowerCase().includes(searchTerm) ||
        tx.recipient?.toLowerCase().includes(searchTerm)
      );
    }

    // Paginate manually
    const pageSize = CONFIG.PAGE_SIZE;
    state.historyTotal = transactions.length;
    const paged = transactions.slice((state.historyPage - 1) * pageSize, state.historyPage * pageSize);

    if (paged.length === 0) {
      container.innerHTML = `
        <div class="text-center py-8 text-gray-400">
          <i class="fas fa-search text-3xl mb-2 opacity-30"></i>
          <p>No transactions found</p>
        </div>
      `;
      updatePagination();
      return;
    }

container.innerHTML = paged.map(tx => `
      <div class="history-row">
        <div class="tx-left">
          <p class="tx-desc">${esc(tx.description)}</p>
          <p class="tx-date">${formatDate(tx.created_at)}</p>
          ${tx.recipient ? `<p class="tx-sub">${esc(tx.recipient)}</p>` : ''}
        </div>
        <div class="tx-right">
          <span class="tx-amount ${tx.amount < 0 ? 'debit' : 'credit'}">
            ${tx.amount < 0 ? '- ' : '+ '}${formatCurrency(Math.abs(tx.amount))}
          </span>
          <span class="${getStatusClass(tx.status)}">${esc(tx.status)}</span>
        </div>
      </div>
    `).join('');

    updatePagination();

  } catch (error) {
    showError(container, 'Failed to load history');
  }
}

        
        function updatePagination() {
            const start = (state.historyPage - 1) * CONFIG.PAGE_SIZE + 1;
            const end = Math.min(state.historyPage * CONFIG.PAGE_SIZE, state.historyTotal);
            
            document.getElementById('paginationInfo').textContent = 
                `Showing ${start}-${end} of ${state.historyTotal}`;
            
            document.getElementById('prevPage').disabled = state.historyPage === 1;
            document.getElementById('nextPage').disabled = end >= state.historyTotal;
        }
        
        // Settings Functions
        async function saveProfile(e) {
            e.preventDefault();
            
            const profileData = {
                firstName: document.getElementById('firstName').value,
                lastName: document.getElementById('lastName').value,
                email: document.getElementById('email').value,
                phone: document.getElementById('phone').value,
                notifications: {
                    email: document.getElementById('emailNotifications').checked,
                    sms: document.getElementById('smsNotifications').checked,
                    push: document.getElementById('pushNotifications').checked
                }
            };
            
          try {
                const result = await api.updateProfile(profileData);
                // Merge back into state keeping firstName/lastName split
                state.user = {
                    ...state.user,
                    ...result.user,
                    firstName: profileData.firstName,
                    lastName: profileData.lastName,
                    email: profileData.email,
                    phone: profileData.phone
                };
                updateUserDisplay();
                showToast('Profile updated successfully', 'success');
            } catch (error) {
                showToast('Failed to update profile', 'error');
            }
        }
        
        // Session Management
        function startSessionTimer() {
            state.lastActivity = Date.now();
            
            state.sessionTimer = setInterval(() => {
                const now = Date.now();
                if (now - state.lastActivity > CONFIG.SESSION_TIMEOUT) {
                    logout();
                }
            }, 60000); // Check every minute
        }
        
        function updateActivity() {
            state.lastActivity = Date.now();
        }
        
        async function logout() {
           // v2: userLogout() calls user-auth Edge Function which revokes
            // the server-side session, deletes the DB row, and clears the cookie.
            await userLogout();
            window.location.href = 'login.html';
        }
        
        // Modal Functions
        function closeModal() {
            document.getElementById('purchaseModal').classList.add('hidden');
            document.body.style.overflow = '';
        }
        
    function openMobileSidebar() {
        console.log('Opening mobile sidebar');
        const sidebar = document.getElementById('mobileSidebar');
        const overlay = document.getElementById('mobileOverlay');
        if (sidebar && overlay) {
            sidebar.classList.add('open');
            overlay.classList.remove('hidden');
            document.body.style.overflow = 'hidden';
            // Add animation
            requestAnimationFrame(() => {
                sidebar.style.transform = 'translateX(0)';
            });
        } else {
            console.error('Mobile sidebar elements not found');
        }
    }

    function closeMobileSidebar() {
        console.log('Closing mobile sidebar');
        const sidebar = document.getElementById('mobileSidebar');
        const overlay = document.getElementById('mobileOverlay');
        if (sidebar && overlay) {
            sidebar.style.transform = 'translateX(-100%)';
            overlay.classList.add('hidden');
            document.body.style.overflow = '';
            setTimeout(() => {
                sidebar.classList.remove('open');
            }, 300);
        }
    }
        
      // In dashboard.html, update loadStorePage function
async function loadStorePage() {
  try {
    const profileRes = await userFetch('get-user-data', {}, 'section=profile');
    const profileData = await profileRes.json();
    if (!profileData.success) { showToast('Failed to load store data', 'error'); return; }

    const profile = profileData.profile;
    const balance = parseFloat(profileData.balance || 0);

    // ── Show full-screen overlay ──────────────────────────────────────────────
    const overlay  = document.getElementById('storeOverlay');
    const paywall  = document.getElementById('overlayStorePaywall');
    const content  = document.getElementById('overlayStoreContent');

    overlay.classList.add('active');

    // Move all real tab panels into the overlay content div so they render correctly
    const panels = ['mystore','bundleprices','recentorders','withdrawalhistory','customization'];
    panels.forEach(function(t) {
        const panel = document.getElementById('storeTab-' + t);
        if (panel && panel.parentElement !== content) {
            content.appendChild(panel);
        }
    });

    if (!profile.store_unlocked) {
      paywall.classList.remove('hidden');
      content.classList.add('hidden');

      const balanceInfo = document.getElementById('overlayPaywallBalanceInfo');
      const unlockBtn   = document.getElementById('overlayUnlockStoreBtn');
      if (balanceInfo && unlockBtn) {
        if (balance >= 50) {
          balanceInfo.innerHTML = `<span class="text-green-600 font-medium"><i class="fas fa-check-circle mr-1"></i>Your balance: ${formatCurrency(balance)} — Ready to unlock!</span>`;
          unlockBtn.disabled = false;
        } else {
          const needed = (50 - balance).toFixed(2);
          balanceInfo.innerHTML = `<span class="text-red-500 font-medium"><i class="fas fa-exclamation-circle mr-1"></i>Your balance: ${formatCurrency(balance)} — Top up GH₵${needed} more to unlock</span>`;
          unlockBtn.disabled = true;
        }
      }
      return;
    }

    // Unlocked — show content
    paywall.classList.add('hidden');
    content.classList.remove('hidden');

    // Activate Overview tab immediately so desktop never shows blank
    switchStoreTab('mystore');

    // Load data in parallel
    await Promise.all([loadStoreStats(), loadStoreCustomization()]);

    // Wire the sidebar "Open Store" button
    try {
      const { data: { user } } = await getAuthUser();
      const storeLink = _storeShortCode
        ? `${_baseUrl}store?s=${_storeShortCode}`
        : `${_baseUrl}store?slug=${user.id}`;
      const openBtn = document.getElementById('openStoreBtn');
      if (openBtn) { openBtn.classList.remove('hidden'); openBtn.onclick = () => window.open(storeLink, '_blank', 'noopener,noreferrer'); }
    } catch(_) {}

  } catch (error) {
    console.error('❌ Error loading store page:', error);
    showToast('Failed to load store data', 'error');
  }
}

// Exit the full-screen store overlay and return to dashboard
function exitStore() {
    const overlay = document.getElementById('storeOverlay');
    if (overlay) overlay.classList.remove('active');

    // Restore tab panels to hidden container for reuse on reopen.
    const storeContent = document.getElementById('storeContent');
    const panels = ['mystore','bundleprices','recentorders','withdrawalhistory','customization'];
    panels.forEach(function(t) {
        const panel = document.getElementById('storeTab-' + t);
        if (panel && storeContent && panel.parentElement !== storeContent) {
            storeContent.appendChild(panel);
            panel.classList.add('hidden');
        }
    });

    navigateTo('dashboard');
}

// ── Store mobile drawer ───────────────────────────────────────────────────────
function openStoreDrawer() {
    const drawer = document.getElementById('storeSideDrawer');
    const panel  = document.getElementById('storeDrawerPanel');
    if (!drawer || !panel) return;
    drawer.style.display = 'block';
    // Force reflow so the CSS transition fires
    panel.getBoundingClientRect();
    panel.style.transform = 'translateX(0)';
}

function closeStoreDrawer() {
    const drawer = document.getElementById('storeSideDrawer');
    const panel  = document.getElementById('storeDrawerPanel');
    if (!drawer || !panel) return;
    panel.style.transform = 'translateX(-100%)';
    setTimeout(function() { drawer.style.display = 'none'; }, 290);
}

window.openStoreDrawer  = openStoreDrawer;
window.closeStoreDrawer = closeStoreDrawer;
// ─────────────────────────────────────────────────────────────────────────────
window.exitStore = exitStore;
window.withdrawProfits = withdrawProfits;
window.unlockStore = unlockStore;

async function unlockStore() {
  // Target whichever unlock button is visible (overlay or original paywall)
  const btn = document.getElementById('overlayUnlockStoreBtn') || document.getElementById('unlockStoreBtn');
  if (!btn) return;
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing...';

  try {
    const res = await userFetch('unlock-store', { action: 'unlock' });
    const data = await res.json();

    if (data.success) {
      showToast('🎉 Store unlocked successfully! Welcome aboard.', 'success');
      state.balance = Math.max(0, state.balance - 50);
      updateBalanceDisplay();
      // Reload store page — this will now show the overlay with content
      await loadStorePage();
    } else {
      showToast(data.message || 'Failed to unlock store', 'error');
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  } catch (error) {
    console.error('❌ Unlock store error:', error);
    showToast('Failed to unlock store: ' + error.message, 'error');
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

async function loadStoreStats() {
  try {
    // Fetch stats and store info in parallel to build complete store view.
    const [statsRes, storeRes] = await Promise.all([
      userFetch('get-user-data', {}, 'section=store-stats'),
      userFetch('get-user-data', {}, 'section=store'),
    ]);
    const result    = await statsRes.json();
    const storeData = await storeRes.json();

    if (!result.success) { console.error('store-stats error:', result.message); return; }

    const el1 = document.getElementById('storeTotalOrders');
    const el2 = document.getElementById('storeTotalRevenue');
    if (el1) el1.textContent = result.orderCount ?? 0;
    // BUG FIX: Show availableProfits (earnings minus withdrawals), not totalEarned
    // (lifetime gross). This matches the admin portal's "Available Profit" figure
    // so both portals are consistent. totalEarned is gross lifetime; availableProfits
    // is what the user can actually withdraw right now.
    if (el2) el2.textContent = formatCurrency(result.totalRevenue ?? 0);

    const el4 = document.getElementById('storePendingBalance');
    const el5 = document.getElementById('storeTotalWithdrawn');
    if (el4) el4.textContent = formatCurrency(result.pendingBalance ?? 0);
    if (el5) el5.textContent = formatCurrency(result.totalWithdrawn ?? 0);

    // Store the short_code for use by all link-building functions in this session
    _storeShortCode = storeData?.store?.short_code || null;

    // Update store display name from the actual stores table record
    const el6 = document.getElementById('storeDisplayName');
    if (el6) {
      const storeName = storeData?.store?.name || null;
      if (storeName) el6.textContent = storeName;
    }

    // Update the right sidebar store name badge
    const sidebarStoreName = document.getElementById('sidebarStoreName');
    if (sidebarStoreName) {
      const storeName = storeData?.store?.name || null;
      if (storeName) sidebarStoreName.textContent = storeName;
    }
    // Update the overlay heading
    const headingEl = document.getElementById('storeOverlayHeading');
    if (headingEl) {
      const storeName = storeData?.store?.name || null;
      if (storeName) headingEl.textContent = storeName;
    }

    const wma = document.getElementById('withdrawModalAvailable');
    if (wma) wma.textContent = formatCurrency(result.availableProfits ?? 0);
    const wta = document.getElementById('withdrawTabAvailable');
    if (wta) wta.textContent = formatCurrency(result.availableProfits ?? 0);
    const owa = document.getElementById('overviewWithdrawAvailable');
    if (owa) owa.textContent = formatCurrency(result.availableProfits ?? 0);
    const wa = document.getElementById('withdrawAmount');
    if (wa) wa.dataset.max = (result.availableProfits ?? 0).toFixed(2);
  } catch (error) {
    console.error('❌ Error in loadStoreStats:', error);
  }
}

// ── Pricing tab: cached bundle data ──────────────────────────────────────────
let _pricingBundleCache = null;   // { baseBundles, storePriceMap, customCostMap }
let _pricingActiveNet   = null;   // currently selected network string

// Called by switchStoreTab('bundleprices') — loads data then shows MTN by default
async function loadBundlePrices() {
  _pricingBundleCache = null;   // always refresh on tab open
  _pricingActiveNet   = null;

  const container = document.getElementById('bundlePricesContainer');
  const heading   = document.getElementById('pricingBundlesHeading');
  if (container) container.innerHTML = '<div class="text-center py-8"><div class="w-8 h-8 rounded-full border-2 border-brand-200 border-t-brand-600 animate-spin mx-auto"></div></div>';

  try {
    const { data: { user }, error: authError } = await getAuthUser();
    if (authError || !user) throw new Error('Not authenticated');

    const [bundlesResult, storePricesResult] = await Promise.all([
      userFetch('get-user-data', {}, 'section=bundles').then(r => r.json()),
      userFetch('get-user-data', {}, 'section=store-prices').then(r => r.json()),
    ]);
    if (!bundlesResult.success) throw new Error(bundlesResult.message || 'Failed to load bundles');

    const bundleRows = bundlesResult.bundles || [];
    const storePriceMap = {};
    (storePricesResult.prices || []).forEach(p => { storePriceMap[`${p.network}-${p.size}`] = parseFloat(p.store_price); });
    const customCostMap = {};
    bundleRows.forEach(b => { if (b.effective_price !== undefined && b.effective_price !== parseFloat(b.price)) customCostMap[b.id] = b.effective_price; });

    _pricingBundleCache = {
      baseBundles:    bundleRows.map(b => ({ id: b.id, network: b.network, size: b.size, price: b.price })),
      storePriceMap,
      customCostMap,
    };

    // Default to first available network (MTN preferred)
    const order = ['mtn', 'airteltigo', 'telecel'];
    const firstNet = order.find(n => _pricingBundleCache.baseBundles.some(b => b.network === n)) || order[0];
    selectPricingNetwork(firstNet);

  } catch (error) {
    console.error('❌ Error in loadBundlePrices:', error);
    if (container) container.innerHTML = `
      <div class="text-center py-8 text-red-500">
        <i class="fas fa-exclamation-triangle text-2xl mb-2"></i>
        <p>Failed to load bundle prices: ${error.message}</p>
      </div>`;
  }
}

// Render bundles for the selected network tab
function selectPricingNetwork(network) {
  if (!_pricingBundleCache) return;   // data not loaded yet

  _pricingActiveNet = network;

  // ── Update network card selected states ───────────────────────────────────
  document.querySelectorAll('.pricing-net-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.pricingNetwork === network);
  });

  const networkMeta = {
    mtn:        { label: 'MTN',        color: '#FFCC00', textColor: '#78350f', bg: '#fffbeb', border: '#fde68a', iconBg: '#fef3c7' },
    airteltigo: { label: 'AirtelTigo', color: '#004F9F', textColor: '#1e3a8a', bg: '#eff6ff', border: '#bfdbfe', iconBg: '#dbeafe' },
    telecel:    { label: 'Telecel',    color: '#E60000', textColor: '#991b1b', bg: '#fff1f2', border: '#fecdd3', iconBg: '#fee2e2' },
  };
  const meta = networkMeta[network] || networkMeta.mtn;

  const { baseBundles, storePriceMap, customCostMap } = _pricingBundleCache;
  const networkBundles = baseBundles.filter(b => b.network === network);

  const container = document.getElementById('bundlePricesContainer');
  const heading   = document.getElementById('pricingBundlesHeading');
  if (heading) heading.textContent = `${meta.label} Bundles`;
  if (!container) return;

  if (!networkBundles.length) {
    container.innerHTML = `
      <div class="text-center py-10 bg-gray-50 rounded-xl border-2 border-dashed border-gray-200">
        <i class="fas fa-exclamation-circle text-3xl text-gray-300 mb-2"></i>
        <p class="text-gray-500 font-medium">No bundles available for ${meta.label}</p>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      ${networkBundles.map(bundle => {
        const key           = `${bundle.network}-${bundle.size}`;
        const masterBase    = parseFloat(bundle.price);
        const effectiveCost = customCostMap[bundle.id] != null ? customCostMap[bundle.id] : masterBase;
        const hasCustomCost = customCostMap[bundle.id] != null;
        const savedPrice    = storePriceMap[key];
        const storePrice    = savedPrice != null ? savedPrice : effectiveCost;
        const profit        = storePrice - effectiveCost;
        const profitColor   = profit > 0 ? '#16a34a' : profit < 0 ? '#ef4444' : '#94a3b8';
        const profitBg      = profit > 0 ? '#dcfce7' : profit < 0 ? '#fee2e2' : '#f1f5f9';
        const profitText    = profit > 0 ? `+GH₵${profit.toFixed(2)}` : profit < 0 ? `-GH₵${Math.abs(profit).toFixed(2)}` : 'No profit';

        return `
          <div class="card p-4 hover:shadow-md transition-shadow">
            <div class="flex justify-between items-start mb-3">
              <div>
                <h4 class="font-bold text-gray-800 text-lg">${bundle.size}<span class="text-sm font-medium text-gray-500 ml-1">GB</span></h4>
                <p class="text-xs text-gray-400 mt-0.5">
                  ${hasCustomCost
                    ? `<span style="text-decoration:line-through;margin-right:4px;">GH₵${masterBase.toFixed(2)}</span><span style="color:#0284c7;font-weight:600;">Cost GH₵${effectiveCost.toFixed(2)}</span>`
                    : `Cost: GH₵${effectiveCost.toFixed(2)}`}
                </p>
              </div>
              <span class="profit-live text-xs font-bold px-2.5 py-1 rounded-full"
                data-bundle-id="${bundle.id}"
                style="color:${profitColor};background:${profitBg};">${profitText}</span>
            </div>
            <div class="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400 transition-all">
              <span class="text-sm font-semibold text-gray-500 flex-shrink-0">GH₵</span>
              <input
                type="number"
                class="store-price-input flex-1 bg-transparent border-none outline-none text-sm font-bold text-gray-800 min-w-0"
                data-network="${bundle.network}"
                data-size="${bundle.size}"
                data-bundle-uuid="${bundle.id}"
                data-base-price="${effectiveCost}"
                data-master-base="${masterBase}"
                value="${storePrice.toFixed(2)}"
                step="0.01"
                placeholder="0.00"
              />
            </div>
          </div>`;
      }).join('')}
    </div>`;

  // Live profit update on input
  container.querySelectorAll('.store-price-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const cost   = parseFloat(inp.dataset.basePrice) || 0;
      const newP   = parseFloat(inp.value) || 0;
      const profit = newP - cost;
      const badge  = inp.closest('.card')?.querySelector('.profit-live');
      if (!badge) return;
      if (profit > 0) {
        badge.textContent = `+GH₵${profit.toFixed(2)}`;
        badge.style.color = '#16a34a'; badge.style.background = '#dcfce7';
      } else if (profit < 0) {
        badge.textContent = `-GH₵${Math.abs(profit).toFixed(2)}`;
        badge.style.color = '#ef4444'; badge.style.background = '#fee2e2';
      } else {
        badge.textContent = 'No profit';
        badge.style.color = '#94a3b8'; badge.style.background = '#f1f5f9';
      }
    });
  });
}

window.selectPricingNetwork = selectPricingNetwork;

// Network filter for bundle prices (kept for legacy callers; no-ops if new tab UI is active)
window.filterBundleNetwork = function(network) {
  // Old chip filter references removed — this is now a no-op shim.
  if (network && network !== 'all') selectPricingNetwork(network);
};

 // ── Store Orders pagination state ──
const storeOrdersState = { page: 1, pageSize: 10, allOrders: [], userId: null };

async function loadStoreOrders(reset) {
  if (reset === true) storeOrdersState.page = 1;
  const container = document.getElementById('storeOrdersList');
  container.innerHTML = '<div class="text-center py-4"><div class="w-6 h-6 rounded-full border-2 border-brand-200 border-t-brand-600 animate-spin mx-auto"></div></div>';
  try {
    const { data: { user }, error: authError } = await getAuthUser();
    if (authError || !user) throw new Error('Not authenticated');
    storeOrdersState.userId = user.id;
    const filter = document.getElementById('orderStatusFilter')?.value || 'all';
    const statusParam = filter !== 'all' ? `&status=${encodeURIComponent(filter)}` : '';
    const res = await userFetch('get-user-data', {}, `section=store-orders${statusParam}`);
    const result = await res.json();
    if (!result.success) throw new Error(result.message || 'Failed to load orders');
    storeOrdersState.allOrders = result.orders || [];
    renderStoreOrdersPage();
  } catch (error) {
    console.error('Failed to load store orders:', error);
    container.innerHTML = '<div class="text-center py-4 text-red-500"><i class="fas fa-exclamation-triangle mb-2"></i><p class="text-sm">Failed to load orders</p></div>';
    document.getElementById('storeOrdersPagination')?.classList.add('hidden');
  }
}

function renderStoreOrdersPage() {
  const { page, pageSize, allOrders, userId } = storeOrdersState;
  const container   = document.getElementById('storeOrdersList');
  const paginationEl = document.getElementById('storeOrdersPagination');
  const infoEl       = document.getElementById('storeOrdersPaginationInfo');
  const pageIndEl    = document.getElementById('storeOrdersPageIndicator');
  const prevBtn      = document.getElementById('storeOrdersPrevBtn');
  const nextBtn      = document.getElementById('storeOrdersNextBtn');

  // No orders at all
  if (!allOrders.length) {
    container.innerHTML = `
      <div class="text-center py-8 text-gray-400">
        <i class="fas fa-shopping-cart text-3xl mb-2 opacity-30"></i>
        <p class="text-gray-600">No orders yet</p>
        <p class="text-sm text-gray-500 mt-1">Share your store link to start receiving orders!</p>
      </div>`;
    if (paginationEl) paginationEl.classList.add('hidden');
    return;
  }

  const totalOrders = allOrders.length;
  const totalPages  = Math.max(1, Math.ceil(totalOrders / pageSize));
  const safePage    = Math.max(1, Math.min(page, totalPages));
  storeOrdersState.page = safePage;

  const start = (safePage - 1) * pageSize;
  const end   = Math.min(start + pageSize, totalOrders);
  const paged = allOrders.slice(start, end);

  const statusConfig = {
    pending:    { cls: 'bg-yellow-100 text-yellow-700', icon: 'fa-clock',        label: 'Pending' },
    processing: { cls: 'bg-blue-100 text-blue-700',     icon: 'fa-cog fa-spin',  label: 'Processing' },
    completed:  { cls: 'bg-green-100 text-green-700',   icon: 'fa-check-circle', label: 'Completed' },
    delivered:  { cls: 'bg-green-100 text-green-700',   icon: 'fa-check-circle', label: 'Delivered' },
    failed:     { cls: 'bg-red-100 text-red-700',       icon: 'fa-times-circle', label: 'Failed' },
    cancelled:  { cls: 'bg-gray-100 text-gray-600',     icon: 'fa-ban',          label: 'Cancelled' },
  };

  container.innerHTML = paged.map(order => {
    const st      = (order.status || 'pending').toLowerCase();
    const cfg     = statusConfig[st] || statusConfig['pending'];

    return `
    <div class="rounded-xl p-4 bg-white border border-gray-200 hover:border-brand-300 hover:shadow-md transition-all">
      <div class="flex items-start justify-between gap-3">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-2">
            <p class="font-extrabold text-gray-900 text-sm tracking-tight">${esc((order.network||'').toUpperCase())} ${esc(String(order.package_size||''))}GB</p>
            <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${cfg.cls}">
              <i class="fas ${cfg.icon} text-xs"></i> ${cfg.label}
            </span>
          </div>
          <p class="text-xs font-semibold text-gray-600 font-mono tracking-wide mb-1 truncate">${esc(order.order_reference||'—')}</p>
          <div class="flex items-center gap-3 flex-wrap">
            <span class="inline-flex items-center gap-1 text-xs font-medium text-gray-700">
              <i class="fas fa-phone text-brand-400 text-xs"></i>${esc(order.recipient||'N/A')}
            </span>
            <span class="inline-flex items-center gap-1 text-xs font-medium text-gray-500">
              <i class="far fa-clock text-gray-400 text-xs"></i>${formatDate(order.created_at)}
            </span>
          </div>
        </div>
        <div class="text-right flex-shrink-0">
          <p class="font-extrabold text-green-600 text-base">GH₵${parseFloat(order.amount||0).toFixed(2)}</p>
        </div>
      </div>
    </div>`;
  }).join('');

  // Always show pagination bar when there are orders
  if (paginationEl) paginationEl.classList.remove('hidden');
  if (infoEl)    infoEl.textContent    = `Showing ${start + 1}–${end} of ${totalOrders} order${totalOrders !== 1 ? 's' : ''}`;
  if (pageIndEl) pageIndEl.textContent = totalPages > 1 ? `Page ${safePage} of ${totalPages}` : '';
  if (prevBtn)   prevBtn.disabled      = safePage <= 1;
  if (nextBtn)   nextBtn.disabled      = safePage >= totalPages;
}

function changeStoreOrdersPage(delta) {
  storeOrdersState.page += delta;
  renderStoreOrdersPage();
  document.getElementById('storeOrdersList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}



// Load user's withdrawal history
async function loadWithdrawalHistory() {
  try {
    const res = await userFetch('get-user-data', {}, 'section=withdrawals');
    const json = await res.json();
    if (!json.success) throw new Error(json.message || 'Failed to load withdrawal history');

    const withdrawals = json.withdrawals || [];

    const container = document.getElementById('withdrawal-history-list');
    if (!container) return;

    // Show empty state if no withdrawals
    if (!withdrawals || withdrawals.length === 0) {
      container.innerHTML = `
        <div class="text-center py-8 text-gray-400">
          <i class="fas fa-money-bill-wave text-3xl mb-2 opacity-30"></i>
          <p class="text-gray-600">No withdrawal history</p>
          <p class="text-sm text-gray-500 mt-1">Your withdrawal requests will appear here</p>
        </div>
      `;
      return;
    }

   // Status colors and icons
    const statusConfig = {
      pending: {
        color: 'bg-yellow-100 text-yellow-800',
        icon: 'fa-clock',
        text: 'Pending Review'
      },
      approved: {
        color: 'bg-blue-100 text-blue-800',
        icon: 'fa-check',
        text: 'Approved - Sending'
      },
      processing: {
        color: 'bg-indigo-100 text-indigo-800',
        icon: 'fa-spinner',
        text: 'Processing'
      },
      processed: {
        color: 'bg-green-100 text-green-800',
        icon: 'fa-check-circle',
        text: 'Sent Successfully'
      },
      completed: {
        color: 'bg-green-100 text-green-800',
        icon: 'fa-check-circle',
        text: 'Sent Successfully'
      },
      rejected: {
        color: 'bg-red-100 text-red-800',
        icon: 'fa-times-circle',
        text: 'Rejected'
      },
      cancelled: {
        color: 'bg-gray-100 text-gray-600',
        icon: 'fa-ban',
        text: 'Cancelled'
      }
    };

    // Render withdrawals
    container.innerHTML = withdrawals.map(w => {
      const status = statusConfig[w.status] || statusConfig.pending;

      // Icon background tints per status
      const iconBg = {
        pending:    'background:#fef9c3;color:#b45309;',
        approved:   'background:#dbeafe;color:#1d4ed8;',
        processing: 'background:#e0e7ff;color:#4338ca;',
        processed:  'background:#dcfce7;color:#15803d;',
        completed:  'background:#dcfce7;color:#15803d;',
        rejected:   'background:#fee2e2;color:#b91c1c;',
        cancelled:  'background:#f1f5f9;color:#64748b;',
      };
      const iconStyle = iconBg[w.status] || iconBg.pending;

      return `
        <div class="withdrawal-history-card" style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:16px;margin-bottom:10px;box-shadow:0 1px 4px rgba(0,0,0,0.05);transition:box-shadow .2s;">
          <div style="display:flex;align-items:center;gap:14px;">

            <!-- Icon -->
            <div style="width:44px;height:44px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;${iconStyle}">
              <i class="fas ${status.icon}" style="font-size:16px;"></i>
            </div>

            <!-- Middle: amount + account -->
            <div style="flex:1;min-width:0;">
              <p style="font-size:17px;font-weight:800;color:#1e293b;line-height:1.2;margin-bottom:3px;">GH₵${parseFloat(w.amount).toFixed(2)}</p>
              <p style="font-size:12px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                <i class="fas fa-mobile-alt" style="margin-right:4px;color:#94a3b8;"></i>${esc(w.recipient_account)}&nbsp;&middot;&nbsp;${esc(w.network || w.method)}
              </p>
              ${w.admin_note ? `<p style="font-size:11px;color:#b91c1c;margin-top:4px;"><i class="fas fa-exclamation-circle" style="margin-right:3px;"></i>${w.admin_note}</p>` : ''}
              ${w.rejection_reason ? `<p style="font-size:11px;color:#b91c1c;margin-top:4px;"><i class="fas fa-times-circle" style="margin-right:3px;"></i>${w.rejection_reason}</p>` : ''}
            </div>

            <!-- Right: status badge + date -->
            <div style="flex-shrink:0;text-align:right;">
              <span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:9999px;font-size:11px;font-weight:600;${iconStyle}">
                <i class="fas ${status.icon}" style="font-size:10px;"></i>${status.text}
              </span>
              <p style="font-size:11px;color:#94a3b8;margin-top:6px;">${formatDate(w.created_at)}</p>
              ${w.processed_at ? `<p style="font-size:11px;color:#16a34a;margin-top:2px;"><i class="fas fa-check" style="margin-right:2px;"></i>Sent ${formatDate(w.processed_at)}</p>` : ''}
            </div>

          </div>
        </div>
      `;
    }).join('');

  } catch (error) {
    console.error('❌ Error loading withdrawal history:', error);
    const container = document.getElementById('withdrawal-history-list');
    if (container) {
      container.innerHTML = `
        <div class="text-center py-8 text-red-500">
          <i class="fas fa-exclamation-triangle text-3xl mb-2"></i>
          <p>Failed to load withdrawal history</p>
        </div>
      `;
    }
  }
}

        async function generateStoreLink() {
            try {
                const { data: { user }, error } = await getAuthUser();
                if (error || !user) throw new Error('No authentication token');

                const storeLink = _storeShortCode
                    ? `${_baseUrl}store?s=${_storeShortCode}`
                    : `${_baseUrl}store?slug=${user.id}`;

                document.getElementById('storeLinkInput').value = storeLink;
                document.getElementById('storeLinkSection').classList.remove('hidden');

                // Show Open Store button
                const openBtn = document.getElementById('openStoreBtn');
                if (openBtn) {
                    openBtn.classList.remove('hidden');
                    openBtn.onclick = () => window.open(storeLink, '_blank', 'noopener,noreferrer');
                }

                showToast('Store link generated! Click "Open Store" to preview.', 'success');

            } catch (error) {
                console.error('Error generating store link:', error);
                showToast('Failed to generate store link', 'error');
            }
        }

  async function copyStoreTrackLink() {
    try {
        const { data: { user }, error } = await getAuthUser();
        if (error || !user) throw new Error('No authentication token');
        const trackLink = _storeShortCode
            ? `${_baseUrl}store?s=${_storeShortCode}&track=1`
            : `${_baseUrl}store?slug=${user.id}&track=1`;
        await navigator.clipboard.writeText(trackLink).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = trackLink; document.body.appendChild(ta);
            ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        });
        showToast('📋 Track Order link copied! Share with your customers.', 'success');
    } catch (error) {
        showToast('Failed to copy track link', 'error');
    }
}
window.copyStoreTrackLink = copyStoreTrackLink;

// Update bundle prices with user context and access control.
async function updateBundlePrices() {
  const priceInputs = document.querySelectorAll('.store-price-input');
  const updates = [];
  const errors = [];

 priceInputs.forEach(input => {
    const network = input.dataset.network;
    const size = parseInt(input.dataset.size);
    const storePrice = parseFloat(input.value);
    const basePrice = parseFloat(input.dataset.basePrice);
    // FIX #3: read data-bundle-uuid (not the non-existent data-bundle-id)
    const bundleId = input.dataset.bundleUuid;

    // Skip empty or invalid prices
    if (!storePrice || storePrice <= 0) return;

    // Block prices below base price
    if (storePrice < basePrice) {
      errors.push({
        message: `${network?.toUpperCase()} ${size}GB: Price GH₵${storePrice.toFixed(2)} is below base price GH₵${basePrice.toFixed(2)}`
      });
      input.classList.add('border-red-500', 'bg-red-50');
      return;
    }

    if (network && size) {
      updates.push({ network, size, storePrice, basePrice });
    }
  });
 // Abort save if any price is invalid; show validation errors.
  if (errors.length > 0) {
    const errorMessages = errors.map(e => e.message).join('\n');
    showToast(`Cannot save — price below base:\n${errorMessages}`, 'error');
    console.error('Price validation errors:', errors);
    return;
  }

  if (updates.length === 0) {
    if (errors.length === 0) {
      showToast('No valid price updates found', 'warning');
    }
    return;
  }

  try {
    console.log('💾 Updating store prices...', updates);

    // Get user from auth properly
    const { data: { user }, error: authError } = await getAuthUser();
    
    if (authError || !user) {
      console.error('❌ Auth error:', authError);
      throw new Error('Not authenticated. Please refresh and try again.');
    }

    console.log('👤 User ID:', user.id);

  // Ensure store exists via server-side upsert before saving prices.
    // Ensure store exists (creates with short_code if new, no-ops if existing)
    const ensureRes = await userFetch('save-store-settings', {});
    const ensureData = await ensureRes.json();
    if (!ensureData.success) throw new Error(ensureData.message || 'Failed to initialise store');
    if (ensureData.short_code) _storeShortCode = ensureData.short_code;
    console.log('🏪 Store ready, storeId:', ensureData.storeId);

  // Save the prices through the secure edge function
    const res = await userFetch('save-store-prices', { updates });
    const priceResult = await res.json();
    if (!priceResult.success) throw new Error(priceResult.message || 'Failed to save prices');

    const successCount = priceResult.successCount || 0;
    const failCount = priceResult.failCount || 0;

    if (successCount > 0) {
      showToast(`✅ Updated ${successCount} price${successCount > 1 ? 's' : ''} successfully!`, 'success');
      await loadBundlePrices();
    }
    if (failCount > 0) {
      showToast(`⚠️ ${failCount} price${failCount > 1 ? 's' : ''} failed to save.`, 'warning');
    }

  } catch (error) {
    console.error('❌ Error updating store prices:', error);
    showToast(`Failed to update store prices: ${error.message}`, 'error');
  }
}

// Withdraw Profits Function
async function withdrawProfits() {
  try {
    // Get authenticated user first
    const { data: { user }, error: authError } = await getAuthUser();
    
    if (authError || !user) {
      console.error('❌ Not authenticated:', authError);
      showToast('Please log in again', 'error');
      return;
    }
    
   console.log('✅ Authenticated user ID:', user.id);


    const wpRes = await userFetch('get-user-data', {}, 'section=store-stats');
    const wpData = await wpRes.json();
    if (!wpData.success) throw new Error(wpData.message || 'Failed to fetch profit data');
    const availableProfits = wpData.availableProfits ?? 0;
    console.log('Profits available:', availableProfits);
    if (availableProfits <= 0) {
      showToast('No profits available for withdrawal', 'warning');
      return;
    }

    // Open withdrawal modal
    const amountInput = document.getElementById('withdrawAmount');
    amountInput.value = availableProfits.toFixed(2);
    amountInput.dataset.max = availableProfits.toFixed(2);
    document.getElementById('withdrawModalAvailable').textContent = `GH₵${availableProfits.toFixed(2)}`;
    document.getElementById('withdrawPhone').value = '';
    document.getElementById('withdrawRecipientName').value = '';
    document.getElementById('withdrawNetwork').value = '';
    document.querySelectorAll('.withdraw-net-btn').forEach(b => {
      b.classList.remove('border-green-500', 'bg-green-50', 'text-green-700');
      b.classList.add('border-gray-200', 'text-gray-600');
    });
    document.getElementById('withdrawalModal').classList.remove('hidden');
    
  } catch (error) {
    console.error('❌ Error requesting withdrawal:', error);
    showToast(`Failed to request withdrawal: ${error.message}`, 'error');
  }
}




        // ── Store Sub-Tab Switching ──────────────────────────────────────
        var _storeTabLabelsGlobal = {
            mystore:          'Overview',
            bundleprices:     'My Pricing',
            recentorders:     'Sales',
            withdrawalhistory:'History',
            customization:    'Customization'
        };

        function switchStoreTab(tabKey) {
            // Show or hide panels by ID.
            ['mystore','bundleprices','recentorders','withdrawalhistory','customization'].forEach(function(t) {
                var panel = document.getElementById('storeTab-' + t);
                if (panel) panel.classList.toggle('hidden', t !== tabKey);
            });

            // Update right sidebar nav buttons
            document.querySelectorAll('.store-right-nav-btn').forEach(function(btn) {
                btn.classList.remove('active');
            });
            var activeBtn = document.getElementById('sidebarBtn-' + tabKey);
            if (activeBtn) activeBtn.classList.add('active');

            // Update mobile drawer buttons (legacy — still present on mobile)
            var drawerTabs = ['mystore','bundleprices','recentorders','withdrawalhistory','customization'];
            drawerTabs.forEach(function(t) {
                var btn = document.getElementById('drawerBtn-' + t);
                if (!btn) return;
                btn.style.background = (t === tabKey) ? 'rgba(255,255,255,0.12)' : 'transparent';
                btn.style.color      = (t === tabKey) ? '#fff' : '#94a3b8';
            });

            // Update mobile overlay header title
            var titleEl = document.getElementById('storeTabTitleOverlay');
            if (titleEl) titleEl.textContent = _storeTabLabelsGlobal[tabKey] || 'My Store';

            // Update desktop heading subtext
            var sub = document.getElementById('storeOverlaySubheading');
            if (sub) sub.textContent = _storeTabLabelsGlobal[tabKey] || 'My Store';

            // Lazy-load data for activated tab
            if (tabKey === 'recentorders')     loadStoreOrders(true);
            if (tabKey === 'withdrawalhistory') loadWithdrawalHistory();
            if (tabKey === 'bundleprices')      loadBundlePrices();
        }

        window.switchStoreTab = switchStoreTab;

        // Event Listeners
        function setupEventListeners() {
            // Navigation
            document.querySelectorAll('.nav-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    navigateTo(item.dataset.page);
                });
            });
            
            // Quick actions
            document.getElementById('quickAddFunds').addEventListener('click', () => navigateTo('topup'));
            document.getElementById('quickBuyData').addEventListener('click', () => navigateTo('purchase'));
            document.getElementById('quickHistory').addEventListener('click', () => navigateTo('history'));
            document.getElementById('viewAllHistory').addEventListener('click', () => navigateTo('history'));
            
            // Network selection
            document.querySelectorAll('.network-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const network = this.dataset.network;
                    
                    // Update selected state
                    document.querySelectorAll('.network-btn').forEach(b => {
                        b.classList.remove('selected');
                    });
                    this.classList.add('selected');
                    
                    loadBundles(network);
                });
            });
            
            // Purchase modal
            document.getElementById('closeModal').addEventListener('click', closeModal);
            document.getElementById('modalBackdrop').addEventListener('click', closeModal);
            document.getElementById('confirmPurchase').addEventListener('click', processPurchase);
            
            // Paystack payment
            document.getElementById('paystackBtn').addEventListener('click', (e) => {
                e.preventDefault();
                initializePayment();
            });

            
            // History filters
            document.getElementById('historySearch').addEventListener('input', loadHistory);
            document.getElementById('historyFilter').addEventListener('change', () => {
                state.historyPage = 1;
                loadHistory();
            });
            
            // Pagination
            document.getElementById('prevPage').addEventListener('click', () => {
                if (state.historyPage > 1) {
                    state.historyPage--;
                    loadHistory();
                }
            });
            
            document.getElementById('nextPage').addEventListener('click', () => {
                state.historyPage++;
                loadHistory();
            });
            
            // Profile form
            document.getElementById('profileForm').addEventListener('submit', saveProfile);

            // Store page
            document.getElementById('unlockStoreBtn').addEventListener('click', unlockStore);
            document.getElementById('generateStoreLink').addEventListener('click', generateStoreLink);
            document.getElementById('copyStoreLink').addEventListener('click', () => {
                const linkInput = document.getElementById('storeLinkInput');
                linkInput.select();
                document.execCommand('copy');
                showToast('Store link copied to clipboard!', 'success');
            });
            document.getElementById('updatePricesBtn').addEventListener('click', updateBundlePrices);
            const wpBtn = document.getElementById('withdrawProfits');
            if (wpBtn) wpBtn.addEventListener('click', withdrawProfits);
            
            // Mobile sidebar
            document.getElementById('openMobileSidebar').addEventListener('click', openMobileSidebar);
            document.getElementById('mobileOverlay').addEventListener('click', closeMobileSidebar);

            // Mobile navigation
            document.querySelectorAll('.mobile-nav-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    navigateTo(item.dataset.page);
                });
            });

            // Mobile logout
            document.getElementById('mobileLogout').addEventListener('click', logout);

            // Logout
            document.getElementById('desktopLogout').addEventListener('click', logout);

            // Header logout button
            const headerLogoutBtn = document.getElementById('headerLogoutBtn');
            if (headerLogoutBtn) headerLogoutBtn.addEventListener('click', logout);

            // User activity tracking
            document.addEventListener('click', updateActivity);
            document.addEventListener('keypress', updateActivity);
            document.addEventListener('scroll', updateActivity);
        }
        
        // Initialize Application
        async function init() {
            try {
                // Check authentication — returns pin_set + store_unlocked from server
                const authData = await api.checkAuth();
                
                // Load user data
                const [userData, balanceData] = await Promise.all([
                    api.getUserProfile(),
                    api.getBalance()
                ]);
                
                // Merge: profile fields first, then auth fields on top.
                // pin_set and store_unlocked come from the verify DB query (server-side,
                // always fresh). getUserProfile() also resolves pin_set from
                // transaction_pin_hash — both sources agree. The explicit authData.user
                // values win in case getUserProfile() omits a field.
                state.user = {
                    ...userData.user,
                    pin_set:        authData.user.pin_set        ?? userData.user.pin_set        ?? false,
                    store_unlocked: authData.user.store_unlocked ?? userData.user.store_unlocked ?? false,
                };
                state.balance = balanceData.balance;
                
                // Update UI
                updateUserDisplay();
                updateBalanceDisplay();
                await updateDashboard();

                // Phase 2: PIN banner — only for resellers who haven't set a PIN
                // store_unlocked comes from get-user-data?section=profile
                // pin_set comes from user-auth login response stored in state.user
                if (state.user.store_unlocked && !state.user.pin_set) {
                    document.getElementById('pinSetupBanner')?.classList.remove('hidden');
                }

                // Phase 2: Show/hide PIN security section in settings
                if (state.user.store_unlocked) {
                    const sec = document.getElementById('pinSecuritySection');
                    if (sec) sec.classList.remove('hidden');
                    // Show correct sub-state
                    if (state.user.pin_set) {
                        document.getElementById('pinNotSetState')?.classList.add('hidden');
                        document.getElementById('pinSetState')?.classList.remove('hidden');
                    } else {
                        document.getElementById('pinNotSetState')?.classList.remove('hidden');
                        document.getElementById('pinSetState')?.classList.add('hidden');
                    }
                }

                // Show Store Orders nav for store owners
                await initStoreOrdersNav();
                
                // Setup event listeners
                setupEventListeners();

                // Recovered wallet top-ups that were paid but not yet credited
                recoverPendingTopups();
                
                // Start session timer
                startSessionTimer();
                
                // Hide loading overlay
                document.getElementById('loadingOverlay').style.display = 'none';
                
                // Log initialization
                console.log(`${CONFIG.APP_NAME} initialized successfully`);
                
            } catch (error) {
                console.error('Initialization error:', error);
                showToast('Failed to initialize dashboard', 'error');
                setTimeout(() => {
                    window.location.href = 'login.html';
                }, 2000);
            }
        }
        
        // Initialize when DOM is loaded.
        // IMPORTANT: await __siteLockReady (set by the inline lock-check script in
        // dashboard.html) before calling init(). If the dashboard is locked, the
        // promise resolves to true and we abort -- the lock overlay is already visible
        // and the loading overlay stays in place so no dashboard content renders.
        document.addEventListener('DOMContentLoaded', async () => {
            try {
                const isLocked = await (window.__siteLockReady || Promise.resolve(false));
                if (isLocked) {
                    // Dashboard is locked. Lock overlay is already showing.
                    // Do NOT call init() -- leave everything hidden.
                    return;
                }
            } catch (_) {
                // If lock check itself threw, proceed normally (fail open).
            }
            init();
            initTicker();
        });
        // ✅ Real-time price validation on input
document.addEventListener('input', (e) => {
  if (e.target.classList.contains('store-price-input')) {
    const input = e.target;
    const basePrice = parseFloat(input.dataset.basePrice);
    const currentValue = parseFloat(input.value);
    
    if (currentValue < basePrice && currentValue > 0) {
      input.classList.add('border-red-500', 'bg-red-50');
      input.setCustomValidity(`Minimum price is GH₵ ${basePrice.toFixed(2)}`);
    } else {
      input.classList.remove('border-red-500', 'bg-red-50');
      input.setCustomValidity('');
    }
  }
});

// ══════════════════════════════════════════════════════
// STORE ORDERS PORTAL — full implementation
// ══════════════════════════════════════════════════════

const portalState = {
  allOrders: [],
  filtered:  [],
  page:      1,
  pageSize:  15
};

// Show nav button only for store owners
async function initStoreOrdersNav() {
  try {
    const userId        = state.user?.id;
    const storeUnlocked = state.user?.store_unlocked ?? false;
    if (!userId) return;
    if (storeUnlocked) {
      document.getElementById('storeOrdersNavBtn')?.classList.remove('hidden');
      document.getElementById('mobileStoreOrdersNavBtn')?.classList.remove('hidden');
      supabase
        .channel('store-owner-orders')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'adminorders' }, (payload) => {
          const ownerId = String(payload.new?.external_response?.storeownerid || '').trim();
          if (ownerId !== String(userId).trim()) return;
          if (state.currentPage === 'storeOrders') loadStoreOrdersPortal();
          if (state.currentPage === 'store') loadStoreOrders();
        })
        .subscribe();
    }
  } catch(e) { /* silent */ }
}

// Fetch all orders for this store owner
async function loadStoreOrdersPortal() {
  const listEl = document.getElementById('portalOrdersList');
  if (!listEl) return;

  listEl.innerHTML = `<div class="p-8 text-center text-gray-400">
    <i class="fas fa-spinner fa-spin text-3xl mb-3 block"></i>
    <p>Loading orders…</p>
  </div>`;

  try {
    const { data: { user }, error: authError } = await getAuthUser();
    if (authError || !user) throw new Error('Not authenticated');

    const portalRes = await userFetch('get-user-data', {}, 'section=store-orders');
    const portalData = await portalRes.json();
    if (!portalData.success) throw new Error(portalData.message || 'Failed to load orders');

    const orders = portalData.orders || [];

    portalState.allOrders = orders;
    portalState.page = 1;

    // Stats
    updatePortalStats(portalState.allOrders);

    // Pending badge on nav
    const pendingCount = (orders || []).filter(o => o.status === 'pending').length;
    ['storeOrdersBadge','mobileStoreOrdersBadge'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (pendingCount > 0) { el.textContent = pendingCount; el.classList.remove('hidden'); }
      else el.classList.add('hidden');
    });

    // Reset filters and render
    portalState.filtered        = [...portalState.allOrders];
    portalActiveFilters.search  = '';
    portalActiveFilters.status  = 'all';
    portalActiveFilters.network = 'all';

    const si = document.getElementById('portalSearchInput');
    const nf = document.getElementById('portalNetworkFilter');
    if (si) si.value = '';
    if (nf) nf.value = 'all';

    // Reset status pills to "All"
    document.querySelectorAll('.status-pill').forEach(b => {
      b.className = 'status-pill px-3 py-1.5 rounded-full text-xs font-semibold border transition-all bg-white text-gray-500 border-gray-200';
    });
    const allPill = document.querySelector('.status-pill[data-status="all"]');
    if (allPill) allPill.className = 'status-pill px-3 py-1.5 rounded-full text-xs font-semibold border transition-all bg-gray-800 text-white border-gray-800';

    document.getElementById('portalClearBtn')?.classList.add('hidden');
    document.getElementById('portalResultsCount')?.classList.add('hidden');

    renderPortalOrders();

  } catch (err) {
    console.error('Portal load error:', err);
    listEl.innerHTML = `<div class="p-8 text-center text-red-500">
      <i class="fas fa-exclamation-triangle text-3xl mb-3 block"></i>
      <p class="text-sm">Failed to load orders: ${err.message}</p>
    </div>`;
  }
}

function updatePortalStats(orders) {
  const total     = orders.length;
  const pending   = orders.filter(o => o.status === 'pending').length;
  const completed = orders.filter(o => ['completed','delivered'].includes(o.status)).length;
  const revenue   = orders.reduce((s, o) => s + parseFloat(o.amount || 0), 0);
  const s = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  s('portalTotalOrders',    total);
  s('portalPendingCount',   pending);
  s('portalCompletedCount', completed);
  s('portalTotalRevenue',   formatCurrency(revenue));
}

// Active filter state
const portalActiveFilters = { search: '', status: 'all', network: 'all' };

// Called when user taps Search button or presses Enter
function doPortalSearch() {
  portalActiveFilters.search = (document.getElementById('portalSearchInput')?.value || '').trim().toLowerCase();
  filterPortalOrders();
}

// Called when a status pill is tapped
function setPortalStatus(btn) {
  // Update pill styles
  const colors = {
    all:        'bg-gray-800 text-white border-gray-800',
    pending:    'bg-yellow-100 text-yellow-700 border-yellow-300',
    processing: 'bg-blue-100 text-blue-700 border-blue-300',
    completed:  'bg-green-100 text-green-700 border-green-300',
    failed:     'bg-red-100 text-red-700 border-red-300',
    cancelled:  'bg-gray-100 text-gray-600 border-gray-300',
  };
  document.querySelectorAll('.status-pill').forEach(b => {
    b.className = 'status-pill px-3 py-1.5 rounded-full text-xs font-semibold border transition-all bg-white text-gray-500 border-gray-200';
  });
  const active = colors[btn.dataset.status] || colors.all;
  active.split(' ').forEach(c => btn.classList.add(c));
  ['bg-white','text-gray-500','border-gray-200'].forEach(c => btn.classList.remove(c));

  portalActiveFilters.status = btn.dataset.status;
  filterPortalOrders();
}

// Core filter + render function
function filterPortalOrders() {
  const { search, status } = portalActiveFilters;
  const network = document.getElementById('portalNetworkFilter')?.value || 'all';
  portalActiveFilters.network = network;

  portalState.filtered = portalState.allOrders.filter(o => {
    const matchStatus  = status  === 'all' || (o.status || '').toLowerCase() === status;
    const matchNetwork = network === 'all' || (o.network || '').toLowerCase() === network;
    const matchSearch  = !search || [
      o.order_reference, o.recipient, o.network,
      String(o.package_size || ''), o.status
    ].join(' ').toLowerCase().includes(search);
    return matchStatus && matchNetwork && matchSearch;
  });

  portalState.page = 1;

  // Show/hide clear button
  const hasFilter = status !== 'all' || network !== 'all' || search !== '';
  document.getElementById('portalClearBtn')?.classList.toggle('hidden', !hasFilter);

  // Results count
  const countEl = document.getElementById('portalResultsCount');
  if (countEl) {
    if (hasFilter) {
      countEl.textContent = `${portalState.filtered.length} of ${portalState.allOrders.length} orders`;
      countEl.classList.remove('hidden');
    } else {
      countEl.classList.add('hidden');
    }
  }

  renderPortalOrders();
}

// Clear all filters and reset UI
function clearPortalFilters() {
  portalActiveFilters.search  = '';
  portalActiveFilters.status  = 'all';
  portalActiveFilters.network = 'all';

  const si = document.getElementById('portalSearchInput');
  const nf = document.getElementById('portalNetworkFilter');
  if (si) si.value = '';
  if (nf) nf.value = 'all';

  // Reset pills — activate "All"
  document.querySelectorAll('.status-pill').forEach(b => {
    b.className = 'status-pill px-3 py-1.5 rounded-full text-xs font-semibold border transition-all bg-white text-gray-500 border-gray-200';
  });
  const allPill = document.querySelector('.status-pill[data-status="all"]');
  if (allPill) {
    allPill.className = 'status-pill px-3 py-1.5 rounded-full text-xs font-semibold border transition-all bg-gray-800 text-white border-gray-800';
  }

  document.getElementById('portalClearBtn')?.classList.add('hidden');
  document.getElementById('portalResultsCount')?.classList.add('hidden');

  portalState.filtered = [...portalState.allOrders];
  portalState.page = 1;
  renderPortalOrders();
}

function changePortalPage(delta) {
  const totalPages = Math.ceil(portalState.filtered.length / portalState.pageSize);
  portalState.page = Math.max(1, Math.min(totalPages, portalState.page + delta));
  renderPortalOrders();
}

function renderPortalOrders() {
  const listEl = document.getElementById('portalOrdersList');
  if (!listEl) return;

  const { filtered, page, pageSize } = portalState;
  const totalPages = Math.ceil(filtered.length / pageSize);
  const start      = (page - 1) * pageSize;
  const pageOrders = filtered.slice(start, start + pageSize);

  // Pagination
  const paginationEl = document.getElementById('portalPagination');
  const infoEl       = document.getElementById('portalPaginationInfo');
  const prevBtn      = document.getElementById('portalPrevBtn');
  const nextBtn      = document.getElementById('portalNextBtn');

  if (filtered.length > pageSize) {
    paginationEl?.classList.remove('hidden');
    if (infoEl) infoEl.textContent =
      `Showing ${start + 1}–${Math.min(start + pageSize, filtered.length)} of ${filtered.length}`;
    if (prevBtn) prevBtn.disabled = page === 1;
    if (nextBtn) nextBtn.disabled = page === totalPages;
  } else {
    paginationEl?.classList.add('hidden');
  }

  if (pageOrders.length === 0) {
    listEl.innerHTML = `<div class="p-10 text-center text-gray-400">
      <i class="fas fa-search text-4xl mb-3 opacity-20 block"></i>
      <p class="font-medium text-gray-500">No orders found</p>
      <p class="text-sm mt-1">Try adjusting your filters</p>
    </div>`;
    return;
  }

  const statusCfg = {
    pending:    { cls: 'bg-yellow-100 text-yellow-700 border-yellow-200', icon: 'fa-clock',       label: 'Pending' },
    processing: { cls: 'bg-blue-100  text-blue-700  border-blue-200',    icon: 'fa-cog',          label: 'Processing' },
    completed:  { cls: 'bg-green-100 text-green-700 border-green-200',   icon: 'fa-check-circle', label: 'Completed' },
    delivered:  { cls: 'bg-green-100 text-green-700 border-green-200',   icon: 'fa-check-circle', label: 'Delivered' },
    failed:     { cls: 'bg-red-100   text-red-700   border-red-200',     icon: 'fa-times-circle', label: 'Failed' },
    cancelled:  { cls: 'bg-gray-100  text-gray-600  border-gray-200',    icon: 'fa-ban',          label: 'Cancelled' },
  };
  const netColors = {
    mtn: 'bg-yellow-400 text-yellow-900',
    airteltigo: 'bg-blue-700 text-white',
    telecel: 'bg-red-600 text-white',
  };

  listEl.innerHTML = pageOrders.map(order => {
    const st     = (order.status || 'pending').toLowerCase();
    const cfg    = statusCfg[st] || statusCfg['pending'];
    const net    = (order.network || '').toLowerCase();
    const netCls = netColors[net] || 'bg-gray-200 text-gray-700';
    const profit = parseFloat(order.external_response?.profit ?? 0);

    return `
      <div class="px-4 py-4 hover:bg-gray-50 transition-colors cursor-pointer active:bg-gray-100"
           data-order-id="${order.id}">
        <div class="flex items-start gap-3">
          <div class="flex-shrink-0 w-10 h-10 rounded-xl ${netCls} flex items-center justify-center font-bold text-sm">
            ${(order.network || '?').charAt(0).toUpperCase()}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap mb-0.5">
              <span class="font-semibold text-gray-900 text-sm">
                ${(order.network || '').toUpperCase()} ${order.package_size || ''}GB
              </span>
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.cls}">
                <i class="fas ${cfg.icon}" style="font-size:9px"></i>${cfg.label}
              </span>
            </div>
            <p class="text-xs text-gray-500 font-mono truncate">${order.order_reference || '—'}</p>
            <p class="text-xs text-gray-500 mt-0.5">
              <i class="fas fa-phone text-gray-300 mr-1"></i>${order.recipient || 'N/A'}
            </p>
            <p class="text-xs text-gray-400 mt-0.5">
              <i class="far fa-clock text-gray-300 mr-1"></i>${formatDate(order.created_at)}
            </p>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="font-bold text-gray-800 text-sm">GH₵${parseFloat(order.amount || 0).toFixed(2)}</p>
            ${profit > 0
              ? `<p class="text-xs text-green-600 font-medium mt-0.5">+GH₵${profit.toFixed(2)} profit</p>`
              : ''}
            <i class="fas fa-chevron-right text-gray-300 text-xs mt-2 block"></i>
          </div>
        </div>
      </div>`;
  }).join('');
}

// Open read-only order detail modal
function openOrderDetail(orderId) {
  const order = portalState.allOrders.find(o => o.id === orderId);
  if (!order) return;
  const modal = document.getElementById('orderDetailModal');
  const body  = document.getElementById('orderDetailBody');
  if (!modal || !body) return;

  const st = (order.status || 'pending').toLowerCase();
  const statusCfg = {
    pending:    { cls: 'bg-yellow-100 text-yellow-700', icon: 'fa-clock',       label: 'Pending — Awaiting admin processing' },
    processing: { cls: 'bg-blue-100  text-blue-700',   icon: 'fa-cog',          label: 'Processing — Order is being fulfilled' },
    completed:  { cls: 'bg-green-100 text-green-700',  icon: 'fa-check-circle', label: 'Completed — Data delivered to customer' },
    delivered:  { cls: 'bg-green-100 text-green-700',  icon: 'fa-check-circle', label: 'Delivered — Data delivered to customer' },
    failed:     { cls: 'bg-red-100   text-red-700',    icon: 'fa-times-circle', label: 'Failed — Could not be processed' },
    cancelled:  { cls: 'bg-gray-100  text-gray-600',   icon: 'fa-ban',          label: 'Cancelled' },
  };
  const cfg = statusCfg[st] || statusCfg['pending'];

  const ext          = order.external_response || {};
  const profit       = parseFloat(ext.profit        ?? 0);
  const baseCost     = parseFloat(ext.base_cost     ?? 0);
  const sellingPrice = parseFloat(ext.selling_price ?? order.amount ?? 0);
  const payRef       = ext.payment_reference || '—';
  const manualFall   = ext.manual_fallback;

  const row = (label, value) => `
    <div class="flex items-start justify-between gap-3 py-2.5 border-b border-gray-50 last:border-0">
      <span class="text-xs text-gray-500 flex-shrink-0 w-28">${label}</span>
      <span class="text-xs text-gray-800 text-right font-medium">${value}</span>
    </div>`;

  body.innerHTML = `
    <div class="rounded-xl p-4 ${cfg.cls} flex items-start gap-3">
      <i class="fas ${cfg.icon} mt-0.5 flex-shrink-0"></i>
      <div>
        <p class="font-semibold text-sm">${cfg.label}</p>
        ${manualFall ? '<p class="text-xs mt-0.5 opacity-75">⚠️ Queued for manual processing by admin</p>' : ''}
      </div>
    </div>

    <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2 text-xs text-amber-700">
      <i class="fas fa-info-circle mt-0.5 flex-shrink-0"></i>
      <p>Order status is controlled by the admin only. Contact support if you need help.</p>
    </div>

    <div>
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Order Info</p>
      ${row('Reference',   `<span class="font-mono">${order.order_reference || '—'}</span>`)}
      ${row('Bundle',      `${(order.network || '').toUpperCase()} ${order.package_size || ''}GB`)}
      ${row('Customer',    order.recipient || '—')}
      ${row('Order Date',  formatDate(order.created_at))}
      ${order.updated_at && order.updated_at !== order.created_at
        ? row('Last Updated', formatDate(order.updated_at)) : ''}
    </div>

    <div>
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Payment Breakdown</p>
      ${row('Customer Paid', `<span class="font-bold text-gray-900">GH₵${sellingPrice.toFixed(2)}</span>`)}
      ${baseCost > 0 ? row('Your Cost',   `GH₵${baseCost.toFixed(2)}`)                                    : ''}
      ${profit   > 0 ? row('Your Profit', `<span class="font-bold text-green-600">+GH₵${profit.toFixed(2)}</span>`) : ''}
      ${payRef  !== '—' ? row('Payment Ref', `<span class="font-mono text-xs">${payRef}</span>`)           : ''}
    </div>

    <button data-phone="${order.recipient || ''}"
      data-action="copy-track-link"
      class="w-full flex items-center justify-center gap-2 px-4 py-3 bg-brand-50 hover:bg-brand-100 border border-brand-200 text-brand-700 text-sm font-semibold rounded-xl transition-colors">
      <i class="fas fa-link text-xs"></i> Copy Customer Track Link
    </button>`;

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeOrderDetailModal() {
  document.getElementById('orderDetailModal')?.classList.add('hidden');
  document.body.style.overflow = '';
}

async function copyOrderTrackLink(phone) {
  try {
    const { data: { user } } = await getAuthUser();
    const base = _storeShortCode
      ? `${_baseUrl}store?s=${_storeShortCode}&track=1`
      : `${_baseUrl}store?slug=${user.id}&track=1`;
    const url = `${base}&phone=${encodeURIComponent(phone)}`;
    await navigator.clipboard.writeText(url).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    });
    showToast('📋 Track link copied! Share with your customer.', 'success');
    closeOrderDetailModal();
  } catch(e) { showToast('Failed to copy link', 'error'); }
}

function filterStoreOrders() {
  storeOrdersState.page = 1;
  loadStoreOrders();
}

window.loadStoreOrdersPortal = loadStoreOrdersPortal;
window.filterStoreOrders     = filterStoreOrders;
window.loadStoreOrders       = loadStoreOrders;
window.changeStoreOrdersPage = changeStoreOrdersPage;
window.doPortalSearch        = doPortalSearch;
window.setPortalStatus       = setPortalStatus;
window.filterPortalOrders    = filterPortalOrders;
window.clearPortalFilters    = clearPortalFilters;
window.filterPortalOrders    = filterPortalOrders;
window.changePortalPage      = changePortalPage;
window.openOrderDetail       = openOrderDetail;
window.closeOrderDetailModal = closeOrderDetailModal;
window.copyOrderTrackLink    = copyOrderTrackLink;

// ══════════════════════════════════════════════════════════════════
// STORE CUSTOMIZATION — JS
// ══════════════════════════════════════════════════════════════════

let _themeColor = '#0284c7';
let _storeShortCode = null; // set by loadStoreStats; used by all store link builders

// Highlight a preset swatch and update preview
window.selectPresetColor = function(btn) {
    _themeColor = btn.dataset.color;
    document.querySelectorAll('.swatch').forEach(s => s.style.outline = 'none');
    btn.style.outline = `3px solid ${_themeColor}`;
    btn.style.outlineOffset = '2px';
    document.getElementById('themeColorPreviewDot').style.background = _themeColor;
    document.getElementById('themeColorHexDisplay').textContent = _themeColor;
    document.getElementById('customColorPicker').value = _themeColor;
};

// Handle the native color-picker input
window.selectCustomColor = function(value) {
    _themeColor = value;
    document.querySelectorAll('.swatch').forEach(s => s.style.outline = 'none');
    document.getElementById('themeColorPreviewDot').style.background = value;
    document.getElementById('themeColorHexDisplay').textContent = value;
};

// Allow only HTTPS URLs.
function _sanitiseUrl(raw) {
    if (!raw) return '';
    const t = raw.trim();
    if (!t) return '';
    try {
        const p = new URL(t);
        if (p.protocol !== 'https:') return '';
        return t;
    } catch (_) { return ''; }
}

// Load saved customization into the form
async function loadStoreCustomization() {
    try {
        const { data: { user } } = await getAuthUser();
        if (!user) return;

        const lcRes = await userFetch('get-user-data', {}, 'section=store');
        const lcData = await lcRes.json();
        if (!lcData.success || !lcData.store) return;
        const store = lcData.store;

        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
        setVal('customStoreName',       store.name);
        setVal('customStoreDesc',       store.description);
        setVal('customSupportPhone',    store.support_phone);
        setVal('customWhatsappSupport', store.whatsapp_support);
        setVal('customWhatsappGroup',   store.whatsapp_group);

        if (store.theme_color) {
            _themeColor = store.theme_color;
            document.getElementById('themeColorPreviewDot').style.background = store.theme_color;
            document.getElementById('themeColorHexDisplay').textContent = store.theme_color;
            document.getElementById('customColorPicker').value = store.theme_color;
            // Highlight matching preset if any
            document.querySelectorAll('.swatch').forEach(s => {
                s.style.outline = s.dataset.color === store.theme_color
                    ? `3px solid ${store.theme_color}` : 'none';
                s.style.outlineOffset = '2px';
            });
        }
    } catch (err) {
        console.error('loadStoreCustomization error:', err);
    }
}

// Save customization to the stores table
window.saveStoreSettings = async function() {
    const btn = document.getElementById('saveStoreSettingsBtn');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Saving...';

    try {
        const { data: { user } } = await getAuthUser();
        if (!user) throw new Error('Not authenticated');

        // ── Validate required field ──
        const storeName = document.getElementById('customStoreName').value.trim();
        if (!storeName) {
            showToast('Store name is required', 'error');
            btn.disabled = false; btn.innerHTML = orig; return;
        }

        // ── Validate & sanitise URL fields ──
        const rawWaSupport = document.getElementById('customWhatsappSupport').value.trim();
        const rawWaGroup   = document.getElementById('customWhatsappGroup').value.trim();
        const waSupport    = _sanitiseUrl(rawWaSupport);
        const waGroup      = _sanitiseUrl(rawWaGroup);

        if (rawWaSupport && !waSupport) {
            showToast('WhatsApp Support Link must start with https://', 'error');
            btn.disabled = false; btn.innerHTML = orig; return;
        }
        if (rawWaGroup && !waGroup) {
            showToast('WhatsApp Group Link must start with https://', 'error');
            btn.disabled = false; btn.innerHTML = orig; return;
        }

        // ── Validate hex color ──
        const hexColor = /^#[0-9a-fA-F]{6}$/.test(_themeColor) ? _themeColor : '#0284c7';

        // FIX #4: pass the payload fields directly to userFetch, not wrapped in { body: JSON.stringify(...) }
        const res = await userFetch('save-store-settings', {
            name:             storeName.slice(0, 60),
            description:      document.getElementById('customStoreDesc').value.trim().slice(0, 200),
            support_phone:    document.getElementById('customSupportPhone').value.trim().slice(0, 20),
            whatsapp_support: waSupport,
            whatsapp_group:   waGroup,
            theme_color:      hexColor,
        });
        const saveResult = await res.json();
        if (!saveResult.success) throw new Error(saveResult.message || 'Save failed');

        showToast('✅ Store settings saved!', 'success');

        // Update _storeShortCode from the save response so links are immediately correct
        if (saveResult.short_code) _storeShortCode = saveResult.short_code;

        // Reveal Open Store button using the short link
        const { data: { user: u } } = await getAuthUser();
        const storeLink = _storeShortCode
            ? `${_baseUrl}store?s=${_storeShortCode}`
            : `${_baseUrl}store?slug=${u.id}`;
        const openBtn = document.getElementById('openStoreBtn');
        if (openBtn) {
            openBtn.classList.remove('hidden');
            openBtn.onclick = () => window.open(storeLink, '_blank', 'noopener,noreferrer');
        }

    } catch (err) {
        console.error('saveStoreSettings error:', err);
        showToast('Failed to save: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
    }
};


// ── Withdrawal Modal ──────────────────────────────────────────────────────────
window.selectWithdrawNetwork = function(btn) {
  document.querySelectorAll('.withdraw-net-btn').forEach(b => {
    b.classList.remove('border-green-500', 'bg-green-50', 'text-green-700');
    b.classList.add('border-gray-200', 'text-gray-600');
  });
  btn.classList.add('border-green-500', 'bg-green-50', 'text-green-700');
  btn.classList.remove('border-gray-200', 'text-gray-600');
  document.getElementById('withdrawNetwork').value = btn.dataset.net;
};

window.submitWithdrawalRequest = async function() {
  const amount         = parseFloat(document.getElementById('withdrawAmount').value);
  const phone          = document.getElementById('withdrawPhone').value.trim();
  const network        = document.getElementById('withdrawNetwork').value;
  const recipient_name = document.getElementById('withdrawRecipientName').value.trim();
  const notes          = '';
  const maxAmount      = parseFloat(document.getElementById('withdrawAmount').dataset.max);

  if (!amount || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }
  if (amount > maxAmount) { showToast(`Maximum withdrawal is GH₵${maxAmount.toFixed(2)}`, 'error'); return; }
  if (!/^[0-9]{10}$/.test(phone)) { showToast('Enter a valid 10-digit phone number', 'error'); return; }
  if (!network) { showToast('Please select a network', 'error'); return; }
  if (!recipient_name || recipient_name.length < 2) { showToast('Enter the name on your mobile money account', 'error'); return; }

  // Phase 2: If user has a PIN set, show PIN verification modal first.
  // The modal's confirm button calls _doFinalWithdrawal() with the PIN.
  if (state.user?.pin_set) {
    openPinModal({ amount, phone, network, notes, recipient_name });
    return;
  }

  // No PIN set — submit directly (backward compatible for existing resellers)
  await _doFinalWithdrawal({ amount, phone, network, notes, recipient_name, pin: null });
};

// Internal — called after PIN is verified (or directly if no PIN set)
   async function _doFinalWithdrawal({ amount, phone, network, notes, recipient_name, pin }) {
    const btn = document.getElementById('submitWithdrawal');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Submitting...'; }

  try {
    const res    = await userFetch('submit-withdrawal', { amount, phone, network, notes, recipient_name, ...(pin ? { pin } : {}) });
    const result = await res.json();

    if (!result.success) {
      // Handle specific server responses
      if (result.locked)    { showToast(result.message, 'error'); closePinModal(); return; }
      if (result.cooldown)  { showToast(result.message, 'warning'); closePinModal(); return; }
      throw new Error(result.message || 'Withdrawal failed');
    }

    document.getElementById('withdrawalModal')?.classList.add('hidden');
    closePinModal();
    showToast('✅ Withdrawal request submitted! Admin will process within 24 hours.', 'success');
    await loadStoreStats();
    await loadWithdrawalHistory();
  } catch (err) {
    console.error('❌ Withdrawal error:', err);
    showToast('Failed: ' + err.message, 'error');
    closePinModal();
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Submit Withdrawal Request'; }
  }
}


// ════════════════════════════════════════════════════════════════════
// PHASE 2 — TRANSACTION PIN LOGIC
// ════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
let _pinModalPendingWithdrawal = null; // stores withdrawal data while PIN is entered

// ── PIN Verification Modal ────────────────────────────────────────────────────

function openPinModal(withdrawalData) {
    _pinModalPendingWithdrawal = withdrawalData;
    _pinCurrentValue = '';
    updatePinDots();
    document.getElementById('pinVerifyError')?.classList.add('hidden');
    document.getElementById('pinVerifySubmit').disabled = true;
    document.getElementById('pinVerifyModal')?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closePinModal() {
    document.getElementById('pinVerifyModal')?.classList.add('hidden');
    document.body.style.overflow = '';
    _pinModalPendingWithdrawal = null;
    _pinCurrentValue = '';
    updatePinDots();
    const errEl = document.getElementById('pinVerifyError');
    if (errEl) errEl.classList.add('hidden');
}

// ── Numpad logic ──────────────────────────────────────────────────────────────
let _pinCurrentValue = '';

function updatePinDots() {
    const dots = document.querySelectorAll('.pin-dot');
    dots.forEach((dot, i) => {
        if (i < _pinCurrentValue.length) {
            dot.classList.remove('border-gray-300');
            dot.classList.add('border-amber-500', 'bg-amber-500');
        } else {
            dot.classList.remove('border-amber-500', 'bg-amber-500');
            dot.classList.add('border-gray-300');
        }
    });
    const submitBtn = document.getElementById('pinVerifySubmit');
    if (submitBtn) submitBtn.disabled = _pinCurrentValue.length < 4;
}

function pinBackspace() {
    if (_pinCurrentValue.length > 0) {
        _pinCurrentValue = _pinCurrentValue.slice(0, -1);
        updatePinDots();
    }
}

// Attach numpad key listeners
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.pin-key').forEach(btn => {
        btn.addEventListener('click', () => {
            if (_pinCurrentValue.length >= 6) return;
            _pinCurrentValue += btn.dataset.key;
            updatePinDots();
        });
    });

    // Backdrop close
    document.getElementById('pinVerifyBackdrop')?.addEventListener('click', closePinModal);

    // Keyboard input support
    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('pinVerifyModal');
        if (modal?.classList.contains('hidden')) return;
        if (/^\d$/.test(e.key) && _pinCurrentValue.length < 6) {
            _pinCurrentValue += e.key;
            updatePinDots();
        } else if (e.key === 'Backspace') {
            pinBackspace();
        } else if (e.key === 'Enter' && _pinCurrentValue.length >= 4) {
            submitPinVerify();
        }
    });
});

// ── Submit PIN and execute withdrawal ─────────────────────────────────────────
async function submitPinVerify() {
    if (_pinCurrentValue.length < 4) return;
    if (!_pinModalPendingWithdrawal) { closePinModal(); return; }

    const btn    = document.getElementById('pinVerifySubmit');
    const errEl  = document.getElementById('pinVerifyError');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Verifying...';
    if (errEl) errEl.classList.add('hidden');

    // Execute the actual withdrawal with the PIN
    try {
        const res    = await userFetch('submit-withdrawal', {
            ..._pinModalPendingWithdrawal,
            pin: _pinCurrentValue,
        });
        const result = await res.json();

        if (!result.success) {
            // Wrong PIN — show error, shake dots, clear input
            _pinCurrentValue = '';
            updatePinDots();

            if (errEl) {
                errEl.textContent = result.message || 'Incorrect PIN';
                errEl.classList.remove('hidden');
            }

            // Animate shake on dots
            const dotsEl = document.getElementById('pinDots');
            if (dotsEl) {
                dotsEl.style.animation = 'none';
                requestAnimationFrame(() => {
                    dotsEl.style.animation = 'shake 0.4s ease';
                });
            }

            btn.disabled  = true;
            btn.innerHTML = 'Confirm Withdrawal';

            // If locked or cooldown, close modal after showing message
            if (result.locked || result.cooldown) {
                setTimeout(closePinModal, 2500);
            }
            return;
        }

        // Success
        document.getElementById('withdrawalModal')?.classList.add('hidden');
        closePinModal();

        // Update pin_set state so banner hides and correct sub-state shows
        if (state.user) { state.user.pin_set = true; }
        document.getElementById('pinSetupBanner')?.classList.add('hidden');

        showToast('✅ Withdrawal submitted! Admin will process within 24 hours.', 'success');
        await loadStoreStats();
        await loadWithdrawalHistory();

    } catch (err) {
        console.error('PIN withdrawal error:', err);
        if (errEl) {
            errEl.textContent = err.message || 'Something went wrong. Please try again.';
            errEl.classList.remove('hidden');
        }
        _pinCurrentValue = '';
        updatePinDots();
        btn.disabled  = true;
        btn.innerHTML = 'Confirm Withdrawal';
    }
}

window.openPinModal    = openPinModal;
window.closePinModal   = closePinModal;
window.pinBackspace    = pinBackspace;
window.submitPinVerify = submitPinVerify;

// ── PIN Setup / Change (Settings page) ───────────────────────────────────────

async function submitSetPin() {
    const newPin     = document.getElementById('newPinInput')?.value.trim();
    const confirmPin = document.getElementById('confirmPinInput')?.value.trim();
    const btn        = document.getElementById('setPinBtn');

    if (!newPin || !/^\d{4,6}$/.test(newPin)) {
        showToast('PIN must be 4-6 digits', 'error'); return;
    }
    if (newPin !== confirmPin) {
        showToast('PINs do not match', 'error'); return;
    }

    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Setting PIN...';

    try {
        const res    = await userFetch('set-transaction-pin', { action: 'set', new_pin: newPin, confirm_pin: confirmPin });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);

        // Update local state
        if (state.user) state.user.pin_set = true;
        document.getElementById('pinSetupBanner')?.classList.add('hidden');

        // Switch to "PIN set" sub-state in settings
        document.getElementById('pinNotSetState')?.classList.add('hidden');
        document.getElementById('pinSetState')?.classList.remove('hidden');

        // Clear inputs
        if (document.getElementById('newPinInput'))     document.getElementById('newPinInput').value = '';
        if (document.getElementById('confirmPinInput')) document.getElementById('confirmPinInput').value = '';

        showToast('✅ Transaction PIN set successfully!', 'success');
    } catch (err) {
        // If the error is "current pin required", the PIN was already set
        // (e.g. double-submit). Switch UI to change-PIN state gracefully.
        if (err.message && err.message.toLowerCase().includes('current pin required')) {
            if (state.user) state.user.pin_set = true;
            document.getElementById('pinSetupBanner')?.classList.add('hidden');
            document.getElementById('pinNotSetState')?.classList.add('hidden');
            document.getElementById('pinSetState')?.classList.remove('hidden');
            showToast('PIN already set. Use the Change PIN form below.', 'info');
        } else {
            showToast(err.message || 'Failed to set PIN', 'error');
        }
    } finally {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fas fa-lock mr-2"></i>Set Transaction PIN';
    }
}

async function submitChangePin() {
    const oldPin     = document.getElementById('oldPinInput')?.value.trim();
    const newPin     = document.getElementById('changePinInput')?.value.trim();
    const confirmPin = document.getElementById('confirmChangePinInput')?.value.trim();
    const btn        = document.getElementById('changePinBtn');

    if (!oldPin) { showToast('Enter your current PIN', 'error'); return; }
    if (!newPin || !/^\d{4,6}$/.test(newPin)) { showToast('New PIN must be 4-6 digits', 'error'); return; }
    if (newPin !== confirmPin) { showToast('New PINs do not match', 'error'); return; }

    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Changing PIN...';

    try {
        const res    = await userFetch('set-transaction-pin', {
            action: 'set', old_pin: oldPin, new_pin: newPin, confirm_pin: confirmPin,
        });
        const result = await res.json();
        if (!result.success) throw new Error(result.message);

        // Clear inputs
        ['oldPinInput','changePinInput','confirmChangePinInput'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });

        showToast('✅ Transaction PIN changed successfully!', 'success');
    } catch (err) {
        showToast(err.message || 'Failed to change PIN', 'error');
    } finally {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fas fa-sync mr-2"></i>Change Transaction PIN';
    }
}

window.submitSetPin    = submitSetPin;
window.submitChangePin = submitChangePin;
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('withdrawalModalBackdrop')?.addEventListener('click', () => {
    document.getElementById('withdrawalModal').classList.add('hidden');
  });
  document.getElementById('closeWithdrawalModal')?.addEventListener('click', () => {
    document.getElementById('withdrawalModal').classList.add('hidden');
  });
});
// ── Delegated listeners for dynamically-rendered portal content ───────────────
// Replaces onclick= attributes in innerHTML templates (blocked by CSP).
document.addEventListener('DOMContentLoaded', function () {

  // Order rows → open detail modal
  const portalList = document.getElementById('portalOrdersList');
  if (portalList) {
    portalList.addEventListener('click', function (e) {
      const row = e.target.closest('[data-order-id]');
      if (row) openOrderDetail(row.dataset.orderId);
    });
  }

  // Copy-track-link button inside order detail modal
  const detailBody = document.getElementById('orderDetailBody');
  if (detailBody) {
    detailBody.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-action="copy-track-link"]');
      if (btn) copyOrderTrackLink(btn.dataset.phone);
    });
  }

  // Withdrawal history card hover — replaces onmouseover/onmouseout inline handlers
  document.addEventListener('mouseover', function (e) {
    const card = e.target.closest('.withdrawal-history-card');
    if (card) card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
  });
  document.addEventListener('mouseout', function (e) {
    const card = e.target.closest('.withdrawal-history-card');
    if (card) card.style.boxShadow = '0 1px 4px rgba(0,0,0,0.05)';
  });

});
// ── Delegated listeners for dynamically-rendered content ─────────────────────
document.addEventListener('DOMContentLoaded', function () {
  const portalList = document.getElementById('portalOrdersList');
  if (portalList) {
    portalList.addEventListener('click', function (e) {
      const row = e.target.closest('[data-order-id]');
      if (row) openOrderDetail(row.dataset.orderId);
    });
  }
  const detailBody = document.getElementById('orderDetailBody');
  if (detailBody) {
    detailBody.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-action="copy-track-link"]');
      if (btn) copyOrderTrackLink(btn.dataset.phone);
    });
  }
  document.addEventListener('mouseover', function (e) {
    const card = e.target.closest('.withdrawal-history-card');
    if (card) card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
  });
  document.addEventListener('mouseout', function (e) {
    const card = e.target.closest('.withdrawal-history-card');
    if (card) card.style.boxShadow = '0 1px 4px rgba(0,0,0,0.05)';
  });
});

/* ============================================================
 * API Access Page — dashboard-main.js addition
 * All calls route through userFetch() → user-proxy → api-generate-key
 * Zero direct DB or Supabase calls from the frontend.
 * ============================================================ */

// ── State ──────────────────────────────────────────────────────────────────────
const apiState = {
  loaded:  false,
  hasKey:  false,
  prefix:  null,
  label:   null,
  lastUsed: null,
};

// ── Load page ──────────────────────────────────────────────────────────────────
async function loadApiAccessPage() {
  if (apiState.loaded) {
    renderApiKeyState();
    return;
  }
  showApiLoading(true);
  await fetchApiKeyInfo();
  wireApiEvents();
}

// ── Fetch key metadata from edge function ──────────────────────────────────────
async function fetchApiKeyInfo() {
  try {
    const res  = await userFetch('api-generate-key', { action: 'list' });
    const data = await res.json();

    if (data.success && data.keys && data.keys.length > 0) {
      // Find the most recent active key, or most recent overall
      const activeKey = data.keys.find(k => k.is_active) || data.keys[0];
      apiState.hasKey   = activeKey.is_active;
      apiState.prefix   = activeKey.key_prefix;
      apiState.label    = activeKey.label || null;
      apiState.lastUsed = activeKey.last_used_at || null;
    } else {
      apiState.hasKey = false;
      apiState.prefix = null;
    }
  } catch (err) {
    console.error('[api-access] fetchApiKeyInfo failed:', err);
    apiState.hasKey = false;
  }
  apiState.loaded = true;
  showApiLoading(false);
  renderApiKeyState();
}

// ── Render key state ───────────────────────────────────────────────────────────
function renderApiKeyState() {
  const loading  = document.getElementById('apiKeyLoading');
  const noKey    = document.getElementById('apiNoKeyState');
  const hasKey   = document.getElementById('apiHasKeyState');

  if (!loading || !noKey || !hasKey) return;

  loading.classList.add('hidden');

  if (apiState.hasKey && apiState.prefix) {
    noKey.classList.add('hidden');
    hasKey.classList.remove('hidden');

    document.getElementById('apiKeyPrefix').textContent = apiState.prefix + '••••••••••••••••••••';
    document.getElementById('apiKeyStatus').textContent = 'Active';
    document.getElementById('apiKeyStatus').className   = 'text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700';

    const lastUsedEl = document.getElementById('apiKeyLastUsed');
    if (lastUsedEl) {
      lastUsedEl.textContent = apiState.lastUsed
        ? new Date(apiState.lastUsed).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'Never';
    }

    const labelSection = document.getElementById('apiKeyLabel');
    const labelText    = document.getElementById('apiKeyLabelText');
    if (labelSection && labelText) {
      if (apiState.label) {
        labelText.textContent = apiState.label;
        labelSection.classList.remove('hidden');
      } else {
        labelSection.classList.add('hidden');
      }
    }
  } else {
    hasKey.classList.add('hidden');
    noKey.classList.remove('hidden');
  }
}

function showApiLoading(show) {
  const loading = document.getElementById('apiKeyLoading');
  const noKey   = document.getElementById('apiNoKeyState');
  const hasKey  = document.getElementById('apiHasKeyState');
  if (!loading) return;
  if (show) {
    loading.classList.remove('hidden');
    noKey?.classList.add('hidden');
    hasKey?.classList.add('hidden');
  } else {
    loading.classList.add('hidden');
  }
}

// ── Wire events (called once) ──────────────────────────────────────────────────
let apiEventsWired = false;
function wireApiEvents() {
  if (apiEventsWired) return;
  apiEventsWired = true;

  // Generate first key
  document.getElementById('apiGenerateBtn')?.addEventListener('click', () => handleGenerateKey(false));

  // Rotate key (generate new, force-revoke old)
  document.getElementById('apiRotateBtn')?.addEventListener('click', () => handleGenerateKey(true));

  // Revoke — show confirm modal
  document.getElementById('apiRevokeBtn')?.addEventListener('click', () => {
    document.getElementById('apiRevokeModal')?.classList.remove('hidden');
  });
  document.getElementById('apiRevokeCancelBtn')?.addEventListener('click', () => {
    document.getElementById('apiRevokeModal')?.classList.add('hidden');
  });
  document.getElementById('apiRevokeConfirmBtn')?.addEventListener('click', handleRevokeKey);

  // Copy key
  document.getElementById('apiCopyKeyBtn')?.addEventListener('click', handleCopyKey);

  // Close reveal modal
  document.getElementById('apiRevealDoneBtn')?.addEventListener('click', () => {
    document.getElementById('apiKeyRevealModal')?.classList.add('hidden');
    // Refresh state after revealing
    apiState.loaded = false;
    fetchApiKeyInfo();
  });
}

// ── Generate / rotate key ──────────────────────────────────────────────────────
async function handleGenerateKey(force = false) {
  showApiLoading(true);
  try {
    const res  = await userFetch('api-generate-key', { action: 'generate', force });
    const data = await res.json();

    if (!data.success) {
      // Key already exists and force not set — prompt rotate
      if (res.status === 409) {
        if (confirm('You already have an active key. Do you want to revoke it and generate a new one?')) {
          return handleGenerateKey(true);
        }
        showApiLoading(false);
        renderApiKeyState();
        return;
      }
      showApiLoading(false);
      alert(data.message || 'Failed to generate key. Please try again.');
      return;
    }

    // Show key reveal modal
    showApiLoading(false);
    document.getElementById('apiRevealKey').textContent = data.api_key;
    document.getElementById('apiCopyBtnText').textContent = 'Copy API Key';
    document.getElementById('apiKeyRevealModal')?.classList.remove('hidden');

    // Update local state
    apiState.hasKey   = true;
    apiState.prefix   = data.key_prefix;
    apiState.label    = data.label || null;
    apiState.lastUsed = null;
    apiState.loaded   = true;
    renderApiKeyState();
  } catch (err) {
    showApiLoading(false);
    console.error('[api-access] generateKey error:', err);
    alert('An error occurred. Please try again.');
  }
}

// ── Revoke key ─────────────────────────────────────────────────────────────────
async function handleRevokeKey() {
  document.getElementById('apiRevokeModal')?.classList.add('hidden');
  showApiLoading(true);
  try {
    const res  = await userFetch('api-generate-key', { action: 'revoke' });
    const data = await res.json();

    if (!data.success) {
      showApiLoading(false);
      alert(data.message || 'Failed to revoke key. Please try again.');
      return;
    }

    apiState.hasKey  = false;
    apiState.prefix  = null;
    apiState.label   = null;
    apiState.loaded  = true;
    showApiLoading(false);
    renderApiKeyState();
  } catch (err) {
    showApiLoading(false);
    console.error('[api-access] revokeKey error:', err);
    alert('An error occurred. Please try again.');
  }
}

// ── Copy key ───────────────────────────────────────────────────────────────────
async function handleCopyKey() {
  const key     = document.getElementById('apiRevealKey')?.textContent?.trim();
  const btnText = document.getElementById('apiCopyBtnText');
  if (!key) return;

  try {
    await navigator.clipboard.writeText(key);
    if (btnText) btnText.textContent = '✓ Copied!';
    setTimeout(() => { if (btnText) btnText.textContent = 'Copy API Key'; }, 2500);
  } catch {
    // Fallback for browsers that block clipboard without interaction
    const ta = document.createElement('textarea');
    ta.value = key;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    if (btnText) btnText.textContent = '✓ Copied!';
    setTimeout(() => { if (btnText) btnText.textContent = 'Copy API Key'; }, 2500);
  }
}