import { supabase as supabaseClient, userLogin } from './supabase-config.js';
        
        // DOM Elements
        const loginForm = document.getElementById('login-form');
        const loginBtn = document.getElementById('login-btn');
        const btnText = document.getElementById('btn-text');
        const btnSpinner = document.getElementById('btn-spinner');
        const passwordInput = document.getElementById('password');
        const togglePasswordBtn = document.getElementById('toggle-password');
        const loadingOverlay = document.getElementById('loading-overlay');
        const messageContainer = document.getElementById('message-container');
        const forgotModal = document.getElementById('forgot-modal');
        const resetEmailInput = document.getElementById('reset-email');
        const sendResetBtn = document.getElementById('send-reset-btn');
        const resetBtnText = document.getElementById('reset-btn-text');
        const resetSpinner = document.getElementById('reset-spinner');
        const resetMessage = document.getElementById('reset-message');

        // The UX-layer supplement.
        const loginRateLimit = {
            attempts: 0,
            lockedUntil: 0,
            maxAttempts: 5,
            lockoutMs: 60_000,
            isLocked() {
                return this.lockedUntil > Date.now();
            },
            recordFailure() {
                this.attempts++;
                if (this.attempts >= this.maxAttempts) {
                    this.lockedUntil = Date.now() + this.lockoutMs;
                    this.attempts = 0;
                }
            },
            reset() { this.attempts = 0; this.lockedUntil = 0; }
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
        
        function showMessage(text, type = 'error') {
            messageContainer.innerHTML = '';
            
            const message = document.createElement('div');
            message.className = `p-4 rounded-lg border text-sm flex items-start gap-3 animate-fade-in ${
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
        
        function validateEmail(email) {
            const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return regex.test(email);
        }
        
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
        
        window.toggleForgotPassword = () => {
            forgotModal.classList.toggle('hidden');
            document.body.style.overflow = forgotModal.classList.contains('hidden') ? '' : 'hidden';
            
            if (!forgotModal.classList.contains('hidden')) {
                resetEmailInput.focus();
                resetMessage.classList.add('hidden');
                resetEmailInput.value = '';
            }
        };
        
        // Form Submission
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();

             if (loginRateLimit.isLocked()) {
                const remaining = Math.ceil((loginRateLimit.lockedUntil - Date.now()) / 1000);
                showMessage(`Too many failed attempts. Please wait ${remaining}s before trying again.`, 'error');
                return;
            }

            // Get form values
            const email = document.getElementById('email').value.trim();
            const password = passwordInput.value;
            const rememberMe = document.getElementById('remember-me').checked;

            // Clear previous messages
            messageContainer.innerHTML = '';
            
            // Validation
            if (!validateEmail(email)) {
                showMessage('Please enter a valid email address', 'error');
                document.getElementById('email').focus();
                return;
            }
            
            if (!password) {
                showMessage('Please enter your password', 'error');
                passwordInput.focus();
                return;
            }
            
            // Set loading state
            loginBtn.disabled = true;
            btnText.textContent = 'Signing in...';
            btnSpinner.classList.remove('hidden');
            loadingOverlay.classList.remove('hidden');
            
            try {
                // Authenticate via user-auth Edge Function.
                // This sets an HttpOnly session cookie — the JWT never
                // touches localStorage. Zero credential exposure.
                const result = await userLogin(email, password);

                if (!result.success) {
                    let errorMessage = result.error || 'Invalid email or password. Please try again.';

                    if (errorMessage.includes('Invalid login credentials')) {
                        errorMessage = 'Invalid email or password. Please check your credentials.';
                    } else if (errorMessage.includes('Email not confirmed')) {
                        errorMessage = 'Please confirm your email address before signing in.';
                    } else if (errorMessage.includes('rate limit')) {
                        errorMessage = 'Too many attempts. Please try again later.';
                    }

                    throw new Error(errorMessage);
                }

                if (!result.user) {
                    throw new Error('Login failed. Please try again.');
                }
                
                // Success! Authentication is complete
                console.log('✅ User authenticated:', result.user.id);

                // Show success and redirect immediately
                showToast('Login successful! Redirecting...', 'success');

                // Redirect to dashboard
                setTimeout(() => {
                    window.location.href = 'dashboard.html';
                }, 800);
                
            } catch (error) {
                console.error('Login error:', error.message);

                loginRateLimit.recordFailure();

                // Add shake animation to form
                loginForm.classList.add('animate-shake');
                setTimeout(() => loginForm.classList.remove('animate-shake'), 400);

                showMessage(error.message || 'Login failed. Please try again.', 'error');
                showToast(error.message || 'Login failed', 'error');
                
            } finally {
                // Reset loading state after delay
                setTimeout(() => {
                    loginBtn.disabled = false;
                    btnText.textContent = 'Sign In';
                    btnSpinner.classList.add('hidden');
                    loadingOverlay.classList.add('hidden');
                }, 1000);
            }
        });
        
        // Reset Password Handler
        sendResetBtn.addEventListener('click', async () => {
            const email = resetEmailInput.value.trim();
            if (!validateEmail(email)) {
                resetMessage.innerHTML = '<div class="text-red-800 bg-red-50 p-3 rounded-lg">Please enter a valid email address</div>';
                resetMessage.classList.remove('hidden');
                return;
            }
            sendResetBtn.disabled = true;
            resetBtnText.textContent = 'Sending...';
            resetSpinner.classList.remove('hidden');
            resetMessage.classList.add('hidden');
            try {
                const res  = await fetch('https://rpolemxgussziexdmdxe.supabase.co/functions/v1/reset-password', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ action: 'request-otp', email }),
                });
                const data = await res.json();
                // Always show step 2 (prevents email enumeration)
                document.getElementById('reset-step-1').classList.add('hidden');
                document.getElementById('reset-step-2').classList.remove('hidden');
                const hintEl = document.getElementById('reset-phone-hint');
                if (hintEl) hintEl.textContent = data.phone_hint
                    ? 'OTP sent to ' + data.phone_hint
                    : 'If your email is registered, an OTP was sent to your phone';
                // Wire up step 2
                setupVerifyReset(email);
            } catch (err) {
                resetMessage.innerHTML = '<div class="text-red-800 bg-red-50 p-3 rounded-lg">Something went wrong. Please try again.</div>';
                resetMessage.classList.remove('hidden');
            } finally {
                sendResetBtn.disabled = false;
                resetBtnText.textContent = 'Send OTP';
                resetSpinner.classList.add('hidden');
            }
        });

        function setupVerifyReset(email) {
            const otpInput      = document.getElementById('reset-otp');
            const newPwInput    = document.getElementById('reset-new-password');
            const confirmPwInput= document.getElementById('reset-confirm-password');
            const verifyBtn     = document.getElementById('verify-reset-btn');
            const verifyBtnText = document.getElementById('verify-btn-text');
            const verifySpinner = document.getElementById('verify-spinner');
            const msgEl         = document.getElementById('reset-step2-message');
            const backBtn       = document.getElementById('reset-back-btn');

            if (otpInput) otpInput.value = '';
            if (newPwInput) newPwInput.value = '';
            if (confirmPwInput) confirmPwInput.value = '';
            setTimeout(() => otpInput?.focus(), 100);

            if (backBtn) backBtn.onclick = () => {
                document.getElementById('reset-step-2').classList.add('hidden');
                document.getElementById('reset-step-1').classList.remove('hidden');
            };

            if (verifyBtn) verifyBtn.onclick = async () => {
                const otp         = otpInput?.value.trim();
                const newPassword = newPwInput?.value.trim();
                const confirmPw   = confirmPwInput?.value.trim();
                if (!otp || otp.length !== 6) { showMsg(msgEl, 'Please enter the 6-digit OTP', 'error'); return; }
                if (!newPassword || newPassword.length < 8) { showMsg(msgEl, 'Password must be at least 8 characters', 'error'); return; }
                if (newPassword !== confirmPw) { showMsg(msgEl, 'Passwords do not match', 'error'); return; }
                verifyBtn.disabled = true;
                verifyBtnText.textContent = 'Verifying...';
                verifySpinner.classList.remove('hidden');
                try {
                    const res  = await fetch('https://rpolemxgussziexdmdxe.supabase.co/functions/v1/reset-password', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ action: 'verify-otp', email, otp, newPassword }),
                    });
                    const data = await res.json();
                    if (!data.success) { showMsg(msgEl, data.error || 'Verification failed', 'error'); return; }
                    showMsg(msgEl, 'Password reset successful! Redirecting to login...', 'success');
                    setTimeout(() => toggleForgotPassword(), 2500);
                } catch (err) {
                    showMsg(msgEl, 'Something went wrong. Please try again.', 'error');
                } finally {
                    verifyBtn.disabled = false;
                    verifyBtnText.textContent = 'Reset Password';
                    verifySpinner.classList.add('hidden');
                }
            };
        }

        function showMsg(el, msg, type) {
            if (!el) return;
            const colors = { success: 'text-green-800 bg-green-50', error: 'text-red-800 bg-red-50' };
            el.innerHTML = `<div class="${colors[type] || ''} p-3 rounded-lg">${msg}</div>`;
            el.classList.remove('hidden');
        }
                
        // Auto-fill email from URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        const emailParam = urlParams.get('email');
        const message = urlParams.get('message');
        
        if (emailParam) {
            document.getElementById('email').value = emailParam;
        }
        
        if (message) {
            showMessage(decodeURIComponent(message), 'success');
        }
        
        // Auto-focus email input on load
        document.getElementById('email').focus();
        
        // Enter key to submit in forgot modal
        resetEmailInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendResetBtn.click();
            }
        });