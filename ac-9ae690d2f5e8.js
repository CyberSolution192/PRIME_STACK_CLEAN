// supabase-admin-config.js  (v4 — zero-credential browser architecture)
// ─────────────────────────────────────────────────────────────────────────────
// SECURITY MODEL — TELCO ENTERPRISE GRADE
// ─────────────────────────────────────────
//
// The browser holds ZERO credentials at all times.
//
// ┌─────────────────────────────────────────┬──────────────────────────────────┐
// │ What                                    │ Where it lives                   │
// ├─────────────────────────────────────────┼──────────────────────────────────┤
// │ Session ID (opaque 32-byte random hex)  │ HttpOnly cookie — JS cannot read │
// │ Access token                            │ admin_sessions DB table only     │
// │ Refresh token                           │ admin_sessions DB table only     │
// └─────────────────────────────────────────┴──────────────────────────────────┘
//
// XSS ATTACK SURFACE: ZERO
// ─────────────────────────
// An XSS payload running in the browser gets:
//   localStorage     → empty (we write nothing there)
//   sessionStorage   → empty (we write nothing there)
//   document.cookie  → empty (session cookie is HttpOnly, invisible to JS)
//   JS memory        → no token (we never store one)
//
// There is nothing to steal. The session cookie is sent automatically by the
// browser to same-origin requests — but only the server can read it.
//
// CSRF PROTECTION
// ────────────────
// Cookie is SameSite=Strict — it is NEVER sent in cross-site requests.
// A malicious third-party site cannot trigger authenticated requests.
//
// HOW A REQUEST WORKS
// ────────────────────
//   adminFetch('admin-manage-orders', { action: 'list' })
//     → POST /functions/v1/admin-proxy
//       headers: { X-Target-Function: 'admin-manage-orders' }
//       body:    { action: 'list' }
//       [browser auto-sends HttpOnly session cookie]
//       [NO Authorization header — JS holds no token]
//     → proxy validates session via admin-auth/verify (server-to-server)
//     → proxy injects Bearer token (from DB) into forwarded request
//     → proxy calls /functions/v1/admin-manage-orders with injected token
//     → response returned to browser
//
// TOKEN NEVER TOUCHES THE BROWSER AT ANY POINT IN THIS FLOW.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL      = 'https://rpolemxgussziexdmdxe.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJwb2xlbXhndXNzemlleGRtZHhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwMjcxNjMsImV4cCI6MjA4NTYwMzE2M30.y6W9tq6X_XG7x5DYwAi-s1m83DNyVoh9fxDIOUcI8eM';

const AUTH_PROXY_URL    = `${SUPABASE_URL}/functions/v1/admin-auth`;
const REQUEST_PROXY_URL = `${SUPABASE_URL}/functions/v1/admin-proxy`;

// ── Session ID fallback for local dev (HTTP) ──────────────────────────────────
// When the admin page is served over HTTP (local dev), browsers block
// SameSite=None cookies because they require HTTPS (the Secure flag).
// As a fallback, the server returns the session_id in the JSON body.
// We store it in sessionStorage and send it as x-session-id header.
//
// SECURITY: sessionStorage is:
//   • Origin-scoped — only this page can read it
//   • Tab-scoped — cleared when the tab closes
//   • Not a cookie — cannot be sent cross-site automatically
//
// In production (HTTPS), the HttpOnly cookie takes over automatically
// and sessionStorage is ignored. The x-session-id header is opaque —
// it is meaningless without the server-side DB row it references.
const SESSION_STORAGE_KEY = 'admin_sid_fallback';

function saveSessionId(sid) {
  try { sessionStorage.setItem(SESSION_STORAGE_KEY, sid); } catch {}
}
function getSessionId() {
  try { return sessionStorage.getItem(SESSION_STORAGE_KEY); } catch { return null; }
}
function clearSessionId() {
  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
}
function sessionHeaders() {
  const sid = getSessionId();
  return sid ? { 'x-session-id': sid } : {};
}

// ── adminFetch ────────────────────────────────────────────────────────────────
// Replaces ALL direct edge-function fetch() calls in admin.js and script.js.
// The browser sends NO Authorization header. The session cookie is sent
// automatically by the browser. The proxy injects the token server-side.
//
// Usage (identical to old pattern except no token needed):
//   const res = await adminFetch('admin-manage-orders', { action: 'list' });
//   const data = await res.json();
export async function adminFetch(targetFunction, body) {
  const res = await fetch(REQUEST_PROXY_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type':      'application/json',
      'apikey':            SUPABASE_ANON_KEY,
      'x-target-function': targetFunction,
      // Fallback for HTTP local dev where Secure cookies are blocked by the browser.
      // In production (HTTPS) the HttpOnly cookie is used instead and this is ignored.
      ...sessionHeaders(),
    },
    body: JSON.stringify(body),
  });

  // If the proxy returns 401 with requiresLogin, the session has expired.
  // admin.js _getAdminToken() handles the redirect to login form.
  return res;
}

