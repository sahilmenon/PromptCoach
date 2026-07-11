import type { DB } from '../db';
import { metaGet, metaSet, openDb } from '../db';
import type { HookInput } from '../types';
import { loadEnvFiles } from '../loadEnv';
import { reviewPromptWithLlm, type PromptReview } from './llm';

export interface NudgeDecision {
  /** Context line to print (Claude Code injects it), or null to stay silent. */
  message: string | null;
  /** Which pattern matched ('none' when we stayed silent) — logged for the digest. */
  pattern: string;
  suppressReason?: string;
}

/** Render the shared Claude Code/Codex UserPromptSubmit response. */
export function renderHookOutput(decision: NudgeDecision): string | null {
  if (decision.message === null) return null;
  const hint = decision.pattern === 'llm_unavailable'
    ? ''
    : decision.pattern === 'good'
      ? '\n\n→ Resubmit without review: to send to Codex.'
      : '\n\n↳ Resubmit with review: for another review, or without it to send to Codex.';
  return JSON.stringify({ decision: 'block', reason: decision.message + hint });
}

export type PromptReviewer = (prompt: string, cwd: string) => Promise<PromptReview | null>;

/** SPEC §5.4: at most 5 fired nudges per local day. */
const DAILY_FIRED_CAP = 5;
/** SPEC §4.3/§5.2: paste-heavy prompt threshold (chars). */
const OVERSIZED_PASTE_CHARS = 8000;
const VAGUE_MAX_CHARS = 100;
const TOPIC_MAX_CHARS = 90;
const KEYWORD_MIN_CHARS = 5;

const OVERSIZED_MESSAGE =
  'Note: this prompt embeds a large paste. Past sessions saved tokens when Claude read files ' +
  'by path instead. If the pasted content exists on disk in this project, prefer referencing ' +
  'the file path.';

const VAGUE_MESSAGE =
  "Note: this project's past sessions show rework when the opening prompt lacks constraints " +
  '(files, scope, acceptance criteria). If the request is ambiguous, a single clarifying ' +
  'question is warranted before starting work.';

function conventionMessage(topic: string): string {
  return (
    `Note: this project's past sessions show rework when ${topic} is unstated. ` +
    'If the request is ambiguous on this, a single clarifying question is warranted.'
  );
}

/**
 * Curated vague-opener lexicon. Precision over recall: a nudge that annoys
 * gets the tool uninstalled, which saves nothing (SPEC §5.4).
 */
const VAGUE_OPENERS = [
  'fix it',
  'fix this',
  'make it work',
  "doesn't work",
  'clean this up',
  'improve this',
  'improve it',
  'make it better',
  'optimize this',
  'do this',
  'refactor this',
  "it's broken",
  'its broken',
  'still broken',
];

/**
 * Words that never count as a "meaningful keyword" for convention-topic
 * matching. Includes generic instruction boilerplate common in findings
 * suggestions ("prefer", "specify", "project", ...) so a nudge only fires
 * on genuinely shared subject matter.
 */
const STOPWORDS = new Set([
  'about',
  'above',
  'across',
  'actually',
  'after',
  'again',
  'against',
  'along',
  'already',
  'also',
  'although',
  'always',
  'among',
  'anything',
  'around',
  'because',
  'before',
  'being',
  'below',
  'beside',
  'besides',
  'between',
  'beyond',
  'cannot',
  'change',
  'changed',
  'changes',
  'claude',
  'consider',
  'convention',
  'conventions',
  'could',
  'create',
  'created',
  'creates',
  'creating',
  'doesn',
  'doing',
  'during',
  'either',
  'ensure',
  'every',
  'everything',
  'explicit',
  'explicitly',
  'files',
  'first',
  'follow',
  'following',
  'further',
  'having',
  'include',
  'included',
  'includes',
  'instead',
  'itself',
  'least',
  'makes',
  'making',
  'maybe',
  'might',
  'never',
  'nothing',
  'often',
  'other',
  'others',
  'otherwise',
  'please',
  'prefer',
  'preference',
  'preferences',
  'preferred',
  'prefers',
  'project',
  'projects',
  'rather',
  'really',
  'recommend',
  'recommended',
  'request',
  'session',
  'sessions',
  'shall',
  'should',
  'since',
  'something',
  'specified',
  'specify',
  'stated',
  'still',
  'suggest',
  'suggested',
  'suggestion',
  'their',
  'theirs',
  'there',
  'these',
  'thing',
  'things',
  'think',
  'those',
  'through',
  'under',
  'unless',
  'unstated',
  'until',
  'update',
  'updated',
  'updates',
  'using',
  'wants',
  'whatever',
  'where',
  'whether',
  'which',
  'while',
  'whose',
  'within',
  'without',
  'would',
  'write',
  'writing',
  'written',
  'yours',
]);

