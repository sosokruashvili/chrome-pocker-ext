const POKER_URL = "adjarabetnewpokerapp.adjarabet.com";

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const statusEl = document.getElementById("status");
  const tab = tabs[0];

  if (tab && tab.url && tab.url.includes(POKER_URL)) {
    statusEl.textContent = "Poker table detected!";
    statusEl.className = "status detected";
  } else {
    statusEl.textContent = "Not on poker site";
    statusEl.className = "status not-detected";
  }
});
