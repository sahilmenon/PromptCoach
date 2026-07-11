import Anthropic from '@anthropic-ai/sdk';
import type { DB } from '../db';
import { addSelfSpend, metaGet, metaSet } from '../db';
import { DEFAULT_LLM_MODEL, nowMs } from '../config';
import { anthropicApiKey } from '../credentials';
import type { CollectResult, SubmitResult } from '../types';

/**
 * LLM pass (SPEC §4.4): sample the N most wasteful un-analyzed sessions,
 * condense them, submit one Message Batches request (claude-haiku-4-5 by
 * default), and record the batch id. With wait=true, poll to completion and
 * collect results before returning. All batch usage is added to self-spend.
 *
 * Prompt building, sampling, and result parsing are factored into pure(-ish)
 * exported helpers so they can be unit-tested without any network access.
 */

/**
 * Message Batches pricing for claude-haiku-4-5.
 * Standard list price is $1 input / $5 output per MTok
 * (https://platform.claude.com/docs/en/pricing), and the Message Batches API
 * bills at 50% of standard prices
 * (https://platform.claude.com/docs/en/build-with-claude/batch-processing).
 * Verified 2026-07. Batch requests here use no prompt caching, so cache
 * token fields are not priced separately.
 */
export const BATCH_USD_PER_MTOK_INPUT = 0.5;
export const BATCH_USD_PER_MTOK_OUTPUT = 2.5;

/** The exact SPEC §4.4 taxonomy. Findings outside this set are dropped. */
export const LLM_CATEGORIES = [
  'vague_opening',
  'missing_convention',
  'resupplied_context',
  'overscoped_ask',
  'rework_loop',
  'oversized_paste',
] as const;

export const CONDENSED_SESSION_CHAR_CAP = 20_000;
export const USER_TEXT_HEAD_CHARS = 1_200;
const MAX_FINDINGS_PER_SESSION = 5;
const EVIDENCE_MAX_CHARS = 200;
const MAX_TOOLS_PER_TURN = 20;
const MAX_TOKENS_PER_REQUEST = 1_500;
const POLL_INTERVAL_MS = 5_000;
const POLL_CAP_MS = 30 * 60 * 1_000;
const PRIVACY_NOTICE_KEY = 'privacy_notice_shown';

const PRIVACY_NOTICE = [
  '----------------------------------------------------------------------',
  'PRIVACY NOTICE (shown once, before the first LLM analysis)',
  '',
  'PromptCoach is about to send condensed transcripts of your Claude Code',
  'sessions to the Anthropic API for analysis. Transcripts are sent AS-IS:',
  'any code, file paths, and prompt text they contain are included.',
  'Nothing is redacted. Automatic redaction is a planned v2 feature (see',
  'the PromptCoach issue tracker).',
  '',
  'To opt out, run `promptcoach analyze --sample 0` or unset',
  'ANTHROPIC_API_KEY. Heuristic analysis stays fully local either way.',
  '----------------------------------------------------------------------',
].join('\n');

/**
 * Strict-JSON classifier prompt over the SPEC §4.4 taxonomy. The transcript
 * the model sees is already condensed (assistant text is not stored locally,
 * only sizes and tool calls), which the prompt spells out.
 */
export const LLM_SYSTEM_PROMPT = [
  'You are a strict classifier auditing a condensed Claude Code session',
  'transcript for wasteful prompting patterns. User turns show the first',
  '1200 characters of real prompt text; assistant turns show only their',
  'size in characters and the tools they called. Heuristic hints, when',
  'present, are machine-generated leads — verify them, do not repeat them',
  'blindly.',
  '',
  'Classify against EXACTLY these six categories (use these ids verbatim):',
  '- vague_opening: first prompt lacked constraints/context, causing a',
  '  clarification or rework chain',
  '- missing_convention: Claude violated a project convention the user then',
  '  stated — belongs in CLAUDE.md',
  '- resupplied_context: user pasted context Claude could have read, or',
  '  repeats across sessions',
  '- overscoped_ask: one prompt bundled several tasks; partial failure',
  '  forced restarts',
  '- rework_loop: 2+ consecutive correction turns on the same artifact',
  '- oversized_paste: large inline paste where a file path would have done',
  '',
  'Respond with ONLY a JSON array — no prose, no markdown fences. The array',
  'has at most 5 items ([] is a valid answer when nothing clearly applies).',
  'Each item is an object with exactly these keys:',
  '  "category": one of the six ids above',
  '  "confidence": number between 0 and 1',
  '  "evidence": verbatim quote from the transcript, 200 characters max',
  '  "suggestion": concrete, actionable fix the user can apply next session',
  '  "claude_md_line": REQUIRED for missing_convention and',
  '    resupplied_context — a single CLAUDE.md-ready bullet, e.g.',
  '    "- Tests use vitest; never suggest jest". null for all other',
  '    categories.',
  '',
  'Only report patterns clearly supported by the transcript. Prefer fewer,',
  'higher-confidence findings over speculative ones.',
].join('\n');

