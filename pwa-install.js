// pwa-install.js — shows a floating "Install app" button (bottom-right,
// matching the Bundle Zone screenshot) when the browser signals the site is
// installable, and registers the service worker.
//
// Note: this only fires on Chrome/Edge/Android (the `beforeinstallprompt`
// event). iOS Safari does not support it — there is no equivalent
// programmatic install prompt on iOS, so no button will appear there. That
// is a platform limitation, not a bug.
(function () {
  let deferredPrompt = null;
  const BTN_ID = 'pwa-install-btn';

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true; // iOS home-screen launch
  }

  function createButton() {
    if (document.getElementById(BTN_ID) || isStandalone()) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.innerHTML = '<i class="fas fa-download"></i><span>Install app</span>';
    btn.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:9998',
      'background:#0284c7', 'color:#fff', 'font-weight:600',
      'padding:12px 20px', 'border-radius:9999px', 'border:none',
      'box-shadow:0 8px 20px rgba(2,132,199,0.35)', 'cursor:pointer',
      'display:flex', 'align-items:center', 'gap:8px', 'font-size:14px',
      'font-family:inherit',
    ].join(';');

    btn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      btn.disabled = true;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (outcome !== 'accepted') btn.disabled = false;
      else btn.remove();
    });

    document.body.appendChild(btn);
  }

  function removeButton() {
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.remove();
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // stop the browser's default mini-infobar
    deferredPrompt = e;
    createButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    removeButton();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }
})();