/**
 * PromptCoach shared core — the single source of truth for analysis logic used
 * by BOTH frontends:
 *
 *   - the CLI/hook (imports this module directly via TypeScript), and
 *   - the browser extension (consumes the generated bundle at
 *     extension/lib/promptcoach-core.js, built by scripts/build-extension-core.cjs).
 *
 * Rules for this file:
 *   - No imports. It must transpile to a standalone script for the extension.
 *   - No I/O, no globals, no Date.now(): pure data and pure functions only.
 *   - Any threshold or constant that both frontends need lives here, so the
 *     two surfaces cannot drift apart again.
 */

/* ------------------------------------------------------------------ */
/* Thresholds shared across frontends                                  */
/* ------------------------------------------------------------------ */

/**
 * SPEC §4.3/§5.2: a prompt above this many characters that also embeds a
 * fenced code block counts as an oversized paste. Used by the CLI hook, the
 * transcript heuristics, and the extension's local prompt analyzer.
 */
export const OVERSIZED_PASTE_CHARS = 8000;

/** Rough chars-per-token divisor for local token estimates. */
export const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Cross-session "resupplied context" detection (CLI heuristics): 5-word
 * shingle Jaccard at or above this value marks two long prompts as the same
 * context pasted again.
 */
export const RESUPPLIED_SIMILARITY = 0.75;

/** Shingle length (words) for resupplied-context similarity. */
export const SHINGLE_SIZE = 5;

/**
 * Consecutive-prompt rework detection (extension dashboard): word-bag
 * Jaccard above this value marks a prompt as a rephrasing of the previous
 * one. Deliberately lower than RESUPPLIED_SIMILARITY — consecutive chat
 * turns are short, so shingles are too sparse; the word bag is the signal.
 */
export const REWORK_SIMILARITY = 0.45;

/** Default hosted models per provider — consumed by src/config.ts and the
 * extension dashboard, so the two frontends always target the same models. */
export const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5.4-nano',
  gemini: 'gemini-2.5-flash',
  cursor: 'composer-2.5',
} as const;

/** Native Gemini API root (dashboard generateContent). The CLI hook appends
 * `/openai` for the OpenAI-compatible chat/completions endpoint. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/* ------------------------------------------------------------------ */
/* Prompt structure analysis (extension Prompt tab / popup)            */
/* ------------------------------------------------------------------ */

export interface PromptAnalysis {
  words: number;
  chars: number;
  approxTokens: number;
  lines: number;
  /** 1–10; structural score, never a judgement of the task itself. */
  score: number;
  tips: string[];
}

/**
 * Local, deterministic prompt-structure check. Philosophy matches the hosted
 * coach rubric (src/hook/llm.ts): brevity is never penalized in the score,
 * and "oversized paste" means the same thing it means everywhere else in
 * PromptCoach (OVERSIZED_PASTE_CHARS + code content), not an ad-hoc limit.
 */
