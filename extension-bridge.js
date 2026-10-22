// The background reloads this tab once the reloaded extension is back; if the page is
// still here after this long, the reload never came, so the bridge does it itself.
const FALLBACK_TAB_RELOAD_MS = 4000;

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return;
  if (!target.closest("#poker-tracker-extension-reload")) return;
  // No runtime id means this bridge is orphaned: the extension was reloaded after this
  // page loaded (UPD in another table, chrome://extensions). It can no longer reach the
  // background, and the extension is already fresh, so reloading this page is enough.
  if (!chrome.runtime || !chrome.runtime.id) {
    location.reload();
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: "reload-extension" }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    location.reload();
    return;
  }
  setTimeout(() => location.reload(), FALLBACK_TAB_RELOAD_MS);
}, true);
