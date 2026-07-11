import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addSelfSpend, metaGet, metaSet, metaSetJson, openDb, type DB } from '../src/db';
import { buildReport, fmtTokens, renderReport } from '../src/report/report';
import {
  CONDENSED_SESSION_CHAR_CAP,
  condenseSession,
  parseLlmFindings,
  selectLlmSample,
  showPrivacyNoticeOnce,
  stripFences,
} from '../src/analyzer/llm';
import { ESTIMATE_LABEL } from '../src/constants';

const NOW = Date.now();
const DAY = 86_400_000;

let tmpDir: string;
let db: DB;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenlean-report-'));
  db = openDb(path.join(tmpDir, 'db.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedSession(
  id: string,
  startedAt: number,
  opts: { project?: string; wasteScore?: number } = {}
): void {
  db.prepare(
    `INSERT INTO sessions (id, project, started_at, ended_at, model, turn_count, abandoned, waste_score)
     VALUES (?, ?, ?, ?, 'claude-sonnet-4-6', 0, 0, ?)`
  ).run(id, opts.project ?? '/tmp/projA', startedAt, startedAt + 1_000, opts.wasteScore ?? 0);
}

interface TurnOpts {
  role: 'user' | 'assistant';
  isCorrection?: boolean;
  textHead?: string | null;
  charLen?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function seedTurn(sessionId: string, idx: number, o: TurnOpts): number {
  const info = db
    .prepare(
      `INSERT INTO turns (session_id, idx, role, ts, char_len, is_correction,
                          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                          text_head, has_fence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(
      sessionId,
      idx,
      o.role,
      NOW,
      o.charLen ?? o.textHead?.length ?? 0,
      o.isCorrection ? 1 : 0,
      o.input ?? null,
      o.output ?? null,
      o.cacheRead ?? null,
      o.cacheWrite ?? null,
      o.textHead ?? null
    );
  return Number(info.lastInsertRowid);
}

function seedFinding(
  sessionId: string,
  category: string,
  opts: {
    confidence?: number;
    evidence?: string;
    suggestion?: string;
    source?: 'heuristic' | 'llm';
    createdAt?: number;
    claudeMdLine?: string | null;
  } = {}
): void {
  db.prepare(
    `INSERT INTO findings (session_id, category, confidence, evidence, suggestion, created_at, source, claude_md_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    category,
    opts.confidence ?? 0.5,
    opts.evidence ?? 'some evidence',
    opts.suggestion ?? 'some suggestion',
    opts.createdAt ?? NOW,
    opts.source ?? 'heuristic',
    opts.claudeMdLine ?? null
  );
}

function seedNudge(sessionId: string, ts: number, fired: boolean): void {
  db.prepare(
    `INSERT INTO nudges (session_id, project, ts, fired, pattern, message)
     VALUES (?, '/tmp/projA', ?, ?, 'vague_opening', 'Note: past sessions show rework here.')`
  ).run(sessionId, ts, fired ? 1 : 0);
}

function seedUsageEvent(
  ts: number,
  o: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
): void {
  db.prepare(
    `INSERT INTO usage_events (ts, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, request_path, streaming)
     VALUES (?, 'claude-sonnet-4-6', ?, ?, ?, ?, '/v1/messages', 1)`
  ).run(ts, o.input ?? 0, o.output ?? 0, o.cacheRead ?? 0, o.cacheWrite ?? 0);
}

function seedBatch(id: string, status: 'in_progress' | 'ended', sessionIds: string[]): void {
  db.prepare(
    `INSERT INTO llm_batches (id, submitted_at, status, session_ids, model)
     VALUES (?, ?, ?, ?, 'claude-haiku-4-5')`
  ).run(id, NOW, status, JSON.stringify(sessionIds));
}

/** Two sessions with a mix of turns; returns nothing, numbers asserted inline. */
function seedBasicUsage(): void {
  seedSession('s1', NOW - 1 * DAY);
  seedTurn('s1', 0, { role: 'user', textHead: 'Fix the login bug' });
  seedTurn('s1', 1, { role: 'assistant', input: 1_000, output: 500, cacheRead: 8_000, cacheWrite: 1_000 });
  seedTurn('s1', 2, { role: 'user', isCorrection: true, textHead: 'no, actually revert that' });
  seedTurn('s1', 3, { role: 'assistant', input: 2_000, output: 500 });
  seedSession('s2', NOW - 2 * DAY);
  seedTurn('s2', 0, { role: 'user', textHead: 'Add a test' });
  seedTurn('s2', 1, { role: 'assistant', input: 500, output: 500 });
}

describe('buildReport scorecard', () => {
  it('computes exact session/turn/correction/token numbers from transcripts', () => {
    seedBasicUsage();
    const data = buildReport(db);
    const sc = data.scorecard;

    expect(sc.sessions).toBe(2);
    expect(sc.userTurns).toBe(3);
    expect(sc.assistantTurns).toBe(3);
    expect(sc.correctionTurns).toBe(1);
    expect(sc.correctionRate).toBeCloseTo(1 / 3, 10);
    expect(sc.inputTokens).toBe(3_500);
    expect(sc.outputTokens).toBe(1_500);
    expect(sc.cacheReadTokens).toBe(8_000);
    expect(sc.cacheWriteTokens).toBe(1_000);
    // 3500 + 1500 + 1000 + 0.1 * 8000
    expect(sc.effTokens).toBeCloseTo(6_800, 6);
    expect(sc.baselineCorrectionRate).toBeNull();
    expect(sc.correctionDelta).toBeNull();
  });

  it('derives cache hit rate from transcripts when no proxy data exists', () => {
    seedBasicUsage();
    const sc = buildReport(db).scorecard;
    // 8000 / (8000 + 1000 + 3500)
    expect(sc.cacheHitRate).toBeCloseTo(8_000 / 12_500, 10);
    expect(sc.cacheHitSource).toBe('transcripts');
  });

  it('uses transcript usage even when legacy usage rows exist', () => {
    seedBasicUsage();
    seedUsageEvent(NOW - 1 * DAY, { input: 1_000, cacheRead: 9_000 });
    seedUsageEvent(NOW - 1 * DAY, { input: 0, cacheRead: 0 });
    const sc = buildReport(db).scorecard;
    expect(sc.cacheHitRate).toBeCloseTo(0.64, 10);
    expect(sc.cacheHitSource).toBe('transcripts');
  });

  it('returns null cache hit rate when there is no token data at all', () => {
    seedSession('s1', NOW - DAY);
    seedTurn('s1', 0, { role: 'user', textHead: 'hello' });
    const sc = buildReport(db).scorecard;
    expect(sc.cacheHitRate).toBeNull();
    expect(sc.cacheHitSource).toBeNull();
  });

  it('window-filters sessions, turns, and usage events by sinceDays', () => {
    seedSession('recent', NOW - 1 * DAY);
    seedTurn('recent', 0, { role: 'user', textHead: 'hi' });
    seedTurn('recent', 1, { role: 'assistant', input: 100, output: 50 });
    seedSession('ancient', NOW - 30 * DAY);
    seedTurn('ancient', 0, { role: 'user', isCorrection: true, textHead: 'no' });
    seedTurn('ancient', 1, { role: 'assistant', input: 9_999, output: 9_999 });
    seedUsageEvent(NOW - 1 * DAY, { input: 10 });
    seedUsageEvent(NOW - 30 * DAY, { input: 99 });

    const data = buildReport(db, { sinceDays: 7 });
    expect(data.sinceDays).toBe(7);
    expect(data.scorecard.sessions).toBe(1);
    expect(data.scorecard.userTurns).toBe(1);
    expect(data.scorecard.correctionTurns).toBe(0);
    expect(data.scorecard.inputTokens).toBe(100);
  });

  it('compares the correction rate to the recorded baseline', () => {
    seedBasicUsage(); // correction rate 1/3
    metaSetJson(db, 'baseline', {
      recordedAt: NOW - 10 * DAY,
      windowStartMs: NOW - 17 * DAY,
      windowEndMs: NOW - 10 * DAY,
      sessions: 5,
      userTurns: 20,
      correctionTurns: 10,
      correctionRate: 0.5,
      tokensPerSession: 100_000,
      effTokensPerSession: 90_000,
    });
    const sc = buildReport(db).scorecard;
    expect(sc.baselineCorrectionRate).toBe(0.5);
    expect(sc.correctionDelta).toBeCloseTo(1 / 3 - 0.5, 10);
  });
});

describe('hook digest', () => {
  it('counts nudges since last_report_ts and lists recent fired ones', () => {
    seedNudge('s1', NOW - 2_000, true);
    seedNudge('s1', NOW - 1_000, true);
    seedNudge('s2', NOW - 500, false);
    metaSet(db, 'muted_until', String(NOW + 5 * DAY));

    const digest = buildReport(db).digest;
    expect(digest.invocations).toBe(3);
    expect(digest.fired).toBe(2);
    expect(digest.suppressed).toBe(1);
    expect(digest.recentFired).toHaveLength(2);
    expect(digest.recentFired[0].ts).toBe(NOW - 1_000); // most recent first
    expect(digest.mutedUntil).toBe(NOW + 5 * DAY);
  });

  it('resets the digest window after each report (last_report_ts updated)', () => {
    seedNudge('s1', NOW - 1_000, true);
    const first = buildReport(db);
    expect(first.digest.invocations).toBe(1);
    expect(Number(metaGet(db, 'last_report_ts'))).toBe(first.generatedAt);

    const second = buildReport(db);
    expect(second.digest.invocations).toBe(0);
    expect(second.digest.fired).toBe(0);
  });

  it('caps recentFired at 5 and ignores an expired mute', () => {
    for (let i = 0; i < 7; i++) seedNudge('s1', NOW - 10_000 + i, true);
    metaSet(db, 'muted_until', String(NOW - DAY));
    const digest = buildReport(db).digest;
    expect(digest.recentFired).toHaveLength(5);
    expect(digest.mutedUntil).toBeNull();
  });
});

describe('self-spend', () => {
  it('computes overhead as self tokens over all analyzed transcript tokens', () => {
    seedSession('s1', NOW - DAY);
    seedTurn('s1', 0, { role: 'assistant', input: 600_000, output: 400_000 });
    addSelfSpend(db, { inputTokens: 15_000, outputTokens: 5_000, usd: 0.05 });

    const spend = buildReport(db).selfSpend;
    expect(spend.inputTokens).toBe(15_000);
    expect(spend.outputTokens).toBe(5_000);
    expect(spend.usd).toBeCloseTo(0.05, 10);
    expect(spend.analyzedTokens).toBe(1_000_000);
    expect(spend.overheadPct).toBeCloseTo(2, 10);
  });

  it('reports null overhead when nothing has been analyzed', () => {
    const spend = buildReport(db).selfSpend;
    expect(spend.analyzedTokens).toBe(0);
    expect(spend.overheadPct).toBeNull();
  });
});

describe('findings groups', () => {
  it('groups by category, sorts by count, splits sources, caps examples at 3', () => {
    seedSession('s1', NOW - DAY);
    seedFinding('s1', 'rework_loop', { source: 'heuristic', confidence: 0.5 });
    seedFinding('s1', 'rework_loop', { source: 'heuristic', confidence: 0.6 });
    seedFinding('s1', 'rework_loop', { source: 'llm', confidence: 0.9, evidence: 'top' });
    seedFinding('s1', 'rework_loop', { source: 'llm', confidence: 0.2 });
    seedFinding('s1', 'vague_opening', { source: 'heuristic', confidence: 0.4 });

    const findings = buildReport(db).findings;
    expect(findings).toHaveLength(2);
    expect(findings[0].category).toBe('rework_loop');
    expect(findings[0].count).toBe(4);
    expect(findings[0].sources).toEqual({ heuristic: 2, llm: 2 });
    expect(findings[0].examples).toHaveLength(3);
    expect(findings[0].examples[0].confidence).toBe(0.9); // highest first
    expect(findings[0].examples[0].evidence).toBe('top');
    expect(findings[0].examples[0].project).toBe('/tmp/projA');
    expect(findings[1].category).toBe('vague_opening');
  });

  it('window-filters findings via their session start time', () => {
    seedSession('old', NOW - 30 * DAY);
    seedFinding('old', 'rework_loop');
    seedSession('new', NOW - DAY);
    seedFinding('new', 'vague_opening');
    const findings = buildReport(db, { sinceDays: 7 }).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('vague_opening');
  });
});

describe.skip('legacy pending batches', () => {
  it('counts only in_progress batches', () => {
    seedBatch('b1', 'in_progress', ['s1']);
    seedBatch('b2', 'ended', ['s2']);
    expect(buildReport(db).pendingBatches).toBe(1);
  });
});

describe('renderReport', () => {
  it('renders every section with the spec self-spend style, no ANSI codes', () => {
    seedBasicUsage();
    metaSetJson(db, 'baseline', {
      recordedAt: NOW,
      windowStartMs: NOW - 7 * DAY,
      windowEndMs: NOW,
      sessions: 2,
      userTurns: 10,
      correctionTurns: 5,
      correctionRate: 0.5,
      tokensPerSession: 10_000,
      effTokensPerSession: 1_000_000,
    });
    seedFinding('s1', 'missing_convention', {
      source: 'llm',
      confidence: 0.9,
      evidence: 'you always forget we use vitest',
      suggestion: 'record the test framework in CLAUDE.md',
      claudeMdLine: '- Tests use vitest; never suggest jest',
    });
    seedNudge('s1', NOW - 1_000, true);
    seedBatch('b1', 'in_progress', ['s2']);
    addSelfSpend(db, { inputTokens: 30_000, outputTokens: 11_200, usd: 0.03 });

    const text = renderReport(buildReport(db));

    for (const section of [
      'SCORECARD',
      'TOP FINDINGS',
      'PROPOSED CLAUDE.md ADDITIONS',
      'HOOK DIGEST',
      'SELF-SPEND',
      'ENVIRONMENTAL ESTIMATE',
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toContain('vs baseline 50.0%');
    expect(text).toMatch(
      /tokenlean spent 41\.2k tokens ≈ \$0\.03 analyzing [\d.]+k tokens — [\d.]+% overhead/
    );
    expect(text).toContain('> "you always forget we use vitest"');
    expect(text).toContain('(0.90 · llm)');
    expect(text).toContain('--- a/CLAUDE.md');
    expect(text).toContain('+- Tests use vitest; never suggest jest');
    expect(text).toContain('never modified');
    expect(text).toContain(ESTIMATE_LABEL);
    expect(text).not.toContain('tokenlean analyze --wait');
    // plain text only — no ANSI escapes
    expect(text).not.toMatch(/\x1b\[/);
  });

  it('renders friendly empty states', () => {
    const text = renderReport(buildReport(db));
    expect(text).toContain('hook not yet installed / no activity');
    expect(text).toContain('none yet');
    expect(text).toContain('baseline not recorded yet — savings appear after week 1');
    expect(text).not.toContain('LLM batch(es) still processing');
  });
});

describe('--json shape', () => {
  it('is stable, serializable, and carries the documented top-level keys', () => {
    seedBasicUsage();
    const data = buildReport(db, { sinceDays: 7 });
    const roundTripped = JSON.parse(JSON.stringify(data));
    expect(Object.keys(roundTripped).sort()).toEqual(
      [
        'claudeMdDiffs',
        'digest',
        'env',
        'findings',
        'generatedAt',
        'scorecard',
        'selfSpend',
        'sinceDays',
      ].sort()
    );
    expect(Object.keys(roundTripped.scorecard).sort()).toEqual(
      [
        'sessions',
        'userTurns',
        'assistantTurns',
        'correctionTurns',
        'correctionRate',
        'baselineCorrectionRate',
        'correctionDelta',
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'effTokens',
        'cacheHitRate',
        'cacheHitSource',
      ].sort()
    );
    expect(typeof roundTripped.generatedAt).toBe('number');
    expect(roundTripped.env.label).toBe(ESTIMATE_LABEL);
  });
});

describe('fmtTokens', () => {
  it('formats token counts in the spec style', () => {
    expect(fmtTokens(41_200)).toBe('41.2k');
    expect(fmtTokens(2_100_000)).toBe('2.1M');
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(0)).toBe('0');
  });
});

/* ------------------------------------------------------------------ */
/* LLM pass pure helpers (no network — SPEC §4.4 plumbing)             */
/* ------------------------------------------------------------------ */

describe('llm sampling', () => {
  it('takes the most wasteful sessions, excluding analyzed and pending ones', () => {
    seedSession('a', NOW - 1 * DAY, { wasteScore: 10 });
    seedSession('b', NOW - 2 * DAY, { wasteScore: 8 });
    seedSession('c', NOW - 3 * DAY, { wasteScore: 5 });
    seedSession('d', NOW - 4 * DAY, { wasteScore: 3 });
    seedSession('e', NOW - 5 * DAY, { wasteScore: 0 }); // never sampled
    seedFinding('a', 'rework_loop', { source: 'llm' }); // already analyzed
    seedBatch('batch1', 'in_progress', ['b']); // pending in a batch

    const { candidates, skippedAlreadyAnalyzed } = selectLlmSample(db, 10);
    expect(candidates.map((c) => c.id)).toEqual(['c', 'd']);
    expect(skippedAlreadyAnalyzed).toBe(2);
  });

  it('honors the sample limit and waste_score ordering', () => {
    seedSession('low', NOW, { wasteScore: 1 });
    seedSession('high', NOW, { wasteScore: 99 });
    seedSession('mid', NOW, { wasteScore: 50 });
    const { candidates } = selectLlmSample(db, 2);
    expect(candidates.map((c) => c.id)).toEqual(['high', 'mid']);
  });

  it('does not exclude sessions listed in already-ended batches', () => {
    seedSession('a', NOW, { wasteScore: 10 });
    seedBatch('old', 'ended', ['a']);
    const { candidates, skippedAlreadyAnalyzed } = selectLlmSample(db, 10);
    expect(candidates.map((c) => c.id)).toEqual(['a']);
    expect(skippedAlreadyAnalyzed).toBe(0);
  });
});

describe('llm condensing', () => {
  it('renders user text heads, correction markers, and assistant tool lines', () => {
    seedSession('s1', NOW - DAY, { wasteScore: 5 });
    seedTurn('s1', 0, { role: 'user', textHead: 'Fix the bug in auth.ts' });
    const asst = seedTurn('s1', 1, { role: 'assistant', charLen: 2_431 });
    db.prepare(`INSERT INTO tool_calls (turn_id, tool, target) VALUES (?, ?, ?)`).run(
      asst,
      'Read',
      'src/x.ts'
    );
    db.prepare(`INSERT INTO tool_calls (turn_id, tool, target) VALUES (?, ?, ?)`).run(
      asst,
      'Edit',
      'src/x.ts'
    );
    seedTurn('s1', 2, { role: 'user', isCorrection: true, textHead: 'no, revert that' });
    seedFinding('s1', 'rework_loop', { source: 'heuristic', evidence: 'no, revert that' });

    const condensed = condenseSession(db, 's1');
    expect(condensed).toContain('HEURISTIC HINTS');
    expect(condensed).toContain('- rework_loop: no, revert that');
    expect(condensed).toContain('USER: Fix the bug in auth.ts');
    expect(condensed).toContain('ASSISTANT (2431 chars): [tools: Read src/x.ts, Edit src/x.ts]');
    expect(condensed).toContain('USER [CORRECTION]: no, revert that');
    // hints come before the transcript
    expect(condensed.indexOf('HEURISTIC HINTS')).toBeLessThan(condensed.indexOf('TRANSCRIPT:'));
  });

  it('truncates long user turns to 1200 chars and caps the whole session at ~20k', () => {
    seedSession('big', NOW - DAY, { wasteScore: 5 });
    seedTurn('big', 0, { role: 'user', textHead: 'y'.repeat(3_000) });
    for (let i = 1; i <= 30; i++) {
      seedTurn('big', i, { role: 'user', textHead: `turn ${i} ` + 'x'.repeat(1_200) });
    }
    const condensed = condenseSession(db, 'big');
    expect(condensed).toContain('y'.repeat(1_200) + ' [...]');
    expect(condensed).not.toContain('y'.repeat(1_201));
    expect(condensed.length).toBeLessThanOrEqual(
      CONDENSED_SESSION_CHAR_CAP + '\n[transcript truncated]'.length
    );
    expect(condensed).toContain('[transcript truncated]');
  });
});

describe('llm result parsing', () => {
  const valid = {
    category: 'rework_loop',
    confidence: 0.9,
    evidence: 'no, revert that',
    suggestion: 'Name the target file in the first prompt.',
    claude_md_line: null,
  };

  it('strips markdown fences before parsing', () => {
    const text = '```json\n' + JSON.stringify([valid]) + '\n```';
    const parsed = parseLlmFindings(text);
    expect(parsed).toHaveLength(1);
    expect(parsed![0].category).toBe('rework_loop');
    expect(stripFences('```\n[]\n```')).toBe('[]');
    expect(stripFences('[]')).toBe('[]');
  });

  it('recovers an array wrapped in prose', () => {
    const text = 'Here are the findings:\n' + JSON.stringify([valid]) + '\nHope that helps!';
    expect(parseLlmFindings(text)).toHaveLength(1);
  });

  it('clamps evidence to 200 chars and confidence to [0, 1]', () => {
    const parsed = parseLlmFindings(
      JSON.stringify([
        { ...valid, evidence: 'e'.repeat(300), confidence: 1.7 },
        { ...valid, confidence: -3 },
      ])
    );
    expect(parsed![0].evidence).toHaveLength(200);
    expect(parsed![0].confidence).toBe(1);
    expect(parsed![1].confidence).toBe(0);
  });

  it('returns null for malformed or non-array JSON (result is skipped)', () => {
    expect(parseLlmFindings('total garbage')).toBeNull();
    expect(parseLlmFindings('{"category": "rework_loop"}')).toBeNull();
    expect(parseLlmFindings('')).toBeNull();
  });

  it('drops unknown categories and non-object items, caps at 5 findings', () => {
    const items = [
      { ...valid, category: 'not_a_category' },
      'just a string',
      ...Array.from({ length: 7 }, () => valid),
    ];
    const parsed = parseLlmFindings(JSON.stringify(items));
    expect(parsed).toHaveLength(3); // 5-item cap applies before validation: 5 - 2 invalid
  });

  it('keeps claude_md_line when a non-empty string, else null', () => {
    const parsed = parseLlmFindings(
      JSON.stringify([
        { ...valid, category: 'missing_convention', claude_md_line: ' - Use pnpm ' },
        { ...valid, claude_md_line: '   ' },
        { ...valid },
      ])
    );
    expect(parsed![0].claude_md_line).toBe('- Use pnpm');
    expect(parsed![1].claude_md_line).toBeNull();
    expect(parsed![2].claude_md_line).toBeNull();
  });
});

describe('privacy notice', () => {
  it('logs the as-is warning exactly once and remembers it in meta', () => {
    const logged: string[] = [];
    const first = showPrivacyNoticeOnce(db, (m) => logged.push(m));
    expect(first).toBe(true);
    expect(logged.join('\n')).toContain('AS-IS');
    expect(logged.join('\n')).toContain('redact');

    const second = showPrivacyNoticeOnce(db, (m) => logged.push(m));
    expect(second).toBe(false);
    expect(logged).toHaveLength(1);
    expect(metaGet(db, 'privacy_notice_shown')).not.toBeNull();
  });
});