export function analyzePromptText(raw: string): PromptAnalysis {
  const text = raw.trim();
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  const chars = text.length;
  const approxTokens = Math.max(1, Math.round(chars / APPROX_CHARS_PER_TOKEN));
  const lines = text.split(/\n/).filter((line) => line.trim());
  // "please" is intentionally NOT a goal signal: the dashboard counts it as
  // filler, and rewarding it here contradicted that.
  const hasGoal = /\b(goal|objective|i (want|need)|fix|implement|build|write|create|explain|compare)\b/i.test(text);
  const hasConstraints = /\b(must|should|do not|don't|requirements?|constraints?)\b/i.test(text);
  const hasDoneWhen = /\b(done when|acceptance|success criteria|verify)\b/i.test(text);
  const hasCodeContent = /```/.test(text) || (text.match(/[{};]/g) || []).length > 20;
  const oversizedPaste = chars > OVERSIZED_PASTE_CHARS && hasCodeContent;

  const tips: string[] = [];
  if (!hasGoal) tips.push('State the goal in one clear sentence.');
  if (!hasConstraints) tips.push('Add requirements or constraints the model must follow.');
  if (!hasDoneWhen) tips.push('Define what “done” looks like so the answer stays focused.');
  if (oversizedPaste) {
    tips.push('Large pasted code inflates tokens — point to files or paste only the relevant slice.');
  }
  if (words.length < 8 && !hasGoal) {
    tips.push('Short and goal-less — add enough context that the model does not guess.');
  }
  if (lines.length === 1 && words.length > 40) {
    tips.push('Break a long single-line prompt into short labeled sections.');
  }
  if (!tips.length) tips.push('Structure looks solid. Keep reviewing before you submit.');

  const score = Math.max(
    1,
    Math.min(
      10,
      4 + (hasGoal ? 2 : 0) + (hasConstraints ? 2 : 0) + (hasDoneWhen ? 2 : 0) - (oversizedPaste ? 2 : 0)
    )
  );
  return { words: words.length, chars, approxTokens, lines: lines.length, score, tips };
}

/** Rewrite a raw prompt into the Goal / Requirements / Done-when skeleton. */
export function structurePrompt(raw: string): string {
  return (
    `Goal:\n${raw.trim()}\n\n` +
    'Requirements:\n' +
    '- Preserve existing behavior unless a change is requested.\n' +
    '- Explain important code decisions in plain text.\n\n' +
    'Done when:\n' +
    '- The requested outcome is implemented and verified.'
  );
}

/* ------------------------------------------------------------------ */
/* Similarity                                                          */
/* ------------------------------------------------------------------ */

/** 5-word shingle set over normalized words (CLI resupplied-context signal). */
export function shingles(text: string, size: number = SHINGLE_SIZE): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9_./-]+/g, ' ').trim().split(/\s+/);
  const out = new Set<string>();
  for (let i = 0; i <= words.length - size; i++) out.add(words.slice(i, i + size).join(' '));
  return out;
}

/** Jaccard index of two sets. Empty input → 0. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap++;
  return overlap / (a.size + b.size - overlap);
}

/** Lowercased alphanumeric word bag (dashboard rework signal). */
export function wordBag(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  return new Set(words);
}

/** Word-bag Jaccard between two prompts; compare against REWORK_SIMILARITY. */
export function wordBagSimilarity(a: string, b: string): number {
  return jaccard(wordBag(a), wordBag(b));
}

/* ------------------------------------------------------------------ */
/* Filler words (dashboard telemetry)                                  */
/* ------------------------------------------------------------------ */

export const FILLER_WORDS: readonly string[] = [
  'please', 'thanks', 'hello', 'hi', 'just', 'basically', 'actually',
  'kindly', 'sorry', 'pls', 'thx',
];

const FILLER_SET = new Set(FILLER_WORDS);

/** Count filler-word occurrences in one prompt. */
export function countFillerWords(text: string): number {
  let count = 0;
  for (const word of text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)) {
    if (FILLER_SET.has(word)) count++;
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* Environmental estimates (SPEC §7)                                   */
/* ------------------------------------------------------------------ */

export interface BoundedConstant {
  low: number;
  high: number;
  unit: string;
  source: string;
  note: string;
}

export interface Range {
  low: number;
  high: number;
}

/** Energy per million uncached tokens processed (input + output). */
export const ENERGY_KWH_PER_MTOK: BoundedConstant = {
  low: 0.3,
  high: 2.0,
  unit: 'kWh per 1M uncached tokens',
  source: 'https://arxiv.org/abs/2509.20241',
  note:
    '2026 literature range. Low: optimized production serving of input-heavy mixes ' +
    '(Oviedo et al., Joule 2026 — median 0.31 Wh/query, IQR 0.16–0.60; finds earlier ' +
    'public estimates overstated 4–20x). High: output-token-dominated bound (~1.95 ' +
    'kWh/MTok output, Epoch-derived Claude Code figures, Couch 2026). No first-party ' +
    'figures exist for Claude as of mid-2026.',
};

/** On-site (scope-1) water use per kWh of datacenter energy. */
export const WATER_L_PER_KWH_ONSITE: BoundedConstant = {
  low: 0.4,
  high: 4.3,
  unit: 'L per kWh (on-site cooling)',
  source: 'https://arxiv.org/abs/2304.03271',
  note:
    '2026 regional WUE spread: ~0.4 L/kWh in cool regions (Iceland, PNW, Scandinavia) ' +
    'to ~4.3 L/kWh in hot regions (Phoenix, Singapore, Texas); global average ~1.8. ' +
    'Baseline methodology: Li et al., "Making AI Less Thirsty".',
};

/** Lifecycle water (on-site + electricity generation) per kWh. */
export const WATER_L_PER_KWH_LIFECYCLE: BoundedConstant = {
  low: 1.8,
  high: 12.0,
  unit: 'L per kWh (lifecycle)',
  source: 'https://arxiv.org/abs/2304.03271',
  note: 'Wide range dominated by the grid mix behind the datacenter.',
};

/**
 * Weight applied to cache-read tokens relative to uncached tokens.
 * Cached prefixes skip prefill compute, so we count them at 10%. The 2026
 * Epoch-derived Claude Code per-token figures (cache read ~39 Wh/MTok vs
 * input ~390 Wh/MTok) land on exactly this ratio, but it remains an
 * estimate, not a first-party measurement. Flagged in every report.
 */
export const CACHED_READ_WEIGHT = 0.1;

export const ESTIMATE_LABEL =
  'rough estimate — no first-party figures exist for Claude; see docs/cli/ASSUMPTIONS.md';

/** Convert a token count into a bounded energy range. */
export function energyRangeKwh(tokens: number): Range {
  const mtok = Math.max(0, tokens) / 1e6;
  return { low: mtok * ENERGY_KWH_PER_MTOK.low, high: mtok * ENERGY_KWH_PER_MTOK.high };
}

/** On-site and lifecycle water ranges for a given energy range. */
export function waterRangesL(energy: Range): { onsite: Range; lifecycle: Range } {
  return {
    onsite: {
      low: energy.low * WATER_L_PER_KWH_ONSITE.low,
      high: energy.high * WATER_L_PER_KWH_ONSITE.high,
    },
    lifecycle: {
      low: energy.low * WATER_L_PER_KWH_LIFECYCLE.low,
      high: energy.high * WATER_L_PER_KWH_LIFECYCLE.high,
    },
  };
}

export function formatEnvNumber(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 100) return String(Math.round(n));
  if (n >= 0.095) return n.toFixed(1);
  return n.toPrecision(2);
}

/** "0.4–1.3 kWh"-style rendering. Always a range, never a bare number. */
export function formatRange(range: Range, unit: string): string {
  return `${formatEnvNumber(range.low)}–${formatEnvNumber(range.high)} ${unit}`;
}

/* ------------------------------------------------------------------ */
/* Transcript prompt extraction (extension Import; mirrors parser.ts)  */
/* ------------------------------------------------------------------ */

/**
 * Pull the user's own prompt text out of one transcript node (Claude Code
 * message.role/content or generic role/content; content may be a string or
 * an array of text blocks). Tool-result turns collapse to empty.
 */
export function extractUserText(node: unknown): string {
  const rec = node as { message?: unknown } | null;
  const msg = (rec && typeof rec === 'object' && 'message' in rec && rec.message ? rec.message : node) as
    | { role?: unknown; content?: unknown }
    | null;
  if (!msg || typeof msg !== 'object' || msg.role !== 'user') return '';
  const content = msg.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

export interface CollectedPrompts {
  prompts: string[];
  turns: number;
}

/**
 * Walk any JSON shape (wrappers like {conversation:[...]}/{messages:[...]},
 * top-level arrays, Claude Code JSONL lines) and collect user prompt text.
 */
export function collectPrompts(value: unknown): CollectedPrompts {
  const prompts: string[] = [];
  let turns = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const el of node) walk(el);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (rec.role || (rec.message as Record<string, unknown> | undefined)?.role) turns++;
    const text = extractUserText(node);
    if (text) {
      prompts.push(text);
      return;
    }
    for (const key in rec) walk(rec[key]);
  };
  walk(value);
  return { prompts, turns };
}
