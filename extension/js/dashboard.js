/**
 * Dashboard Controller for Prompt Coach
 * Performs client-side telemetry prep, requests AI evaluation, and manages Chart.js components.
 *
 * All analysis math (filler words, redundancy similarity, environmental
 * ranges) comes from lib/promptcoach-core.js — generated from src/shared/core.ts,
 * the same logic the CLI uses. Do not re-implement thresholds here.
 */

document.addEventListener('DOMContentLoaded', () => {
  const core = globalThis.PromptCoachCore;

  const apiKeyInput = document.getElementById('api-key-input');
  const saveKeyBtn = document.getElementById('save-api-key-btn');
  const statusBanner = document.getElementById('status-banner');
  const loadingOverlay = document.getElementById('loading-overlay');

  const accordionToggle = document.getElementById('accordion-toggle');
  const accordionContent = document.getElementById('accordion-content');

  // Demonstration prompts shown when the extension is opened with no
  // scraped data. Never persisted: storage stays real-data-only.
  const DEMO_PROMPTS = [
    "Hello Gemini, I hope you are having a wonderful day! Could you please help me write a quick function in Node.js? I am trying to build a scraper to get headings from Google, but I'm not really sure how to handle it. Thank you so much!",
    "Hi, I noticed the function you wrote has some style dependencies. Could you please rewrite it without them? Just pure JavaScript, thanks!",
    "Can you write a Node.js script using fetch to crawl headings from google.com, stripping style dependencies, and return JSON arrays?",
    "Wait, how do I run this code? Can you show me the terminal command? Please and thank you.",
    "Is there a simpler way? Like using curl in a bash script instead of Node.js?",
    "Actually, I need to fetch all headings, not just h1. Can you modify the node script to get h1, h2, h3, h4? Thanks a lot, kindly do that.",
    "Could you write a Node.js script using fetch to crawl headings from google.com, stripping style dependencies, and return JSON arrays?",
    "Thanks, this is awesome! It works perfectly. I appreciate your help a lot. Have a good one!",
    "Wait, does it support https? Can you confirm?",
    "How do I install the dependencies for this script?"
  ];

  // Sample AI response rendered only in demo mode (no API key). Clearly
  // labeled as a sample in the UI; never presented as a real audit.
  const SAMPLE_AI_RESPONSE = {
    final_score: 6.2,
    critique_points: [
      {
        category: "Conversational Bloat",
        suggestion: "Remove greeting and gratitude formulas ('Hello', 'thank you so much'). They occupy token context without altering instructions."
      },
      {
        category: "Rework Loops",
        suggestion: "Consolidate iterative amendments (like adding h2/h3 headings later) into a single structured specifications block in prompt 1."
      },
      {
        category: "Content Redundancy",
        suggestion: "Avoid sending near-identical prompts (prompt 7 is a literal duplicate of prompt 3). Review similarity metrics before re-posting."
      }
    ],
    green_alternative: "Write a Node.js script that fetches 'google.com', extracts h1-h4 headings using fetch/regex (no heavy dependencies), and outputs a raw JSON array."
  };

  // Toggle accordion log
  accordionToggle.addEventListener('click', () => {
    accordionToggle.classList.toggle('active');
    accordionContent.classList.toggle('hidden');
  });

  // Save API Key
  saveKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    chrome.storage.local.set({ gemini_api_key: key }, () => {
      showBanner("API key saved locally. Refreshing your prompt audit…", false);
      loadAndAnalyze();
    });
  });

  // Initialize
  chrome.storage.local.get(['gemini_api_key'], (result) => {
    if (result.gemini_api_key) {
      apiKeyInput.value = result.gemini_api_key;
    }
    loadAndAnalyze();
  });

  /**
   * Main orchestrator function: loads prompts, calculates telemetry, runs Gemini audit.
   */
  function loadAndAnalyze() {
    chrome.storage.local.get(['recentPrompts', 'gemini_api_key'], (data) => {
      const apiKey = data.gemini_api_key || "";
      let prompts = data.recentPrompts;
      const isDemoData = !prompts || prompts.length === 0;

      if (isDemoData) {
        console.log("No collected prompts found. Falling back to demonstration prompts.");
        prompts = DEMO_PROMPTS;
      }

      // 1. Telemetry Prep
      const metrics = calculateMetrics(prompts);
      updateTelemetryUI(metrics, prompts);

      // Find longest prompt
      let longestPrompt = "";
      prompts.forEach(p => {
        if (p.length > longestPrompt.length) longestPrompt = p;
      });

      // 2. Hybrid AI Audit Pass
      if (!apiKey) {
        showBanner(
          (isDemoData ? "Showing demonstration prompts. " : "") +
          "Local review only — the audit below is a sample, not a live result. Add a Gemini API key for personalized coaching.",
          false
        );
        renderAudit(SAMPLE_AI_RESPONSE, longestPrompt, true);
      } else {
        if (isDemoData) {
          showBanner("No collected prompts yet — reviewing demonstration prompts.", false);
        } else {
          hideBanner();
        }
        loadingOverlay.classList.remove('hidden');

        callGeminiAPI(apiKey, prompts, metrics, longestPrompt)
          .then(aiResult => {
            renderAudit(aiResult, longestPrompt, false);
          })
          .catch(err => {
            console.error(err);
            showBanner(`AI Scorer connection failed: ${err.message}. Showing SAMPLE audit as fallback.`, true);
            renderAudit(SAMPLE_AI_RESPONSE, longestPrompt, true);
          })
          .finally(() => {
            loadingOverlay.classList.add('hidden');
          });
      }
    });
  }

  /**
   * Step 1: Telemetry Prep calculations (shared-core math).
   */
  function calculateMetrics(prompts) {
    let fillerCount = 0;
    let charCount = 0;
    let redundancyCount = 0;
    let redundantChars = 0;

    prompts.forEach((prompt, index) => {
      charCount += prompt.length;
      fillerCount += core.countFillerWords(prompt);

      // Rework loop: this prompt largely restates the immediately preceding
      // one (word-bag Jaccard, same signal family as the CLI's shingle check).
      if (index > 0 && core.wordBagSimilarity(prompt, prompts[index - 1]) > core.REWORK_SIMILARITY) {
        redundancyCount++;
        redundantChars += prompt.length;
      }
    });

    return {
      promptsCount: prompts.length,
      fillerCount,
      charCount,
      redundancyCount,
      redundantChars
    };
  }

  /**
   * Update metrics cards and the environmental estimate.
   *
   * Environmental math mirrors the CLI (SPEC §7): tokens are converted with
   * the sourced bounded constants from the shared core, and every figure is
   * a LOW–HIGH range labeled a rough estimate — never a single number.
   */
  function updateTelemetryUI(metrics, prompts) {
    document.getElementById('stat-prompts-count').textContent = metrics.promptsCount;
    document.getElementById('stat-filler-count').textContent = metrics.fillerCount;
    document.getElementById('stat-token-count').textContent = metrics.charCount.toLocaleString();
    document.getElementById('stat-redundancy-count').textContent = metrics.redundancyCount;

    const promptNoun = metrics.promptsCount === 1 ? 'prompt' : 'prompts';
    const issueParts = [];
    if (metrics.fillerCount > 0) {
      issueParts.push(`${metrics.fillerCount} filler word${metrics.fillerCount === 1 ? '' : 's'}`);
    }
    if (metrics.redundancyCount > 0) {
      issueParts.push(`${metrics.redundancyCount} repeated prompt${metrics.redundancyCount === 1 ? '' : 's'}`);
    }
    const issueSummary = issueParts.length
      ? `${issueParts.join(' and ')} detected`
      : 'No filler or repeated prompts were detected';
    document.getElementById('telemetry-summary').textContent =
      `Reviewed ${metrics.promptsCount} ${promptNoun} locally. ${issueSummary} across ` +
      `${metrics.charCount.toLocaleString()} characters.`;

    // Waste that trimming would avoid: ~1 token per filler word, plus the
    // full token load of prompts that were near-duplicates of their
    // predecessor.
    const totalTokens = Math.max(0, Math.round(metrics.charCount / core.APPROX_CHARS_PER_TOKEN));
    const estimatedSavedTokens = metrics.fillerCount +
      Math.round(metrics.redundantChars / core.APPROX_CHARS_PER_TOKEN);
    const savedTokens = Math.min(totalTokens, estimatedSavedTokens);
    const optimizedTokens = Math.max(0, totalTokens - savedTokens);

    const toWh = (range) => ({ low: range.low * 1000, high: range.high * 1000 });
    const savedEnergyWh = toWh(core.energyRangeKwh(savedTokens));
    const currentEnergyWh = toWh(core.energyRangeKwh(totalTokens));
    const optimizedEnergyWh = toWh(core.energyRangeKwh(optimizedTokens));
    const savedWater = core.waterRangesL(core.energyRangeKwh(savedTokens));
    const currentWater = core.waterRangesL(core.energyRangeKwh(totalTokens));
    const optimizedWater = core.waterRangesL(core.energyRangeKwh(optimizedTokens));

    const percent = (value, maximum) => maximum > 0
      ? Math.max(0, Math.min(100, (value / maximum) * 100))
      : 0;

    const renderRangeBar = (prefix, range, maximum, unit) => {
      const lowPercent = percent(range.low, maximum);
      const highPercent = percent(range.high, maximum);
      document.getElementById(`${prefix}-low`).style.width = `${lowPercent}%`;
      const highBar = document.getElementById(`${prefix}-high`);
      highBar.style.left = `${lowPercent}%`;
      highBar.style.width = `${Math.max(0, highPercent - lowPercent)}%`;
      const formatted = core.formatRange(range, unit);
      document.getElementById(`${prefix}-value`).textContent = formatted;
      document.getElementById(`${prefix}-bar`).setAttribute('aria-label', formatted);
    };

    renderRangeBar('water-current', currentWater.onsite, currentWater.onsite.high, 'L');
    renderRangeBar('water-optimized', optimizedWater.onsite, currentWater.onsite.high, 'L');
    renderRangeBar('energy-current', currentEnergyWh, currentEnergyWh.high, 'Wh');
    renderRangeBar('energy-optimized', optimizedEnergyWh, currentEnergyWh.high, 'Wh');

    document.getElementById('water-axis-max').textContent = core.formatRange(
      { low: currentWater.onsite.high, high: currentWater.onsite.high }, 'L'
    ).split('–')[0] + ' L';
    document.getElementById('energy-axis-max').textContent = core.formatRange(
      { low: currentEnergyWh.high, high: currentEnergyWh.high }, 'Wh'
    ).split('–')[0] + ' Wh';
    document.getElementById('sustain-water').textContent = `Save ${core.formatRange(savedWater.onsite, 'L')}`;
    document.getElementById('sustain-energy').textContent = `Save ${core.formatRange(savedEnergyWh, 'Wh')}`;
    document.getElementById('sustain-narrative').textContent =
      `Based on roughly ${savedTokens} potentially avoidable token(s). Lifecycle water savings: ` +
      `${core.formatRange(savedWater.lifecycle, 'L')}. Literature-based low–high ranges — see ` +
      `ASSUMPTIONS.md; these are not measured figures.`;

    // Populate prompts list accordion
    const listContainer = document.getElementById('prompts-list');
    listContainer.innerHTML = '';

    prompts.forEach((p, i) => {
      const li = document.createElement('li');
      li.textContent = `[Prompt ${i + 1}]: "${p}"`;
      listContainer.appendChild(li);
    });

    document.getElementById('scraped-log-count').textContent = prompts.length;
  }

  /**
   * Step 2: Live AI Scorer utilizing Gemini API gateway.
   * The key travels in the x-goog-api-key header (matching the CLI's
   * src/hook/llm.ts), never in the URL where it could leak into logs.
   */
  async function callGeminiAPI(apiKey, prompts, metrics, longestPrompt) {
    const model = core.DEFAULT_MODELS.gemini;
    const url = `${core.GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;

    const promptInstructions = `
      You are an expert AI prompt optimization engine. You are analyzing a sequence of user prompts to evaluate prompt efficiency, scoring habits, and stripping waste from context.

      Here is the telemetry data gathered:
      - Recent Prompts: ${JSON.stringify(prompts)}
      - Filler Word Count: ${metrics.fillerCount}
      - Character Count: ${metrics.charCount}
      - Redundant (near-duplicate) prompts: ${metrics.redundancyCount}

      Analyze the prompting pattern. Identify negative habits like:
      - Rework Loops (asking the same question in multiple slightly different ways)
      - Context Dumping (providing huge walls of text without clear structure/instructions)
      - Conversational Bloat (excessive filler words like "please", "could you", "thanks")
      - Under-specification (not giving enough constraints, leading to follow-up corrections)

      Return a strict, valid JSON object containing exactly these fields (no markdown formatting, no code block backticks):
      {
        "final_score": <number between 1 and 10 representing overall prompting efficiency>,
        "critique_points": [
          { "category": "Habit Name", "suggestion": "Clear, actionable advice to resolve this habit" }
        ],
        "green_alternative": "<A beautifully rewritten, token-stripped version of their longest prompt: '${longestPrompt.replace(/'/g, "\\'")}'. It should achieve the exact same goal but with minimal tokens, high instruction density, and zero filler.>"
      }
    `;

    const requestBody = {
      contents: [{
        parts: [{ text: promptInstructions }]
      }],
      generationConfig: {
        responseMimeType: "application/json"
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned code ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const textResult = data.candidates[0].content.parts[0].text;

    // Parse result
    return JSON.parse(textResult);
  }

  /**
   * Render AI-generated results to the Dashboard.
   */
  let scoreChart = null;

  function renderAudit(result, longestPrompt, isSample) {
    const finalScore = result.final_score || 0;

    // Update Score Chart
    const ctx = document.getElementById('scoreChart').getContext('2d');
    if (scoreChart) {
      scoreChart.destroy();
    }

    let accentColor = '#176b4d';
    let trackColor = 'rgba(23, 107, 77, 0.12)';
    let ratingBadge = 'Excellent habits';

    if (finalScore < 5.0) {
      accentColor = '#a53b32';
      trackColor = 'rgba(165, 59, 50, 0.1)';
      ratingBadge = 'Needs focus';
    } else if (finalScore < 7.5) {
      accentColor = '#d9673f';
      trackColor = 'rgba(217, 103, 63, 0.1)';
      ratingBadge = 'Room to improve';
    } else if (finalScore < 9.0) {
      accentColor = '#306b8c';
      trackColor = 'rgba(48, 107, 140, 0.1)';
      ratingBadge = 'Strong foundation';
    }
    if (isSample) ratingBadge += ' (sample)';

    scoreChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [finalScore, 10 - finalScore],
          backgroundColor: [accentColor, trackColor],
          borderWidth: 0,
          cutout: '80%'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        },
        interaction: { mode: 'none' }
      }
    });

    document.getElementById('score-number').textContent = finalScore.toFixed(1);
    const scoreBadge = document.getElementById('score-rating');
    scoreBadge.textContent = ratingBadge;
    scoreBadge.style.color = accentColor;
    scoreBadge.style.borderColor = accentColor;
    scoreBadge.style.backgroundColor = accentColor + '15'; // Hex alpha

    // Render Side-by-Side Diff
    const originalEl = document.getElementById('original-prompt-text');
    const greenEl = document.getElementById('green-prompt-text');

    originalEl.textContent = longestPrompt || "No prompt scraped yet.";
    document.getElementById('original-length-badge').textContent = `${(longestPrompt || "").length} chars`;

    greenEl.textContent = result.green_alternative || "Waiting for alternative...";
    document.getElementById('green-length-badge').textContent = `${(result.green_alternative || "").length} chars`;

    // Render Critique Points
    const feedbackList = document.getElementById('feedback-list');
    feedbackList.innerHTML = '';

    if (result.critique_points && result.critique_points.length > 0) {
      result.critique_points.forEach(point => {
        const li = document.createElement('li');
        li.className = 'feedback-item';

        // Severity classification
        let badgeClass = 'badge-warning';
        if (point.category.toLowerCase().includes('loop') || point.category.toLowerCase().includes('redundancy')) {
          badgeClass = 'badge-severe';
        }

        li.innerHTML = `
          <div class="feedback-title">
            <span class="feedback-badge ${badgeClass}">${point.category}</span>
            <span>${isSample ? 'Sample Habit (demo)' : 'Habit Identified'}</span>
          </div>
          <p class="feedback-text">${point.suggestion}</p>
        `;
        feedbackList.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.className = 'feedback-placeholder';
      li.textContent = 'Your prompting habits look strong. No recurring issues were detected.';
      feedbackList.appendChild(li);
    }
  }

  // Banner Helpers
  function showBanner(text, isError = false) {
    statusBanner.className = 'banner';
    const icon = document.getElementById('banner-icon');
    const textEl = document.getElementById('banner-text');

    if (isError) {
      statusBanner.classList.add('error');
      icon.textContent = '⚠️';
    } else {
      icon.textContent = 'ℹ️';
    }
    textEl.textContent = text;
    statusBanner.classList.remove('hidden');
  }

  function hideBanner() {
    statusBanner.classList.add('hidden');
  }
});
