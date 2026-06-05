 import { supabase, PAYSTACK_PUBLIC_KEY, SUPABASE_PROJECT_URL, SUPABASE_ANON } from './supabase-config.js';
    
    const supabaseKey = SUPABASE_ANON; // used for edge function Authorization header

    // Use esc() for all dynamic values before injecting into innerHTML.
    function esc(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

let storeOwnerUserId = null;
let storeShortCode = null; // set once loadStore resolves ?s= param
    let storeOwnerEmail = null;
    let storeId = null;
    let selectedBundle = null;
   // Only supports short-code store links via ?s= parameter.
    function getStoreIdentifierFromURL() {
        const urlParams = new URLSearchParams(window.location.search);

        // ── Explicitly reject old UUID slug links ─────────────────────────
        if (urlParams.get('slug')) {
            console.error('❌ Old store link format is no longer supported');
            return null;
        }

        // ── Short code param ──────────────────────────────────────────────
        const s = urlParams.get('s');
        if (!s) return null;

        if (!/^[a-z0-9]{4,12}$/i.test(s)) {
            console.error('❌ Invalid store link');
            return null;
        }

        return { param: 's', value: s };
    }

    // ══════════════════════════════════════════════════════
    // DARK MODE — customer-facing toggle
    // ══════════════════════════════════════════════════════
    function applyDark(dark) {
        document.body.classList.toggle('dark', dark);
        const lbl = document.getElementById('dmLabel');
        if (lbl) lbl.textContent = dark ? 'Dark' : 'Light';
        try { localStorage.setItem('_pcDark', dark ? '1' : '0'); } catch(_) {}
    }
    window.toggleDark = function() {
        applyDark(!document.body.classList.contains('dark'));
    };
    // Restore preference on load
    try {
        if (localStorage.getItem('_pcDark') === '1') applyDark(true);
    } catch(_) {}

    // ══════════════════════════════════════════════════════
    // THEME COLOR — apply from store settings
    // ══════════════════════════════════════════════════════
    function applyTheme(hex) {
        if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
        const r = parseInt(hex.slice(1,3),16);
        const g = parseInt(hex.slice(3,5),16);
        const b = parseInt(hex.slice(5,7),16);
        const dark = '#' + [r,g,b].map(c => Math.max(0,c-28).toString(16).padStart(2,'0')).join('');
        document.documentElement.style.setProperty('--tc',     hex);
        document.documentElement.style.setProperty('--tc-dark', dark);
        document.documentElement.style.setProperty('--tc-rgb', `${r},${g},${b}`);
    }

    // ══════════════════════════════════════════════════════
    // CONTACT BAR — rendered from store row
    // ══════════════════════════════════════════════════════
    function renderContactBar(store) {
        let visible = false;

        if (store.support_phone) {
            const link = document.getElementById('contactPhoneLink');
            const txt  = document.getElementById('contactPhoneText');
            if (link && txt) {
                txt.textContent = store.support_phone;
                link.href = 'tel:' + store.support_phone.replace(/\s+/g,'');
                link.classList.remove('hidden'); link.classList.add('flex');
                visible = true;
            }
        }

        if (store.whatsapp_support) {
            const el = document.getElementById('contactWaSupport');
            if (el) {
                el.href = store.whatsapp_support;
                el.classList.remove('hidden'); el.classList.add('flex');
                visible = true;
            }
        }

        if (store.whatsapp_group) {
            const el = document.getElementById('contactWaGroup');
            if (el) {
                el.href = store.whatsapp_group;
                el.classList.remove('hidden'); el.classList.add('flex');
                visible = true;
            }
        }

        if (visible) document.getElementById('contactBar')?.classList.remove('hidden');
    }

        // Load store data
    async function loadStore() {
        try {
            const storeId_ = getStoreIdentifierFromURL();

            if (!storeId_) {
                // Could be an old ?slug= link or a completely malformed URL
                throw new Error('This store link is no longer valid. Please request the updated link from the store owner.');
            }

            storeShortCode = storeId_.value; // save for bundles fetch
            console.log('Loading store:', storeId_.param, '=', storeId_.value);

           // Retrieve store data via edge function using supported URL identifiers.
            const storeInfoRes = await fetch(
                `${SUPABASE_PROJECT_URL}/functions/v1/get-store-data?section=info&${storeId_.param}=${encodeURIComponent(storeId_.value)}`,
                { headers: { 'apikey': SUPABASE_ANON } }
            );
            const storeInfoData = await storeInfoRes.json();

            if (!storeInfoData.success || !storeInfoData.store) {
                console.error('Store not found:', storeInfoData.message);
                throw new Error('Store not found');
            }
            const storeData = storeInfoData.store;

            // Persist server-resolved owner ID for use in subsequent requests.
            storeOwnerUserId = storeData.owner_id;
            storeId          = storeData.id;
            storeOwnerEmail  = storeData.owner_email ?? null; // populated by get-store-data join
            console.log('Store loaded — owner:', storeOwnerUserId, 'id:', storeId, 'email:', storeOwnerEmail);

            // ── Apply theme color ──────────────────────────────────────────
            if (storeData.theme_color) applyTheme(storeData.theme_color);

            // ── Apply store branding ───────────────────────────────────────
            const displayName = storeData.name || 'Prime Connect Store';
            const displayDesc = storeData.description || 'Fast, reliable data bundles';
            const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
            setTxt('storeDisplayTitle', displayName);
            setTxt('storeDisplayTagline', displayDesc);
            setTxt('bannerStoreName', displayName);
            setTxt('bannerTagline', displayDesc);
            document.title = displayName + ' — Buy Data Bundles';

            // ── Apply contact bar ──────────────────────────────────────────
            renderContactBar(storeData);

            // Show main content
            document.getElementById('loadingState').classList.add('hidden');
            document.getElementById('mainContent').classList.remove('hidden');

            console.log('Store loaded successfully!');
        } catch (error) {
            console.error('Error loading store:', error);
            document.getElementById('loadingState').classList.add('hidden');
            document.getElementById('errorState').classList.remove('hidden');
        }
    }

// Load bundles for selected network with store prices
async function loadBundles(network) {
  const container = document.getElementById('bundlesContainer');
  container.innerHTML = `
    <div class="text-center py-8">
      <div class="w-8 h-8 rounded-full border-2 border-blue-200 border-t-blue-600 animate-spin mx-auto"></div>
    </div>
  `;

  try {
    console.log('📦 Loading bundles for network:', network);

    /// Retrieve bundles and pricing through edge function using store identifier.
    const bundlesRes = await fetch(
      `${SUPABASE_PROJECT_URL}/functions/v1/get-store-data?section=bundles&s=${encodeURIComponent(storeShortCode)}&network=${encodeURIComponent(network.toLowerCase())}`,
      { headers: { 'apikey': SUPABASE_ANON } }
    );
    const bundlesData = await bundlesRes.json();

    if (!bundlesData.success) throw new Error(bundlesData.message || 'Failed to load bundles');

    const baseBundles  = bundlesData.bundles  || [];  // [{id,network,size,price,validity,active}]
    const adminCostMap = bundlesData.adminCostMap || {}; // bundleId -> admin's cost for this owner
    const priceMap     = bundlesData.priceMap     || {}; // "network-size" -> store selling price

    console.log('✅ Bundles loaded via edge function:', baseBundles.length, 'bundles');
    console.log('✅ Admin cost map:', adminCostMap);
    console.log('✅ Store price map:', priceMap);

    if (!baseBundles || baseBundles.length === 0) {
      container.innerHTML = `
        <div class="text-center py-12 bg-white rounded-xl">
          <i class="fas fa-exclamation-circle text-3xl text-gray-400 mb-3"></i>
          <p class="text-gray-500">No bundles available for ${esc(network)}</p>
        </div>
      `;
      return;
    }

    // Display bundles with custom prices
    container.innerHTML = `
      <h3 class="text-lg font-bold text-gray-700 mb-4">${esc(network.toUpperCase())} Bundles</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${baseBundles.map(bundle => {
          const bundleKey = `${bundle.network}-${bundle.size}`;
          
          // ✅ Use store price if available, otherwise use base price
          const finalPrice = parseFloat(priceMap[bundleKey] || bundle.price);
          
          console.log(`📦 Bundle: ${bundle.network} ${bundle.size}GB - Store Price: ${priceMap[bundleKey] || 'none'}, Base: ${bundle.price}, Using: ${finalPrice}`);

          // Ensure size is properly formatted
          const bundleSize = parseFloat(bundle.size) || bundle.size;

        // Create complete bundle object
          const bundleData = {
            id: bundle.id,
            network: bundle.network.toLowerCase(),
            size: bundleSize,
            validity: bundle.validity || 'NON-EXPIRY',
            price: finalPrice,        // store owner's selling price (what customer pays)
           // Use store-specific cost when available; fallback to base bundle price.
            baseCost: adminCostMap[bundle.id] ?? parseFloat(bundle.price),
            active: bundle.active
          };

          return `
            <div class="bundle-card bg-white border border-gray-200 rounded-lg p-5 transition-all cursor-pointer" 
                 data-bundle='${JSON.stringify(bundleData)}'>
              <div class="flex justify-between items-start mb-3">
                <div>
                  <h4 class="font-bold text-gray-800 text-lg">${esc(String(bundleSize))}GB</h4>
                  <p class="text-sm text-gray-500">${esc(bundleData.validity)}</p>
                </div>
                <div class="text-right">
                  <p class="text-xs text-blue-600 font-medium uppercase">Price</p>
                  <p class="font-bold text-blue-700 text-2xl">GH₵ ${parseFloat(finalPrice).toFixed(2)}</p>
                  ${priceMap[bundleKey] ? '<p class="text-xs text-green-600">Store Price</p>' : ''}
                </div>
              </div>
              <button class="buy-btn w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition-colors">
                <i class="fas fa-shopping-cart mr-2"></i>Buy Now
              </button>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Attach click handlers
    document.querySelectorAll('.bundle-card').forEach(card => {
      card.querySelector('.buy-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const bundleData = JSON.parse(card.dataset.bundle);
        console.log('🛒 User clicked Buy Now for:', bundleData);
        openPurchaseModal(bundleData);
      });
    });

  } catch (error) {
    console.error('❌ Error loading bundles:', error);
    container.innerHTML = `
      <div class="text-center py-12 bg-white rounded-xl border border-red-200">
        <i class="fas fa-exclamation-triangle text-3xl text-red-500 mb-3"></i>
        <p class="text-red-600">Failed to load bundles</p>
      </div>
    `;
  }
}

    // Open purchase modal
    function openPurchaseModal(bundle) {
        // ✅ Validate bundle data
        if (!bundle || !bundle.size || !bundle.network) {
            console.error('❌ Invalid bundle data:', bundle);
            alert('Bundle data is incomplete. Please refresh and try again.');
            return;
        }
// ✅ Ensure size is a number and validate bundle structure
        const validatedBundle = {
            id: bundle.id,
            network: bundle.network.toLowerCase(),
            size: parseFloat(bundle.size) || bundle.size,
            validity: bundle.validity || 'NON-EXPIRY',
            price: parseFloat(bundle.price),
      // Keep precomputed baseCost from admin pricing; do not replace with bundle price.
            baseCost: parseFloat(bundle.baseCost ?? bundle.price), // admin's custom cost for this store owner
            active: bundle.active
        };
        selectedBundle = validatedBundle;
        
        console.log('✅ Selected bundle for purchase:', selectedBundle); // Debug log
        
        document.getElementById('selectedBundle').innerHTML = `
            <div class="flex justify-between items-center">
                <div>
                    <p class="text-xs text-blue-600 font-medium uppercase">Selected Bundle</p>
                    <p class="font-bold text-gray-800 text-lg">${esc(selectedBundle.network.toUpperCase())} ${esc(String(selectedBundle.size))}GB</p>
                    <p class="text-sm text-gray-500">${selectedBundle.validity}</p>
                </div>
                <div class="text-right">
                    <p class="font-bold text-blue-700 text-2xl">GH₵ ${parseFloat(selectedBundle.price).toFixed(2)}</p>
                </div>
            </div>
        `;

        // Show base price + 4% fee breakdown so customer sees the exact Paystack charge
        const _base = parseFloat(selectedBundle.price);
        const _fee  = Math.round((_base * 4 / 100) * 100) / 100;
        const _tot  = Math.round((_base + _fee) * 100) / 100;
        document.getElementById('modalTotal').innerHTML =
            `GH₵ ${_tot.toFixed(2)} <span class="text-xs font-normal text-gray-400">(incl. GH₵${_fee.toFixed(2)} fee)</span>`;
        document.getElementById('purchaseModal').classList.remove('hidden');
        document.getElementById('purchaseModal').classList.add('flex');
        document.getElementById('recipientPhone').value = '';
    }

    // Close modal
    function closeModal() {
        document.getElementById('purchaseModal').classList.add('hidden');
        document.getElementById('purchaseModal').classList.remove('flex');
    }
