// store-event-wiring.js
// CSP-safe event wiring — loaded from an external file, covered by 'self'.
// Replaces inline onclick="..." attributes with addEventListener wiring.

document.addEventListener('DOMContentLoaded', function () {

  function on(id, evt, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  }
  function onAll(sel, evt, fn) {
    document.querySelectorAll(sel).forEach(function (el) { el.addEventListener(evt, fn); });
  }

  on('dmPill',              'click', function () { window.toggleDark(); });
  on('trackOrderHeaderBtn', 'click', function () { window.showTrackOrderPage(); });
  on('trackBtn',            'click', function () { window.trackOrder(); });
  onAll('[data-action="show-store-page"]', 'click', function () { window.showStorePage(); });

});