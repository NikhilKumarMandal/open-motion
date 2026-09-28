// tabId of the page being demoed -> tabId of the record.html tab to notify
const watchedTabs = new Map();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'om-watch-tab' && msg.tabId && msg.recordTabId) {
    watchedTabs.set(msg.tabId, msg.recordTabId);
  }
  if (msg.type === 'om-unwatch-tab' && msg.tabId) {
    watchedTabs.delete(msg.tabId);
  }
});

function notifyTrackingEnded(recordTabId, reason) {
  if (!recordTabId) return;
  chrome.tabs.sendMessage(recordTabId, { type: 'om-tracking-ended', reason }).catch(() => {});
}

async function reinjectTracker(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch (err) {
    // e.g. the tab navigated to a chrome://, Chrome Web Store, or other page
    // scripting can't reach even with host_permissions
    return false;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (watchedTabs.has(tabId)) {
    notifyTrackingEnded(watchedTabs.get(tabId), 'closed');
    watchedTabs.delete(tabId);
  }
});

// A full page navigation destroys the previously injected content script, so
// re-inject it as soon as the new page finishes loading instead of treating
// every navigation as the end of tracking — this is what keeps zoom/click
// data flowing across a demo that clicks through to other pages.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!watchedTabs.has(tabId)) return;
  if (changeInfo.status !== 'complete') return;

  const ok = await reinjectTracker(tabId);
  if (!ok) {
    notifyTrackingEnded(watchedTabs.get(tabId), 'navigated');
    watchedTabs.delete(tabId);
  }
});
