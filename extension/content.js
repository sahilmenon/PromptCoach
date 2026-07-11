(() => {
  const existing = document.getElementById("tokenlean-floating-root");
  if (existing) {
    // Re-injection should not toggle visibility — only TOKENLEAN_TOGGLE / PROMPTCOACH_TOGGLE does.
    return;
  }

  let lastEditable = null;
  let hintTarget = null;
  let hintHideTimer = 0;
  let hintShowTimer = 0;
  let selectionPending = false;
  let allowToolbarClick = false;
  let lastSelectionRect = null;
  let pointerSelecting = false;
  let selectionSnapshot = null;
  /** @type {"analyze"|"analyzing"|"suggest"|"done"} */
  let toolbarMode = "analyze";
  let toolbarPinned = false;
  let toolbarSuggestion = "";
  let toolbarInsertTarget = null;
  let toolbarSourceText = "";

  const onClaude = /(?:^|\.)claude\.ai$/i.test(location.hostname);
  const onGpt = /(?:^|\.)(?:chatgpt\.com|chat\.openai\.com)$/i.test(location.hostname);

  const host = document.createElement("div");
  host.id = "tokenlean-floating-root";
  host.setAttribute("data-tokenlean", "floating-widget");
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const logoUrl = chrome.runtime.getURL("icons/promptcoach-logo.png");

  // Shared analysis logic from extension/lib/promptcoach-core.js (generated from
  // src/shared/core.ts — the same functions the CLI uses). The manifest and
  // background.js both inject the lib before this file.
  const { analyzePromptText, structurePrompt, collectPrompts } = globalThis.PromptCoachCore;

  // User prompts extracted from the most recent widget import, held for Re-evaluate.
  let importedPrompts = [];

  const isEditableRoot = (node) => {
    if (!(node instanceof HTMLElement) || host.contains(node)) return false;
    if (node.matches("textarea, input[type='text'], input:not([type])")) return true;
    if (node.getAttribute("role") === "textbox") return true;
    if (node.classList?.contains("ProseMirror")) return true;
    const ce = node.getAttribute("contenteditable");
    return ce === "true" || ce === "" || ce === "plaintext-only";
  };

  const isEditable = (node) => isEditableRoot(node);

  const editableRootFrom = (node) => {
    if (!(node instanceof Node)) return null;
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== document.documentElement) {
      if (isEditableRoot(el)) return el;
      el = el.parentElement;
    }
    return null;
  };

  const readEditable = (node) => {
    if (!node) return "";
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      return String(node.value || "").trim();
    }
    return (node.innerText || node.textContent || "").trim();
  };

  const textMatchesInsert = (actual, expected) => {
    const a = String(actual || "").replace(/\s+/g, " ").trim();
    const e = String(expected || "").replace(/\s+/g, " ").trim();
    if (!e) return true;
    if (!a) return false;
    if (a === e || a.includes(e) || e.includes(a)) return true;
    const head = e.slice(0, Math.min(48, e.length));
    return head.length >= 8 && a.includes(head);
  };

  const focusComposer = (target) => {
    try { target.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch { /* ignore */ }
    try {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      target.click();
    } catch { /* ignore */ }
    try { target.focus({ preventScroll: true }); }
    catch { try { target.focus(); } catch { /* ignore */ } }
  };

  const selectComposerContents = (target) => {
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      target.select();
      return true;
    }
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    } catch {
      try { return document.execCommand("selectAll", false, null); }
      catch { return false; }
    }
  };

  const writeEditable = (node, value) => {
    if (!node || value == null) return false;
    let target = editableRootFrom(node) || node;
    if (!(target instanceof HTMLElement) || !document.contains(target)) return false;
    if (target.id !== "prompt-textarea") {
      const promptBox = target.closest?.("#prompt-textarea, [data-testid='prompt-textarea'], div.ProseMirror");
      if (promptBox instanceof HTMLElement) target = promptBox;
    }
    const text = String(value);
    focusComposer(target);
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const proto = Object.getPrototypeOf(target);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter ? setter.call(target, text) : (target.value = text);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return textMatchesInsert(target.value, text);
    }
    selectComposerContents(target);
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, text); }
    catch { inserted = false; }
    if (!inserted || !textMatchesInsert(readEditable(target), text)) {
      try {
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
        inserted = document.execCommand("insertText", false, text);
      } catch { inserted = false; }
    }
    if (!textMatchesInsert(readEditable(target), text)) {
      try {
        selectComposerContents(target);
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
      } catch { /* ignore */ }
    }
    target.dispatchEvent(new InputEvent("input", {
      bubbles: true, cancelable: true, inputType: "insertText", data: text,
    }));
    if (!textMatchesInsert(readEditable(target), text)) {
      try {
        while (target.firstChild) target.removeChild(target.firstChild);
        text.split("\n").forEach((line, index) => {
          if (index) target.appendChild(document.createElement("br"));
          target.appendChild(document.createTextNode(line));
        });
        target.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: "insertFromPaste", data: text,
        }));
      } catch { /* ignore */ }
    }
    return textMatchesInsert(readEditable(target), text);
  };

  const looksLikePromptField = (node) => {
    if (!isEditableRoot(node)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 16) return false;

    if (onClaude) return true;
    if (onGpt && (node.id === "prompt-textarea" || node.matches("[data-testid*='prompt'], [contenteditable], textarea"))) {
      return true;
    }

    const attrs = [
      node.getAttribute("aria-label"),
      node.getAttribute("placeholder"),
      node.getAttribute("data-placeholder"),
      node.getAttribute("data-testid"),
      node.getAttribute("name"),
      node.id,
      typeof node.className === "string" ? node.className : "",
    ].filter(Boolean).join(" ").toLowerCase();
    const promptHints = /prompt|message|ask|chat|composer|query|question|send a|talk to|write|reply|claude|prosemirror/i;
    if (promptHints.test(attrs)) return true;
    if (node.matches("textarea") && rect.height >= 32) return true;
    if (node.getAttribute("role") === "textbox" && rect.height >= 28) return true;
    if (node.classList.contains("ProseMirror")) return true;
    const ce = node.getAttribute("contenteditable");
    if ((ce === "true" || ce === "" || ce === "plaintext-only") && rect.height >= 28 && rect.width >= 160) {
      return true;
    }
    return false;
  };

  const findBestComposer = () => {
    const preferred = [
      "div#prompt-textarea[contenteditable='true']",
      "#prompt-textarea",
      "[data-testid='prompt-textarea']",
      "div.ProseMirror[contenteditable='true']",
    ];
    for (const sel of preferred) {
      let node;
      try { node = document.querySelector(sel); }
      catch { continue; }
      if (node instanceof HTMLElement && !host.contains(node)) {
        return editableRootFrom(node) || node;
      }
    }

    const selectors = [
      "div.ProseMirror",
      "[contenteditable='true'][data-testid]",
      "[contenteditable][data-placeholder]",
      "[aria-label*='Claude' i][contenteditable]",
      "[aria-label*='Write' i][contenteditable]",
      "[aria-label*='Reply' i][contenteditable]",
      "[aria-label*='Message' i][contenteditable]",
      "div[role='textbox'][contenteditable]",
      "textarea[name='prompt']",
      "textarea[placeholder*='Message' i]",
      "[contenteditable='true']",
      "[contenteditable='plaintext-only']",
    ];
    let best = null;
    let bestArea = 0;
    for (const sel of selectors) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); }
      catch { continue; }
      for (const node of nodes) {
        if (!(node instanceof HTMLElement) || host.contains(node)) continue;
        const rootEl = editableRootFrom(node) || node;
        if (!looksLikePromptField(rootEl)) continue;
        const rect = rootEl.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > innerHeight) continue;
        const area = rect.width * rect.height;
        // Prefer visible bottom composers over huge page contenteditables.
        const score = area + (rect.top > innerHeight * 0.45 ? 50_000 : 0);
        if (score > bestArea) {
          best = rootEl;
          bestArea = score;
        }
      }
      if (best && onClaude) break;
    }
    return best;
  };

  const selectionRectFrom = (selection, fallbackEl) => {
    try {
      if (selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        const rects = range.getClientRects();
        const rect = rects.length ? rects[0] : range.getBoundingClientRect();
        if (rect && (rect.width || rect.height)) return rect;
      }
    } catch {}
    return fallbackEl?.getBoundingClientRect?.() || null;
  };

  const localPromptStats = (raw) => {
    const analysis = analyzePromptText(raw);
    return {
      words: analysis.words,
      chars: analysis.chars,
      approxTokens: analysis.approxTokens,
      lines: analysis.lines,
    };
  };

  // When the bridge is unreachable, fall back to the shared local analyzer —
  // the same scoring the popup and CLI heuristics use — instead of showing
  // nothing.
  const localReview = (raw) => {
    const analysis = analyzePromptText(raw);
    const needsImprovement = analysis.score < 8;
    return {
      score: analysis.score,
      needsImprovement,
      category: "local",
      feedback: analysis.tips.join(" "),
      polishedPrompt: needsImprovement ? structurePrompt(raw) : null,
    };
  };

  const escapeHtml = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const requestModelReview = (prompt) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "TOKENLEAN_REVIEW", prompt, cwd: location.href },
          (response) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: "bridge_unreachable" });
              return;
            }
            resolve(response || { ok: false, error: "unavailable" });
          },
        );
      } catch {
        resolve({ ok: false, error: "bridge_unreachable" });
      }
    });

  const requestBridgeHealth = () =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "TOKENLEAN_REVIEW_HEALTH" }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: "bridge_unreachable" });
            return;
          }
          resolve(response || { ok: false, error: "unavailable" });
        });
      } catch {
        resolve({ ok: false, error: "bridge_unreachable" });
      }
    });

  document.addEventListener(
    "focusin",
    (event) => {
      const rootEl = editableRootFrom(event.target);
      if (rootEl && looksLikePromptField(rootEl)) lastEditable = rootEl;
    },
    true,
  );

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      :root, .fab, .widget, .toolbar {
        --ink: #1a1f1c; --muted: #6b736e; --line: #e4e6e1;
        --paper: #ffffff; --wash: #f4f5f2; --accent: #1f6b4a;
        --accent-soft: #e8f3ec;
      }
      .fab {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
        display: grid; place-items: center;
        width: 28px; height: 28px; padding: 0; border: 1px solid var(--line);
        border-radius: 8px; cursor: pointer; background: var(--paper);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        transition: border-color .15s ease, background .15s ease;
      }
      .fab:hover { border-color: #c9cec8; background: var(--wash); }
      .fab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .fab img { width: 18px; height: 18px; border-radius: 4px; object-fit: contain; pointer-events: none; }
      .fab.hidden { visibility: hidden; pointer-events: none; }
      .widget {
        position: fixed; right: 18px; bottom: 54px; z-index: 2147483647;
        display: none; flex-direction: column; overflow: hidden;
        width: min(340px, calc(100vw - 24px)); max-height: min(520px, calc(100vh - 72px));
        color: var(--ink); background: var(--paper);
        border: 1px solid var(--line); border-radius: 12px;
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .widget.open { display: flex; }
      .top {
        display: flex; align-items: center; gap: 8px; min-height: 44px;
        padding: 0 12px; border-bottom: 1px solid var(--line);
        background: var(--paper); cursor: move; user-select: none;
      }
      .mark { display:grid; place-items:center; width:22px; height:22px;
        overflow:hidden; border-radius:5px; }
      .mark img { display:block; width:100%; height:100%; object-fit:contain; }
      .name { font-size: 13px; font-weight: 700; }
      .runtime {
        margin-left:auto; max-width:150px; padding:3px 7px; border-radius:999px;
        color:var(--muted); background:var(--wash); border:1px solid var(--line);
        font-size:9px; letter-spacing:.02em; line-height:1.2; text-align:right;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        transition: color .35s ease, background .35s ease, border-color .35s ease, opacity .35s ease;
      }
      .runtime.ready { color:#2d5a45; background:var(--accent-soft); border-color:#cfe3d7; }
      .runtime.running {
        color:#6a4b12; background:#fff6e5; border-color:#f0dfb8;
        animation: runtime-pulse 1.2s ease-in-out infinite;
      }
      .runtime.error { color:#7a2e2e; background:#f8ecec; border-color:#e8cfcf; }
      @keyframes runtime-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: .72; }
      }
      .icon { width:26px; height:26px; border:0; border-radius:6px;
        color:var(--muted); background:transparent; cursor:pointer; font-size:16px; }
      .icon:hover { background: var(--wash); color: var(--ink); }
      .tabs { display:flex; border-bottom:1px solid var(--line); background:var(--paper); }
      .tab { flex:1; padding:9px 4px; border:0; color:var(--muted);
        background:none; cursor:pointer; font:600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .tab.on { color:var(--ink); box-shadow:inset 0 -2px var(--accent); }
      .body { overflow:auto; padding:12px; background: var(--wash); }
      .panel { display:none; }
      .panel.on { display:block; }
      .card { padding:12px; margin-bottom:0; background:var(--paper);
        border:1px solid var(--line); border-radius:10px; }
      .label { margin:0 0 6px; color:var(--accent); font-size:9px;
        letter-spacing:.12em; font-weight:700; text-transform:uppercase; }
      h2 { margin:0 0 6px; font-size:15px; line-height:1.25; font-weight:700; }
      p { margin:4px 0 8px; color:var(--muted); font-size:12px; }
      button.action, .file { display:block; width:100%; padding:9px; margin-top:7px;
        border:0; border-radius:8px; color:white; background:var(--accent);
        text-align:center; cursor:pointer; font:600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      button.soft { color:var(--ink); background:var(--wash); border:1px solid var(--line); }
      .analyze-btn {
        position: relative; overflow: hidden;
        display: block; line-height: 1.25;
        min-height: 0; height: auto;
      }
      .analyze-btn .analyze-fill {
        position: absolute; inset: 0 auto 0 0; width: 0%;
        background: var(--accent); opacity: .18; pointer-events: none;
        transition: none;
      }
      .analyze-btn .analyze-label {
        position: relative; z-index: 1;
        display: inline-block;
      }
      .analyze-btn .analyze-tick {
        position: absolute; right: 10px; top: 50%; z-index: 1;
        width: 14px; height: 14px; margin-top: -7px;
        opacity: 0; transform: scale(.8);
        transition: opacity .25s ease, transform .25s ease;
        pointer-events: none;
      }
      .analyze-btn .analyze-tick svg { display:block; width:14px; height:14px; }
      .analyze-btn.filling .analyze-fill {
        animation: analyze-fill .7s cubic-bezier(.22,1,.36,1) forwards;
      }
      .analyze-btn.success {
        color: #fff; background: var(--accent); border-color: var(--accent);
        animation: none;
      }
      .analyze-btn.success .analyze-fill { width: 100%; opacity: 0; }
      .analyze-btn.success .analyze-tick {
        opacity: 1; transform: scale(1);
      }
      @keyframes analyze-fill {
        from { width: 0%; }
        to { width: 100%; }
      }
      textarea { width:100%; min-height:110px; padding:10px; margin-top:7px;
        resize:vertical; border:1px solid var(--line); border-radius:8px;
        color:var(--ink); background:var(--paper); font:12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      pre { max-height:200px; overflow:auto; white-space:pre-wrap; margin:8px 0 0;
        padding:10px; border-radius:8px; color:#355246; background:var(--accent-soft);
        font:11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .status { min-height:16px; margin-top:7px; color:var(--muted); font-size:11px; }
      .file input { display:none; }
      .privacy { padding:8px 12px; border-top:1px solid var(--line);
        color:var(--muted); background:var(--paper); font-size:10px; text-align:center; }
      .result-graphs {
        display:flex; justify-content:center; margin: 4px 0 10px;
      }
      .score-wrap { text-align:center; }
      .score-wrap .label { margin-bottom:8px; text-align:center; }
      .score-gauge {
        position:relative; width:96px; height:96px; margin:0 auto;
      }
      .score-gauge svg { display:block; width:96px; height:96px; transform:rotate(-90deg); }
      .score-gauge .track { fill:none; stroke:#e4e6e1; stroke-width:8; }
      .score-gauge .fill {
        fill:none; stroke:var(--accent); stroke-width:8; stroke-linecap:round;
        stroke-dasharray: 251.2; stroke-dashoffset: 251.2;
        transition: stroke-dashoffset .8s cubic-bezier(.22,1,.36,1);
      }
      .score-gauge.low .fill { stroke:#b45309; }
      .score-gauge.mid .fill { stroke:#c9851a; }
      .score-gauge.high .fill { stroke:var(--accent); }
      .score-gauge .score-center {
        position:absolute; inset:0; display:grid; place-items:center;
        text-align:center; pointer-events:none;
      }
      .score-gauge .score-num {
        display:block; color:var(--ink); font:700 22px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .score-gauge .score-of {
        display:block; margin-top:2px; color:var(--muted); font-size:10px; letter-spacing:.04em;
      }
      .result-block { margin-top:10px; }
      .result-block .label { margin-bottom:4px; }
      .result-block p { margin:0; color:var(--ink); font-size:12px; line-height:1.45; }
      .suggest {
        margin-top:10px; padding:10px; border-radius:8px;
        border:1px solid var(--line); background:var(--wash);
      }
      .suggest pre {
        margin:6px 0 0; max-height:160px; padding:8px;
        border-radius:6px; color:var(--ink); background:var(--paper);
        font:11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .progress { list-style:none; margin:8px 0 0; padding:0; min-height: 28px; }
      .progress-meta .label, .progress-meta p, #analysis > .label, #analysis > p {
        transition: opacity .3s ease, transform .3s ease;
      }
      .progress li {
        position:relative; padding:8px 0 8px 26px; color:var(--muted); font-size:12px;
        opacity: 0; transform: translateY(8px);
        transition:
          opacity .35s ease,
          transform .4s cubic-bezier(.22,1,.36,1),
          color .35s ease;
      }
      .progress li.show {
        opacity: 1; transform: translateY(0);
      }
      .progress li.leaving {
        opacity: 0; transform: translateY(-6px);
      }
      .progress li::before {
        content:""; position:absolute; left:4px; top:13px; width:10px; height:10px;
        border-radius:50%; background:#d5d8d3; border:1px solid #c4c8c2;
        transition: background .35s ease, border-color .35s ease, box-shadow .35s ease, transform .35s ease;
      }
      .progress li.done { color:#2d5a45; }
      .progress li.done::before {
        background:var(--accent); border-color:var(--accent);
        transform: scale(1.05);
      }
      .progress li.on { color:var(--ink); font-weight:600; }
      .progress li.on::before {
        background:transparent; border-color:var(--accent);
        box-shadow:0 0 0 3px var(--accent-soft);
        animation: runtime-pulse 1.1s ease-in-out infinite;
      }
      .progress li.fail { color:#7a2e2e; }
      .progress li.fail::before { background:#b42318; border-color:#b42318; }
      #analysis {
        transition: opacity .35s ease, transform .35s cubic-bezier(.22,1,.36,1);
      }
      #analysis.swap {
        opacity: 0; transform: translateY(4px);
      }
      .tb-btn[disabled] { opacity:.55; cursor:wait; transition: opacity .25s ease; }
      button.action, .tb-btn { transition: background .2s ease, color .2s ease, opacity .25s ease; }

      .toolbar {
        position: fixed; z-index: 2147483646; display: inline-flex;
        align-items: stretch; padding: 0; border: 1px solid var(--line);
        border-radius: 10px; background: var(--paper); overflow: hidden;
        opacity: 0; visibility: hidden; pointer-events: none;
        transform: translateY(6px) scale(.98); transform-origin: bottom center;
        transition: opacity .18s ease, transform .2s ease, visibility 0s linear .18s;
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .toolbar.show {
        opacity: 1; visibility: visible; pointer-events: auto;
        transform: translateY(0) scale(1);
        transition: opacity .18s ease, transform .2s ease, visibility 0s;
      }
      .toolbar.below { transform-origin: top center; }
      .toolbar.below:not(.show) { transform: translateY(-6px) scale(.98); }
      .tb-brand {
        display: grid; place-items: center; width: 34px;
        border-right: 1px solid var(--line); background: var(--wash);
      }
      .tb-brand img { width: 16px; height: 16px; border-radius: 4px; object-fit: contain; }
      .tb-btn {
        appearance: none; border: 0; margin: 0; padding: 9px 12px;
        background: transparent; color: var(--ink); cursor: pointer;
        border-left: 1px solid var(--line); white-space: nowrap;
      }
      .tb-btn:first-of-type { border-left: 0; }
      .tb-btn:hover { background: var(--wash); }
      .tb-btn.primary { color: var(--accent); font-weight: 700; }
      .tb-btn.suggest {
        max-width: min(320px, 70vw);
        overflow: hidden; text-overflow: ellipsis;
        color: var(--accent); font-weight: 600; text-align: left;
      }
      .tb-btn.done { color: var(--accent); font-weight: 700; }
      .tb-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

      @media (max-width: 520px) {
        .fab { right:12px; bottom:12px; }
        .widget { right:12px; bottom:48px; width:calc(100vw - 24px); max-height:calc(100vh - 64px); }
      }
    </style>

    <div class="toolbar" id="toolbar" role="toolbar" aria-label="PromptCoach selection tools" hidden>
      <span class="tb-brand" aria-hidden="true"><img src="${logoUrl}" alt=""></span>
      <button class="tb-btn primary" id="tb-analyze" type="button">Analyze</button>
    </div>

    <button class="fab" id="fab" type="button" title="Open PromptCoach" aria-label="Open PromptCoach" aria-expanded="false">
      <img src="${logoUrl}" alt="">
    </button>
    <section class="widget" id="widget" role="dialog" aria-label="PromptCoach tools">
      <header class="top">
        <span class="mark"><img src="${logoUrl}" alt=""></span>
        <span class="name">PromptCoach</span>
        <span class="runtime" id="runtime" title="Analysis runtime">Checking bridge…</span>
        <button class="icon" id="close" type="button" title="Close">×</button>
      </header>
      <nav class="tabs">
        <button class="tab on" data-tab="prompt" type="button">Prompt</button>
        <button class="tab" data-tab="inspect" type="button">Inspect</button>
        <button class="tab" data-tab="import" type="button">Import</button>
      </nav>
      <div class="body">
        <section class="panel on" id="prompt">
          <article class="card">
            <p class="label">Prompt review</p>
            <h2>Analyze before you submit</h2>
            <p>Select prompt text to open Analyze. You get a score, advice, and a suggested rewrite when the prompt needs work.</p>
            <button class="action soft" id="read" type="button">Read focused prompt</button>
            <textarea id="editor" placeholder="Selected or focused prompt text appears here."></textarea>
            <button class="action soft analyze-btn" id="analyze" type="button">
              <span class="analyze-fill" aria-hidden="true"></span>
              <span class="analyze-label">Analyze prompt</span>
              <span class="analyze-tick" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
            </button>
            <div id="analysis" hidden></div>
            <div class="status" id="prompt-status"></div>
          </article>
        </section>
        <section class="panel" id="inspect">
          <article class="card">
            <p class="label">Active page</p>
            <h2>Inspect visible context</h2>
            <p>Scrape your recent activity on Gemini to generate a comprehensive prompt efficiency report.</p>
            <button class="action" id="inspect-page" type="button">Run Deep Prompt Efficiency Audit</button>
            <div class="status" id="inspect-status"></div>
          </article>
        </section>
        <section class="panel" id="import">
          <article class="card">
            <p class="label">Local transcripts</p>
            <h2>Import JSONL, JSON, or text</h2>
            <p>Files are parsed locally. Re-evaluate opens the audit dashboard,
              which analyzes your prompts with Gemini using your own key.</p>
            <label class="file">Choose files<input id="files" type="file" accept=".jsonl,.json,.txt" multiple></label>
            <pre id="summary" hidden></pre>
            <button class="action" id="reevaluate" type="button" disabled>Re-evaluate prompts</button>
            <div class="status" id="import-status"></div>
          </article>
        </section>
      </div>
      <footer class="privacy" id="privacy">Temporary page access · no prompt auto-submit · bridge offline</footer>
    </section>
  `;

  const fab = root.querySelector("#fab");
  const widget = root.querySelector("#widget");
  const toolbar = root.querySelector("#toolbar");
  const editor = root.querySelector("#editor");
  const promptStatus = root.querySelector("#prompt-status");
  const analysisBox = root.querySelector("#analysis");
  const runtimeEl = root.querySelector("#runtime");
  const privacyEl = root.querySelector("#privacy");
  const analyzeBtn = root.querySelector("#analyze");
  const analyzeLabel = analyzeBtn.querySelector(".analyze-label");
  const tbAnalyzeBtn = root.querySelector("#tb-analyze");

  let bridgeInfo = { provider: null, model: null, configured: false, online: false };
  let analysisBusy = false;
  let analysisToken = 0;

  const providerLabel = (provider) => {
    const key = String(provider || "").toLowerCase();
    if (key === "cursor") return "Cursor";
    if (key === "anthropic") return "Anthropic";
    if (key === "openai") return "OpenAI";
    if (key === "gemini") return "Gemini";
    return provider ? String(provider) : "API";
  };

  const modelLabel = (model, provider) => model || (
    provider === "cursor" ? "composer-2.5"
      : provider === "openai" ? "gpt model"
        : provider === "anthropic" ? "Claude"
          : provider === "gemini" ? "gemini-2.5-flash" : "model"
  );

  const readyCopy = (provider, model) =>
    `${modelLabel(model, provider)} · ${providerLabel(provider)}`;

  const setRuntimeStatus = ({ state, provider, model, detail }) => {
    const p = provider || bridgeInfo.provider;
    const m = model || bridgeInfo.model;
    runtimeEl.classList.remove("ready", "running", "error");
    if (state === "running") {
      runtimeEl.classList.add("running");
      runtimeEl.textContent = detail || "Analyzing…";
      runtimeEl.title = runtimeEl.textContent;
      privacyEl.textContent = "Temporary page access · no prompt auto-submit · analyzing";
      return;
    }
    if (state === "ready" && p) {
      runtimeEl.classList.add("ready");
      runtimeEl.textContent = detail || readyCopy(p, m);
      runtimeEl.title = `Analysis model: ${modelLabel(m, p)} provided by ${providerLabel(p)}`;
      privacyEl.textContent = `Temporary page access · no prompt auto-submit · ${modelLabel(m, p)} via ${providerLabel(p)}`;
      return;
    }
    if (state === "error") {
      runtimeEl.classList.add("error");
      runtimeEl.textContent = detail || "Bridge offline";
      runtimeEl.title = runtimeEl.textContent;
      privacyEl.textContent = "Temporary page access · no prompt auto-submit · bridge offline";
      return;
    }
    runtimeEl.textContent = detail || "Local";
    runtimeEl.title = runtimeEl.textContent;
    privacyEl.textContent = "Temporary page access · no prompt auto-submit · local only";
  };

  const truncateToolbarLabel = (text, max = 48) => {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  };

  const resetToolbarChrome = () => {
    toolbarMode = "analyze";
    toolbarPinned = false;
    toolbarSuggestion = "";
    toolbarInsertTarget = null;
    toolbarSourceText = "";
    tbAnalyzeBtn.disabled = false;
    tbAnalyzeBtn.classList.add("primary");
    tbAnalyzeBtn.classList.remove("suggest", "done");
    tbAnalyzeBtn.textContent = "Analyze";
    tbAnalyzeBtn.title = "Analyze selected prompt";
    tbAnalyzeBtn.setAttribute("aria-label", "Analyze");
  };

  const normalizeToolbarText = (text) => String(text || "").replace(/\s+/g, " ").trim();

  const isDifferentToolbarText = (text) => {
    const next = normalizeToolbarText(text);
    const prev = normalizeToolbarText(toolbarSourceText);
    if (!next) return false;
    if (!prev) return true;
    return next !== prev;
  };

  const keepToolbarVisible = (field, rect) => {
    const target = (field && document.contains(field) ? field : null)
      || (hintTarget && document.contains(hintTarget) ? hintTarget : null)
      || lastEditable
      || findBestComposer();
    const placeRect = rect || lastSelectionRect || target?.getBoundingClientRect?.();
    if (placeRect) {
      lastSelectionRect = placeRect;
      toolbar.hidden = false;
      placeNear(toolbar, placeRect, true);
      toolbar.classList.add("show");
    }
    if (target) {
      hintTarget = target;
      lastEditable = target;
    }
  };

  const applyToolbarAnalyzeChrome = () => {
    toolbarMode = "analyze";
    toolbarPinned = false;
    toolbarSuggestion = "";
    tbAnalyzeBtn.disabled = false;
    tbAnalyzeBtn.classList.add("primary");
    tbAnalyzeBtn.classList.remove("suggest", "done");
    tbAnalyzeBtn.textContent = "Analyze";
    tbAnalyzeBtn.title = "Analyze selected prompt";
    tbAnalyzeBtn.setAttribute("aria-label", "Analyze");
  };

  const showToolbarReviewResult = (review, field, sourceText = "") => {
    const polished = review?.needsImprovement
      ? String(review?.polishedPrompt || review?.polished_prompt || "").trim()
      : "";
    toolbarPinned = true;
    toolbarSourceText = normalizeToolbarText(sourceText) || toolbarSourceText;
    toolbarInsertTarget = (field && document.contains(field) ? field : null)
      || lastEditable
      || findBestComposer();
    keepToolbarVisible(toolbarInsertTarget, lastSelectionRect);
    tbAnalyzeBtn.disabled = false;
    tbAnalyzeBtn.classList.add("primary");
    if (polished) {
      toolbarMode = "suggest";
      toolbarSuggestion = polished;
      tbAnalyzeBtn.classList.remove("done");
      tbAnalyzeBtn.classList.add("suggest");
      tbAnalyzeBtn.textContent = truncateToolbarLabel(polished);
      tbAnalyzeBtn.title = `${polished}\n\nClick to insert. Select other text to analyze again.`;
      tbAnalyzeBtn.setAttribute("aria-label", "Insert suggested prompt");
    } else {
      toolbarMode = "done";
      toolbarSuggestion = "";
      tbAnalyzeBtn.classList.remove("suggest");
      tbAnalyzeBtn.classList.add("done");
      tbAnalyzeBtn.textContent = "Done";
      tbAnalyzeBtn.title = "Prompt looks good — select other text to analyze again";
      tbAnalyzeBtn.setAttribute("aria-label", "Done");
    }
  };

  const insertSuggestedPrompt = async () => {
    const text = toolbarSuggestion.trim();
    if (!text) return false;
    const target = (toolbarInsertTarget && document.contains(toolbarInsertTarget)
      ? toolbarInsertTarget
      : null) || findBestComposer() || lastEditable;
    if (!target) {
      promptStatus.textContent = "No prompt field available to insert into.";
      return false;
    }
    allowToolbarClick = true;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    focusComposer(target);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const ok = writeEditable(target, text);
    if (ok) {
      lastEditable = target;
      editor.value = text;
      promptStatus.textContent = "Suggested prompt inserted into the chat input.";
      // Keep the suggestion visible until the user selects different text.
      toolbarPinned = true;
      toolbarMode = "suggest";
      toolbarSuggestion = text;
      toolbarSourceText = normalizeToolbarText(toolbarSourceText) || normalizeToolbarText(text);
      tbAnalyzeBtn.classList.remove("done");
      tbAnalyzeBtn.classList.add("suggest", "primary");
      tbAnalyzeBtn.textContent = truncateToolbarLabel(text);
      tbAnalyzeBtn.title = `${text}\n\nInserted. Select other text to analyze again.`;
      keepToolbarVisible(target, lastSelectionRect);
      setTimeout(() => { allowToolbarClick = false; }, 500);
    } else {
      promptStatus.textContent = "Could not insert into the chat input. Click the field and try again.";
      allowToolbarClick = false;
    }
    return ok;
  };

  const resetAnalyzeButton = () => {
    analyzeBtn.classList.remove("filling", "success");
    analyzeBtn.disabled = false;
    analyzeLabel.textContent = "Analyze prompt";
    if (toolbarMode === "suggest" || toolbarMode === "done" || toolbarPinned) {
      tbAnalyzeBtn.disabled = false;
      return;
    }
    tbAnalyzeBtn.disabled = false;
    tbAnalyzeBtn.classList.add("primary");
    tbAnalyzeBtn.classList.remove("suggest", "done");
    tbAnalyzeBtn.textContent = "Analyze";
  };

  const setAnalysisBusy = (busy) => {
    analysisBusy = busy;
    if (busy) {
      analyzeBtn.classList.remove("filling", "success");
      analyzeBtn.disabled = true;
      analyzeLabel.textContent = "Analyzing…";
      if (toolbarPinned || toolbarMode === "analyzing") {
        tbAnalyzeBtn.disabled = true;
        tbAnalyzeBtn.classList.remove("suggest", "done");
        tbAnalyzeBtn.classList.add("primary");
        tbAnalyzeBtn.textContent = "Analyzing…";
        tbAnalyzeBtn.title = "Analyzing…";
      } else {
        tbAnalyzeBtn.disabled = true;
        tbAnalyzeBtn.textContent = "Analyzing…";
      }
      return;
    }
    if (!analyzeBtn.classList.contains("success")) resetAnalyzeButton();
  };

  const playAnalyzeSuccess = async (token) => {
    analyzeBtn.classList.add("filling");
    analyzeLabel.textContent = "Finishing…";
    const filled = await waitMs(720, token);
    if (!filled) {
      resetAnalyzeButton();
      return false;
    }
    analyzeBtn.classList.remove("filling");
    analyzeBtn.classList.add("success");
    analyzeLabel.textContent = "Analysis complete";
    const held = await waitMs(900, token);
    if (!held) {
      resetAnalyzeButton();
      return false;
    }
    resetAnalyzeButton();
    return true;
  };

  const ensureProgressShell = () => {
    analysisBox.hidden = false;
    let list = analysisBox.querySelector("ol.progress");
    if (!list || analysisBox.querySelector(".progress-meta")) {
      analysisBox.innerHTML = `<ol class="progress"></ol>`;
      list = analysisBox.querySelector("ol.progress");
    }
    return list;
  };

  /** Show only the current stage (single step), with a crossfade out/in. */
  const renderCurrentStage = async (step, _meta, token) => {
    const list = ensureProgressShell();
    promptStatus.textContent = "";
    const previous = [...list.children];
    for (const item of previous) {
      item.classList.add("leaving");
      item.classList.remove("show", "on", "done", "fail");
    }
    if (previous.length) {
      const faded = await waitMs(280, token);
      if (!faded) return false;
      previous.forEach((item) => item.remove());
    }

    const item = document.createElement("li");
    item.textContent = step.label;
    if (step.state) item.classList.add(step.state);
    list.appendChild(item);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        item.classList.add("show");
      });
    });
    return true;
  };

  const waitMs = (ms, token) => new Promise((resolve) => {
    if (token !== analysisToken) {
      resolve(false);
      return;
    }
    setTimeout(() => resolve(token === analysisToken), ms);
  });

  const swapAnalysisContent = async (renderFn, token) => {
    analysisBox.classList.add("swap");
    const ok = await waitMs(240, token);
    if (!ok) {
      analysisBox.classList.remove("swap");
      return false;
    }
    renderFn();
    void analysisBox.offsetWidth;
    requestAnimationFrame(() => {
      analysisBox.classList.remove("swap");
    });
    return true;
  };

  /** Advance through stages one by one — only the current stage is visible. */
  const showPipeline = async (labels, meta, token, options = {}) => {
    const pause = options.pauseMs ?? 560;
    for (let i = 0; i < labels.length; i += 1) {
      if (token !== analysisToken) return false;
      const state = options.finalState && i === labels.length - 1
        ? options.finalState
        : "on";
      if (!(await renderCurrentStage({ label: labels[i], state }, meta, token))) return false;
      if (i < labels.length - 1 || options.pauseOnLast) {
        const ok = await waitMs(pause, token);
        if (!ok) return false;
      }
    }
    return true;
  };

  const refreshBridgeInfo = async (options = {}) => {
    if (analysisBusy && !options.force) return bridgeInfo;
    const health = await requestBridgeHealth();
    if (!health?.ok) {
      bridgeInfo = { provider: null, model: null, configured: false, online: false };
      if (!analysisBusy) setRuntimeStatus({ state: "error", detail: "Bridge offline" });
      return bridgeInfo;
    }
    bridgeInfo = {
      provider: health.provider || null,
      model: health.model || null,
      configured: health.configured === true,
      online: true,
    };
    if (analysisBusy) return bridgeInfo;
    if (!bridgeInfo.configured) {
      setRuntimeStatus({ state: "error", detail: "No API key" });
    } else {
      setRuntimeStatus({
        state: "ready",
        provider: bridgeInfo.provider,
        model: bridgeInfo.model,
      });
    }
    return bridgeInfo;
  };

  const attachDrag = (handle, target) => {
    let drag = null;
    let moved = false;
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button.icon")) return;
      const rect = target.getBoundingClientRect();
      drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      moved = false;
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      const width = target.offsetWidth;
      const height = target.offsetHeight;
      const left = Math.max(8, Math.min(innerWidth - width - 8, drag.left + dx));
      const top = Math.max(8, Math.min(innerHeight - height - 8, drag.top + dy));
      target.style.left = left + "px";
      target.style.top = top + "px";
      target.style.right = "auto";
      target.style.bottom = "auto";
    });
    handle.addEventListener("pointerup", () => { drag = null; });
    return () => moved;
  };

  const fabWasDragged = attachDrag(fab, fab);
  attachDrag(root.querySelector(".top"), widget);

  const placeNear = (el, anchorRect, preferAbove = true) => {
    const width = el.offsetWidth || 280;
    const height = el.offsetHeight || 44;
    let left = anchorRect.left + anchorRect.width / 2 - width / 2;
    let top = preferAbove ? anchorRect.top - height - 10 : anchorRect.bottom + 10;
    const below = top < 8;
    if (below) top = Math.min(innerHeight - height - 8, anchorRect.bottom + 10);
    left = Math.max(8, Math.min(innerWidth - width - 8, left));
    el.classList.toggle("below", below);
    el.style.left = left + "px";
    el.style.top = top + "px";
  };

  const syncWidgetToFab = () => {
    // Keep the panel anchored above the icon without moving the icon.
    if (fab.style.left || fab.style.top) {
      const fabRect = fab.getBoundingClientRect();
      const gap = 8;
      const width = widget.offsetWidth || 340;
      const height = widget.offsetHeight || 420;
      let left = fabRect.right - width;
      let top = fabRect.top - height - gap;
      left = Math.max(8, Math.min(innerWidth - width - 8, left));
      top = Math.max(8, Math.min(innerHeight - height - 8, top));
      widget.style.left = left + "px";
      widget.style.top = top + "px";
      widget.style.right = "auto";
      widget.style.bottom = "auto";
      return;
    }
    widget.style.left = "";
    widget.style.top = "";
    widget.style.right = "";
    widget.style.bottom = "";
  };

  const setOpen = (open) => {
    widget.classList.toggle("open", open);
    fab.classList.toggle("hidden", open);
    fab.setAttribute("aria-expanded", String(open));
    if (open) {
      // Icon stays put; only the panel is shown/positioned relative to it.
      requestAnimationFrame(syncWidgetToFab);
      void refreshBridgeInfo();
    }
  };

  const showPromptTab = () => {
    root.querySelectorAll(".tab,.panel").forEach((node) => node.classList.remove("on"));
    root.querySelector('[data-tab="prompt"]').classList.add("on");
    root.querySelector("#prompt").classList.add("on");
  };

  const resolveReviewScore = (review) => {
    if (!review || typeof review !== "object") return null;
    const candidates = [
      review.score,
      review.rate,
      review.prompt_score,
      review.promptScore,
      review.rating,
    ];
    for (const candidate of candidates) {
      const n = typeof candidate === "number" ? candidate : Number(candidate);
      if (Number.isFinite(n)) return Math.min(10, Math.max(0, Math.round(n)));
    }
    // Review succeeded but score was omitted (stale bridge / model drift).
    if (review.needsImprovement === true || review.needs_improvement === true) return 4;
    if (review.needsImprovement === false || review.needs_improvement === false) return 8;
    if (review.category === "good" || review.feedback) return 8;
    return null;
  };

  const renderAnalysis = (result) => {
    analysisBox.hidden = false;
    const review = result.review;
    const score = resolveReviewScore(review);
    const polished = review?.needsImprovement
      ? String(review?.polishedPrompt || review?.polished_prompt || "").trim()
      : "";

    const circumference = 2 * Math.PI * 40;
    const scoreClamped = score == null ? 0 : Math.min(10, Math.max(0, score));
    const scoreOffset = circumference * (1 - scoreClamped / 10);
    const scoreTone = score == null ? "" : scoreClamped <= 4 ? "low" : scoreClamped <= 7 ? "mid" : "high";

    const scoreHtml = score != null
      ? `<div class="score-gauge ${scoreTone}" data-score="${scoreClamped}">
          <svg viewBox="0 0 96 96" aria-hidden="true">
            <circle class="track" cx="48" cy="48" r="40"></circle>
            <circle class="fill" cx="48" cy="48" r="40"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${circumference}"
              data-offset="${scoreOffset}"></circle>
          </svg>
          <div class="score-center">
            <span><span class="score-num">${scoreClamped}</span><span class="score-of">/ 10</span></span>
          </div>
        </div>`
      : `<div class="score-gauge">
          <svg viewBox="0 0 96 96" aria-hidden="true">
            <circle class="track" cx="48" cy="48" r="40"></circle>
          </svg>
          <div class="score-center"><span class="score-of">n/a</span></div>
        </div>`;

    const suggestHtml = polished
      ? `<div class="suggest">
          <p class="label">Suggested prompt</p>
          <pre>${escapeHtml(polished)}</pre>
        </div>`
      : "";

    analysisBox.innerHTML = `
      ${result.sourceLabel ? `<p class="label">${escapeHtml(result.sourceLabel)}</p>` : ""}
      <div class="result-graphs">
        <div class="score-wrap">
          <p class="label">Rate</p>
          ${scoreHtml}
        </div>
      </div>
      <div class="result-block">
        <p class="label">Analysis</p>
        <p>${escapeHtml(review?.feedback || result.message || "No feedback returned.")}</p>
      </div>
      ${suggestHtml}
    `;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const ring = analysisBox.querySelector(".score-gauge .fill");
        if (ring) {
          const offset = Number(ring.getAttribute("data-offset"));
          if (Number.isFinite(offset)) ring.style.strokeDashoffset = String(offset);
        }
      });
    });
  };

  const runAnalysis = async (text, options = {}) => {
    const raw = text.trim();
    if (!raw) {
      analysisBox.hidden = true;
      promptStatus.textContent = "Add or load a prompt first.";
      if (options.fromToolbar) {
        toolbarMode = "analyze";
        toolbarPinned = false;
        resetToolbarChrome();
      }
      return false;
    }
    if (analysisBusy) {
      promptStatus.textContent = "Analysis already running…";
      return false;
    }

    const token = ++analysisToken;
    editor.value = raw;
    if (options.fromToolbar) {
      toolbarMode = "analyzing";
      toolbarPinned = true;
      toolbarInsertTarget = options.field || lastEditable || findBestComposer();
      toolbarSourceText = normalizeToolbarText(options.sourceText || raw);
      keepToolbarVisible(toolbarInsertTarget, options.rect || lastSelectionRect);
    }
    setAnalysisBusy(true);

    const connectingMeta = null;
    if (!(await renderCurrentStage(
      { label: "Connecting to local bridge", state: "on" },
      connectingMeta,
      token,
    ))) return false;

    const info = await refreshBridgeInfo({ force: true });
    if (token !== analysisToken) return false;

    const provider = info.provider;
    const model = info.model;
    const meta = null;

    setRuntimeStatus({
      state: provider ? "running" : "error",
      provider,
      model,
      detail: provider ? "Analyzing…" : (info.online ? "No API key" : "Bridge offline"),
    });
    if (!provider) {
      promptStatus.textContent = info.online
        ? "No API key configured for the bridge."
        : "Start the local bridge first: promptcoach extension serve";
    }

    if (!info.online || !info.configured || !provider) {
      const hint = !info.online
        ? "Start the local bridge first: promptcoach extension serve"
        : "No API key configured. Add GEMINI_API_KEY to .env, then run: promptcoach extension serve";
      await showPipeline(
        [
          info.online ? "Connected to local bridge" : "Could not reach local bridge",
          "Provider unavailable",
        ],
        meta,
        token,
        { pauseMs: 420, finalState: "fail", pauseOnLast: true },
      );
      if (token !== analysisToken) return false;
      if (!(await swapAnalysisContent(() => {
        renderAnalysis({
          sourceLabel: "Local analysis — model review unavailable",
          subtitle: hint,
          stats: localPromptStats(raw),
          review: localReview(raw),
          message: hint,
        });
      }, token))) return false;
      promptStatus.textContent = hint;
      setAnalysisBusy(false);
      resetAnalyzeButton();
      await refreshBridgeInfo();
      if (options.fromToolbar) {
        toolbarMode = "done";
        toolbarPinned = true;
        toolbarSuggestion = "";
        keepToolbarVisible(options.field || toolbarInsertTarget, options.rect || lastSelectionRect);
        tbAnalyzeBtn.disabled = false;
        tbAnalyzeBtn.classList.remove("suggest");
        tbAnalyzeBtn.classList.add("done", "primary");
        tbAnalyzeBtn.textContent = "Done";
        tbAnalyzeBtn.title = hint;
      }
      return false;
    }

    if (!(await showPipeline(
      [
        "Connected to local bridge",
        `Sending prompt to ${modelLabel(model, provider)}`,
      ],
      meta,
      token,
      { pauseMs: 480 },
    ))) return false;

    const stats = localPromptStats(raw);
    const startedAt = Date.now();

    if (!(await renderCurrentStage(
      { label: `Waiting for review from ${providerLabel(provider)}`, state: "on" },
      meta,
      token,
    ))) return false;

    const response = await requestModelReview(raw);
    if (token !== analysisToken) return false;

    const elapsedMs = Date.now() - startedAt;
    const usedProvider = response?.provider || provider;
    const usedModel = response?.model || model;
    const seconds = Math.max(1, Math.round(elapsedMs / 1000));

    if (!response?.ok || !response.review) {
      const hint = response?.error === "not_configured"
        ? "No API key configured. Add GEMINI_API_KEY to .env, then run: promptcoach extension serve"
        : response?.error === "bridge_unreachable"
          ? "Start the local bridge first: promptcoach extension serve"
          : "Model review unavailable. Check the local bridge and API key, then try again.";
      if (!(await renderCurrentStage(
        { label: `Review failed via ${providerLabel(usedProvider)}`, state: "fail" },
        null,
        token,
      ))) return false;
      const ok = await waitMs(560, token);
      if (!ok) return false;
      if (!(await swapAnalysisContent(() => {
        renderAnalysis({
          sourceLabel: `Local analysis — failed on ${modelLabel(usedModel, usedProvider)} via ${providerLabel(usedProvider)}`,
          subtitle: hint,
          stats,
          provider: usedProvider,
          model: usedModel,
          review: localReview(raw),
          message: hint,
        });
      }, token))) return false;
      promptStatus.textContent = hint;
      setAnalysisBusy(false);
      resetAnalyzeButton();
      setRuntimeStatus({
        state: "error",
        detail: usedProvider ? `${modelLabel(usedModel, usedProvider)} · failed` : "Review failed",
      });
      if (options.fromToolbar) {
        toolbarMode = "done";
        toolbarPinned = true;
        toolbarSuggestion = "";
        keepToolbarVisible(options.field || toolbarInsertTarget, options.rect || lastSelectionRect);
        tbAnalyzeBtn.disabled = false;
        tbAnalyzeBtn.classList.remove("suggest");
        tbAnalyzeBtn.classList.add("done", "primary");
        tbAnalyzeBtn.textContent = "Done";
        tbAnalyzeBtn.title = hint;
      }
      return false;
    }

    if (!(await renderCurrentStage(
      { label: `Review received from ${providerLabel(usedProvider)} (${seconds}s)`, state: "done" },
      null,
      token,
    ))) return false;
    if (!(await waitMs(420, token))) return false;

    bridgeInfo = {
      ...bridgeInfo,
      provider: usedProvider,
      model: usedModel,
      configured: true,
      online: true,
    };

    await playAnalyzeSuccess(token);
    if (token !== analysisToken) return false;

    if (!(await swapAnalysisContent(() => {
      renderAnalysis({
        stats,
        provider: usedProvider,
        model: usedModel,
        review: response.review,
      });
    }, token))) return false;

    analysisBusy = false;
    setRuntimeStatus({
      state: "ready",
      provider: usedProvider,
      model: usedModel,
      detail: readyCopy(usedProvider, usedModel),
    });

    const score = resolveReviewScore(response.review);
    const scoreBit = score != null ? ` Score ${score}/10.` : "";
    const polished = response.review.needsImprovement
      ? String(response.review.polishedPrompt || response.review.polished_prompt || "").trim()
      : "";
    promptStatus.textContent = response.review.needsImprovement
      ? `Done on ${modelLabel(usedModel, usedProvider)} via ${providerLabel(usedProvider)}.${scoreBit}${polished ? " Suggested prompt below." : " See analysis below."}`
      : `Done on ${modelLabel(usedModel, usedProvider)} via ${providerLabel(usedProvider)}.${scoreBit} Prompt looks good.`;
    if (options.fromToolbar) {
      showToolbarReviewResult(
        response.review,
        options.field || toolbarInsertTarget,
        options.sourceText || raw,
      );
    }
    return true;
  };

  const hideToolbar = (opts = {}) => {
    if (!opts.force && (toolbarMode === "analyzing" || toolbarMode === "suggest" || toolbarMode === "done")) {
      return;
    }
    clearTimeout(hintHideTimer);
    clearTimeout(hintShowTimer);
    hintShowTimer = 0;
    selectionPending = false;
    toolbar.classList.remove("show");
    toolbar.hidden = true;
    hintTarget = null;
    resetToolbarChrome();
  };

  const switchToolbarToAnalyzeForSelection = (selected) => {
    toolbarSourceText = "";
    toolbarSuggestion = "";
    toolbarInsertTarget = selected?.field || null;
    toolbarPinned = false;
    applyToolbarAnalyzeChrome();
    if (selected?.text) {
      hintTarget = selected.field;
      lastEditable = selected.field;
      lastSelectionRect = selected.rect || lastSelectionRect;
      toolbar.hidden = false;
      placeNear(toolbar, selected.rect || selected.field.getBoundingClientRect(), true);
      toolbar.classList.add("show");
    }
  };

  const fieldFromNode = (node) => {
    const rootEl = editableRootFrom(node);
    if (rootEl && looksLikePromptField(rootEl)) return rootEl;
    return null;
  };

  const getFieldSelection = (field) => {
    if (!field || !document.contains(field)) return { text: "", rect: null };
    if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
      const start = field.selectionStart ?? 0;
      const end = field.selectionEnd ?? 0;
      if (end <= start) return { text: "", rect: null };
      return { text: field.value.slice(start, end), rect: field.getBoundingClientRect() };
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return { text: "", rect: null };
    }
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    const inside =
      (anchor && field.contains(anchor)) ||
      (focus && field.contains(focus)) ||
      field === anchor ||
      field === focus;
    if (!inside && !onClaude) return { text: "", rect: null };
    const text = selection.toString().trim();
    if (!text) return { text: "", rect: null };
    return { text, rect: selectionRectFrom(selection, field) };
  };

  const findSelectedPromptField = () => {
    const selection = window.getSelection();
    const selectedText = selection && !selection.isCollapsed ? selection.toString().trim() : "";

    if (selectedText) {
      const fromSel = fieldFromNode(selection.anchorNode) || fieldFromNode(selection.focusNode);
      if (fromSel) {
        const selected = getFieldSelection(fromSel);
        if (selected.text) return { field: fromSel, ...selected };
      }

      const composer = findBestComposer();
      if (composer) {
        const inside =
          (selection.anchorNode && composer.contains(selection.anchorNode)) ||
          (selection.focusNode && composer.contains(selection.focusNode));
        if (inside || onClaude) {
          return {
            field: composer,
            text: selectedText,
            rect: selectionRectFrom(selection, composer),
          };
        }
      }
    }

    const active = document.activeElement;
    const activeRoot = editableRootFrom(active);
    if (activeRoot && looksLikePromptField(activeRoot)) {
      const selected = getFieldSelection(activeRoot);
      if (selected.text) return { field: activeRoot, ...selected };
    }

    return null;
  };

  const captureSelectionSnapshot = () => {
    const found = findSelectedPromptField();
    if (found?.text) {
      selectionSnapshot = found;
      hintTarget = found.field;
      lastEditable = found.field;
      lastSelectionRect = found.rect;
      return found;
    }
    selectionSnapshot = null;
    return null;
  };

  const positionToolbar = (field, selectionRect) => {
    if (allowToolbarClick) return;
    const rect = selectionRect || field.getBoundingClientRect();
    lastSelectionRect = rect;
    toolbar.hidden = false;
    placeNear(toolbar, rect, true);
  };

  const revealToolbar = (selected) => {
    if (allowToolbarClick) return;
    hintTarget = selected.field;
    lastEditable = selected.field;
    positionToolbar(selected.field, selected.rect);
    toolbar.classList.add("show");
  };

  const cancelPendingToolbar = () => {
    clearTimeout(hintShowTimer);
    hintShowTimer = 0;
  };

  const scheduleToolbarAfterIdle = () => {
    if (host.hidden || allowToolbarClick) return;
    cancelPendingToolbar();
    const selected = captureSelectionSnapshot() || selectionSnapshot;

    // Keep Done / suggested prompt until the user selects different text.
    if (toolbarMode === "suggest" || toolbarMode === "done" || toolbarMode === "analyzing") {
      if (!selected?.text) {
        keepToolbarVisible(toolbarInsertTarget, lastSelectionRect);
        return;
      }
      if (toolbarMode !== "analyzing" && isDifferentToolbarText(selected.text)) {
        switchToolbarToAnalyzeForSelection(selected);
        return;
      }
      keepToolbarVisible(selected.field, selected.rect);
      return;
    }

    if (!selected?.text) {
      selectionPending = false;
      if (toolbar.classList.contains("show")) hideToolbar();
      return;
    }
    selectionPending = true;
    hintTarget = selected.field;
    lastEditable = selected.field;
    lastSelectionRect = selected.rect;
    if (toolbar.classList.contains("show")) {
      positionToolbar(selected.field, selected.rect);
      return;
    }
    hintShowTimer = setTimeout(() => {
      hintShowTimer = 0;
      selectionPending = false;
      if (allowToolbarClick) return;
      const again = captureSelectionSnapshot() || selectionSnapshot;
      if (!again?.text) {
        hideToolbar();
        return;
      }
      if (toolbarMode === "suggest" || toolbarMode === "done" || toolbarMode === "analyzing") {
        if (toolbarMode !== "analyzing" && isDifferentToolbarText(again.text)) {
          switchToolbarToAnalyzeForSelection(again);
        } else {
          keepToolbarVisible(again.field, again.rect);
        }
        return;
      }
      revealToolbar(again);
    }, 350);
  };

  const onSelectionFinished = () => {
    if (allowToolbarClick) return;
    clearTimeout(hintHideTimer);
    hintHideTimer = setTimeout(scheduleToolbarAfterIdle, 30);
  };

  const onUserActivity = () => {
    // While dragging to select, keep delaying. After release, mouse moves must NOT cancel.
    if (allowToolbarClick || !pointerSelecting) return;
    if (!toolbar.classList.contains("show")) cancelPendingToolbar();
    clearTimeout(hintHideTimer);
    hintHideTimer = setTimeout(scheduleToolbarAfterIdle, 40);
  };

  const selectedOrFocusedText = () => {
    const snap = selectionSnapshot;
    const field = (hintTarget && document.contains(hintTarget) ? hintTarget : null)
      || snap?.field
      || lastEditable;
    const live = field ? getFieldSelection(field) : { text: "" };
    return {
      field,
      text: live.text || snap?.text || readEditable(field),
      rect: live.rect || snap?.rect || lastSelectionRect,
    };
  };

  const openPanel = () => {
    host.hidden = false;
    showPromptTab();
    setOpen(true);
  };

  fab.addEventListener("click", () => {
    if (!fabWasDragged()) setOpen(true);
  });
  root.querySelector("#close").onclick = () => setOpen(false);

  toolbar.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    allowToolbarClick = true;
    cancelPendingToolbar();
    clearTimeout(hintHideTimer);
  });

  const runToolbarAction = (action) => {
    allowToolbarClick = true;
    cancelPendingToolbar();
    clearTimeout(hintHideTimer);
    const snapshot = selectedOrFocusedText();
    hideToolbar();
    action(snapshot);
    // Keep frozen briefly so selectionchange from the click cannot reposition UI.
    setTimeout(() => { allowToolbarClick = false; }, 500);
  };

  root.querySelector("#tb-analyze").onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    allowToolbarClick = true;
    cancelPendingToolbar();
    clearTimeout(hintHideTimer);

    if (toolbarMode === "suggest") {
      void insertSuggestedPrompt();
      return;
    }
    if (toolbarMode === "done") {
      // Keep Done visible until the user selects different text.
      setTimeout(() => { allowToolbarClick = false; }, 400);
      return;
    }
    if (toolbarMode === "analyzing" || analysisBusy) {
      setTimeout(() => { allowToolbarClick = false; }, 400);
      return;
    }

    const snapshot = selectedOrFocusedText();
    if (snapshot.field) lastEditable = snapshot.field;
    if (!snapshot.text.trim()) {
      promptStatus.textContent = "Select prompt text first.";
      openPanel();
      hideToolbar({ force: true });
      setTimeout(() => { allowToolbarClick = false; }, 400);
      return;
    }

    toolbarMode = "analyzing";
    toolbarPinned = true;
    toolbarSuggestion = "";
    toolbarInsertTarget = snapshot.field;
    toolbarSourceText = normalizeToolbarText(snapshot.text);
    keepToolbarVisible(snapshot.field, snapshot.rect);
    tbAnalyzeBtn.disabled = true;
    tbAnalyzeBtn.classList.remove("suggest", "done");
    tbAnalyzeBtn.classList.add("primary");
    tbAnalyzeBtn.textContent = "Analyzing…";
    void runAnalysis(snapshot.text, {
      fromToolbar: true,
      field: snapshot.field,
      rect: snapshot.rect,
      sourceText: snapshot.text,
    });
    setTimeout(() => { allowToolbarClick = false; }, 500);
  };

  document.addEventListener("selectionchange", () => {
    if (pointerSelecting) onUserActivity();
    else onSelectionFinished();
  });
  document.addEventListener("pointermove", onUserActivity, true);
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        hideToolbar({ force: true });
        setOpen(false);
        return;
      }
      if (event.key === "Shift" || event.shiftKey || event.metaKey || event.ctrlKey) {
        onUserActivity();
      }
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      const path = event.composedPath?.() || [];
      if (path.includes(toolbar) || path.includes(widget) || path.includes(fab)) return;
      pointerSelecting = true;
      selectionSnapshot = null;
      onUserActivity();
    },
    true,
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      if (event.button !== 0) return;
      pointerSelecting = false;
      captureSelectionSnapshot();
      onSelectionFinished();
    },
    true,
  );

  document.addEventListener("scroll", () => {
    if (allowToolbarClick) return;
    if (toolbarMode === "suggest" || toolbarMode === "done" || toolbarMode === "analyzing") {
      keepToolbarVisible(toolbarInsertTarget || hintTarget, lastSelectionRect);
      return;
    }
    if (!toolbar.classList.contains("show") || !hintTarget) {
      if (selectionPending) onSelectionFinished();
      return;
    }
    const selected = getFieldSelection(hintTarget) || selectionSnapshot;
    if (!selected?.text) hideToolbar();
    else positionToolbar(hintTarget, selected.rect);
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TOKENLEAN_PING" || message?.type === "PROMPTCOACH_PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "TOKENLEAN_TOGGLE" || message?.type === "PROMPTCOACH_TOGGLE") {
      host.hidden = !host.hidden;
      sendResponse({ ok: true, hidden: host.hidden, success: true });
      return false;
    }
    if (message?.action === "read_prompt") {
      const selected = findSelectedPromptField();
      const text = selected ? selected.text : (lastEditable ? readEditable(lastEditable) : "");
      sendResponse({ success: true, text });
      return false;
    }
    if (message?.action === "insert_prompt") {
      const value = String(message.value || "");
      const target = (lastEditable && document.contains(lastEditable) ? lastEditable : null)
        || findBestComposer();
      if (!target) {
        sendResponse({ success: false, error: "No editable field focused on page." });
        return false;
      }
      const ok = writeEditable(target, value);
      if (ok) lastEditable = target;
      sendResponse({ success: ok });
      return false;
    }
    if (message?.action === "harvest_prompts") {
      const selectors = {
        userPrompts: 'user-query, .query-text, .user-message, div[data-message-author="user"]',
        userPromptsFallback: 'div.query-content, div.user-query, .query-content',
      };
      let promptElements = Array.from(document.querySelectorAll(selectors.userPrompts));
      if (promptElements.length === 0) {
        promptElements = Array.from(document.querySelectorAll(selectors.userPromptsFallback));
      }
      const prompts = promptElements
        .map((el) => el.innerText.replace(/\s+/g, " ").trim())
        .filter((text) => text.length > 0);
      if (prompts.length === 0) {
        sendResponse({ success: false, error: "No prompts found on the page yet." });
        return false;
      }
      chrome.storage.local.set({ recentPrompts: prompts.slice(-10) }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true });
        }
      });
      return true;
    }
    return false;
  });

  root.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.onclick = () => {
      root.querySelectorAll(".tab,.panel").forEach((node) => node.classList.remove("on"));
      tab.classList.add("on");
      root.querySelector("#" + tab.dataset.tab).classList.add("on");
    };
  });

  root.querySelector("#read").onclick = () => {
    if (!lastEditable || !document.contains(lastEditable)) {
      promptStatus.textContent = "Focus an editable field on the page first.";
      return;
    }
    editor.value = readEditable(lastEditable);
    promptStatus.textContent = editor.value ? "Prompt loaded for review." : "The focused field is empty.";
  };
  root.querySelector("#analyze").onclick = () => {
    runAnalysis(editor.value || readEditable(lastEditable));
  };

  root.querySelector("#inspect-page").onclick = () => {
    const inspectStatus = root.querySelector("#inspect-status");
    if (!location.href.includes("gemini.google.com")) {
      if (inspectStatus) {
        inspectStatus.textContent = "Deep prompt auditing is currently optimized for Gemini. Open a Gemini chat to run this analysis.";
      }
      return;
    }
    if (inspectStatus) inspectStatus.textContent = "Harvesting prompts from Gemini…";
    const selectors = {
      userPrompts: 'user-query, .query-text, .user-message, div[data-message-author="user"]',
      userPromptsFallback: 'div.query-content, div.user-query, .query-content',
    };
    let promptElements = Array.from(document.querySelectorAll(selectors.userPrompts));
    if (promptElements.length === 0) {
      promptElements = Array.from(document.querySelectorAll(selectors.userPromptsFallback));
    }
    const prompts = promptElements
      .map((el) => el.innerText.replace(/\s+/g, " ").trim())
      .filter((text) => text.length > 0);
    if (prompts.length === 0) {
      if (inspectStatus) inspectStatus.textContent = "No user prompts found on the page yet.";
      return;
    }
    const recentPrompts = prompts.slice(-10);
    // Storing recentPrompts triggers the background storage listener, which
    // opens the dashboard — the single open path shared with popup Import.
    chrome.storage.local.set({ recentPrompts }, () => {
      if (chrome.runtime.lastError) {
        if (inspectStatus) inspectStatus.textContent = chrome.runtime.lastError.message;
        return;
      }
      if (inspectStatus) inspectStatus.textContent = "Opening dashboard…";
    });
  };

  root.querySelector("#files").onchange = async (event) => {
    const importStatus = root.querySelector("#import-status");
    const reevaluateBtn = root.querySelector("#reevaluate");
    const files = [...event.target.files];
    let records = 0, malformed = 0, turns = 0, characters = 0;
    const prompts = [];
    for (const file of files) {
      const text = await file.text();
      characters += text.length;
      const isJsonl = file.name.endsWith(".jsonl");
      const isTxt = file.name.endsWith(".txt");
      const entries = isJsonl ? text.split(/\r?\n/).filter(Boolean) : [text];
      for (const entry of entries) {
        try {
          const value = JSON.parse(entry);
          records += Array.isArray(value) ? value.length : 1;
          const collected = collectPrompts(value);
          prompts.push(...collected.prompts);
          turns += collected.turns;
        } catch {
          if (isTxt) prompts.push(text.trim());
          else malformed++;
        }
      }
    }
    importedPrompts = prompts;
    await chrome.storage.local.set({
      transcriptSummary: { files: files.length, records, malformed, turns, characters, importedAt: Date.now() },
    });
    const summary = root.querySelector("#summary");
    summary.hidden = false;
    summary.textContent = `Files: ${files.length}\nParsed records: ${records}\nDetected turns: ${turns}\nUser prompts found: ${prompts.length}\nMalformed records skipped: ${malformed}\nCharacters read locally: ${characters.toLocaleString()}`;
    reevaluateBtn.disabled = prompts.length === 0;
    importStatus.textContent = prompts.length
      ? `${prompts.length} prompt(s) ready. Click Re-evaluate to open the audit.`
      : "No user prompts found in these files.";
  };

  // Re-evaluate: publish the imported prompts as recentPrompts; the background
  // storage listener opens the audit dashboard — same pipeline as Inspect.
  root.querySelector("#reevaluate").onclick = async () => {
    const importStatus = root.querySelector("#import-status");
    if (!importedPrompts.length) {
      importStatus.textContent = "Import a transcript with user prompts first.";
      return;
    }
    importStatus.textContent = "Opening audit dashboard…";
    await chrome.storage.local.set({ recentPrompts: importedPrompts });
  };

  void refreshBridgeInfo();
})();