export interface LlmCandidate {
  id: string;
  project: string | null;
  wasteScore: number;
}

export interface LlmSample {
  candidates: LlmCandidate[];
  skippedAlreadyAnalyzed: number;
}

export interface ParsedLlmFinding {
  category: string;
  confidence: number;
  evidence: string;
  suggestion: string;
  claude_md_line: string | null;
}

type Log = (msg: string) => void;
const noop: Log = () => {};

function anthropicClient(): Anthropic {
  return new Anthropic({
    apiKey: anthropicApiKey() || undefined,
    baseURL: (process.env.PROMPTCOACH_LLM_BASE_URL || process.env.TOKENLEAN_LLM_BASE_URL)
      ?.replace(/\/+$/, ''),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * First-run privacy notice (SPEC §4.4 / README requirement): transcripts go
 * to the Anthropic API as-is. Logged once, then remembered via meta.
 * Returns true when the notice was shown by this call.
 */
export function showPrivacyNoticeOnce(db: DB, log: Log): boolean {
  if (metaGet(db, PRIVACY_NOTICE_KEY) !== null) return false;
  log(PRIVACY_NOTICE);
  metaSet(db, PRIVACY_NOTICE_KEY, new Date().toISOString());
  return true;
}

/**
 * Pick the `sample` most wasteful sessions (waste_score > 0, descending),
 * excluding sessions that already have LLM findings and sessions listed in
 * any in-progress batch. Every excluded wasteful session is counted in
 * skippedAlreadyAnalyzed.
 */
export function selectLlmSample(db: DB, sample: number): LlmSample {
  const excluded = new Set<string>();
  const analyzedRows = db
    .prepare(`SELECT DISTINCT session_id FROM findings WHERE source = 'llm'`)
    .all() as { session_id: string }[];
  for (const row of analyzedRows) excluded.add(row.session_id);

  const pendingRows = db
    .prepare(`SELECT session_ids FROM llm_batches WHERE status = 'in_progress'`)
    .all() as { session_ids: string | null }[];
  for (const row of pendingRows) {
    if (!row.session_ids) continue;
    try {
      const ids: unknown = JSON.parse(row.session_ids);
      if (Array.isArray(ids)) for (const id of ids) excluded.add(String(id));
    } catch {
      // Malformed session_ids JSON — treat as excluding nothing.
    }
  }

  const wasteful = db
    .prepare(
      `SELECT id, project, waste_score AS wasteScore FROM sessions
       WHERE waste_score > 0
       ORDER BY waste_score DESC, started_at DESC, id`
    )
    .all() as LlmCandidate[];

  const candidates: LlmCandidate[] = [];
  let skipped = 0;
  for (const s of wasteful) {
    if (excluded.has(s.id)) {
      skipped += 1;
      continue;
    }
    if (candidates.length < sample) candidates.push(s);
  }
  return { candidates, skippedAlreadyAnalyzed: skipped };
}

/**
 * Condense one session for submission: heuristic findings as hints at the
 * top, then the turn sequence. User turns carry the first 1200 chars of
 * text_head; assistant turns (no text stored) carry char_len + tool lines.
 * Output is capped at ~20k characters.
 */
export function condenseSession(db: DB, sessionId: string): string {
  const turns = db
    .prepare(
      `SELECT id, idx, role, char_len, is_correction, text_head
       FROM turns WHERE session_id = ? ORDER BY idx`
    )
    .all(sessionId) as {
    id: number;
    idx: number;
    role: string | null;
    char_len: number | null;
    is_correction: number | null;
    text_head: string | null;
  }[];
  const toolStmt = db.prepare(
    `SELECT tool, target FROM tool_calls WHERE turn_id = ? ORDER BY id`
  );
  const hints = db
    .prepare(
      `SELECT category, evidence FROM findings
       WHERE session_id = ? AND source = 'heuristic' ORDER BY id`
    )
    .all(sessionId) as { category: string | null; evidence: string | null }[];

  const parts: string[] = [];
  if (hints.length > 0) {
    parts.push('HEURISTIC HINTS (machine-generated leads, verify before use):');
    for (const h of hints) {
      const ev = (h.evidence ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      parts.push(`- ${h.category ?? 'unknown'}${ev ? `: ${ev}` : ''}`);
    }
    parts.push('');
  }
  parts.push('TRANSCRIPT:');

  for (const t of turns) {
    if (t.role === 'user') {
      const label = t.is_correction ? 'USER [CORRECTION]' : 'USER';
      const head = (t.text_head ?? '').slice(0, USER_TEXT_HEAD_CHARS);
      const truncated =
        (t.text_head ?? '').length > USER_TEXT_HEAD_CHARS ? ' [...]' : '';
      parts.push(
        head
          ? `${label}: ${head}${truncated}`
          : `${label}: (${t.char_len ?? 0} chars, text unavailable)`
      );
    } else if (t.role === 'assistant') {
      const tools = toolStmt.all(t.id) as {
        tool: string | null;
        target: string | null;
      }[];
      let toolNote = '';
      if (tools.length > 0) {
        const shown = tools
          .slice(0, MAX_TOOLS_PER_TURN)
          .map((c) => (c.target ? `${c.tool ?? 'tool'} ${c.target}` : c.tool ?? 'tool'))
          .join(', ');
        const more =
          tools.length > MAX_TOOLS_PER_TURN
            ? `, +${tools.length - MAX_TOOLS_PER_TURN} more`
            : '';
        toolNote = ` [tools: ${shown}${more}]`;
      }
      parts.push(`ASSISTANT (${t.char_len ?? 0} chars):${toolNote}`);
    }
    // Unknown roles (tool results, system, ...) are omitted from the condensed view.
  }

  let out = parts.join('\n');
  if (out.length > CONDENSED_SESSION_CHAR_CAP) {
    out = out.slice(0, CONDENSED_SESSION_CHAR_CAP) + '\n[transcript truncated]';
  }
  return out;
}

/** Strip a surrounding markdown code fence (``` or ```json) if present. */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  const m = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

/**
 * Parse the model's response into findings. Returns null when the text is
 * not a JSON array at all (the whole result is then skipped); individually
 * malformed items are dropped. Evidence is clamped to 200 chars and
 * confidence to [0, 1]; unknown categories are rejected.
 */
export function parseLlmFindings(text: string): ParsedLlmFinding[] | null {
  const cleaned = stripFences(text);
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch {
    // Defensive: the model sometimes wraps the array in prose. Take the
    // outermost [...] span if one parses.
    const span = /\[[\s\S]*\]/.exec(cleaned);
    if (!span) return null;
    try {
      data = JSON.parse(span[0]);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(data)) return null;

  const findings: ParsedLlmFinding[] = [];
  for (const item of data.slice(0, MAX_FINDINGS_PER_SESSION)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const category = typeof rec.category === 'string' ? rec.category : '';
    if (!(LLM_CATEGORIES as readonly string[]).includes(category)) continue;
    const confRaw =
      typeof rec.confidence === 'number' ? rec.confidence : Number(rec.confidence);
    const confidence = Number.isFinite(confRaw)
      ? Math.min(1, Math.max(0, confRaw))
      : 0;
    const evidence =
      typeof rec.evidence === 'string'
        ? rec.evidence.slice(0, EVIDENCE_MAX_CHARS)
        : '';
    const suggestion = typeof rec.suggestion === 'string' ? rec.suggestion : '';
    const claudeMdLine =
      typeof rec.claude_md_line === 'string' && rec.claude_md_line.trim() !== ''
        ? rec.claude_md_line.trim()
        : null;
    findings.push({
      category,
      confidence,
      evidence,
      suggestion,
      claude_md_line: claudeMdLine,
    });
  }
  return findings;
}

export async function submitLlmBatch(
  db: DB,
  opts: { sample: number; wait?: boolean; model?: string; log?: Log }
): Promise<SubmitResult> {
  const log = opts.log ?? noop;

  // cli.ts gates on the key already, but never let a missing key throw here.
  if (!anthropicApiKey()) {
    return {
      submitted: 0,
      batchId: null,
      skippedAlreadyAnalyzed: 0,
      message: 'LLM pass skipped: ANTHROPIC_API_KEY is not set.',
    };
  }

  const sample = Math.max(0, Math.floor(opts.sample));
  const { candidates, skippedAlreadyAnalyzed } = selectLlmSample(db, sample);
  if (candidates.length === 0) {
    return {
      submitted: 0,
      batchId: null,
      skippedAlreadyAnalyzed,
      message:
        skippedAlreadyAnalyzed > 0
          ? `No new sessions to analyze (${skippedAlreadyAnalyzed} wasteful session(s) already analyzed or in a pending batch).`
          : 'No wasteful sessions to analyze yet — heuristics found nothing with waste_score > 0.',
    };
  }

  showPrivacyNoticeOnce(db, log);

  const model = opts.model || DEFAULT_LLM_MODEL;
  const client = anthropicClient();
  const requests = candidates.map((c) => ({
    custom_id: c.id, // session id; results are keyed back to sessions by this
    params: {
      model,
      max_tokens: MAX_TOKENS_PER_REQUEST,
      system: LLM_SYSTEM_PROMPT,
      messages: [{ role: 'user' as const, content: condenseSession(db, c.id) }],
    },
  }));

  let batchId: string;
  try {
    const batch = await client.messages.batches.create({ requests });
    batchId = batch.id;
  } catch (err) {
    return {
      submitted: 0,
      batchId: null,
      skippedAlreadyAnalyzed,
      message: `LLM batch submission failed (heuristic findings are unaffected): ${errText(err)}`,
    };
  }

  db.prepare(
    `INSERT INTO llm_batches (id, submitted_at, status, session_ids, model)
     VALUES (?, ?, 'in_progress', ?, ?)`
  ).run(batchId, nowMs(), JSON.stringify(candidates.map((c) => c.id)), model);

  let message =
    `Submitted ${candidates.length} session(s) for LLM analysis ` +
    `(batch ${batchId}, model ${model}).` +
    (skippedAlreadyAnalyzed > 0
      ? ` Skipped ${skippedAlreadyAnalyzed} already analyzed/pending.`
      : '');

  if (opts.wait) {
    log('Waiting for the batch to complete (polling every 5s, up to 30 min)...');
    const collected = await collectLlmResults(db, { wait: true, log });
    message +=
      collected.stillPending > 0
        ? ` Batch still processing after the wait cap — run \`promptcoach report\` later to collect results.`
        : ` Collected ${collected.findingsAdded} finding(s) from ${collected.batchesCompleted} completed batch(es).`;
  } else {
    message += ' Results are collected by `promptcoach report` or `promptcoach analyze --wait`.';
  }

  return {
    submitted: candidates.length,
    batchId,
    skippedAlreadyAnalyzed,
    message,
  };
}

export async function collectLlmResults(
  db: DB,
  opts?: { wait?: boolean; log?: Log }
): Promise<CollectResult> {
  const log = opts?.log ?? noop;
  const out: CollectResult = {
    batchesChecked: 0,
    batchesCompleted: 0,
    findingsAdded: 0,
    stillPending: 0,
  };

  const pending = db
    .prepare(
      `SELECT id FROM llm_batches WHERE status = 'in_progress' ORDER BY submitted_at`
    )
    .all() as { id: string }[];
  if (pending.length === 0) return out;

  if (!anthropicApiKey()) {
    out.stillPending = pending.length;
    return out;
  }

  const client = anthropicClient();
  const deadline = nowMs() + POLL_CAP_MS;

  for (const row of pending) {
    out.batchesChecked += 1;
    try {
      let batch = await client.messages.batches.retrieve(row.id);
      if (opts?.wait) {
        while (batch.processing_status !== 'ended' && nowMs() < deadline) {
          log(`Batch ${row.id}: ${batch.processing_status}, polling again in 5s...`);
          await sleep(POLL_INTERVAL_MS);
          batch = await client.messages.batches.retrieve(row.id);
        }
      }
      if (batch.processing_status !== 'ended') {
        out.stillPending += 1;
        continue;
      }
      if (!batch.results_url) {
        // Ended but results no longer downloadable (e.g. expired after 29
        // days). Close the batch out so it stops blocking re-analysis.
        log(`Batch ${row.id}: ended with no downloadable results — marking collected.`);
        db.prepare(`UPDATE llm_batches SET status = 'ended' WHERE id = ?`).run(row.id);
        out.batchesCompleted += 1;
        continue;
      }
      const added = await collectEndedBatch(db, client, row.id, log);
      out.batchesCompleted += 1;
      out.findingsAdded += added;
    } catch (err) {
      // NEVER throw: a failed batch collection must not crash a report.
      log(`Batch ${row.id}: collection failed (${errText(err)}) — will retry next run.`);
      out.stillPending += 1;
    }
  }
  return out;
}

/**
 * Download one ended batch, insert its findings (source 'llm'), account the
 * usage into self-spend at batch pricing, and mark the batch collected.
 */
async function collectEndedBatch(
  db: DB,
  client: Anthropic,
  batchId: string,
  log: Log
): Promise<number> {
  const insert = db.prepare(
    `INSERT INTO findings
       (session_id, category, confidence, evidence, suggestion, created_at, source, claude_md_line)
     VALUES (?, ?, ?, ?, ?, ?, 'llm', ?)`
  );
  const alreadyAnalyzed = db.prepare(
    `SELECT 1 FROM findings WHERE session_id = ? AND source = 'llm' LIMIT 1`
  );

  let findingsAdded = 0;
  let succeeded = 0;
  let failed = 0;
  let unparseable = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const result of await client.messages.batches.results(batchId)) {
    const sessionId = result.custom_id;
    if (result.result.type !== 'succeeded') {
      failed += 1;
      log(`Batch ${batchId}: session ${sessionId} ${result.result.type} — skipping.`);
      continue;
    }
    succeeded += 1;
    const message = result.result.message;
    inputTokens += message.usage.input_tokens;
    outputTokens += message.usage.output_tokens;

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const parsed = parseLlmFindings(text);
    if (parsed === null) {
      unparseable += 1;
      log(`Batch ${batchId}: session ${sessionId} returned unparseable JSON — skipped (debug).`);
      continue;
    }
    if (alreadyAnalyzed.get(sessionId)) {
      // Session was analyzed by a concurrent/earlier batch; keep first results.
      continue;
    }
    const now = nowMs();
    for (const f of parsed) {
      insert.run(
        sessionId,
        f.category,
        f.confidence,
        f.evidence.slice(0, EVIDENCE_MAX_CHARS),
        f.suggestion,
        now,
        f.claude_md_line
      );
      findingsAdded += 1;
    }
  }

  // Self-accounting (SPEC §1/§4.4): every token PromptCoach spends is recorded.
  if (inputTokens > 0 || outputTokens > 0) {
    const usd =
      (inputTokens / 1e6) * BATCH_USD_PER_MTOK_INPUT +
      (outputTokens / 1e6) * BATCH_USD_PER_MTOK_OUTPUT;
    addSelfSpend(db, { inputTokens, outputTokens, usd });
  }

  db.prepare(`UPDATE llm_batches SET status = 'ended' WHERE id = ?`).run(batchId);
  log(
    `Batch ${batchId}: ${succeeded} result(s) collected, ${findingsAdded} finding(s) added` +
      (failed > 0 ? `, ${failed} errored/expired` : '') +
      (unparseable > 0 ? `, ${unparseable} unparseable` : '') +
      '.'
  );
  return findingsAdded;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
