document.addEventListener('DOMContentLoaded', () => {
  // Shared analysis logic from lib/promptcoach-core.js (generated from
  // src/shared/core.ts — the same functions the CLI uses).
  const { analyzePromptText, structurePrompt, collectPrompts } = globalThis.PromptCoachCore;

  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  const editor = document.getElementById('editor');
  const promptStatus = document.getElementById('prompt-status');
  const analysisBox = document.getElementById('analysis');
  const inspectStatus = document.getElementById('inspect-status');
  const workflowSteps = document.querySelectorAll('.workflow-step');

  const setWorkflowStep = (step) => {
    const order = { prompt: 0, review: 1, apply: 2 };
    workflowSteps.forEach((item) => {
      item.classList.toggle('active', order[item.dataset.step] <= order[step]);
    });
  };

  // Tab switching
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove('on'));
      panels.forEach(p => p.classList.remove('on'));
      tab.classList.add('on');
      document.getElementById(tab.dataset.tab).classList.add('on');
    };
  });

  // Header: show/hide the floating on-page widget.
  document.getElementById('toggle-widget').onclick = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
      const tabId = activeTabs[0]?.id;
      if (!tabId) return;
      chrome.tabs.sendMessage(tabId, { type: 'PROMPTCOACH_TOGGLE' }, () => {
        if (chrome.runtime.lastError) {
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['lib/promptcoach-core.js', 'content.js'],
          }, () => {
            if (chrome.runtime.lastError) {
              promptStatus.textContent = 'Widget is only available on supported AI sites.';
              return;
            }
            promptStatus.textContent = 'Widget reconnected to this page.';
          });
        }
      });
    });
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
    chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
      chrome.tabs.sendMessage(activeTabs[0].id, { action: "read_prompt" }, (response) => {
        if (response && response.text !== undefined) {
          editor.value = response.text;
          promptStatus.textContent = response.text ? "Prompt loaded from page." : "The focused field is empty.";
          setWorkflowStep('prompt');
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
    setWorkflowStep('review');
  };

  document.getElementById('improve').onclick = () => {
    const raw = editor.value.trim();
    if (!raw) { promptStatus.textContent = "Add or load a prompt first."; return; }
    editor.value = structurePrompt(raw);
    renderAnalysis(analyzePromptText(editor.value));
    promptStatus.textContent = "Suggestion ready. Edit it before inserting.";
    setWorkflowStep('review');
  };

  document.getElementById('insert').onclick = () => {
    const value = editor.value;
    chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
      chrome.tabs.sendMessage(activeTabs[0].id, { action: "insert_prompt", value }, (response) => {
        if (response && response.success) {
          promptStatus.textContent = "Inserted into the page, but not submitted.";
          setWorkflowStep('apply');
        } else {
          promptStatus.textContent = response?.error || "Failed to insert.";
        }
      });
    });
  };

  // Tab 2: History audit. The content script stores the collected
  // prompts; the background storage listener opens the dashboard.
  document.getElementById('harvest-btn').onclick = () => {
    inspectStatus.textContent = "Collecting prompts from Gemini for review...";
    chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
      const activeTab = activeTabs[0];
      if (!activeTab || !activeTab.url || !activeTab.url.includes("gemini.google.com")) {
        inspectStatus.textContent = "Deep prompt auditing currently supports Gemini only. Open a Gemini chat to run it.";
        return;
      }

      chrome.tabs.sendMessage(activeTab.id, { action: "harvest_prompts" }, (response) => {
        if (chrome.runtime.lastError) {
          inspectStatus.textContent = "Error: " + chrome.runtime.lastError.message;
          return;
        }

        if (response && response.success) {
          inspectStatus.textContent = "Prompts captured. Opening audit dashboard…";
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

  document.getElementById('files').onchange = async (event) => {
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
    const summary = document.getElementById('summary');
    summary.hidden = false;
    summary.textContent = `Files: ${files.length}\nParsed records: ${records}\nDetected turns: ${turns}\nUser prompts found: ${prompts.length}\nMalformed records skipped: ${malformed}\nCharacters read locally: ${characters.toLocaleString()}`;
    reevaluateBtn.disabled = prompts.length === 0;
    importStatus.textContent = prompts.length
      ? `${prompts.length} prompt(s) ready. Click Re-evaluate to open the audit.`
      : "No user prompts found in these files.";
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
    await chrome.storage.local.set({ recentPrompts: importedPrompts, recentPromptsAt: Date.now() });
  };
});
