document.addEventListener("click", (event) => {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return;
  if (!target.closest("#poker-tracker-extension-reload")) return;
  try {
    chrome.runtime.sendMessage({ type: "reload-extension" }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}, true);
