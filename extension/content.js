(() => {
  const existing = document.getElementById("tokenlean-floating-root");
  if (existing) {
    existing.hidden = !existing.hidden;
    return;
  }

  let lastEditable = null;
  let hintTarget = null;
  let hintHideTimer = 0;

  const host = document.createElement("div");
  host.id = "tokenlean-floating-root";
  host.setAttribute("data-tokenlean", "floating-widget");
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const logoUrl = chrome.runtime.getURL("icons/tokenlean-logo.png");

  const isEditable = (node) => {
    if (!(node instanceof HTMLElement) || host.contains(node)) return false;
    if (node.matches("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [contenteditable=''], [role='textbox']")) {
      return true;
    }
    return node.isContentEditable;
  };

  const readEditable = (node) => {
    if (!node) return "";
    if (node.isContentEditable || node.getAttribute?.("contenteditable") != null) {
      return (node.innerText || "").trim();
    }
    return String(node.value || "").trim();
  };

  const looksLikePromptField = (node) => {
    if (!isEditable(node)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 28) return false;
    const attrs = [
      node.getAttribute("aria-label"),
      node.getAttribute("placeholder"),
      node.getAttribute("data-placeholder"),
      node.getAttribute("name"),
      node.id,
      node.className,
    ].filter(Boolean).join(" ").toLowerCase();
    const promptHints = /prompt|message|ask|chat|composer|query|question|send a|talk to|write|input/i;
    if (promptHints.test(attrs)) return true;
    if (node.matches("textarea") && rect.height >= 40) return true;
    if ((node.isContentEditable || node.getAttribute("role") === "textbox") && rect.height >= 36) return true;
    return false;
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

  document.addEventListener(
    "focusin",
    (event) => {
      if (isEditable(event.target)) lastEditable = event.target;
    },
    true,
  );

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .shell {
        --ink: #14251f; --green: #173f32; --acid: #c8f15a;
        --paper: #f5f3ec; --line: #d7d8cf; --muted: #65726c;
        position: fixed; right: 22px; bottom: 22px; z-index: 2147483647;
        font: 13px/1.45 Arial, sans-serif;
      }
      .fab {
        display: grid; place-items: center;
        width: 56px; height: 56px; padding: 0; border: 0;
        border-radius: 50%; cursor: pointer;
        background: var(--green);
        box-shadow: 0 10px 28px rgba(14,31,24,.32), 0 0 0 3px rgba(200,241,90,.35);
        transition: transform .18s ease, box-shadow .18s ease;
      }
      .fab:hover { transform: scale(1.06); box-shadow: 0 14px 34px rgba(14,31,24,.38), 0 0 0 3px rgba(200,241,90,.5); }
      .fab:focus-visible { outline: 2px solid var(--acid); outline-offset: 3px; }
      .fab img { width: 34px; height: 34px; border-radius: 9px; background: white; object-fit: contain; pointer-events: none; }
      .shell.open .fab { display: none; }
      .widget {
        display: none; flex-direction: column; overflow: hidden;
        width: min(370px, calc(100vw - 28px)); max-height: min(680px, calc(100vh - 28px));
        color: var(--ink); background: var(--paper);
        border: 1px solid rgba(20,37,31,.16); border-radius: 18px;
        box-shadow: 0 22px 70px rgba(14,31,24,.28);
      }
      .shell.open .widget { display: flex; }
      .top {
        display: flex; align-items: center; gap: 9px; min-height: 58px;
        padding: 0 14px; color: white; background: var(--green); cursor: move;
        user-select: none;
      }
      .mark { display:grid; place-items:center; width:34px; height:34px;
        overflow:hidden; border-radius:10px; background:white; }
      .mark img { display:block; width:100%; height:100%; object-fit:contain; }
      .name { font-size: 16px; font-weight: 800; }
      .local { margin-left:auto; color:#bad0c6; font-size:9px; letter-spacing:.12em; }
      .icon { width:30px; height:30px; border:0; border-radius:50%;
        color:white; background:rgba(255,255,255,.1); cursor:pointer; font-size:18px; }
      .tabs { display:flex; border-bottom:1px solid var(--line); background:white; }
      .tab { flex:1; padding:11px 4px; border:0; color:var(--muted);
        background:none; cursor:pointer; font:700 10px Arial; }
      .tab.on { color:var(--ink); box-shadow:inset 0 -2px #e56f3b; }
      .body { overflow:auto; padding:12px; }
      .panel { display:none; }
      .panel.on { display:block; }
      .card { padding:14px; margin-bottom:10px; background:white;
        border:1px solid #e2e3db; border-radius:11px; }
      .label { margin:0 0 7px; color:#d45e31; font-size:9px;
        letter-spacing:.14em; font-weight:800; }
      h2 { margin:0 0 7px; font-size:16px; line-height:1.2; }
      p { margin:6px 0 10px; color:var(--muted); font-size:11px; }
      button.action, .file { display:block; width:100%; padding:10px; margin-top:8px;
        border:0; border-radius:7px; color:white; background:var(--green);
        text-align:center; cursor:pointer; font:700 11px Arial; }
      button.soft { color:var(--ink); background:#e4e9e3; }
      textarea { width:100%; min-height:118px; padding:10px; margin-top:8px;
        resize:vertical; border:1px solid var(--line); border-radius:7px;
        color:var(--ink); background:#fbfbf7; font:11px/1.5 Arial; }
      pre { max-height:220px; overflow:auto; white-space:pre-wrap; margin:9px 0 0;
        padding:10px; border-radius:7px; color:#315044; background:#edf0ea;
        font:10px/1.5 Arial; }
      .status { min-height:16px; margin-top:7px; color:var(--muted); font-size:10px; }
      .file input { display:none; }
      .privacy { padding:9px 13px; border-top:1px solid var(--line);
        color:var(--muted); background:white; font-size:9px; text-align:center; }
      .metrics { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
      .metric { padding:5px 8px; border-radius:999px; background:#edf0ea;
        color:#315044; font:700 10px Arial; }
      .tips { margin:8px 0 0; padding-left:16px; color:var(--muted); font-size:11px; }
      .tips li { margin:4px 0; }
      .hint {
        --ink: #14251f; --green: #173f32; --acid: #c8f15a; --paper: #f7f5ef;
        position: fixed; z-index: 2147483646; display: inline-flex; flex-direction: column;
        align-items: center; gap: 0; padding: 0; border: 0; background: transparent;
        cursor: pointer; opacity: 0; visibility: hidden; pointer-events: none;
        transform: translateY(18px) scale(.94); transform-origin: bottom center;
        transition: opacity .24s ease, transform .32s cubic-bezier(.2,.9,.2,1), visibility 0s linear .24s;
      }
      .hint.show {
        opacity: 1; visibility: visible; pointer-events: auto;
        transform: translateY(0) scale(1);
        transition: opacity .24s ease, transform .32s cubic-bezier(.2,.9,.2,1), visibility 0s;
      }
      .hint-float {
        display: inline-flex; flex-direction: column; align-items: center;
        filter: drop-shadow(0 12px 24px rgba(14,31,24,.2));
      }
      .hint.show .hint-float { animation: hint-bob 2.6s ease-in-out .3s infinite; }
      .hint-bubble {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 10px 14px 10px 10px; border-radius: 20px;
        color: var(--ink); background: var(--paper);
        border: 1px solid rgba(23,63,50,.14);
        font: 700 12px/1.1 Arial, sans-serif; white-space: nowrap;
      }
      .hint-bubble strong { color: var(--green); font-weight: 800; }
      .hint-bubble em {
        color: #5f6d66; font-style: normal; font-weight: 600; font-size: 11px;
      }
      .hint img {
        width: 22px; height: 22px; border-radius: 7px; background: white;
        object-fit: contain; box-shadow: inset 0 0 0 1px rgba(23,63,50,.08);
      }
      .hint-tail {
        width: 16px; height: 11px; margin-top: -1px;
        background: var(--paper);
        clip-path: polygon(0 0, 100% 0, 50% 100%);
      }
      .hint.below { transform-origin: top center; }
      .hint.below:not(.show) { transform: translateY(-18px) scale(.94); }
      .hint.below .hint-float { flex-direction: column-reverse; }
      .hint.below .hint-tail {
        margin-top: 0; margin-bottom: -1px;
        clip-path: polygon(50% 0, 0 100%, 100% 100%);
      }
      .hint:hover .hint-bubble {
        background: #fffef9;
        box-shadow: inset 0 0 0 1px rgba(200,241,90,.55);
      }
      .hint:focus-visible { outline: none; }
      .hint:focus-visible .hint-bubble { outline: 2px solid var(--acid); outline-offset: 2px; }
      @keyframes hint-bob {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-7px); }
      }
      @media (max-width: 520px) {
        .shell { right:14px; bottom:14px; }
        .widget { width:calc(100vw - 28px); max-height:calc(100vh - 28px); }
      }
    </style>
    <button class="hint" id="hint" type="button" aria-label="Analyze with tokenlean">
      <span class="hint-float">
        <span class="hint-bubble">
          <img src="${logoUrl}" alt="">
          <em><strong>Analyze</strong> with tokenlean</em>
        </span>
        <span class="hint-tail" aria-hidden="true"></span>
      </span>
    </button>
    <div class="shell" aria-label="tokenlean floating tools">
      <button class="fab" id="fab" type="button" title="Open tokenlean" aria-label="Open tokenlean" aria-expanded="false">
        <img src="${logoUrl}" alt="">
      </button>
      <section class="widget" role="dialog" aria-label="tokenlean tools">
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
              <p>Reads a bounded sample only after you click.</p>
              <button class="action" id="inspect-page" type="button">Inspect this page</button>
              <pre id="inspection" hidden></pre>
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
    </div>
  `;

  const shell = root.querySelector(".shell");
  const fab = root.querySelector("#fab");
  const hint = root.querySelector("#hint");
  const editor = root.querySelector("#editor");
  const promptStatus = root.querySelector("#prompt-status");
  const analysisBox = root.querySelector("#analysis");

  const attachDrag = (handle, surface) => {
    let drag = null;
    let moved = false;
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button.icon")) return;
      const rect = shell.getBoundingClientRect();
      drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      moved = false;
      surface.setPointerCapture(event.pointerId);
    });
    surface.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      const width = shell.offsetWidth;
      const height = shell.offsetHeight;
      const left = Math.max(8, Math.min(innerWidth - width - 8, drag.left + dx));
      const top = Math.max(8, Math.min(innerHeight - height - 8, drag.top + dy));
      shell.style.left = left + "px";
      shell.style.top = top + "px";
      shell.style.right = "auto";
      shell.style.bottom = "auto";
    });
    surface.addEventListener("pointerup", () => { drag = null; });
    return () => moved;
  };

  const fabWasDragged = attachDrag(fab, fab);
  attachDrag(root.querySelector(".top"), root.querySelector(".top"));

  const clampShell = () => {
    const rect = shell.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - rect.width - 8, rect.left));
    const top = Math.max(8, Math.min(innerHeight - rect.height - 8, rect.top));
    if (shell.style.left || shell.style.top) {
      shell.style.left = left + "px";
      shell.style.top = top + "px";
      shell.style.right = "auto";
      shell.style.bottom = "auto";
    }
  };

  const setOpen = (open) => {
    shell.classList.toggle("open", open);
    fab.setAttribute("aria-expanded", String(open));
    if (open) requestAnimationFrame(clampShell);
  };

  const showPromptTab = () => {
    root.querySelectorAll(".tab,.panel").forEach((node) => node.classList.remove("on"));
    root.querySelector('[data-tab="prompt"]').classList.add("on");
    root.querySelector("#prompt").classList.add("on");
  };

  const renderAnalysis = (result) => {
    analysisBox.hidden = false;
    analysisBox.innerHTML = `
      <p class="label">LOCAL ANALYSIS</p>
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

  const hideHint = () => {
    clearTimeout(hintHideTimer);
    hint.classList.remove("show");
    hintTarget = null;
  };

  const fieldFromNode = (node) => {
    if (!(node instanceof Node)) return null;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return null;
    if (isEditable(el) && looksLikePromptField(el)) return el;
    const closest = el.closest?.("textarea, input, [contenteditable], [role='textbox']");
    if (closest && isEditable(closest) && looksLikePromptField(closest)) return closest;
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
    const range = selection.getRangeAt(0);
    const anchorField = fieldFromNode(selection.anchorNode);
    const focusField = fieldFromNode(selection.focusNode);
    if (anchorField !== field && focusField !== field) return { text: "", rect: null };
    if (!field.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== field) {
      return { text: "", rect: null };
    }
    const text = selection.toString().trim();
    if (!text) return { text: "", rect: null };
    const rects = range.getClientRects();
    const rect = rects.length ? rects[0] : range.getBoundingClientRect();
    return { text, rect: rect.width || rect.height ? rect : field.getBoundingClientRect() };
  };

  const findSelectedPromptField = () => {
    const active = document.activeElement;
    if (active && isEditable(active) && looksLikePromptField(active)) {
      const selected = getFieldSelection(active);
      if (selected.text) return { field: active, ...selected };
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode) return null;
    const field = fieldFromNode(selection.anchorNode) || fieldFromNode(selection.focusNode);
    if (!field) return null;
    const selected = getFieldSelection(field);
    if (!selected.text) return null;
    return { field, ...selected };
  };

  const positionHint = (field, selectionRect) => {
    const rect = selectionRect || field.getBoundingClientRect();
    const bubbleWidth = hint.offsetWidth || 190;
    const bubbleHeight = hint.offsetHeight || 56;
    let left = rect.left + rect.width / 2 - bubbleWidth / 2;
    let top = rect.top - bubbleHeight - 10;
    const below = top < 8;
    if (below) top = Math.min(innerHeight - bubbleHeight - 8, rect.bottom + 10);
    left = Math.max(8, Math.min(innerWidth - bubbleWidth - 8, left));
    hint.classList.toggle("below", below);
    hint.style.left = left + "px";
    hint.style.top = top + "px";
  };

  let allowBubbleClick = false;

  const syncHintToSelection = () => {
    if (host.hidden || allowBubbleClick) return;
    const selected = findSelectedPromptField();
    if (!selected) {
      hideHint();
      return;
    }
    hintTarget = selected.field;
    lastEditable = selected.field;
    positionHint(selected.field, selected.rect);
    requestAnimationFrame(() => {
      const again = findSelectedPromptField();
      if (!again || again.field !== selected.field) {
        hideHint();
        return;
      }
      positionHint(again.field, again.rect);
      hint.classList.add("show");
    });
  };

  fab.addEventListener("click", () => {
    if (!fabWasDragged()) setOpen(true);
  });
  root.querySelector("#close").onclick = () => setOpen(false);

  hint.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    allowBubbleClick = true;
    clearTimeout(hintHideTimer);
    setTimeout(() => { allowBubbleClick = false; }, 400);
  });
  hint.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const field = hintTarget && document.contains(hintTarget) ? hintTarget : lastEditable;
    const selected = field ? getFieldSelection(field) : { text: "" };
    const text = selected.text || readEditable(field);
    allowBubbleClick = false;
    hideHint();
    host.hidden = false;
    setOpen(true);
    showPromptTab();
    if (field) lastEditable = field;
    runAnalysis(text);
  };

  document.addEventListener("selectionchange", () => {
    clearTimeout(hintHideTimer);
    hintHideTimer = setTimeout(syncHintToSelection, 60);
  });

  document.addEventListener(
    "mouseup",
    (event) => {
      if (event.button !== 0) return;
      clearTimeout(hintHideTimer);
      hintHideTimer = setTimeout(syncHintToSelection, 30);
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") hideHint();
      else if (hint.classList.contains("show")) {
        clearTimeout(hintHideTimer);
        hintHideTimer = setTimeout(syncHintToSelection, 30);
      }
    },
    true,
  );

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!hint.classList.contains("show")) return;
      const path = event.composedPath?.() || [];
      if (path.includes(hint)) return;
      // Let the browser update selection first; syncHintToSelection will dismiss if cleared.
      clearTimeout(hintHideTimer);
      hintHideTimer = setTimeout(syncHintToSelection, 40);
    },
    true,
  );

  document.addEventListener("scroll", () => {
    if (!hint.classList.contains("show") || !hintTarget) return;
    const selected = getFieldSelection(hintTarget);
    if (!selected.text) hideHint();
    else positionHint(hintTarget, selected.rect);
  }, true);

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
    editor.value = `Goal:\n${raw}\n\nRequirements:\n- Preserve existing behavior unless a change is requested.\n- Explain important code decisions in plain text.\n\nDone when:\n- The requested outcome is implemented and verified.`;
    renderAnalysis(analyzePromptText(editor.value));
    promptStatus.textContent = "Suggestion ready. Edit it before inserting.";
  };
  root.querySelector("#insert").onclick = () => {
    if (!lastEditable || !document.contains(lastEditable)) {
      promptStatus.textContent = "The original editable field is no longer available.";
      return;
    }
    const value = editor.value;
    lastEditable.focus();
    if (lastEditable.isContentEditable || lastEditable.getAttribute("contenteditable") != null) {
      lastEditable.innerText = value;
      lastEditable.dispatchEvent(new InputEvent("input", { bubbles:true, data:value }));
    } else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(lastEditable), "value")?.set;
      setter ? setter.call(lastEditable, value) : (lastEditable.value = value);
      lastEditable.dispatchEvent(new Event("input", { bubbles:true }));
      lastEditable.dispatchEvent(new Event("change", { bubbles:true }));
    }
    promptStatus.textContent = "Inserted into the page, but not submitted.";
  };

  root.querySelector("#inspect-page").onclick = () => {
    const output = root.querySelector("#inspection");
    output.hidden = false;
    const headings = [...document.querySelectorAll("h1,h2,h3")]
      .filter((node) => !host.contains(node)).slice(0, 12)
      .map((node) => node.innerText.trim()).filter(Boolean);
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2800);
    const fields = document.querySelectorAll("textarea,input[type='text'],[contenteditable='true']").length;
    output.textContent = `Title: ${document.title}\nURL: ${location.href}\nEditable fields: ${fields}\nHeadings: ${headings.join(" · ") || "None"}\n\nVisible text sample:\n${text || "None"}`;
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
        } catch {
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

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "TOKENLEAN_TOGGLE") host.hidden = !host.hidden;
  });
})();
