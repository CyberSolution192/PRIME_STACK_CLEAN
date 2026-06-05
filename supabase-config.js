// supabase-config.js  (v2 — zero-credential architecture for dashboard)
// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS BY PAGE
// ────────────────
//   login.html    → supabase (for signInWithPassword, resetPasswordForEmail)
//   signup.html   → supabase, SUPABASE_PROJECT_URL, SUPABASE_ANON
//   store.html    → supabase, PAYSTACK_PUBLIC_KEY, SUPABASE_PROJECT_URL, SUPABASE_ANON
//   index-main.js → supabase, PAYSTACK_PUBLIC_KEY
//   dashboard-main.js → supabase, userFetch, userLogin, userLogout,
//                        tryRestoreUserSession, PAYSTACK_PUBLIC_KEY,
//                        SUPABASE_PROJECT_URL, SUPABASE_ANON
//
// SECURITY MODEL BY PAGE
// ───────────────────────
//   login.html    — calls userLogin() which routes through user-auth Edge
//                   Function, setting an HttpOnly session cookie. The JWT
//                   never touches localStorage.
//   signup.html   — uses supabase.auth.signUp() (unavoidable — user has no
//                   session yet). After signup the user lands on login.html
//                   which sets the secure session.
//   store.html    — public page, no auth. Uses only anon-key endpoints.
//   index-main.js — public page, no auth. Uses only anon-key endpoints.
//   dashboard     — all authenticated calls go through userFetch() →
//                   user-proxy Edge Function. Browser holds zero tokens.
//
// WHAT IS SAFE TO EXPOSE HERE
// ────────────────────────────
//   SUPABASE_ANON_KEY  — public by design, enforced by RLS
//   SUPABASE_URL       — public, appears in every network request
//   PAYSTACK_PUBLIC_KEY— public by design, restrict domains in Paystack dashboard
//   NEVER place service_role key or any secret here.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL      = 'https://rpolemxgussziexdmdxe.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJwb2xlbXhndXNzemlleGRtZHhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwMjcxNjMsImV4cCI6MjA4NTYwMzE2M30.y6W9tq6X_XG7x5DYwAi-s1m83DNyVoh9fxDIOUcI8eM';

export const PAYSTACK_PUBLIC_KEY  = 'pk_live_ab6a5a8a637a287d763a910af6e44136f779a93b';
export const SUPABASE_PROJECT_URL = SUPABASE_URL;
export const SUPABASE_ANON        = SUPABASE_ANON_KEY;

const USER_AUTH_URL  = `${SUPABASE_URL}/functions/v1/user-auth`;
const USER_PROXY_URL = `${SUPABASE_URL}/functions/v1/user-proxy`;

// ── Session ID fallback for local HTTP dev ────────────────────────────────────
// On production HTTPS the HttpOnly cookie is used automatically.
// On local HTTP, browsers block Secure cookies, so we store the opaque
// session_id in sessionStorage and send it as x-session-id header.
// sessionStorage is origin-scoped and cleared when the tab closes.
const SESSION_KEY    = 'user_sid_fallback';
const saveSessionId  = (sid) => { try { sessionStorage.setItem(SESSION_KEY, sid); } catch {} };
const getSessionId   = ()    => { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } };
const clearSessionId = ()    => { try { sessionStorage.removeItem(SESSION_KEY); } catch {} };
const sessionHeaders = ()    => { const sid = getSessionId(); return sid ? { 'x-session-id': sid } : {}; };

// ── userLogin ─────────────────────────────────────────────────────────────────
// Called by login.html instead of supabase.auth.signInWithPassword().
// Routes through user-auth Edge Function which:
//   1. Authenticates with Supabase server-side
//   2. Stores access_token + refresh_token in user_sessions DB table
//   3. Returns only an opaque session_id as an HttpOnly cookie
//   4. Returns safe user data (no token) in the JSON body
// The browser receives a cookie it cannot read — zero credential exposure.
export async function userLogin(email, password) {
  const res = await fetch(USER_AUTH_URL, {
    method:      'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'apikey':       SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action: 'login', email, password }),
  });
  const data = await res.json();
  if (data.success && data.session_id) saveSessionId(data.session_id);
  return data;
}

// ── userLogout ────────────────────────────────────────────────────────────────
// Calls user-auth Edge Function which revokes the session server-side,
// deletes the DB row, and clears the HttpOnly cookie.
export async function userLogout() {
  const sid = getSessionId();
  await fetch(USER_AUTH_URL, {
    method:      'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'apikey':       SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action: 'logout', ...(sid ? { __sid: sid } : {}) }),
  }).catch(() => {});
  clearSessionId();
}

// ── tryRestoreUserSession ─────────────────────────────────────────────────────
// Called on dashboard page load. Validates the HttpOnly session cookie
// server-side. Returns session data if valid, null if not.
// The browser still holds no token after this call.
export async function tryRestoreUserSession() {
  try {
    const sid = getSessionId();
    const res = await fetch(USER_AUTH_URL, {
      method:      'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'apikey':       SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ action: 'verify', ...(sid ? { __sid: sid } : {}) }),
    });
    const data = await res.json();
    if (data.success) return data;
    clearSessionId();
    return null;
  } catch {
    return null;
  }
}

// ── userFetch ─────────────────────────────────────────────────────────────────
// Used exclusively by dashboard-main.js for all authenticated API calls.
// The browser sends NO Authorization header — only the HttpOnly cookie.
// The user-proxy Edge Function injects the bearer token server-side.
export async function userFetch(targetFunction, body = {}, queryString = '') {
  // ALL routing info — including the session fallback ID — goes in the request
  // body, NEVER in custom headers. Any non-standard header (x-session-id, etc.)
  // triggers a CORS preflight that Supabase gateway v3 intercepts and mishandles,
  // causing it to return 405 on the subsequent POST before function code runs.
  const sid = getSessionId();
  const res = await fetch(USER_PROXY_URL, {
    method:      'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'apikey':       SUPABASE_ANON_KEY,
      // ← no x-session-id header — moved to body as __sid
    },
    body: JSON.stringify({
      __target: targetFunction,
      __query:  queryString || '',
      ...(sid ? { __sid: sid } : {}),  // session fallback read from body in user-proxy
      ...body,
    }),
  });
  return res;
}

// ── Supabase client ───────────────────────────────────────────────────────────
// Used by:
//   login.html    — signInWithPassword (entry point, creates the session)
//   signup.html   — signUp (entry point, no session exists yet)
//   store.html    — public anon-key requests only
//   index-main.js — public anon-key requests only
//   dashboard     — realtime channel subscriptions only
//
// For login.html: this client's signInWithPassword still works normally
// because userLogin() (above) handles the secure session cookie setup.
// The client below is used ONLY for the auth call — the resulting JWT
// is not stored by the dashboard (it uses the proxy architecture instead).
//
// Storage: no-op adapter so no token is ever written to localStorage
// or sessionStorage by this client anywhere in the app.
const _noopStorage = {
  getItem:    () => null,
  setItem:    () => {},
  removeItem: () => {},
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage:            _noopStorage,
    autoRefreshToken:   false,
    persistSession:     false,
    detectSessionInUrl: false,
  },
});

// ── Legacy window exports ─────────────────────────────────────────────────────
// Kept for any non-module code. Do NOT add token-exposing methods here.
window.supabaseConfig = { getClient: () => supabase };
window.supabaseAuth   = {
  isAuthenticated: async () => !!(await tryRestoreUserSession()),
  signOut:         userLogout,
};