const AI_MATCH =
  /(?:^|\.)(?:chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|perplexity\.ai|copilot\.microsoft\.com|chat\.deepseek\.com)$/i;

const REVIEW_URL = "http://127.0.0.1:8787/v1/review";
const HEALTH_URL = "http://127.0.0.1:8787/v1/health";

// The shared core must load before content.js (it defines PromptCoachCore).
// Keep in sync with manifest.json content_scripts.
const CONTENT_SCRIPTS = ["lib/promptcoach-core.js", "content.js"];

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PROMPTCOACH_PING" });
    return true;
  } catch {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "TOKENLEAN_PING" });
      return true;
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: CONTENT_SCRIPTS,
        });
        return true;
      } catch {
        return false;
      }
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
    await chrome.tabs.sendMessage(tab.id, { type: "PROMPTCOACH_TOGGLE" });
  } catch {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "TOKENLEAN_TOGGLE" });
    } catch {
      await ensureContentScript(tab.id);
    }
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

// Single path for opening the audit dashboard: every producer (widget
// Inspect, popup Inspect, popup/widget Import re-evaluate) writes
// recentPrompts together with a fresh recentPromptsAt timestamp, and this
// listener reacts to the timestamp. Nothing opens dashboard.html directly, so
// the dashboard can never double-open.
//
// We watch recentPromptsAt (not recentPrompts) on purpose: chrome.storage's
// onChanged does NOT fire when a key is written with the value it already has,
// so re-harvesting the same chat or re-importing the same file would leave
// recentPrompts unchanged and never open the dashboard. recentPromptsAt is a
// new timestamp on every request, so the event always fires. It also keeps
// dashboard.js's internal recentPrompts writes (mock fallback) from reopening.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.recentPromptsAt && changes.recentPromptsAt.newValue) {
    const url = chrome.runtime.getURL("dashboard.html");
    chrome.tabs.query({ url }, (existingTabs) => {
      if (existingTabs && existingTabs.length > 0) {
        // Reload so an already-open dashboard re-reads the new prompts.
        chrome.tabs.update(existingTabs[0].id, { active: true });
        chrome.tabs.reload(existingTabs[0].id);
      } else {
        chrome.tabs.create({ url });
      }
    });
  }
});
