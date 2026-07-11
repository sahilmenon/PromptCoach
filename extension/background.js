const AI_MATCH =
  /(?:^|\.)(?:chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|perplexity\.ai|copilot\.microsoft\.com|chat\.deepseek\.com)$/i;

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "TOKENLEAN_PING" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      return true;
    } catch {
      return false;
    }
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOKENLEAN_TOGGLE" });
  } catch {
    await ensureContentScript(tab.id);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab?.url) return;
  try {
    const { hostname } = new URL(tab.url);
    if (!AI_MATCH.test(hostname)) return;
  } catch {
    return;
  }
  await ensureContentScript(tabId);
});

// Detect storage write completion to open dashboard.html
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.recentPrompts && changes.recentPrompts.newValue) {
    chrome.tabs.query({ url: chrome.runtime.getURL("dashboard.html") }, (existingTabs) => {
      if (existingTabs && existingTabs.length > 0) {
        chrome.tabs.update(existingTabs[0].id, { active: true });
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
      }
    });
  }
});

// Message broker to forward messages from popup.js to content.js if chrome.runtime.sendMessage is used
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "harvest_prompts") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          sendResponse(response);
        });
      } else {
        sendResponse({ success: false, error: "No active tab found." });
      }
    });
    return true; // Keep message channel open for async response
  }
  if (message.action === "open_dashboard") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }, (tab) => {
      if (chrome.runtime.lastError) {
        console.warn("Error creating dashboard tab:", chrome.runtime.lastError.message);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, tabId: tab.id });
      }
    });
    return true;
  }
});