function suppressed(reason: string): NudgeDecision {
  return { message: null, pattern: 'none', suppressReason: reason };
}

/** Tokenize into lowercase alphanumeric words ≥5 chars, minus stopwords. */
function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const w = m[0];
    if (w.length >= KEYWORD_MIN_CHARS && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * Reduce a finding's suggestion to a short topic phrase: first sentence,
 * capped at 90 chars on a word boundary, trailing punctuation stripped,
 * leading capital lowered so it reads inside the nudge sentence.
 */
function topicFrom(suggestion: unknown, claudeMdLine: unknown): string | null {
  const src =
    (typeof suggestion === 'string' && suggestion.trim()) ||
    (typeof claudeMdLine === 'string' && claudeMdLine.trim()) ||
    '';
  if (!src) return null;
  const m = /^[^.!?\n]+/.exec(src);
  let topic = (m ? m[0] : src).trim();
  if (topic.length > TOPIC_MAX_CHARS) {
    topic = topic.slice(0, TOPIC_MAX_CHARS);
    const lastSpace = topic.lastIndexOf(' ');
    if (lastSpace > TOPIC_MAX_CHARS / 2) topic = topic.slice(0, lastSpace);
  }
  topic = topic.replace(/[\s.,;:!?-]+$/, '').trim();
  if (/^[A-Z][a-z]/.test(topic)) topic = topic[0].toLowerCase() + topic.slice(1);
  return topic.length > 0 ? topic : null;
}

/**
 * Pattern (b): known missing-convention topics learned offline for this
 * project (SPEC §5.2). Fires only when the prompt shares at least one
 * meaningful keyword with a finding's topic.
 */
function matchConvention(db: DB, project: string, prompt: string): string | null {
  if (!project) return null;
  const promptKw = keywords(prompt);
  if (promptKw.size === 0) return null;
  const rows = db
    .prepare(
      `SELECT f.suggestion AS suggestion, f.claude_md_line AS claude_md_line
       FROM findings f JOIN sessions s ON f.session_id = s.id
       WHERE s.project = ? AND f.category = 'missing_convention'
       ORDER BY f.confidence DESC, f.id ASC`
    )
    .all(project) as Array<{ suggestion: unknown; claude_md_line: unknown }>;
  for (const row of rows) {
    const topic = topicFrom(row.suggestion, row.claude_md_line);
    if (!topic) continue;
    for (const kw of keywords(topic)) {
      if (promptKw.has(kw)) return topic;
    }
  }
  return null;
}

/** Pattern (c): short prompt, no path-like token, matches the vague lexicon. */
function isVagueOpening(prompt: string): boolean {
  if (prompt.length >= VAGUE_MAX_CHARS) return false;
  // Path-like tokens signal the user did anchor the request to a file.
  if (prompt.includes('/') || prompt.includes('\\')) return false;
  if (/\.[a-z0-9]/i.test(prompt)) return false;
  const norm = prompt.toLowerCase().replace(/[‘’]/g, "'");
  return VAGUE_OPENERS.some((opener) => norm.includes(opener));
}

function evaluate(db: DB, sessionId: string, project: string, prompt: string): NudgeDecision {
  // First prompt of the session only; doubles as the 1-nudge-per-session cap.
  const prior = db
    .prepare('SELECT 1 FROM nudges WHERE session_id = ? LIMIT 1')
    .get(sessionId);
  if (prior !== undefined) return suppressed('not_first_prompt');

  const mutedRaw = metaGet(db, 'muted_until');
  if (mutedRaw !== null) {
    const mutedUntil = Number(mutedRaw);
    if (Number.isFinite(mutedUntil) && mutedUntil > Date.now()) return suppressed('muted');
  }

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const firedToday = (
    db
      .prepare('SELECT COUNT(*) AS c FROM nudges WHERE fired = 1 AND ts >= ?')
      .get(midnight.getTime()) as { c: number }
  ).c;
  if (firedToday >= DAILY_FIRED_CAP) return suppressed('daily_cap');

  // Pattern scan — at most one nudge, first match wins.
  if (prompt.length > OVERSIZED_PASTE_CHARS && prompt.includes('```')) {
    return { message: OVERSIZED_MESSAGE, pattern: 'oversized_paste' };
  }

  const topic = matchConvention(db, project, prompt);
  if (topic !== null) {
    return { message: conventionMessage(topic), pattern: 'missing_convention' };
  }

  if (isVagueOpening(prompt)) {
    return { message: VAGUE_MESSAGE, pattern: 'vague_opening' };
  }

  return suppressed('no_match');
}

function logNudge(
  db: DB,
  sessionId: string,
  project: string,
  decision: NudgeDecision
): void {
  db.prepare(
    'INSERT INTO nudges (session_id, project, ts, fired, pattern, message) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    sessionId,
    project,
    Date.now(),
    decision.message !== null ? 1 : 0,
    decision.message !== null ? decision.pattern : decision.suppressReason ?? 'none',
    decision.message
  );
}

/**
 * Legacy pure heuristic evaluator retained for report/migration compatibility.
 * The live hook entrypoint below uses decideNudgeWithLlm instead.
 */
export function decideNudge(db: DB, input: HookInput): NudgeDecision {
  try {
    const prompt = input && typeof input.prompt === 'string' ? input.prompt : '';
    if (prompt.trim().length === 0) return suppressed('no_prompt');

    const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
    const project = typeof input.cwd === 'string' ? input.cwd : '';

    const decision = evaluate(db, sessionId, project, prompt);

    // Audit trail for the report's suggestions digest (SPEC §5.3). Suppressed
    // rows record the reason in `pattern` so the digest can break them down.
    logNudge(db, sessionId, project, decision);

    return decision;
  } catch {
    // A locked DB or malformed input must never surface: stay silent.
    return suppressed('internal_error');
  }
}

/**
 * Live hook decision path. Local code only enforces mute/rate limits; the
 * hosted model makes the prompt-quality decision. Any API failure fails open.
 */
export async function decideNudgeWithLlm(
  db: DB,
  input: HookInput,
  reviewer: PromptReviewer = reviewPromptWithLlm
): Promise<NudgeDecision> {
  try {
    const prompt = input && typeof input.prompt === 'string' ? input.prompt : '';
    if (prompt.trim().length === 0) return suppressed('no_prompt');
    const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
    const project = typeof input.cwd === 'string' ? input.cwd : '';

    const trigger = /^review:\s*/i.exec(prompt);
    if (trigger === null) {
      const decision = suppressed('review_not_requested');
      logNudge(db, sessionId, project, decision);
      return decision;
    }
    const promptToReview = prompt.slice(trigger[0].length).trim();
    if (!promptToReview) {
      const decision = {
        pattern: 'empty_review',
        message: '🟡 ADD A PROMPT\n\nPut the prompt you want reviewed after  review:',
      };
      logNudge(db, sessionId, project, decision);
      return decision;
    }

    const bypass = metaGet(db, 'hook_bypass');
    if (bypass === 'on' || bypass === 'next') {
      if (bypass === 'next') metaSet(db, 'hook_bypass', 'off');
      const decision = suppressed(bypass === 'next' ? 'bypass_next' : 'bypass_on');
      logNudge(db, sessionId, project, decision);
      return decision;
    }

    const mutedRaw = metaGet(db, 'muted_until');
    if (mutedRaw !== null && Number(mutedRaw) > Date.now()) {
      const decision = suppressed('muted');
      logNudge(db, sessionId, project, decision);
      return decision;
    }

    const review = await reviewer(promptToReview, project);
    let decision: NudgeDecision;
    if (review === null) {
      decision = {
        pattern: 'llm_unavailable',
        message:
          '🔴 REVIEW UNAVAILABLE\n\nPrompt not sent. Check the configured API key or network; remove  review:  to send without review.',
      };
    } else {
      decision = {
        pattern: review.category,
        message: `${review.needsImprovement ? '🟡 SUGGESTION' : '🟢 READY'}\n\n${review.feedback}`,
      };
    }
    logNudge(db, sessionId, project, decision);
    return decision;
  } catch {
    return suppressed('internal_error');
  }
}

/**
 * Hook entrypoint: reads HookInput JSON from stdin, asks the configured hosted
 * model only when the prompt begins with `review:`. Reviewed prompts are
 * blocked with feedback; ordinary prompts proceed directly to the coding model.
 */
export async function runHookMain(): Promise<void> {
  loadEnvFiles();
  let db: DB | null = null;
  try {
    process.stdin.setEncoding('utf8');
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw) as HookInput;
    db = openDb();
    const decision = await decideNudgeWithLlm(db, input);
    const output = renderHookOutput(decision);
    if (output !== null) process.stdout.write(output + '\n');
  } catch {
    // A failure before a decision cannot safely emit malformed hook output.
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // Best-effort close; never let cleanup produce a non-zero exit.
      }
    }
  }
}

if (require.main === module) {
  // Structured JSON performs intentional blocking; process failures still exit 0.
  runHookMain().catch(() => process.exit(0));
}
