/**
 * Ping the service worker so the device list can refresh before the *next* context menu open
 * (Chromium cannot populate the menu synchronously on first paint).
 */
document.addEventListener(
  'contextmenu',
  (e) => {
    const el = e.target;
    if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) return;
    try {
      chrome.runtime.sendMessage({ type: 'TRIGGER_MENU_REFRESH' });
    } catch {
      /* extension context invalid */
    }
  },
  true
);
