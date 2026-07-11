document.addEventListener('DOMContentLoaded', () => {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  const editor = document.getElementById('editor');
  const promptStatus = document.getElementById('prompt-status');
  const analysisBox = document.getElementById('analysis');
  const inspectStatus = document.getElementById('inspect-status');

  // Tab switching
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove('on'));
      panels.forEach(p => p.classList.remove('on'));
      tab.classList.add('on');
      document.getElementById(tab.dataset.tab).classList.add('on');
    };
  });

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

  // Tab 1: Prompt
  document.getElementById('read').onclick = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: "read_prompt" }, (response) => {
        if (response && response.text !== undefined) {
          editor.value = response.text;
          promptStatus.textContent = response.text ? "Prompt loaded from page." : "The focused field is empty.";
        } else {
          promptStatus.textContent = "Could not read from page. Ensure a prompt field is focused.";
        }
      });
    });
  };

  document.getElementById('analyze').onclick = () => {
    const text = editor.value.trim();
    if (!text) {
      promptStatus.textContent = "Add or load a prompt first.";
      analysisBox.hidden = true;
      return;
    }
    renderAnalysis(analyzePromptText(text));
    promptStatus.textContent = "Local analysis ready.";
  };

  document.getElementById('improve').onclick = () => {
    const raw = editor.value.trim();
    if (!raw) { promptStatus.textContent = "Add or load a prompt first."; return; }
    editor.value = `Goal:\n${raw}\n\nRequirements:\n- Preserve existing behavior unless a change is requested.\n- Explain important code decisions in plain text.\n\nDone when:\n- The requested outcome is implemented and verified.`;
    renderAnalysis(analyzePromptText(editor.value));
    promptStatus.textContent = "Suggestion ready. Edit it before inserting.";
  };

  document.getElementById('insert').onclick = () => {
    const value = editor.value;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: "insert_prompt", value }, (response) => {
        if (response && response.success) {
          promptStatus.textContent = "Inserted into the page.";
        } else {
          promptStatus.textContent = response?.error || "Failed to insert.";
        }
      });
    });
  };

  // Tab 2: Inspect (Deep Audit)
  document.getElementById('harvest-btn').onclick = () => {
    inspectStatus.textContent = "Harvesting prompts from Gemini...";
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (!activeTab || !activeTab.url || !activeTab.url.includes("gemini.google.com")) {
        inspectStatus.textContent = "Deep prompt auditing is currently optimized exclusively for Gemini. Please open a Gemini chat window to run this analysis.";
        return;
      }
      
      chrome.tabs.sendMessage(activeTab.id, { action: "harvest_prompts" }, (response) => {
        if (chrome.runtime.lastError) {
          inspectStatus.textContent = "Error: " + chrome.runtime.lastError.message;
          return;
        }
        
        if (response && response.success) {
          inspectStatus.textContent = "Success! Opening dashboard...";
          chrome.runtime.sendMessage({ action: "open_dashboard" });
        } else {
          inspectStatus.textContent = response?.error || "Failed to harvest prompts.";
        }
      });
    });
  };

  // Tab 3: Import
  const reevaluateBtn = document.getElementById('reevaluate');
  const importStatus = document.getElementById('import-status');
  // User prompts extracted from the most recent import, held for Re-evaluate.
  let importedPrompts = [];

  // Pull the user's own prompt text out of one transcript node (Claude Code
  // message.role/content or generic role/content; content may be a string or an
  // array of text blocks). Tool-result turns collapse to empty and are skipped.
  const extractUserText = (node) => {
    const msg = node?.message ?? node;
    if (msg?.role !== "user") return "";
    const content = msg.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
    }
    return "";
  };

  document.getElementById('files').onchange = async (event) => {
    const files = [...event.target.files];
    let records = 0, malformed = 0, characters = 0;
    const prompts = [];
    const counters = { turns: 0 };

    // Walk any JSON shape (wrappers like {conversation:[...]}/{messages:[...]},
    // top-level arrays, Claude Code JSONL lines) and collect user prompt text.
    const collect = (node) => {
      if (Array.isArray(node)) { for (const el of node) collect(el); return; }
      if (!node || typeof node !== "object") return;
      if (node.role || node.message?.role) counters.turns++;
      const t = extractUserText(node);
      if (t) { prompts.push(t); return; }
      for (const key in node) collect(node[key]);
    };

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
          collect(value);
        } catch {
          if (isTxt) prompts.push(text.trim());
          else malformed++;
        }
      }
    }

    importedPrompts = prompts;
    const turns = counters.turns;
    await chrome.storage.local.set({
      transcriptSummary: { files: files.length, records, malformed, turns, characters, importedAt: Date.now() },
    });
    const summary = document.getElementById('summary');
    summary.hidden = false;
    summary.textContent = `Files: ${files.length}\nParsed records: ${records}\nDetected turns: ${turns}\nUser prompts found: ${prompts.length}\nMalformed records skipped: ${malformed}\nCharacters read locally: ${characters.toLocaleString()}`;
    reevaluateBtn.disabled = prompts.length === 0;

    if (prompts.length) {
      // Auto-open the audit dashboard as soon as the upload is parsed: publish
      // the prompts, then open the dashboard (dashboard.js reads recentPrompts
      // and runs the Gemini audit).
      importStatus.textContent = "Opening audit dashboard…";
      await chrome.storage.local.set({ recentPrompts: prompts });
      chrome.runtime.sendMessage({ action: "open_dashboard" });
    } else {
      importStatus.textContent = "No user prompts found in these files.";
    }
  };

  // Re-evaluate: publish the imported prompts as recentPrompts. The background
  // storage listener opens the dashboard, and dashboard.js runs the Gemini audit
  // — the same pipeline the Inspect tab uses.
  reevaluateBtn.onclick = async () => {
    if (!importedPrompts.length) {
      importStatus.textContent = "Import a transcript with user prompts first.";
      return;
    }
    importStatus.textContent = "Opening audit dashboard…";
    await chrome.storage.local.set({ recentPrompts: importedPrompts });
    chrome.runtime.sendMessage({ action: "open_dashboard" });
  };
});
