const POKER_URL = "adjarabetnewpokerapp.adjarabet.com";

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
