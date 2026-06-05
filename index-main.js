/* ============================================================
 * index-main.js — Prime Connect Landing Page (ES Module)
 * ============================================================ */

        // Import Supabase client and shared keys
        import { supabase, PAYSTACK_PUBLIC_KEY } from './supabase-config.js';

       // Escape all user and database values before using innerHTML.
        function esc(str) {
            if (str == null) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        // Define app as a namespace
        const app = (function() {
            // Paystack channel mapping for mobile money
            const PAYSTACK_CHANNELS = {
                MTN: 'mobile_money',
                AIRTELTIGO: 'mobile_money',
                TELECEL: 'mobile_money',
            };

            // Application State
            const state = {
                currentNetwork: null,
                currentBundle: null,
                paystackState: {
                    reference: null,
                    amount: null,
                    phone: null,
                    channel: null,
                }
            };
            
            // DOM Elements
            const elements = {
                loadingOverlay: document.getElementById('loading-overlay'),
                orderModal: document.getElementById('order-modal'),
                trackModal: document.getElementById('track-modal')
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
                        <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'} mr-3"></i>
                        <span class="font-medium">${message}</span>
                    </div>
                `;
                
                const container = document.getElementById('toast-container');
                container.appendChild(toast);
                
                setTimeout(() => toast.classList.add('show'), 10);
                
                setTimeout(() => {
                    toast.classList.remove('show');
                    setTimeout(() => toast.remove(), 300);
                }, 5000);
            }
            
            function formatCurrency(amount) {
                return `GH₵ ${parseFloat(amount).toFixed(2)}`;
            }
            
            function validatePhone(phone) {
                // Ghana phone number validation
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

            // Normalize phone number for paystack(233 format)
            // Normalize phone number for payments (233 format)
            function normalizePhone(phone) {
                const clean = phone.replace(/\s+/g, '').replace(/\D/g, '');
                
                if (clean.startsWith('233') && clean.length === 12) {
                    return clean; // Already in 233 format
                }
                
                if (clean.startsWith('0') && clean.length === 10) {
                    return '233' + clean.substring(1); // Convert 0XXXXXXXXX to 233XXXXXXXXX
                }
                
                return null;
            }

            // Fetch bundles from server-side endpoint for dynamic loading.
            const EDGE_FUNCTION_URL = 'https://rpolemxgussziexdmdxe.supabase.co/functions/v1/get-public-bundles';

            async function getBundlesFromDatabase() {
                try {
                    const res = await fetch(EDGE_FUNCTION_URL);
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const data = await res.json();
                    if (!data?.success) throw new Error(data?.message || 'Failed to load bundles');

                  // Transform grouped bundle data into UI-compatible format.
                    const bundlesByNetwork = {};
                    const grouped = data.bundles || {};
                    Object.keys(grouped).forEach(network => {
                        bundlesByNetwork[network] = (grouped[network] || []).map(bundle => ({
                            id:          `${bundle.network}-${bundle.size}`,
                            name:        `${bundle.network.toUpperCase()} ${bundle.size}GB`,
                            price:       bundle.price,
                            size:        bundle.size,
                            network:     bundle.network.toLowerCase(),
                            description: `${bundle.size}GB Data Bundle`
                        }));
                    });

                    return bundlesByNetwork;
                } catch (error) {
                    console.error('Error fetching bundles:', error);
                    return {};
                }
            }

            // Bundle Management
            async function loadBundles(network, clickedBtn) {
                state.currentNetwork = network;
                const container = document.getElementById('bundles-container');

                // Highlight selected network
                document.querySelectorAll('.network-btn').forEach(btn => {
                    btn.classList.remove('active', 'border-brand-500', 'ring-2', 'ring-brand-200');
                });
                if (clickedBtn) clickedBtn.classList.add('active', 'border-brand-500', 'ring-2', 'ring-brand-200');

                // Show loading state
                container.innerHTML = `
                    <div class="text-center py-16 bg-slate-50 rounded-xl border-2 border-dashed border-slate-300">
                        <i class="fas fa-spinner fa-spin text-4xl text-brand-400 mb-4"></i>
                        <p class="text-slate-500 font-medium">Loading bundles...</p>
                    </div>
                `;

                try {
                    // Get bundles from database
                    const bundlesByNetwork = await getBundlesFromDatabase();
                    const bundles = bundlesByNetwork[network] || [];

                    if (bundles.length === 0) {
                        container.innerHTML = `
                            <div class="text-center py-16 bg-slate-50 rounded-xl border-2 border-dashed border-slate-300">
                                <i class="fas fa-exclamation-circle text-4xl text-slate-400 mb-4"></i>
                                <p class="text-slate-500 font-medium">No bundles available for this network</p>
                                <p class="text-slate-400 text-sm mt-2">Please check back later</p>
                            </div>
                        `;
                        return;
                    }

                    container.innerHTML = `
                        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 animate-fade-in">
                            ${bundles.map(bundle => `
                                <div class="card p-4 hover:shadow-md transition-shadow cursor-pointer"
                                onclick="app.selectBundle('${bundle.id}', '${bundle.name}', ${bundle.price}, '${bundle.description}', '${bundle.network}', ${bundle.size})">                           
                                         <div class="flex justify-between items-start mb-3">
                                        <div>
                                            <h4 class="font-bold text-slate-800 text-lg">${bundle.name}</h4>
                                            <p class="text-sm text-slate-500">${bundle.size}GB • ${bundle.description}</p>
                                        </div>
                                        <div class="text-right">
                                            <p class="font-bold text-brand-600 text-xl">${formatCurrency(bundle.price)}</p>
                                        </div>
                                    </div>
                                    <button class="w-full bg-brand-600 hover:bg-brand-700 text-white font-semibold py-2 rounded-xl transition-colors">
                                        Buy Now
                                    </button>
                                </div>
                            `).join('')}
                        </div>
                    `;

                    // Scroll to bundles on mobile
                    if (window.innerWidth < 768) {
                        container.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                } catch (error) {
                    console.error('Error loading bundles:', error);
                    container.innerHTML = `
                        <div class="text-center py-16 bg-slate-50 rounded-xl border-2 border-dashed border-slate-300">
                            <i class="fas fa-exclamation-circle text-4xl text-red-400 mb-4"></i>
                            <p class="text-slate-500 font-medium">Failed to load bundles</p>
                            <p class="text-slate-400 text-sm mt-2">Please try again later</p>
                        </div>
                    `;
                }
            }
            
           function selectBundle(id, name, price, description, network, size) {
                state.currentBundle = { id, name, price, description, network, size };
                
                document.getElementById('selected-bundle-container').innerHTML = `
                    <div class="bg-brand-50 border border-brand-200 rounded-lg p-4">
                        <div class="flex justify-between items-center">
                            <div>
                                <p class="text-xs text-brand-600 font-medium uppercase">Selected Bundle</p>
                                <p class="font-bold text-slate-800 text-lg">${name}</p>
                                <p class="text-sm text-slate-600">${description}</p>
                            </div>
                            <div class="text-right">
                                <p class="text-xs text-brand-600 font-medium uppercase">Price</p>
                                <p class="font-bold text-brand-700 text-2xl">${formatCurrency(price)}</p>
                            </div>
                        </div>
                    </div>
                `;
                
                document.getElementById('modal-total').textContent = formatCurrency(price);
                
                // Show modal
                openModal();
            }
            
            // Modal Functions
            function openModal() {
                elements.orderModal.classList.remove('hidden');
                document.body.style.overflow = 'hidden';
                
                // Focus on phone input
                setTimeout(() => {
                    document.getElementById('recipient-phone').focus();
                }, 100);
            }
            
            function closeModal() {
                elements.orderModal.classList.add('hidden');
                document.body.style.overflow = '';
                // Reset state
                state.paystackState = { reference: null, amount: null, phone: null, channel: null };
            }
            
            function openTrackModal() {
                elements.trackModal.classList.remove('hidden');
                document.body.style.overflow = 'hidden';
                
                setTimeout(() => {
                    document.getElementById('track-input').focus();
                }, 100);
            }
            
            function closeTrackModal() {
                elements.trackModal.classList.add('hidden');
                document.body.style.overflow = '';
                document.getElementById('track-result').classList.add('hidden');
            }
            
            // Normalize network value
            // Initialize Paystack payment
            function initializePayment() {
                const recipientPhone = document.getElementById('recipient-phone').value.trim();
                const paymentMethod = document.getElementById('payment-method').value;
                
                // Validation
                if (!validatePhone(recipientPhone)) {
                    showToast('Please enter a valid Ghanaian phone number', 'error');
                    return;
                }

                if (!state.currentBundle || !state.currentBundle.price) {
                    showToast('Please select a bundle first', 'error');
                    return;
                }

                const bundleAmount = parseFloat(state.currentBundle.price);
                
                if (bundleAmount < 1 || bundleAmount > 5000) {
                    showToast(
                        `Amount must be between GH₵ 1.00 and GH₵ 5,000.00`,
                        'error'
                    );
                    return;
                }

                // ✅ Calculate 4% processing charge
                const processingCharge = bundleAmount * 0.04; // 4% processing fee
                const totalAmount = bundleAmount + processingCharge;

                // Map payment method to Paystack channel
                const channel = PAYSTACK_CHANNELS[paymentMethod.toUpperCase()];
                if (!channel) {
                    showToast('Invalid payment method selected', 'error');
                    return;
                }

                // Ask for payer's phone number
                const payerPhone = prompt("Enter your mobile money number to make payment:", "024");
                if (!payerPhone || !validatePhone(payerPhone)) {
                    showToast('Please enter a valid mobile money number', 'error');
                    return;
                }

                // Store payment info in state (including charge for verification)
                state.paystackState = {
                    reference: null,
                    bundleAmount: bundleAmount,
                    processingCharge: processingCharge,
                    totalAmount: totalAmount,
                    phone: payerPhone,
                    channel: channel,
                    recipientPhone: recipientPhone
                };

                // Initialize Paystack payment with TOTAL amount (bundle + 4% charge)
                handlePaystackPayment(totalAmount, bundleAmount, processingCharge, payerPhone, recipientPhone, paymentMethod);
            }

           // Handle Paystack payment
            async function handlePaystackPayment(totalAmount, bundleAmount, processingCharge, phone, recipientPhone, network) {
                try {
                    elements.loadingOverlay.classList.remove('hidden');

                    // Ensure guest order references use GST- prefix for correct processing..
                   const reference =
                       'GST-' +
                     Date.now() +
                     '-' +
                    Math.random()
                    .toString(36)
                       .substring(2, 7)
                        .toUpperCase();

                  state.paystackState.reference = reference;
                    // Get user's email (or prompt for guest)
                    const email = prompt("Enter your email address for payment receipt:", "user@example.com");
                    if (!email || !email.includes('@')) {
                        elements.loadingOverlay.classList.add('hidden');
                        showToast('Please enter a valid email address', 'error');
                        return;
                    }

                    // PRE-REGISTER ORDER BEFORE PAYMENT
                     const preRegisterPayload = {
                     network: state.currentBundle.network.toLowerCase(),
                     phone: recipientPhone,
                    size: parseFloat(state.currentBundle.size),
                    amount: parseFloat(bundleAmount),
                    payment_reference: reference,
                    guest_email: email,
                     guest_phone: phone,
                    status: 'payment_pending'
                      };
                 console.log(
                 'Pre-registering guest order:',
                 preRegisterPayload
                );

               const preRegisterResponse =
               await supabase.functions.invoke(
                   'guest-buy-data',
              {
             body: preRegisterPayload
        }
           );

          if (preRegisterResponse.error) {

              console.error(
           'Pre-registration failed:',
             preRegisterResponse.error
                );

                elements.loadingOverlay.classList.add('hidden');

                showToast(
                  'Could not initialize order. Please try again.',
                 'error'
            );
            return;
               }

                console.log(
                'Pre-registration successful:',
                  preRegisterResponse.data
                       );
                    // Initialize Paystack with TOTAL amount (including 4% processing charge)
                    const handler = PaystackPop.setup({
                        key: PAYSTACK_PUBLIC_KEY,
                        email: email,
                        amount: Math.round(totalAmount * 100), // Paystack uses pesewas (GHS * 100) 
                        currency: 'GHS',
                        ref: reference,       
                         channels: ['mobile_money'],
                        metadata: {
                            phone: phone,
                            recipient_phone: recipientPhone,
                            recipient: recipientPhone,           // webhook reads 'recipient'
                            network: network,
                            bundle_name: state.currentBundle?.name,
                            bundle_id: state.currentBundle?.id,
                            bundle_size: state.currentBundle?.size,  // webhook reads 'bundle_size'
                            // ✅ Include processing charge details for verification
                            bundle_amount: bundleAmount,
                            processing_charge: processingCharge,
                            total_amount: totalAmount,
                            custom_fields: [
                                {
                                    display_name: "Bundle Price",
                                    variable_name: "bundle_price",
                                    value: bundleAmount.toFixed(2)
                                },
                                {
                                    display_name: "Processing Fee (4%)",
                                    variable_name: "processing_fee",
                                    value: processingCharge.toFixed(2)
                                },
                                {
                                    display_name: "Total Amount",
                                    variable_name: "total_amount",
                                    value: totalAmount.toFixed(2)
                                },
                                {
                                    display_name: "Recipient Phone",
                                    variable_name: "recipient_phone",
                                    value: recipientPhone
                                },
                                {
                                    display_name: "Bundle",
                                    variable_name: "bundle_name",
                                    value: state.currentBundle?.name
                                }
                            ]
                        },
                        callback: function(response) {
                            // Payment successful - verify with server
                            // Pass email and payer phone so they are saved to guest_orders
                            verifyPaystackPayment(response.reference, recipientPhone, bundleAmount, processingCharge, email, phone);
                        },
                        onClose: function() {
                            elements.loadingOverlay.classList.add('hidden');
                            showToast('Payment cancelled', 'info');
                        }
                    });

                    handler.openIframe();
                    
                } catch (err) {
                    console.error("Paystack payment error:", err);
                    elements.loadingOverlay.classList.add('hidden');
                    showToast(err.message || "Payment failed. Please try again.", "error");
                }
            }

        // Route payment processing based on authentication state; guest flow handled server-side with idempotency.
            async function verifyPaystackPayment(reference, recipientPhone, bundleAmount, processingCharge, payerEmail, payerPhone) {
                try {
                    elements.loadingOverlay.classList.remove('hidden');
                    closeModal();
                    // Go directly to guest purchase — no auth token needed
                    await processGuestPurchase(reference, recipientPhone, payerEmail, payerPhone);
                } catch (error) {
                    console.error('Payment verification error:', error);
                    elements.loadingOverlay.classList.add('hidden');
                    showToast(error.message || 'Payment verification failed. Please contact support.', 'error');
                }
            }

            // initializePayment is now the main entry point using Paystack

            // Process guest purchase after successful payment
            async function processGuestPurchase(reference, phone, payerEmail, payerPhone) {
                try {
                    elements.loadingOverlay.classList.remove('hidden');

                    // Validate payment reference
                    if (!reference) {
                        throw new Error('Missing payment reference');
                    }

                    // Validate selectedBundle
                    if (!state.currentBundle || !state.currentBundle.size || !state.currentBundle.network) {
                        throw new Error('Invalid bundle data');
                    }

                  // Build purchase data
                    const purchaseData = {
                        network: state.currentBundle.network.toLowerCase(),
                        phone: phone,
                        size: parseFloat(state.currentBundle.size) || state.currentBundle.size,
                        amount: parseFloat(state.currentBundle.price),
                        payment_reference: reference,
                        guest_email: payerEmail || null,   // email the guest typed into Paystack
                        guest_phone: payerPhone || null,   // MoMo number the guest paid from
                    };

                    // Validate all required fields
                    const requiredFields = ['network', 'phone', 'size', 'amount', 'payment_reference'];
                    const missingFields = requiredFields.filter(field => !purchaseData[field]);
                    
                    if (missingFields.length > 0) {
                        console.error('Missing required fields:', missingFields);
                        throw new Error(`Missing fields: ${missingFields.join(', ')}`);
                    }

                    console.log('Sending guest purchase data:', purchaseData);

                    // Try to call guest-buy-data function
                    try {
                       const response =
                     await supabase.functions.invoke(
                     'guest-buy-data',
                 {
              body: {
                ...purchaseData,
                status: 'payment_completed'
                }
              }
           );

                if (response.error) {
                   throw new Error(
               response.error.message ||
             'Payment confirmation failed'
             );
              }
           console.log(
          'Payment confirmation successful!',
           response
       );

        elements.loadingOverlay.classList.add('hidden');

          showSuccessMessage({
          success: true,
         order_reference:
         response.data?.order_reference ||
         reference,
        phone: phone
        });

                  } catch (apiError) {

                 console.error(
                'Guest purchase processing failed:',
             apiError
              );

           elements.loadingOverlay.classList.add('hidden');

              showToast(
         'Payment received. Order verification is in progress. Please wait a moment and track your order.',
        'info'
        );
     }
                } catch (error) {
                    console.error('Error processing purchase:', error);
                    elements.loadingOverlay.classList.add('hidden');
                    showToast('Purchase failed: ' + (error.message || 'Unknown error'), 'error');
                }
            }
            
            // Track Order — calls the track-guest-order edge function
            // Accepts: phone number OR order reference (GST-, STORE-, PAY-)
            async function performTrack() {
                const input = document.getElementById('track-input').value.trim();
                const resultDiv = document.getElementById('track-result');

                if (!input) {
                    showToast('Please enter an order reference or phone number', 'warning');
                    return;
                }

                // Show loading state
                resultDiv.innerHTML = `
                    <div class="text-center py-8">
                        <i class="fas fa-spinner fa-spin text-2xl text-brand-600 mb-3"></i>
                        <p class="text-slate-600">Searching for your order...</p>
                    </div>
                `;
                resultDiv.classList.remove('hidden');

                try {
                    // Determine if input is a phone number or an order reference
                    const isPhone = /^[0-9+\s]{9,13}$/.test(input.replace(/\s/g, ''));

                    const payload = isPhone
                        ? { phone: input.replace(/\s/g, '') }
                        : { reference: input.toUpperCase() };

                    // Call the track-guest-order edge function
                    const { data, error } = await supabase.functions.invoke('track-guest-order', {
                        body: payload
                    });

                    if (error) throw new Error(error.message || 'Could not reach tracking service');

                    if (!data || !data.success || !data.orders || data.orders.length === 0) {
                        resultDiv.innerHTML = `
                            <div class="card p-6 text-center">
                                <div class="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
                                    <i class="fas fa-search text-2xl text-slate-400"></i>
                                </div>
                                <h4 class="font-bold text-slate-700 mb-1">No Orders Found</h4>
                                <p class="text-sm text-slate-500">
                                    We couldn't find any orders for <span class="font-medium text-slate-700">${esc(input)}</span>.
                                </p>
                                <p class="text-xs text-slate-400 mt-3">
                                    Make sure you enter the phone number the data was sent to,
                                    or the full reference (e.g. GST-1773594474913-MC17V).
                                </p>
                            </div>
                        `;
                        return;
                    }

                    const statusConfig = {
                        completed:  { cls: 'bg-green-100 text-green-800 border-green-200',  icon: 'fa-check-circle',   label: 'Delivered'   },
                        processing: { cls: 'bg-blue-100 text-blue-800 border-blue-200',     icon: 'fa-cog',            label: 'Processing'  },
                        pending:    { cls: 'bg-yellow-100 text-yellow-800 border-yellow-200', icon: 'fa-clock',         label: 'Pending'     },
                        failed:     { cls: 'bg-red-100 text-red-800 border-red-200',        icon: 'fa-times-circle',   label: 'Failed'      },
                        cancelled:  { cls: 'bg-slate-100 text-slate-600 border-slate-200',  icon: 'fa-ban',            label: 'Cancelled'   },
                    };

                    const ordersHTML = data.orders.map(order => {
                        const status  = (order.status || 'pending').toLowerCase();
                        const badge   = statusConfig[status] || statusConfig['pending'];
                        const network = esc((order.network || '').toUpperCase());
                        const size    = esc(String(order.package_size || order.size || '—'));
                        const ref     = esc(order.reference || order.order_reference || '—');
                        const amount  = order.amount ? formatCurrency(order.amount) : '—';
                        const date    = order.created_at
                            ? new Date(order.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                            : '—';

                        // Delivery timeline steps
                        const isDone      = status === 'completed' || status === 'delivered';
                        const isProcessing = status === 'processing';
                        const isFailed    = status === 'failed' || status === 'cancelled';

                        const timelineHTML = isFailed ? `
                            <div class="flex gap-3 p-3 bg-red-50 border border-red-200 rounded-xl mt-3">
                                <i class="fas fa-times-circle text-red-500 mt-0.5"></i>
                                <div>
                                    <p class="font-semibold text-red-800 text-sm">Order ${badge.label}</p>
                                    <p class="text-red-600 text-xs mt-0.5">Could not be completed. Please contact support.</p>
                                </div>
                            </div>` : `
                            <div class="mt-3 space-y-2">
                                ${[
                                    { label: 'Order Placed',  done: true,                          icon: 'fa-shopping-cart' },
                                    { label: 'Processing',    done: isProcessing || isDone,         icon: 'fa-cog'          },
                                    { label: 'Delivered',     done: isDone,                         icon: 'fa-check-circle' },
                                ].map((step, i, arr) => {
                                    const isActive = !step.done && (i === 0 || arr[i-1].done);
                                    return `
                                    <div class="flex items-center gap-3">
                                        <div class="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-xs
                                            ${step.done  ? 'bg-green-500 text-white'    :
                                              isActive    ? 'bg-blue-600 text-white'     :
                                                            'bg-slate-100 text-slate-400'}">
                                            <i class="fas ${step.done ? 'fa-check' : step.icon}"></i>
                                        </div>
                                        <span class="text-sm font-medium
                                            ${step.done ? 'text-slate-800' : isActive ? 'text-blue-700' : 'text-slate-400'}">
                                            ${step.label}
                                        </span>
                                    </div>`;
                                }).join('')}
                            </div>
                            ${!isDone ? `
                            <p class="text-xs text-blue-600 mt-3 flex items-center gap-1">
                                <i class="fas fa-clock"></i> Delivery usually takes 1–5 minutes after processing.
                            </p>` : `
                            <p class="text-xs text-green-600 mt-3 flex items-center gap-1">
                                <i class="fas fa-check-circle"></i> Bundle delivered successfully!
                            </p>`}`;

                        return `
                        <div class="card p-4 mb-3">
                            <div class="flex justify-between items-start mb-3">
                                <div>
                                    <p class="font-bold text-slate-800">${network} ${size}GB Data Bundle</p>
                                    <p class="text-xs text-slate-400 font-mono mt-0.5">${ref}</p>
                                </div>
                                <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${badge.cls}">
                                    <i class="fas ${badge.icon}"></i> ${badge.label}
                                </span>
                            </div>
                            <div class="grid grid-cols-2 gap-2 text-sm border-t border-slate-100 pt-3">
                                <div>
                                    <p class="text-xs text-slate-400">Amount</p>
                                    <p class="font-semibold text-slate-700">${amount}</p>
                                </div>
                                <div>
                                    <p class="text-xs text-slate-400">Date</p>
                                    <p class="font-semibold text-slate-700">${date}</p>
                                </div>
                            </div>
                            ${timelineHTML}
                        </div>`;
                    }).join('');

                    resultDiv.innerHTML = `
                        <p class="text-sm font-semibold text-slate-600 mb-3">
                            <i class="fas fa-list text-brand-500 mr-1"></i>
                            ${esc(String(data.orders.length))} order${data.orders.length > 1 ? 's' : ''} found
                        </p>
                        ${ordersHTML}
                        <p class="text-xs text-slate-400 text-center mt-2">
                            <i class="fas fa-info-circle mr-1"></i>
                            Create an account to manage all your orders in one place
                        </p>
                    `;

                } catch (err) {
                    console.error('Track order error:', err);
                    resultDiv.innerHTML = `
                        <div class="card p-5 text-center">
                            <i class="fas fa-exclamation-triangle text-2xl text-red-400 mb-3"></i>
                            <p class="font-semibold text-slate-700">Tracking Unavailable</p>
                            <p class="text-sm text-slate-500 mt-1">${esc(err.message) || 'Please try again in a moment.'}</p>
                        </div>
                    `;
                }
            }

            // Show success message
            function showSuccessMessage(data) {
                const successHTML = `
                    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
                        <div class="bg-white rounded-xl w-full max-w-md p-8 text-center">
                            <div class="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                                <i class="fas fa-check text-4xl text-green-600"></i>
                            </div>
                            <h2 class="text-2xl font-bold text-gray-800 mb-2">Purchase Successful!</h2>
                            <p class="text-gray-600 mb-4">Your ${state.currentBundle?.network?.toUpperCase()} ${state.currentBundle?.size}GB bundle is being delivered.</p>
                            <div class="bg-gray-50 rounded-lg p-4 mb-6 text-left">
                                <div class="flex justify-between mb-2">
                                    <span class="text-gray-600">Reference:</span>
                                    <span class="font-mono text-sm">${data.order_reference || 'N/A'}</span>
                                </div>
                                <div class="flex justify-between mb-2">
                                    <span class="text-gray-600">Phone:</span>
                                    <span class="font-medium">${data.phone || 'N/A'}</span>
                                </div>
                                <div class="flex justify-between">
                                    <span class="text-gray-600">Amount:</span>
                                    <span class="font-bold text-green-600">${formatCurrency(state.currentBundle?.price || 0)}</span>
                                </div>
                            </div>
                            <p class="text-sm text-gray-500 mb-6">Delivery usually takes 1-5 minutes</p>
                            <button onclick="location.reload()" class="w-full bg-brand-600 hover:bg-brand-700 text-white font-bold py-3 rounded-lg">
                                Buy Another Bundle
                            </button>
                        </div>
                    </div>
                `;
                
                document.body.insertAdjacentHTML('beforeend', successHTML);
            }
            
            // Event Listeners Setup
            function setupEventListeners() {
                // Order modal backdrop
                document.getElementById('modal-backdrop').addEventListener('click', closeModal);
                
                // Track modal backdrop
                document.getElementById('track-modal-backdrop').addEventListener('click', closeTrackModal);
                
                // Checkout button
                document.getElementById('checkout-btn').addEventListener('click', initializePayment);
                
                // Enter key in recipient phone
                document.getElementById('recipient-phone').addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        initializePayment();
                    }
                });
                
                // Enter key in track input
                document.getElementById('track-input').addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        performTrack();
                    }
                });
            }
            
            // Initialize
            function init() {
                setupEventListeners();
                
                // Check for URL parameters
                const urlParams = new URLSearchParams(window.location.search);
                const network = urlParams.get('network');
                if (network && ['mtn', 'airteltigo', 'telecel'].includes(network)) {
                    loadBundles(network);
                }
            }
            
            // Expose public methods
            return {
                loadBundles,
                selectBundle,
                openModal,
                closeModal,
                openTrackModal,
                closeTrackModal,
                performTrack,
                init
            };
        })();

        // Make app globally available
        window.app = app;

        // Quick track — used by the inline track bar above the buy section.
        // Pre-fills the track modal input and triggers the search immediately.
        window.quickTrack = function() {
            const input = document.getElementById('quick-track-input').value.trim();
            if (!input) {
                app.openTrackModal();
                return;
            }
            // Open the modal, pre-fill its input, then search
            app.openTrackModal();
            setTimeout(() => {
                const modalInput = document.getElementById('track-input');
                if (modalInput) {
                    modalInput.value = input;
                    app.performTrack();
                }
            }, 80);
        };

        // Initialize the app
        document.addEventListener('DOMContentLoaded', () => {
            app.init();
        });
        
        // Smooth scrolling for anchor links
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function (e) {
                e.preventDefault();
                
                const targetId = this.getAttribute('href');
                if (targetId === '#') return;
                
                const targetElement = document.querySelector(targetId);
                if (targetElement) {
                    targetElement.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
            });
        });