(() => {
  const existing = document.getElementById("tokenlean-floating-root");
  if (existing) {
    existing.hidden = !existing.hidden;
    return;
  }

  let lastEditable = null;
  const isEditable = (node) =>
    node instanceof HTMLElement &&
    node.matches("textarea, input[type='text'], [contenteditable='true']");

  const host = document.createElement("div");
  host.id = "tokenlean-floating-root";
  host.setAttribute("data-tokenlean", "floating-widget");
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const logoUrl = chrome.runtime.getURL("icons/tokenlean-logo.png");

  document.addEventListener(
    "focusin",
    (event) => {
      if (isEditable(event.target) && !host.contains(event.target)) {
        lastEditable = event.target;
      }
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
      @media (max-width: 520px) {
        .shell { right:14px; bottom:14px; }
        .widget { width:calc(100vw - 28px); max-height:calc(100vh - 28px); }
      }
    </style>
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
              <p>Focus a prompt field on the page, then load it here. tokenlean never submits it.</p>
              <button class="action soft" id="read" type="button">Read focused prompt</button>
              <textarea id="editor" placeholder="Focus a prompt field, or write a prompt here."></textarea>
              <button class="action soft" id="improve" type="button">Suggest clearer structure</button>
              <button class="action" id="insert" type="button">Insert approved text</button>
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

  fab.addEventListener("click", () => {
    if (!fabWasDragged()) setOpen(true);
  });
  root.querySelector("#close").onclick = () => setOpen(false);

  root.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.onclick = () => {
      root.querySelectorAll(".tab,.panel").forEach((node) => node.classList.remove("on"));
      tab.classList.add("on");
      root.querySelector("#" + tab.dataset.tab).classList.add("on");
    };
  });

  const editor = root.querySelector("#editor");
  const promptStatus = root.querySelector("#prompt-status");
  root.querySelector("#read").onclick = () => {
    if (!lastEditable || !document.contains(lastEditable)) {
      promptStatus.textContent = "Focus an editable field on the page first.";
      return;
    }
    editor.value = lastEditable.isContentEditable ? lastEditable.innerText : lastEditable.value;
    promptStatus.textContent = editor.value ? "Prompt loaded for review." : "The focused field is empty.";
  };
  root.querySelector("#improve").onclick = () => {
    const raw = editor.value.trim();
    if (!raw) { promptStatus.textContent = "Add or load a prompt first."; return; }
    editor.value = `Goal:\n${raw}\n\nRequirements:\n- Preserve existing behavior unless a change is requested.\n- Explain important code decisions in plain text.\n\nDone when:\n- The requested outcome is implemented and verified.`;
    promptStatus.textContent = "Suggestion ready. Edit it before inserting.";
  };
  root.querySelector("#insert").onclick = () => {
    if (!lastEditable || !document.contains(lastEditable)) {
      promptStatus.textContent = "The original editable field is no longer available.";
      return;
    }
    const value = editor.value;
    lastEditable.focus();
    if (lastEditable.isContentEditable) {
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
