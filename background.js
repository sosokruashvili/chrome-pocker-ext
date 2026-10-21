const POKER_URL = "adjarabetnewpokerapp.adjarabet.com";
const RELOAD_TAB_KEY = "reloadPokerTabId";
let handlingReloadMessage = false;

function reloadPokerTab(tabId) {
  chrome.tabs.reload(tabId, () => {
    if (!chrome.runtime.lastError) return;
    chrome.tabs.query({ url: "https://" + POKER_URL + "/*" }, (tabs) => {
      (tabs || []).forEach((tab) => {
        if (tab.id) chrome.tabs.reload(tab.id);
      });
    });
  });
}

function consumePendingTableReload() {
  if (handlingReloadMessage) return;
  chrome.storage.local.get(RELOAD_TAB_KEY, (stored) => {
    if (handlingReloadMessage) return;
    const tabId = stored && stored[RELOAD_TAB_KEY];
    if (!tabId) return;
    chrome.storage.local.remove(RELOAD_TAB_KEY, () => {
      setTimeout(() => reloadPokerTab(tabId), 150);
    });
  });
}

consumePendingTableReload();

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "reload-extension") return;
  handlingReloadMessage = true;
  const tabId = sender.tab && sender.tab.id;
  const reloadExtension = () => chrome.runtime.reload();
  if (!tabId) {
    reloadExtension();
    return;
  }
  chrome.storage.local.set({ [RELOAD_TAB_KEY]: tabId }, reloadExtension);
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url && tab.url.includes(POKER_URL)) {
    chrome.action.setBadgeText({ text: "ON", tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && tab.url.includes(POKER_URL)) {
      chrome.action.setBadgeText({ text: "ON", tabId: tab.id });
      chrome.action.setBadgeBackgroundColor({ color: "#4CAF50", tabId: tab.id });
    } else {
      chrome.action.setBadgeText({ text: "", tabId: tab.id });
    }
  } catch (e) {}
});
