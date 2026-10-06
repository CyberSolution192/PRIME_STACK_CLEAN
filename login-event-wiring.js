// login-event-wiring.js
// CSP-safe event wiring — loaded from an external file, covered by 'self'.
// Replaces inline onclick="..." attributes (blocked once 'unsafe-inline' is
// removed from script-src) with addEventListener wiring instead.

document.addEventListener('DOMContentLoaded', function () {

  function onAll(sel, evt, fn) {
    document.querySelectorAll(sel).forEach(function (el) { el.addEventListener(evt, fn); });
  }

  // Every "Forgot password?" trigger + the modal's own close/cancel/backdrop
  // controls all just toggle the same modal.
  onAll('[data-action="toggle-forgot-password"]', 'click', function () {
    window.toggleForgotPassword();
  });

});