// ✅ Process purchase with Paystack — 4% charge + pre-registration fix
// Guard against double-submission (e.g. user clicks button twice after payment popup closes)
let _purchaseInProgress = false;

// [FIX-1] Pre-register the order in the DB BEFORE opening Paystack.
// This ensures the Paystack webhook always finds the order when it fires,
// eliminating the race condition that caused "No real order found" recovery records.
async function processPurchase() {
    if (_purchaseInProgress) {
        console.warn('⚠️ Purchase already in progress — ignoring duplicate click');
        return;
    }
    const phone = document.getElementById('recipientPhone').value.trim();
    
    if (!phone || phone.length < 10) {
        alert('Please enter a valid phone number');
        return;
    }

    // Validate phone format
    const cleanPhone = phone.replace(/\D/g, '');
    let normalizedPhone = cleanPhone;
    
    if (normalizedPhone.startsWith('233')) {
        normalizedPhone = '0' + normalizedPhone.slice(3);
    } else if (normalizedPhone.startsWith('+233')) {
        normalizedPhone = '0' + normalizedPhone.slice(4);
    }

    if (!/^0[0-9]{9}$/.test(normalizedPhone)) {
        alert('Please enter a valid phone number starting with 0 (e.g., 0241234567)');
        return;
    }

    // Add 4% Paystack charge — customers see this on Paystack checkout page
    const PAYSTACK_CHARGE_PERCENT = 4;
    const baseAmount      = parseFloat(selectedBundle.price);
    const paystackCharge  = Math.round((baseAmount * PAYSTACK_CHARGE_PERCENT / 100) * 100) / 100;
    const totalAmount     = Math.round((baseAmount + paystackCharge) * 100) / 100;
    const amountInPesewas = Math.round(totalAmount * 100); // pesewas for Paystack

    // Generate the ref NOW — same ref used for pre-registration and Paystack
    const paymentRef = 'STORE-' + Date.now() + '-' + Math.random().toString(36).substring(7).toUpperCase();

    console.log('💳 Paystack Payment Details:', { baseAmount, paystackCharge, totalAmount, amountInPesewas, ref: paymentRef });

    // Disable button and set in-progress guard
    _purchaseInProgress = true;
    const btn = document.getElementById('confirmPurchase');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Preparing order…';

    // ── [FIX-1] Pre-register the order BEFORE opening Paystack ───────────────
    // The Paystack webhook can fire before processStorePurchase() runs.
    // Pre-registering with status='payment_pending' means the webhook always
    // finds the order record, so no recovery records are created.
    try {
        const preRes = await fetch(`${SUPABASE_PROJECT_URL}/functions/v1/guest-buy-data`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseKey}`
            },
            body: JSON.stringify({
                network:           selectedBundle.network.toLowerCase(),
                phone:             normalizedPhone,
                size:              Math.round(parseFloat(selectedBundle.size)),
                amount:            totalAmount,
                selling_price:     baseAmount,
                base_cost:         parseFloat(selectedBundle.baseCost || 0),
                payment_reference: paymentRef,
                storeownerid:      storeOwnerUserId,
                storeowneremail:   storeOwnerEmail,
                status:            'payment_pending',  // signals pre-registration
            })
        });

        const preData = await preRes.json();

        if (!preData.status && !preData.duplicate) {
            // Pre-registration failed — still safe to proceed (webhook fallback exists)
            // but log it so it can be investigated
            console.warn('⚠️ Pre-registration failed (non-fatal):', preData.message);
        } else {
            console.log('✅ Order pre-registered:', paymentRef);
        }
    } catch (preErr) {
        // Network error during pre-registration — log but continue.
        // The webhook recovery path still handles this case.
        console.warn('⚠️ Pre-registration network error (non-fatal):', preErr.message);
    }

    // ── Open Paystack using the SAME ref that was pre-registered ─────────────
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Opening payment…';

    try {
        const handler = PaystackPop.setup({
            key:      PAYSTACK_PUBLIC_KEY,
            email:    `customer-${Date.now()}@primeconnect.site`,
            amount:   amountInPesewas,
            currency: 'GHS',
            ref:      paymentRef,  // same ref used in pre-registration above
            metadata: {
                store_owner_id:    storeOwnerUserId,
                storeownerid:      storeOwnerUserId,
                store_owner_email: storeOwnerEmail,
                network:           selectedBundle.network,
                bundle_network:    selectedBundle.network,
                bundle_size:       selectedBundle.size,
                recipient:         normalizedPhone,
                recipient_phone:   normalizedPhone,
                bundle_price:      baseAmount,
                custom_fields: [
                    {
                        display_name:  "Phone Number",
                        variable_name: "phone_number",
                        value:         normalizedPhone
                    },
                    {
                        display_name:  "Bundle",
                        variable_name: "bundle",
                        value:         `${selectedBundle.network.toUpperCase()} ${selectedBundle.size}GB`
                    },
                    {
                        display_name:  "Bundle Price",
                        variable_name: "bundle_price",
                        value:         `GH₵ ${baseAmount.toFixed(2)}`
                    },
                    {
                        display_name:  "Processing Fee (4%)",
                        variable_name: "processing_fee",
                        value:         `GH₵ ${paystackCharge.toFixed(2)}`
                    },
                    {
                        display_name:  "Total Amount",
                        variable_name: "total_amount",
                        value:         `GH₵ ${totalAmount.toFixed(2)}`
                    }
                ]
            },
            onClose: function() {
                console.log('Payment window closed');
                _purchaseInProgress = false;
                btn.disabled = false;
                btn.innerHTML = 'Proceed to Payment';
            },
            callback: function(response) {
                console.log('✅ Payment successful!', response);

                if (!response || !response.reference) {
                    console.error('❌ No payment reference received from Paystack');
                    alert('Payment succeeded but no reference received. Contact support with ref: ' + paymentRef);
                    btn.disabled = false;
                    btn.innerHTML = 'Proceed to Payment';
                    return;
                }

                console.log('📦 Fulfilling order for reference:', response.reference);

                processStorePurchase(response.reference, normalizedPhone)
                    .catch(error => {
                        console.error('❌ Error processing purchase:', error);
                        alert('Purchase processing failed: ' + error.message);
                        btn.disabled = false;
                        btn.innerHTML = 'Proceed to Payment';
                    });
            }
        });

        handler.openIframe();

    } catch (error) {
        console.error('❌ Paystack error:', error);
        alert('Payment initialization failed. Please try again.');
        _purchaseInProgress = false;
        btn.disabled = false;
        btn.innerHTML = 'Proceed to Payment';
    }
}

    async function processStorePurchase(reference, phone) {
  const btn = document.getElementById('confirmPurchase');
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Processing purchase...';

  try {
    // Validate payment reference first
    if (!reference) {
      throw new Error('Missing payment reference from Paystack');
    }

    // Validate selectedBundle before sending
    if (!selectedBundle || !selectedBundle.size || !selectedBundle.network) {
      throw new Error('Invalid bundle data. Please try again.');
    }

    // ── Recompute amounts to match exactly what Paystack charged ─────────
    // IMPORTANT: amount sent here MUST equal what Paystack charged (totalAmount),
    // not selectedBundle.price (baseAmount). The edge function verifies the
    // Paystack payment and compares amounts — a mismatch triggers the recovery
    // path and creates a manual pending order instead of auto-processing.
    const PAYSTACK_CHARGE_PERCENT = 4;
    const baseAmount     = parseFloat(selectedBundle.price);
    const paystackCharge = Math.round((baseAmount * PAYSTACK_CHARGE_PERCENT / 100) * 100) / 100;
    const totalAmount    = Math.round((baseAmount + paystackCharge) * 100) / 100; // what Paystack charged

    // Build and validate purchase data
    const purchaseData = {
      network:           selectedBundle.network.toLowerCase(),
      phone:             phone,
      size:              Math.round(parseFloat(selectedBundle.size)) || parseInt(selectedBundle.size),
      bundlename:        `${selectedBundle.network.toUpperCase()} ${selectedBundle.size}GB`,
      payment_reference: reference,
      // ✅ FIX: send totalAmount (base + 4% fee) — matches what Paystack actually charged.
      // The edge function verifies this against the Paystack API response; sending
      // only baseAmount caused an amount mismatch → recovery/pending order fallback.
      amount:            totalAmount,
      selling_price:     baseAmount,     // the store owner's selling price (profit calculation)
      base_cost:         parseFloat(selectedBundle.baseCost || 0),
      storeownerid:      storeOwnerUserId,
      storeowneremail:   storeOwnerEmail  // populated from get-store-data owner_email join
    };

    // Validate all required fields
    const requiredFields = ['network', 'phone', 'size', 'amount', 'payment_reference', 'storeownerid'];
    const missingFields = requiredFields.filter(field => !purchaseData[field]);
    if (missingFields.length > 0) {
      console.error('❌ Missing required fields:', missingFields);
      throw new Error(`Missing fields: ${missingFields.join(', ')}`);
    }

    console.log('📤 Sending purchase data:', purchaseData);
    console.log('💰 Amount breakdown — selling:', baseAmount, '| fee:', paystackCharge, '| total charged:', totalAmount);
  // Retry order persistence to handle transient failures after payment confirmation.
    const MAX_ATTEMPTS = 3;
    let result = null;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`🔄 Retry attempt ${attempt}/${MAX_ATTEMPTS} for ref: ${reference}`);
          btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>Retrying… (${attempt}/${MAX_ATTEMPTS})`;
          // Exponential back-off: 1.5 s, 3 s
          await new Promise(r => setTimeout(r, 1500 * (attempt - 1)));
        }

        const response = await fetch(`${SUPABASE_PROJECT_URL}/functions/v1/guest-buy-data`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseKey}`
          },
          body: JSON.stringify(purchaseData)
        });

        const data = await response.json();

        // Idempotency: if edge function says already processed, treat as success.
        // Also covers the case where the pre-registered record was already upgraded
        // by the Paystack webhook before this callback ran.
        if (data.duplicate) {
          console.log('ℹ️ Order already recorded (duplicate) — treating as success');
          result = data;
          break;
        }

        // pre_registered = true means this was a pre-reg call echoed back — skip
        if (data.pre_registered) {
          console.log('ℹ️ Received pre-registration response in fulfillment path — ignoring');
          throw new Error('Unexpected pre-registration response. Please try again.');
        }

        if (!data.status) {
          throw new Error(data.message || 'Purchase failed');
        }

        result = data;
        break; // success — exit retry loop

      } catch (err) {
        lastError = err;
        console.warn(`⚠️ Attempt ${attempt} failed:`, err.message);
        // Don't retry on validation errors — they won't resolve with retries
        if (err.message && (err.message.includes('Missing') || err.message.includes('Invalid'))) {
          break;
        }
      }
    }

    if (!result) {
      throw lastError || new Error('Purchase failed after multiple attempts. Your payment was received — please contact support with reference: ' + reference);
    }

    console.log('✅ Purchase successful!', result);

    // Reset guard and show success
    _purchaseInProgress = false;
    closeModal();
    showSuccessMessage({
      success: true,
      order_reference: result.order_reference,
      phone: phone
    });

  } catch (error) {
    console.error('❌ Error processing purchase:', error);
    alert('Purchase failed: ' + (error.message || 'Unknown error'));
    _purchaseInProgress = false;
    btn.disabled = false;
    btn.innerHTML = 'Proceed to Payment';
  }
}

    // Show success message - Updated version with Track Order button
   function showSuccessMessage(data) {
    // Recompute for display — same formula as processPurchase() and processStorePurchase()
    const baseAmt  = parseFloat(selectedBundle.price);
    const fee      = Math.round((baseAmt * 4 / 100) * 100) / 100;
    const totalAmt = Math.round((baseAmt + fee) * 100) / 100;

    const successHTML = `
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" id="successOverlay">
            <div class="bg-white rounded-2xl w-full max-w-md p-8 text-center shadow-2xl">
                <div class="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                    <i class="fas fa-check text-4xl text-green-600"></i>
                </div>
                <h2 class="text-2xl font-bold text-gray-800 mb-2">Purchase Successful!</h2>
                <p class="text-gray-600 mb-4">Your ${esc(selectedBundle.network.toUpperCase())} ${esc(String(selectedBundle.size))}GB bundle is being delivered.</p>
                <div class="bg-gray-50 rounded-xl p-4 mb-5 text-left space-y-2">
                    <div class="flex justify-between">
                        <span class="text-gray-500 text-sm">Phone</span>
                        <span class="font-medium text-sm">${esc(data.phone || 'N/A')}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-500 text-sm">Bundle</span>
                        <span class="font-semibold text-sm">${esc(selectedBundle.network.toUpperCase())} ${esc(String(selectedBundle.size))}GB</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-500 text-sm">Bundle Price</span>
                        <span class="font-medium text-sm">GH₵ ${baseAmt.toFixed(2)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-500 text-sm">Processing Fee (4%)</span>
                        <span class="font-medium text-sm">GH₵ ${fee.toFixed(2)}</span>
                    </div>
                    <div class="flex justify-between border-t border-gray-200 pt-2 mt-1">
                        <span class="text-gray-600 text-sm font-semibold">Total Paid</span>
                        <span class="font-bold text-green-600">GH₵ ${totalAmt.toFixed(2)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-500 text-sm">Status</span>
                        <span class="bg-yellow-100 text-yellow-800 text-xs font-semibold px-2 py-0.5 rounded-full">Processing</span>
                    </div>
                </div>
                <p class="text-xs text-gray-400 mb-5"><i class="fas fa-clock mr-1"></i>Delivery usually takes 1–5 minutes</p>
                <div class="flex flex-col gap-3">
                    <button data-phone="${esc(data.phone)}"
                        class="track-from-success-btn w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2">
                        <i class="fas fa-search-location"></i> Track This Order
                    </button>
                    <button onclick="document.getElementById('successOverlay').remove(); location.reload();"
                        class="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-xl transition-colors">
                        Buy Another Bundle
                    </button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', successHTML);
}

function openTrackFromSuccess(phone) {
    const overlay = document.getElementById('successOverlay');
    if (overlay) overlay.remove();
    showTrackOrderPage();
    if (phone) document.getElementById('trackPhone').value = phone;
    setTimeout(() => trackOrder(), 300);
}
    // ═══════════════════════════════════════════
    //  TRACK ORDER FUNCTIONS
    // ═══════════════════════════════════════════

    function showTrackOrderPage() {
        document.getElementById('storeView').classList.add('hidden');
        document.getElementById('trackView').classList.remove('hidden');
        document.getElementById('trackResult').classList.add('hidden');
        document.getElementById('trackResult').innerHTML = '';
    }

    function showStorePage() {
        document.getElementById('trackView').classList.add('hidden');
        document.getElementById('storeView').classList.remove('hidden');
    }

    window.showTrackOrderPage = showTrackOrderPage;
    window.showStorePage = showStorePage;
    window.openTrackFromSuccess = openTrackFromSuccess;

    // Handle click events via delegation and use data attributes for safe data passing.
    document.addEventListener('click', function(e) {
        const btn = e.target.closest('.track-from-success-btn');
        if (!btn) return;
        const phone = btn.getAttribute('data-phone') || '';
        openTrackFromSuccess(phone);
    });

async function trackOrder() {
    const phone = document.getElementById('trackPhone').value.trim();
    const resultDiv = document.getElementById('trackResult');
    const btn = document.getElementById('trackBtn');

    if (!phone || phone.length < 10) {
        showTrackError('Please enter your 10-digit phone number.');
        return;
    }

    let normalizedPhone = phone.replace(/\D/g, '');
    if (normalizedPhone.startsWith('233')) normalizedPhone = '0' + normalizedPhone.slice(3);
    if (normalizedPhone.startsWith('+233')) normalizedPhone = '0' + normalizedPhone.slice(4);

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Searching...';
    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-200 p-8 text-center">
            <div class="w-10 h-10 rounded-full border-2 border-blue-200 border-t-blue-600 animate-spin mx-auto mb-3"></div>
            <p class="text-gray-500">Looking up your orders...</p>
        </div>`;

    try {
       // Use server endpoint to return only permitted customer-safe order fields.
        const res = await fetch(
            `${SUPABASE_PROJECT_URL}/functions/v1/track-order` +
            `?store_owner_id=${encodeURIComponent(storeOwnerUserId)}` +
            `&phone=${encodeURIComponent(normalizedPhone)}`,
            { headers: { 'apikey': SUPABASE_ANON } }
        );
        const result = await res.json();
        if (!result.success) throw new Error(result.message || 'Failed to look up orders');

        const orders = result.orders;

        if (!orders || orders.length === 0) {
            showTrackNotFound(normalizedPhone);
            return;
        }

        renderTrackResults(orders);

    } catch (err) {
        console.error('Track order error:', err);
        showTrackError('Something went wrong. Please try again.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-search"></i> Track Order';
    }
}
    window.trackOrder = trackOrder;

    function showTrackError(msg) {
        const resultDiv = document.getElementById('trackResult');
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `
            <div class="bg-red-50 border border-red-200 rounded-xl p-4 flex gap-3 items-start">
                <i class="fas fa-exclamation-circle text-red-500 mt-0.5"></i>
                <p class="text-red-700 text-sm font-medium">${msg}</p>
            </div>`;
    }

   function showTrackNotFound(phone) {
    const resultDiv = document.getElementById('trackResult');
    resultDiv.innerHTML = `
        <div class="bg-white rounded-2xl border border-gray-200 p-8 text-center">
            <div class="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
                <i class="fas fa-search text-2xl text-gray-400"></i>
            </div>
            <h3 class="font-bold text-gray-800 mb-2">No Orders Found</h3>
            <p class="text-gray-500 text-sm mb-1">No orders found for <strong>${esc(phone)}</strong></p>
            <p class="text-gray-400 text-xs">Please check the phone number and try again.</p>
        </div>`;
}

function renderTrackResults(orders) {
    const resultDiv = document.getElementById('trackResult');

    function fmtDate(d) {
        if (!d) return '—';
        return new Date(d).toLocaleString('en-GH', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    const statusBadge = {
        pending:    { cls: 'bg-yellow-100 text-yellow-800 border-yellow-200', label: 'Pending',     icon: 'fa-clock' },
        processing: { cls: 'bg-blue-100 text-blue-800 border-blue-200',       label: 'Processing',  icon: 'fa-cog' },
        completed:  { cls: 'bg-green-100 text-green-800 border-green-200',    label: 'Delivered ✓', icon: 'fa-check-circle' },
        delivered:  { cls: 'bg-green-100 text-green-800 border-green-200',    label: 'Delivered ✓', icon: 'fa-check-circle' },
        failed:     { cls: 'bg-red-100 text-red-800 border-red-200',          label: 'Failed',      icon: 'fa-times-circle' },
        cancelled:  { cls: 'bg-red-100 text-red-800 border-red-200',          label: 'Cancelled',   icon: 'fa-ban' },
    };

    const networkColors = {
        mtn:        'bg-yellow-100 text-yellow-800',
        airteltigo: 'bg-blue-100 text-blue-800',
        telecel:    'bg-red-100 text-red-800'
    };

    const ordersHTML = orders.map((order, idx) => {
        // Server returns only permitted fields for client display.
        const pkgSize  = order.size || order.package_size || '—';
        const orderDate = order.date || order.created_at;
        const status   = (order.status || 'pending').toLowerCase();
        const badge    = statusBadge[status] || statusBadge['pending'];
        const netColor = networkColors[(order.network||'').toLowerCase()] || 'bg-gray-100 text-gray-700';
        const isFailed = status === 'failed' || status === 'cancelled';

        const steps = [
            { key: 'pending',    label: 'Order Placed', desc: 'Payment received. Your order has been created.',                  icon: 'fa-shopping-cart', done: true },
            { key: 'processing', label: 'Processing',   desc: 'Your data bundle is being processed and queued for delivery.',    icon: 'fa-cog',           done: ['processing','completed','delivered'].includes(status) },
            { key: 'completed',  label: 'Delivered',    desc: 'Your data bundle has been delivered to your phone successfully.', icon: 'fa-check-circle',  done: ['completed','delivered'].includes(status) },
        ];

        return `
        <div class="bg-white rounded-2xl border border-gray-200 overflow-hidden ${idx > 0 ? 'mt-4' : ''}">
            <div class="bg-gradient-to-r from-slate-800 to-slate-700 p-4 text-white">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <span class="inline-block px-2 py-0.5 rounded-full text-xs font-bold ${netColor}">${esc((order.network||'').toUpperCase())}</span>
                        <span class="font-bold text-lg">${pkgSize}GB</span>
                    </div>
                    <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${badge.cls}">
                        <i class="fas ${badge.icon} text-xs"></i> ${badge.label}
                    </span>
                </div>
                <p class="text-slate-400 text-xs mt-1"><i class="far fa-clock mr-1"></i>${fmtDate(orderDate)}</p>
            </div>
            <div class="p-4 border-b border-gray-100">
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <p class="text-xs text-gray-400 mb-0.5">Reference</p>
                        <p class="font-semibold text-gray-800 text-sm">${esc(order.reference || '—')}</p>
                    </div>
                    <div>
                        <p class="text-xs text-gray-400 mb-0.5">Network</p>
                        <p class="font-bold text-gray-700">${esc((order.network||'').toUpperCase())} ${esc(String(pkgSize))}GB</p>
                    </div>
                </div>
            </div>
            <div class="p-4">
                <p class="text-xs font-bold text-gray-500 uppercase tracking-wide mb-4">Delivery Progress</p>
                ${isFailed ? `
                <div class="flex gap-3 p-3 bg-red-50 border border-red-200 rounded-xl">
                    <div class="step-icon bg-red-100 text-red-600 w-8 h-8 text-sm"><i class="fas fa-times-circle"></i></div>
                    <div>
                        <p class="font-semibold text-red-800 text-sm">Order ${badge.label}</p>
                        <p class="text-red-600 text-xs mt-0.5">Could not be completed. Please contact support.</p>
                    </div>
                </div>` : `
                <div class="space-y-0">
                    ${steps.map((step, i) => {
                        const isActive = !step.done && steps[i-1]?.done;
                        return `
                        <div class="timeline-step flex gap-3 pb-5 ${step.done ? 'done' : ''} ${isActive ? 'active-step' : ''}">
                            <div class="step-icon flex-shrink-0 w-8 h-8 text-xs ${
                                step.done ? 'bg-green-500 text-white' :
                                isActive  ? 'bg-blue-600 text-white active-icon' :
                                'bg-gray-100 text-gray-400 border-2 border-gray-200'
                            }">
                                <i class="fas ${step.done ? 'fa-check' : step.icon}"></i>
                            </div>
                            <div class="pt-0.5">
                                <p class="font-semibold text-sm ${step.done ? 'text-gray-800' : isActive ? 'text-blue-700' : 'text-gray-400'}">${step.label}</p>
                                <p class="text-xs mt-0.5 ${step.done ? 'text-gray-500' : isActive ? 'text-blue-500' : 'text-gray-300'}">${step.desc}</p>
                                ${step.done && step.key === 'completed' && order.updated_at ? `<p class="text-xs text-gray-400 mt-1"><i class="far fa-clock mr-1"></i>${fmtDate(order.updated_at)}</p>` : ''}
                            </div>
                        </div>`;
                    }).join('')}
                </div>
                ${status !== 'completed' && status !== 'delivered' ? `
                <div class="bg-blue-50 rounded-xl p-3 flex gap-2 items-center text-xs text-blue-700 border border-blue-100">
                    <i class="fas fa-clock text-blue-400"></i>
                    <span>Delivery usually takes <strong>1–5 minutes</strong> after processing.</span>
                </div>` : `
                <div class="bg-green-50 rounded-xl p-3 flex gap-2 items-center text-xs text-green-700 border border-green-100">
                    <i class="fas fa-check-circle text-green-500"></i>
                    <span>Your bundle has been delivered successfully! 🎉</span>
                </div>`}`}
            </div>
        </div>`;
    }).join('');

    resultDiv.innerHTML = `
        <div class="mb-4 flex items-center justify-between">
            <p class="text-sm font-semibold text-gray-700">
                <i class="fas fa-list text-blue-500 mr-1"></i>
                ${orders.length} order${orders.length > 1 ? 's' : ''} found
            </p>
            <button onclick="trackOrder()" class="text-xs flex items-center gap-1 text-gray-500 hover:text-blue-600 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-blue-50 transition-colors">
                <i class="fas fa-sync-alt"></i> Refresh
            </button>
        </div>
        ${ordersHTML}`;
}
   // Auto-open track page if URL contains ?track=1
(function() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('track') === '1') {
        window.addEventListener('load', () => {
            setTimeout(() => {
                showTrackOrderPage();
                const ph = params.get('phone');
                if (ph) {
                    document.getElementById('trackPhone').value = ph;
                    setTimeout(() => trackOrder(), 400);
                }
            }, 600);
        });
    }
})();
    // ═══════════════════════════════════════════
    //  END TRACK ORDER FUNCTIONS
    // ═══════════════════════════════════════════

    // Event listeners
    document.querySelectorAll('.network-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const network = this.dataset.network;
            
            // Update selected state
            document.querySelectorAll('.network-btn').forEach(b => b.classList.remove('selected'));
            this.classList.add('selected');
            
            loadBundles(network);
        });
    });

    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('modalBackdrop').addEventListener('click', closeModal);
    document.getElementById('confirmPurchase').addEventListener('click', processPurchase);

    // Initialize -- but only after the store lock check resolves.
    // window.__storeLockReady is set by the lock-check script that runs after this
    // inline block. We use setTimeout(0) to yield so that script tag executes first,
    // then await the promise. If locked=true, the overlay is already showing and we
    // skip loadStore() entirely so no store content renders behind the overlay.
    setTimeout(async function() {
      try {
        const isLocked = await (window.__storeLockReady || Promise.resolve(false));
        if (isLocked) return; // overlay already visible, nothing to load
      } catch (_) {
        // fail open -- if lock check errors, load the store normally
      }
      loadStore();
    }, 0);