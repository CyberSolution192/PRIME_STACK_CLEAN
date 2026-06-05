 import { supabase as supabaseClient, SUPABASE_PROJECT_URL, SUPABASE_ANON } from './supabase-config.js';
        
        // DOM Elements
        const signupForm = document.getElementById('signup-form');
        const signupBtn = document.getElementById('signup-btn');
        const btnText = document.getElementById('btn-text');
        const btnSpinner = document.getElementById('btn-spinner');
        const passwordInput = document.getElementById('password');
        const togglePasswordBtn = document.getElementById('toggle-password');
        const loadingOverlay = document.getElementById('loading-overlay');
        const messageContainer = document.getElementById('message-container');
        
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
        
        function showMessage(text, type = 'error') {
            messageContainer.innerHTML = '';
            
            const message = document.createElement('div');
            message.className = `p-4 rounded-lg border text-sm flex items-start gap-3 ${
                type === 'error' ? 'bg-red-50 text-red-800 border-red-200' :
                type === 'success' ? 'bg-green-50 text-green-800 border-green-200' :
                'bg-blue-50 text-blue-800 border-blue-200'
            }`;
            
            message.innerHTML = `
                <i class="fas fa-${type === 'error' ? 'exclamation-circle' : type === 'success' ? 'check-circle' : 'info-circle'} mt-0.5"></i>
                <span>${text}</span>
            `;
            
            messageContainer.appendChild(message);
        }
        
        function validatePhone(phone) {
            // Validate Ghanaian phone number - 10 digits starting with 0
            const regex = /^0[0-9]{9}$/;
            return regex.test(phone);
        }
        
        function validateEmail(email) {
            const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return regex.test(email);
        }

        // ── Password strength helper (mirrors Supabase policy) ────────────────
        function checkPasswordStrength(pw) {
            return {
                length: pw.length >= 8,
                lower:  /[a-z]/.test(pw),
                upper:  /[A-Z]/.test(pw),
                digit:  /[0-9]/.test(pw),
                symbol: /[!@#$%^&*()\-_=+\[\]{};':"\\|,.<>\/?`~]/.test(pw),
                get allMet() {
                    return this.length && this.lower && this.upper && this.digit && this.symbol;
                }
            };
        }

        // Real-time password strength indicator
        passwordInput.addEventListener('input', () => {
            const pw = passwordInput.value;
            const req = document.getElementById('pw-requirements');
            const bar = document.getElementById('strength-bar');

            if (pw.length === 0) {
                req.classList.add('hidden');
                bar.style.width = '0';
                return;
            }

            req.classList.remove('hidden');

            const s = checkPasswordStrength(pw);
            const metCount = [s.length, s.lower, s.upper, s.digit, s.symbol].filter(Boolean).length;

            // Update requirement dots
            const toggle = (id, met) => {
                const el = document.getElementById(id);
                el.classList.toggle('met', met);
                el.querySelector('i').className = met ? 'fas fa-check-circle' : 'fas fa-circle-dot';
            };
            toggle('req-length', s.length);
            toggle('req-lower',  s.lower);
            toggle('req-upper',  s.upper);
            toggle('req-digit',  s.digit);
            toggle('req-symbol', s.symbol);

            // Strength bar
            const pct   = (metCount / 5) * 100;
            const color = metCount <= 2 ? '#ef4444' : metCount <= 3 ? '#f59e0b' : metCount === 4 ? '#3b82f6' : '#16a34a';
            bar.style.width = `${pct}%`;
            bar.style.backgroundColor = color;
        });
        
        // Event Listeners
        togglePasswordBtn.addEventListener('click', () => {
            const icon = togglePasswordBtn.querySelector('i');
            if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                icon.className = 'far fa-eye-slash';
            } else {
                passwordInput.type = 'password';
                icon.className = 'far fa-eye';
            }
        });
        
        // Form Submission
        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            // Get form values
            const fullname = document.getElementById('fullname').value.trim();
            const email = document.getElementById('email').value.trim();
            const phone = document.getElementById('phone').value.trim();
            const password = passwordInput.value;
            const terms = document.getElementById('terms').checked;
            
            // Clear previous messages
            messageContainer.innerHTML = '';
            
            // Validation
            if (!fullname) {
                showMessage('Please enter your full name', 'error');
                document.getElementById('fullname').focus();
                return;
            }
            
            if (!validateEmail(email)) {
                showMessage('Please enter a valid email address', 'error');
                document.getElementById('email').focus();
                return;
            }
            
            if (!validatePhone(phone)) {
                showMessage('Please enter a valid 10-digit Ghanaian phone number', 'error');
                document.getElementById('phone').focus();
                return;
            }
            
            // Match Supabase password policy exactly: 8+ chars, lower, upper, digit, symbol
            const pwCheck = checkPasswordStrength(password);
            if (!pwCheck.allMet) {
                const missing = [];
                if (!pwCheck.length)  missing.push('at least 8 characters');
                if (!pwCheck.lower)   missing.push('a lowercase letter');
                if (!pwCheck.upper)   missing.push('an uppercase letter');
                if (!pwCheck.digit)   missing.push('a number');
                if (!pwCheck.symbol)  missing.push('a special character (!@#$%^&* etc.)');
                showMessage(`Password must contain: ${missing.join(', ')}.`, 'error');
                passwordInput.focus();
                return;
            }
            
            if (!terms) {
                showMessage('Please agree to the Terms of Service and Privacy Policy', 'error');
                return;
            }
            
            // Set loading state
            signupBtn.disabled = true;
            btnText.textContent = 'Creating Account...';
            btnSpinner.classList.remove('hidden');
            loadingOverlay.classList.remove('hidden');
            
            try {
                // Sign up with Supabase Auth
                // FIX: role removed from options.data — role is always assigned
                // server-side by the DB trigger and create-profile Edge Function.
                // Passing it here is a no-op at best and misleading at worst.
                const { data: authData, error: authError } = await supabaseClient.auth.signUp({
                    email,
                    password,
                    options: {
                        data: {
                            full_name: fullname,
                            phone: `+233${phone.replace(/^0/, '')}`,
                        }
                    }
                });
                
                if (authError) throw authError;
                
                if (authData.user && authData.session) {
                    try {
                        const profileRes = await fetch(
                            `${SUPABASE_PROJECT_URL}/functions/v1/create-profile`,
                            {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${authData.session.access_token}`,
                                    'apikey': SUPABASE_ANON,
                                },
                                // Edge function expects 9 digits without leading 0.
                                // Form collects 10-digit format (e.g. 0249654924) so strip the 0.
                                body: JSON.stringify({ fullname, phone: phone.replace(/^0/, '') }),
                            }
                        );
                        const profileResult = await profileRes.json();
                        if (!profileResult.success) {
                            // Non-fatal — auth succeeded, profile can be created later
                            console.warn('Profile creation failed:', profileResult.message);
                        }
                    } catch (profileError) {
                        console.error('Profile creation error:', profileError);
                        // Continue anyway - auth is still successful
                    }
                }
                
                // Show success message
                showToast('Account created successfully! Please check your email to confirm your account.', 'success');
                showMessage('Account created! Please check your email for confirmation link.', 'success');
                
                // Reset form
                signupForm.reset();
                
                // Redirect to login page after delay
                setTimeout(() => {
                    window.location.href = 'login.html?message=Account created successfully! Please check your email to confirm your account.';
                }, 3000);
                
            } catch (error) {
                console.error('Signup error:', error);
                
                // Handle specific error cases
                let errorMessage = 'An error occurred during signup. Please try again.';
                
                if (error.message.includes('User already registered')) {
                    errorMessage = 'An account with this email already exists. Please try logging in instead.';
                } else if (error.message.includes('Invalid email')) {
                    errorMessage = 'Please enter a valid email address.';
                } else if (error.message.includes('rate limit')) {
                    errorMessage = 'Too many attempts. Please try again later.';
                } else if (
                    error.name === 'AuthWeakPasswordError' ||
                    error.message.toLowerCase().includes('weak') ||
                    error.message.toLowerCase().includes('password should contain')
                ) {
                    errorMessage = 'Your password doesn\'t meet the security requirements. It must be at least 8 characters and include uppercase, lowercase, a number, and a special character.';
                }
                
                showMessage(errorMessage, 'error');
                showToast(errorMessage, 'error');
                
            } finally {
                // Reset loading state
                signupBtn.disabled = false;
                btnText.textContent = 'Create Account';
                btnSpinner.classList.add('hidden');
                loadingOverlay.classList.add('hidden');
            }
        });
        
        // Auto-format phone number input
        document.getElementById('phone').addEventListener('input', function(e) {
            // Remove non-numeric characters
            let value = this.value.replace(/\D/g, '');
            
            // Limit to 10 digits
            if (value.length > 10) {
                value = value.substring(0, 10);
            }
            
            // Update input value
            this.value = value;
            
            // Validate and show feedback
            if (value.length === 10) {
                if (validatePhone(value)) {
                    this.classList.remove('border-red-300');
                    this.classList.add('border-green-300');
                } else {
                    this.classList.remove('border-green-300');
                    this.classList.add('border-red-300');
                }
            } else {
                this.classList.remove('border-red-300', 'border-green-300');
            }
        });
        
        // Real-time email validation
        document.getElementById('email').addEventListener('blur', function() {
            if (this.value && !validateEmail(this.value)) {
                this.classList.add('border-red-300');
            } else {
                this.classList.remove('border-red-300');
            }
        });
        
        // Check for URL parameters (for redirects from login page)
        const urlParams = new URLSearchParams(window.location.search);
        const message = urlParams.get('message');
        const error = urlParams.get('error');
        
        if (message) {
            showToast(message, 'success');
        }
        
        if (error) {
            showMessage(error, 'error');
        }
        
        // Auto-focus first input on load
        document.getElementById('fullname').focus();
        