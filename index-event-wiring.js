// index-event-wiring.js
// CSP-safe event wiring — loaded from an external file, covered by 'self'.
// Replaces inline onclick/onkeypress/onerror attributes with
// addEventListener wiring instead.

document.addEventListener('DOMContentLoaded', function () {

  function onAll(sel, evt, fn) {
    document.querySelectorAll(sel).forEach(function (el) { el.addEventListener(evt, fn); });
  }

  // Decorative background images — hide silently if they fail to load.
  onAll('img[aria-hidden="true"]', 'error', function () {
    this.style.display = 'none';
  });

  // Quick-track: Enter key in the input, or the button next to it.
  const quickTrackInput = document.getElementById('quick-track-input');
  if (quickTrackInput) {
    quickTrackInput.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') window.quickTrack();
    });
  }
  onAll('[data-action="quick-track"]', 'click', function () { window.quickTrack(); });

  // Track-order modal open/close, from both the header button and the
  // footer link.
  onAll('[data-action="open-track-modal"]', 'click', function (e) {
    e.preventDefault();
    window.app.openTrackModal();
  });
  onAll('[data-action="close-modal"]',       'click', function () { window.app.closeModal(); });
  onAll('[data-action="close-track-modal"]', 'click', function () { window.app.closeTrackModal(); });
  onAll('[data-action="perform-track"]',     'click', function () { window.app.performTrack(); });

  // Network selector buttons — each carries its network in data-network;
  // `this` (the clicked button element) is passed through exactly as the
  // original inline handler did.
  onAll('[data-network]', 'click', function () {
    window.app.loadBundles(this.dataset.network, this);
  });

  // ── Dynamically-rendered content ─────────────────────────────────────
  // Bundle cards (and the "Buy Another Bundle" reload button) are created
  // by index-main.js at runtime via innerHTML, well after this
  // DOMContentLoaded handler runs — so they need event delegation on a
  // stable ancestor (document.body), not direct per-element listeners,
  // which would only ever catch elements that already existed at load time.
  document.body.addEventListener('click', function (e) {
    const card = e.target.closest('.bundle-card');
    if (card) {
      window.app.selectBundle(
        card.dataset.bundleId,
        card.dataset.bundleName,
        parseFloat(card.dataset.bundlePrice),
        card.dataset.bundleDescription,
        card.dataset.bundleNetwork,
        parseFloat(card.dataset.bundleSize)
      );
      return;
    }

    if (e.target.closest('[data-action="reload-page"]')) {
      location.reload();
    }
  });

});