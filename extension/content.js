(() => {
  const existing = document.getElementById("tokenlean-floating-root");
  if (existing) {
    // Re-injection should not toggle visibility — only TOKENLEAN_TOGGLE does.
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

  const onClaude = /(?:^|\.)claude\.ai$/i.test(location.hostname);
  const onGpt = /(?:^|\.)(?:chatgpt\.com|chat\.openai\.com)$/i.test(location.hostname);

  const host = document.createElement("div");
  host.id = "tokenlean-floating-root";
  host.setAttribute("data-tokenlean", "floating-widget");
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const logoUrl = chrome.runtime.getURL("icons/tokenlean-logo.png");

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
    return (node.innerText || "").trim();
  };

  const writeEditable = (node, value) => {
    if (!node) return;
    node.focus();
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
      setter ? setter.call(node, value) : (node.value = value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    // ProseMirror (Claude) ignores innerText assignment — insertText updates its doc model.
    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, value);
    } catch {
      node.innerText = value;
      node.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    }
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
    const selectors = [
      "div.ProseMirror[contenteditable='true']",
      "div.ProseMirror",
      "[contenteditable='true'][data-testid]",
      "[contenteditable][data-placeholder]",
      "[aria-label*='Claude' i][contenteditable]",
      "[aria-label*='Write' i][contenteditable]",
      "[aria-label*='Reply' i][contenteditable]",
      "[aria-label*='Message' i][contenteditable]",
      "div[role='textbox'][contenteditable]",
      "#prompt-textarea",
      "textarea[name='prompt']",
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
        const area = rect.width * rect.height;
        if (area > bestArea) {
          best = rootEl;
          bestArea = area;
        }
      }
      if (best && (sel.includes("ProseMirror") || onClaude)) break;
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

  const analyzePromptText = (raw) => {
    const text = raw.trim();
    const words = text ? text.split(/\s+/).filter(Boolean) : [];
    const chars = text.length;
    const approxTokens = Math.max(1, Math.round(chars / 4));
    const lines = text.split(/\n/).filter((line) => line.trim());
    const hasGoal = /\b(goal|objective|i (want|need)|please)\b/i.test(text);
    const hasConstraints = /\b(must|should|do not|don't|requirements?|constraints?)\b/i.test(text);
    const hasDoneWhen = /\b(done when|acceptance|success criteria|verify)\b/i.test(text);
    const hasCodeDump = chars > 1200 || (text.match(/[{};]/g) || []).length > 20;
    const tips = [];
    if (!hasGoal) tips.push("State the goal in one clear sentence.");
    if (!hasConstraints) tips.push("Add requirements or constraints the model must follow.");
    if (!hasDoneWhen) tips.push("Define what “done” looks like so the answer stays focused.");
    if (hasCodeDump) tips.push("Large pasted code inflates tokens — point to files or paste only the relevant slice.");
    if (words.length < 8) tips.push("Add a bit more context so the model does not guess.");
    if (lines.length === 1 && words.length > 40) tips.push("Break a long single-line prompt into short labeled sections.");
    if (!tips.length) tips.push("Structure looks solid. Keep reviewing before you submit.");
    const score = Math.max(1, Math.min(10, 4 + (hasGoal ? 2 : 0) + (hasConstraints ? 2 : 0) + (hasDoneWhen ? 2 : 0) - (hasCodeDump ? 2 : 0)));
    return { words: words.length, chars, approxTokens, lines: lines.length, score, tips };
  };

  const structurePrompt = (raw) =>
    `Goal:\n${raw.trim()}\n\nRequirements:\n- Preserve existing behavior unless a change is requested.\n- Explain important code decisions in plain text.\n\nDone when:\n- The requested outcome is implemented and verified.`;

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
      .shell {
        --ink: #1a1f1c; --muted: #6b736e; --line: #e4e6e1;
        --paper: #ffffff; --wash: #f4f5f2; --accent: #1f6b4a;
        --accent-soft: #e8f3ec;
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .fab {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
        display: grid; place-items: center;
        width: 38px; height: 38px; padding: 0; border: 1px solid var(--line);
        border-radius: 10px; cursor: pointer; background: var(--paper);
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        transition: border-color .15s ease, background .15s ease, transform .15s ease;
      }
      .fab:hover { border-color: #c9cec8; background: var(--wash); transform: scale(1.05); }
      .fab:active { transform: scale(0.95); }
      .fab img { width: 24px; height: 24px; border-radius: 4px; object-fit: contain; pointer-events: none; }
      .fab.hidden { visibility: hidden; pointer-events: none; }
      
      .widget {
        position: fixed; right: 18px; bottom: 64px; z-index: 2147483647;
        display: none; flex-direction: column; overflow: hidden;
        width: min(340px, calc(100vw - 24px)); max-height: min(520px, calc(100vh - 84px));
        color: var(--ink); background: var(--paper);
        border: 1px solid var(--line); border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.12);
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
      .local { margin-left:auto; color:var(--muted); font-size:9px; letter-spacing:.08em; text-transform:uppercase; }
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
      .metrics { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
      .metric { padding:4px 8px; border-radius:6px; background:var(--accent-soft);
        color:#2d5a45; font:600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .tips { margin:8px 0 0; padding-left:16px; color:var(--muted); font-size:12px; }
      .tips li { margin:4px 0; }

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
      .tb-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

      @media (max-width: 520px) {
        .fab { right:12px; bottom:12px; }
        .widget { right:12px; bottom:64px; width:calc(100vw - 24px); max-height:calc(100vh - 84px); }
      }
    </style>
    <div class="shell" aria-label="tokenlean floating tools">
      <button class="fab" id="fab" type="button" title="Open tokenlean" aria-label="Open tokenlean" aria-expanded="false">
        <img src="${logoUrl}" alt="">
      </button>
      <section class="widget" id="widget" role="dialog" aria-label="tokenlean tools">
        <header class="top">
          <span class="mark"><img src="${logoUrl}" alt=""></span><span class="name">tokenlean</span>
          <span class="local">LOCAL ONLY</span>
          <button class="icon" id="close" type="button" title="Collapse to icon">×</button>
        </header>
        <nav class="tabs">
          <button class="tab on" data-tab="prompt" type="button">Prompt</button>
          <button class="tab" data-tab="inspect" type="button">Inspect</button>
          <button class="tab" data-tab="import" type="button">Import</button>
        </nav>
        <div class="body">
          <section class="panel on" id="prompt">
            <article class="card">
              <p class="label">IMPROVE A PROMPT</p>
              <h2>Review every change</h2>
              <p>Select text in a prompt field to see the analyze bubble. tokenlean never submits it.</p>
              <button class="action soft" id="read" type="button">Read focused prompt</button>
              <textarea id="editor" placeholder="Focus a prompt field, or write a prompt here."></textarea>
              <button class="action soft" id="analyze" type="button">Analyze prompt</button>
              <button class="action soft" id="improve" type="button">Suggest clearer structure</button>
              <button class="action" id="insert" type="button">Insert approved text</button>
              <div id="analysis" hidden></div>
              <div class="status" id="prompt-status"></div>
            </article>
          </section>
          <section class="panel" id="inspect">
            <article class="card">
              <p class="label">ACTIVE PAGE</p>
              <h2>Inspect visible context</h2>
              <p>Scrape your recent activity on Gemini to generate a comprehensive prompt efficiency report.</p>
              <button class="action" id="inspect-page" type="button">Run Deep Prompt Efficiency Audit</button>
            </article>
          </section>
          <section class="panel" id="import">
            <article class="card">
              <p class="label">LOCAL TRANSCRIPTS</p>
              <h2>Import JSONL, JSON, or text</h2>
              <p>Files are parsed locally. Raw transcript text is not uploaded.</p>
              <label class="file">Choose files<input id="files" type="file" accept=".jsonl,.json,.txt" multiple></label>
              <pre id="summary" hidden></pre>
            </article>
          </section>
        </div>
        <footer class="privacy">Temporary page access · no prompt auto-submit · no developer API</footer>
      </section>

      <div class="toolbar" id="toolbar" role="toolbar" aria-label="tokenlean selection tools" hidden>
        <span class="tb-brand" aria-hidden="true"><img src="${logoUrl}" alt=""></span>
        <button class="tb-btn primary" id="tb-analyze" type="button">Analyze</button>
        <button class="tb-btn" id="tb-structure" type="button">Structure</button>
        <button class="tb-btn" id="tb-insert" type="button">Insert</button>
      </div>
    </div>
  `;

  const fab = root.querySelector("#fab");
  const widget = root.querySelector("#widget");
  const toolbar = root.querySelector("#toolbar");
  const editor = root.querySelector("#editor");
  const promptStatus = root.querySelector("#prompt-status");
  const analysisBox = root.querySelector("#analysis");
  const inspectStatus = root.querySelector("#inspect"); // panel itself as container or add a status div

  const closeBtn = root.querySelector("#close");
  const inspectPageBtn = root.querySelector("#inspect-page");
  const readBtn = root.querySelector("#read");
  const analyzeBtn = root.querySelector("#analyze");
  const improveBtn = root.querySelector("#improve");
  const insertBtn = root.querySelector("#insert");
  const fileInput = root.querySelector("#files");

  const tabs = root.querySelectorAll(".tab");

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
      requestAnimationFrame(syncWidgetToFab);
    }
  };

  fab.onclick = () => {
    if (!fabWasDragged()) {
      setOpen(true);
    }
  };

  closeBtn.onclick = () => setOpen(false);

  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove("on"));
      root.querySelectorAll(".panel").forEach(p => p.classList.remove("on"));
      tab.classList.add("on");
      root.querySelector(`#${tab.dataset.tab}`).classList.add("on");
    };
  });

  inspectPageBtn.onclick = () => {
    inspectStatus.textContent = "Harvesting prompts from Gemini...";
    chrome.runtime.sendMessage({ action: "harvest_prompts" }, (response) => {
      if (response && response.success) {
        inspectStatus.textContent = "Success! Opening dashboard...";
        chrome.runtime.sendMessage({ action: "open_dashboard" });
      } else {
        inspectStatus.textContent = response?.error || "Failed to harvest prompts.";
      }
    });
  };

  readBtn.onclick = () => {
    const text = lastEditable ? readEditable(lastEditable) : "";
    editor.value = text;
    promptStatus.textContent = text ? "Prompt loaded from page." : "Field is empty.";
  };

  analyzeBtn.onclick = () => runAnalysis(editor.value);

  improveBtn.onclick = () => {
    const raw = editor.value.trim();
    if (!raw) {
      promptStatus.textContent = "Add or load a prompt first.";
      return;
    }
    editor.value = structurePrompt(raw);
    runAnalysis(editor.value);
    promptStatus.textContent = "Suggestion ready.";
  };

  insertBtn.onclick = () => {
    const value = editor.value;
    if (!lastEditable) {
      promptStatus.textContent = "No field to insert into.";
      return;
    }
    writeEditable(lastEditable, value);
    promptStatus.textContent = "Inserted into page.";
  };

  fileInput.onchange = (e) => {
    if (e.target.files.length > 0) {
      handleImport(Array.from(e.target.files));
    }
  };

  const showPromptTab = () => {
    root.querySelectorAll(".tab,.panel").forEach((node) => node.classList.remove("on"));
    root.querySelector('[data-tab="prompt"]').classList.add("on");
    root.querySelector("#prompt").classList.add("on");
  };

  const renderAnalysis = (result) => {
    analysisBox.hidden = false;
    analysisBox.innerHTML = `
      <p class="label">Local analysis</p>
      <div class="metrics">
        <span class="metric">Score ${result.score}/10</span>
        <span class="metric">~${result.approxTokens} tokens</span>
        <span class="metric">${result.words} words</span>
        <span class="metric">${result.lines} lines</span>
      </div>
      <ul class="tips">${result.tips.map((tip) => `<li>${tip}</li>`).join("")}</ul>
    `;
  };

  const runAnalysis = (text) => {
    const raw = text.trim();
    if (!raw) {
      analysisBox.hidden = true;
      promptStatus.textContent = "Add or load a prompt first.";
      return false;
    }
    editor.value = raw;
    renderAnalysis(analyzePromptText(raw));
    promptStatus.textContent = "Local analysis ready. Nothing was submitted.";
    return true;
  };

  const hideToolbar = () => {
    clearTimeout(hintHideTimer);
    clearTimeout(hintShowTimer);
    hintShowTimer = 0;
    selectionPending = false;
    toolbar.classList.remove("show");
    toolbar.hidden = true;
    hintTarget = null;
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
    runToolbarAction(({ field, text }) => {
      if (field) lastEditable = field;
      openPanel();
      runAnalysis(text);
    });
  };

  root.querySelector("#tb-structure").onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    runToolbarAction(({ field, text }) => {
      if (field) lastEditable = field;
      if (!text.trim()) {
        openPanel();
        promptStatus.textContent = "Select prompt text first.";
        return;
      }
      editor.value = structurePrompt(text);
      renderAnalysis(analyzePromptText(editor.value));
      openPanel();
      promptStatus.textContent = "Structure ready. Edit it, then Insert.";
    });
  };

  root.querySelector("#tb-insert").onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    runToolbarAction(({ field, text }) => {
      const target = field && document.contains(field) ? field : lastEditable;
      if (!target || !document.contains(target)) {
        openPanel();
        promptStatus.textContent = "No prompt field available to insert into.";
        return;
      }
      const value = editor.value.trim() || text;
      if (!value) {
        openPanel();
        promptStatus.textContent = "Nothing to insert yet. Analyze or Structure first.";
        return;
      }
      writeEditable(target, value);
      lastEditable = target;
      openPanel();
      editor.value = value;
      promptStatus.textContent = "Inserted into the page, but not submitted.";
    });
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
        hideToolbar();
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
    if (!toolbar.classList.contains("show") || !hintTarget) {
      if (selectionPending) onSelectionFinished();
      return;
    }
    const selected = getFieldSelection(hintTarget) || selectionSnapshot;
    if (!selected?.text) hideToolbar();
    else positionToolbar(hintTarget, selected.rect);
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TOKENLEAN_PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "TOKENLEAN_TOGGLE") {
      host.hidden = !host.hidden;
      sendResponse({ ok: true, hidden: host.hidden });
      return false;
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
  root.querySelector("#improve").onclick = () => {
    const raw = editor.value.trim();
    if (!raw) { promptStatus.textContent = "Add or load a prompt first."; return; }
    editor.value = structurePrompt(raw);
    renderAnalysis(analyzePromptText(editor.value));
    promptStatus.textContent = "Suggestion ready. Edit it before inserting.";
  };
  root.querySelector("#insert").onclick = () => {
    if (!lastEditable || !document.contains(lastEditable)) {
      promptStatus.textContent = "The original editable field is no longer available.";
      return;
    }
    writeEditable(lastEditable, editor.value);
    promptStatus.textContent = "Inserted into the page, but not submitted.";
  };

  root.querySelector("#inspect-page").onclick = () => {
    if (!location.href.includes("gemini.google.com")) {
      alert("Deep prompt auditing is currently optimized exclusively for Gemini. Please open a Gemini chat window to run this analysis.");
      return;
    }

    const selectors = {
      userPrompts: 'user-query, .query-text, .user-message, div[data-message-author="user"]',
      userPromptsFallback: 'div.query-content, div.user-query, .query-content'
    };
    
    let promptElements = Array.from(document.querySelectorAll(selectors.userPrompts));
    if (promptElements.length === 0) {
      promptElements = Array.from(document.querySelectorAll(selectors.userPromptsFallback));
    }
    
    const prompts = promptElements
      .map(el => el.innerText.replace(/\s+/g, ' ').trim())
      .filter(text => text.length > 0);
      
    if (prompts.length === 0) {
      alert("No user prompts found on the page yet. Please write a prompt to Gemini first!");
      return;
    }

    const recentPrompts = prompts.slice(-10);
    chrome.storage.local.set({ recentPrompts: recentPrompts }, () => {
      if (chrome.runtime.lastError) {
        console.error("Storage error:", chrome.runtime.lastError.message);
        return;
      }
      chrome.runtime.sendMessage({ action: "open_dashboard" });
    });
  };

  root.querySelector("#files").onchange = async (event) => {
    const files = [...event.target.files];
    let records = 0, malformed = 0, turns = 0, characters = 0;
    for (const file of files) {
      const text = await file.text();
      characters += text.length;
      const entries = file.name.endsWith(".jsonl") ? text.split(/\r?\n/).filter(Boolean) : [text];
      for (const entry of entries) {
        try {
          const value = JSON.parse(entry);
          const items = Array.isArray(value) ? value : [value];
          records += items.length;
          for (const item of items) if (item?.role || item?.message?.role) turns++;
        } catch (e) {
          if (!file.name.endsWith(".txt")) malformed++;
        }
      }
    }
    await chrome.storage.local.set({
      transcriptSummary: { files:files.length, records, malformed, turns, characters, importedAt:Date.now() },
    });
    const summary = root.querySelector("#summary");
    summary.hidden = false;
    summary.textContent = `Files: ${files.length}\nParsed records: ${records}\nDetected turns: ${turns}\nMalformed records skipped: ${malformed}\nCharacters read locally: ${characters.toLocaleString()}`;
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "TOKENLEAN_TOGGLE") {
      host.hidden = !host.hidden;
      sendResponse({ success: true, hidden: host.hidden });
    } else if (message?.action === "read_prompt") {
      const selected = findSelectedPromptField();
      const text = selected ? selected.text : (lastEditable ? readEditable(lastEditable) : "");
      sendResponse({ success: true, text: text });
    } else if (message?.action === "insert_prompt") {
      const value = message.value;
      if (lastEditable && document.contains(lastEditable)) {
        lastEditable.focus();
        if (lastEditable.isContentEditable || lastEditable.getAttribute("contenteditable") != null) {
          lastEditable.innerText = value;
          lastEditable.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
        } else {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(lastEditable), "value")?.set;
          setter ? setter.call(lastEditable, value) : (lastEditable.value = value);
          lastEditable.dispatchEvent(new Event("input", { bubbles: true }));
          lastEditable.dispatchEvent(new Event("change", { bubbles: true }));
        }
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: "No editable field focused on page." });
      }
    } else if (message?.action === "harvest_prompts") {
      const selectors = {
        userPrompts: 'user-query, .query-text, .user-message, div[data-message-author="user"]',
        userPromptsFallback: 'div.query-content, div.user-query, .query-content'
      };
      
      let promptElements = Array.from(document.querySelectorAll(selectors.userPrompts));
      if (promptElements.length === 0) {
        promptElements = Array.from(document.querySelectorAll(selectors.userPromptsFallback));
      }
      
      const prompts = promptElements
        .map(el => el.innerText.replace(/\s+/g, ' ').trim())
        .filter(text => text.length > 0);
        
      if (prompts.length === 0) {
        sendResponse({ success: false, error: "No prompts found on the page yet." });
      } else {
        const recentPrompts = prompts.slice(-10);
        chrome.storage.local.set({ recentPrompts: recentPrompts }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ success: true });
          }
        });
      }
      return true; // Keep channel open for async response
    }
  });
})();
