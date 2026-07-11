/**
 * Dashboard Controller for EcoPrompt Scorer
 * Performs client-side telemetry prep, requests AI evaluation, and manages Chart.js components
 */

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('api-key-input');
  const saveKeyBtn = document.getElementById('save-api-key-btn');
  const statusBanner = document.getElementById('status-banner');
  const loadingOverlay = document.getElementById('loading-overlay');
  
  const accordionToggle = document.getElementById('accordion-toggle');
  const accordionContent = document.getElementById('accordion-content');

  // Define realistic mock prompts in case extension is opened empty
  const MOCK_PROMPTS = [
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

  // Static/Mock AI Response for demonstration before API key configuration
  const MOCK_AI_RESPONSE = {
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
        suggestion: "Avoid sending near-identical prompts (prompt 7 is a literal duplicate of prompt 3). Review Jaccard similarity metrics before re-posting."
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
      showBanner("API Key saved! Processing prompt analytics...", false);
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

      if (!prompts || prompts.length === 0) {
        console.log("No scraped prompts found. Falling back to demonstration prompts.");
        prompts = MOCK_PROMPTS;
        // Optionally save mock prompts so content makes sense
        chrome.storage.local.set({ recentPrompts: MOCK_PROMPTS });
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
        showBanner("Using local telemetry scanner. Enter a Gemini API Key to unlock live AI audits.", false);
        renderAudit(MOCK_AI_RESPONSE, longestPrompt);
      } else {
        hideBanner();
        loadingOverlay.classList.remove('hidden');
        
        callGeminiAPI(apiKey, prompts, metrics, longestPrompt)
          .then(aiResult => {
            renderAudit(aiResult, longestPrompt);
          })
          .catch(err => {
            console.error(err);
            showBanner(`AI Scorer connection failed: ${err.message}. Showing local metrics fallback.`, true);
            renderAudit(MOCK_AI_RESPONSE, longestPrompt);
          })
          .finally(() => {
            loadingOverlay.classList.add('hidden');
          });
      }
    });
  }

  /**
   * Step 1: Telemetry Prep calculations
   */
  function calculateMetrics(prompts) {
    let fillerCount = 0;
    let charCount = 0;
    let redundancyCount = 0;
    
    const fillerWordsList = [
      "please", "could you", "would you", "thank you", "thanks", 
      "hello", "hi", "just", "basically", "actually", "kindly", 
      "sorry", "would you mind", "pls", "thx"
    ];

    const promptWordLists = [];

    prompts.forEach((prompt, index) => {
      charCount += prompt.length;
      
      const words = prompt.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 0);
      
      promptWordLists.push(words);

      // Count filler words
      words.forEach(w => {
        if (fillerWordsList.includes(w)) {
          fillerCount++;
        }
      });

      // Check Jaccard similarity against immediately preceding prompt
      if (index > 0) {
        const prevWords = promptWordLists[index - 1];
        const jaccard = getJaccardSimilarity(words, prevWords);
        if (jaccard > 0.45) { // 45% or more Jaccard overlap
          redundancyCount++;
        }
      }
    });

    return {
      promptsCount: prompts.length,
      fillerCount,
      charCount,
      redundancyCount
    };
  }

  /**
   * Jaccard index similarity of two word bags.
   */
  function getJaccardSimilarity(wordsA, wordsB) {
    if (wordsA.length === 0 || wordsB.length === 0) return 0;
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return intersection.size / union.size;
  }

  /**
   * Update metrics cards and carbon/water matrix.
   */
  function updateTelemetryUI(metrics, prompts) {
    document.getElementById('stat-prompts-count').textContent = metrics.promptsCount;
    document.getElementById('stat-filler-count').textContent = metrics.fillerCount;
    document.getElementById('stat-token-count').textContent = metrics.charCount;
    document.getElementById('stat-redundancy-count').textContent = metrics.redundancyCount;

    // Eco Computations (scaled per 100 turns)
    const scale = prompts.length > 0 ? (100 / prompts.length) : 10;
    
    // Grid Energy conservation estimation:
    // Every redundancy Jaccard loop saves ~4.2 Wh, every filler word parsed saves ~0.15 Wh
    const energySaved = (metrics.fillerCount * 0.15 + metrics.redundancyCount * 4.2) * scale;
    
    // Server Cooling Water saved:
    // Every Jaccard loop takes ~12 ml (0.012L) of water, each filler word ~0.5 ml (0.0005L)
    const waterSaved = (metrics.fillerCount * 0.0005 + metrics.redundancyCount * 0.012) * scale;

    document.getElementById('sustain-water').textContent = `${waterSaved.toFixed(3)} L`;
    document.getElementById('sustain-energy').textContent = `${energySaved.toFixed(2)} Wh`;

    const narrative = `By cutting out ${metrics.fillerCount} filler word(s) and Jaccard-redundancies, you prevent unnecessary prompt expansion. Scaling this to 100 turns conserves roughly ${waterSaved.toFixed(3)} Liters of water and ${energySaved.toFixed(2)} Watt-hours of electricity.`;
    document.getElementById('sustain-narrative').textContent = narrative;

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
   * Step 2: Live AI Scorer utilizing Gemini API gateway
   */
  async function callGeminiAPI(apiKey, prompts, metrics, longestPrompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;

    const promptInstructions = `
      You are an expert AI prompt optimization engine. You are analyzing a sequence of user prompts to evaluate prompt efficiency, scoring habits, and stripping waste from context.
      
      Here is the telemetry data gathered:
      - Recent Prompts: ${JSON.stringify(prompts)}
      - Filler Word Count: ${metrics.fillerCount}
      - Character Count: ${metrics.charCount}
      - Redundancy Jaccard loops: ${metrics.redundancyCount}
      
      Analyze the prompting pattern. Identify negative habits like:
      - Rework Loops (asking the same question in multiple slightly different ways Jaccard matching)
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
      headers: { 'Content-Type': 'application/json' },
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

  function renderAudit(result, longestPrompt) {
    const finalScore = result.final_score || 0;
    
    // Update Score Chart
    const ctx = document.getElementById('scoreChart').getContext('2d');
    if (scoreChart) {
      scoreChart.destroy();
    }

    let accentColor = '#10b981'; // Green
    let trackColor = 'rgba(16, 185, 129, 0.1)';
    let ratingBadge = 'Optimal Pro';

    if (finalScore < 5.0) {
      accentColor = '#f43f5e'; // Rose/Red
      trackColor = 'rgba(244, 63, 94, 0.1)';
      ratingBadge = 'Bloated Habit';
    } else if (finalScore < 7.5) {
      accentColor = '#f59e0b'; // Amber/Orange
      trackColor = 'rgba(245, 158, 11, 0.1)';
      ratingBadge = 'Sub-optimal';
    } else if (finalScore < 9.0) {
      accentColor = '#3b82f6'; // Blue
      trackColor = 'rgba(59, 130, 246, 0.1)';
      ratingBadge = 'Efficient';
    }

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
            <span>Habit Identified</span>
          </div>
          <p class="feedback-text">${point.suggestion}</p>
        `;
        feedbackList.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.className = 'feedback-placeholder';
      li.textContent = 'Excellent prompting style! No negative habits detected.';
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
