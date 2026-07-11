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
