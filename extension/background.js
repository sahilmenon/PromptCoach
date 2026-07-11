const AI_MATCH =
  /(?:^|\.)(?:chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|perplexity\.ai|copilot\.microsoft\.com|chat\.deepseek\.com)$/i;

const REVIEW_URL = "http://127.0.0.1:8787/v1/review";
const HEALTH_URL = "http://127.0.0.1:8787/v1/health";

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

async function reviewPrompt(prompt, cwd) {
  try {
    const response = await fetch(REVIEW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, cwd: cwd || "" }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok !== true || !body.review) {
      return {
        ok: false,
        error: body?.error || (response.ok ? "unavailable" : "bridge_unreachable"),
        provider: body?.provider,
        model: body?.model,
      };
    }
    return {
      ok: true,
      review: body.review,
      provider: body.provider,
      model: body.model,
    };
  } catch {
    return { ok: false, error: "bridge_unreachable" };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TOKENLEAN_REVIEW") {
    reviewPrompt(String(message.prompt || ""), String(message.cwd || ""))
      .then(sendResponse);
    return true;
  }
  if (message?.type === "TOKENLEAN_REVIEW_HEALTH") {
    fetch(HEALTH_URL)
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        sendResponse(body && body.ok ? body : { ok: false, error: "bridge_unreachable" });
      })
      .catch(() => sendResponse({ ok: false, error: "bridge_unreachable" }));
    return true;
  }
  return false;
});

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