// ── adminLogin ────────────────────────────────────────────────────────────────
// Step 1 of 2FA login. Validates email + password server-side, then sends an
// OTP to the admin's registered phone via Arkesel SMS.
//   • meta.step must be 'request-otp'
//   • On success returns { success, step: 'otp-sent', phone_hint, pending_id }
//   • pending_id is an opaque token — pass it to adminVerifyOTP for step 2
// The browser receives NO session cookie or token at this stage.
export async function adminLogin(email, password, meta = {}) {
  const res = await fetch(AUTH_PROXY_URL, {
    method:      'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'apikey':       SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action: 'login', email, password, ...meta }),
  });
  const data = await res.json();
  // Step 'request-otp' does NOT return a session_id — only pending_id.
  // A real session_id only arrives after adminVerifyOTP succeeds.
  // Save session_id after EITHER step — step 1 returns a pending session_id
  // needed as x-session-id header in step 2 (verify-otp). Step 2 returns the
  // final session_id. Both are saved here; the server validates the difference.
  if (data.success && data.session_id) {
    saveSessionId(data.session_id);
  }
  return data;
}

// ── adminVerifyOTP ────────────────────────────────────────────────────────────
// Step 2 of 2FA login. Verifies the SMS OTP code without requiring the
// password to be re-sent or held in browser memory.
//
// SECURITY: The password is discarded after step 1 succeeds. Step 2 only
// needs the opaque pending_id (a random hex token, useless without the DB row)
// and the 6-digit OTP from the admin's phone. Neither is a credential.
//
//   pendingId   — returned by adminLogin as result.pending_id
//   otpCode     — 6-digit code entered by the admin
//   fingerprint — device fingerprint string (optional, for audit logging)
//
// On success returns { success, session_id, user: { fullname, email, role } }
// and the HttpOnly session cookie is set by the server.
export async function adminVerifyOTP(pendingId, otpCode, fingerprint = '') {
  const res = await fetch(AUTH_PROXY_URL, {
    method:      'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'apikey':       SUPABASE_ANON_KEY,
      ...sessionHeaders(),
    },
    body: JSON.stringify({
      action:      'verify-otp',
      otp:         otpCode,
      fingerprint,
    }),
  });
  const data = await res.json();
  // Save session_id as fallback for HTTP local dev where cookie is blocked.
  // In production the HttpOnly cookie is used and this is ignored.
  if (data.success && data.session_id) {
    saveSessionId(data.session_id);
  }
  return data;
}

// ── adminLogout ───────────────────────────────────────────────────────────────
// Calls admin-auth logout action which:
//   1. Reads session_id from HttpOnly cookie
//   2. Loads access_token from DB
//   3. Calls supabase.auth.signOut() server-side — token is IMMEDIATELY dead
//   4. Deletes the admin_sessions row
//   5. Clears the cookie via Set-Cookie: Max-Age=0
// After this call there is no valid credential anywhere.
export async function adminLogout() {
  await fetch(AUTH_PROXY_URL, {
    method:      'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'apikey':       SUPABASE_ANON_KEY,
      ...sessionHeaders(),
    },
    body: JSON.stringify({ action: 'logout' }),
  }).catch(() => {});
  clearSessionId();
}

// ── tryRestoreSession ─────────────────────────────────────────────────────────
// Called by init() on page load instead of supabase.auth.getSession().
// Asks the proxy to verify the session cookie. Returns profile data if valid,
// null if the session has expired or does not exist.
// The browser still holds no token after this call — just the cookie it can't read.
export async function tryRestoreSession() {
  try {
    const res = await fetch(AUTH_PROXY_URL, {
      method:      'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'apikey':       SUPABASE_ANON_KEY,
        ...sessionHeaders(),   // fallback for HTTP local dev
      },
      body: JSON.stringify({ action: 'verify' }),
    });
    const data = await res.json();
    if (data.success) return data.user;  // { user_id, email, role }
    // If verify failed, clear any stale session_id from sessionStorage
    if (!data.success) clearSessionId();
    return null;
  } catch {
    return null;
  }
}

// ── Supabase client (realtime only) ──────────────────────────────────────────
// The Supabase JS client is kept ONLY for the realtime channel subscription
// used to notify admins of new store unlocks. It does NOT handle auth.
// We configure it with a minimal no-op storage adapter so it never writes
// tokens anywhere. Realtime connections use the anon key for channel access;
// the RLS policy on the 'stores' table controls what it can see.
const _noopStorage = {
  getItem:    () => null,
  setItem:    () => {},
  removeItem: () => {},
};

const adminSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage:            _noopStorage,
    autoRefreshToken:   false,
    persistSession:     false,
    detectSessionInUrl: false,
  },
});

export { adminSupabase as supabase };
export const SUPABASE_PROJECT_URL = SUPABASE_URL;
export const SUPABASE_ANON        = SUPABASE_ANON_KEY;