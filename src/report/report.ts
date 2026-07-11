import type { DB } from '../db';
import { getSelfSpend, metaGet, metaGetJson, metaSet } from '../db';
import { nowMs } from '../config';
import { CACHED_READ_WEIGHT } from '../constants';
import {
  estimateEnvironment,
  formatRange,
  windowCutoffMs,
  type BaselineMeta,
  type EnvEstimate,
} from './envEstimate';
import { buildClaudeMdDiffs, type ClaudeMdDiff } from './claudeMdDiff';

/**
 * Report data (SPEC §4.5). `tokenlean report --json` dumps this verbatim,
 * so every field is plain JSON (numbers, strings, nulls, arrays).
 */

export interface Scorecard {
  sessions: number;
  userTurns: number;
  assistantTurns: number;
  correctionTurns: number;
  /** correctionTurns / userTurns; 0 when there are no user turns. */
  correctionRate: number;
  baselineCorrectionRate: number | null;
  /** correctionRate - baselineCorrectionRate (fraction, not pp). */
  correctionDelta: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + output + cacheWrite + CACHED_READ_WEIGHT x cacheRead. */
  effTokens: number;
  /** cacheRead / (cacheRead + cacheWrite + input); null without token data. */
  cacheHitRate: number | null;
  cacheHitSource: 'transcripts' | null;
}

export interface FindingExample {
  sessionId: string;
  project: string | null;
  confidence: number;
  evidence: string;
  suggestion: string;
  source: string;
}

export interface FindingGroup {
  category: string;
  count: number;
  sources: { heuristic: number; llm: number };
  /** Up to 3, highest-confidence first (ties broken by recency). */
  examples: FindingExample[];
}

export interface HookDigest {
  invocations: number;
  fired: number;
  suppressed: number;
  recentFired: {
    ts: number;
    project: string | null;
    pattern: string | null;
    message: string | null;
  }[];
  mutedUntil: number | null;
}

export interface SelfSpendReport {
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** input + output over ALL turns, all time (the usage tokenlean analyzed). */
  analyzedTokens: number;
  /** (self input+output) / analyzedTokens as a percentage; null when 0/0. */
  overheadPct: number | null;
}

export interface ReportData {
  generatedAt: number;
  /** The --since window in days; null = all time. */
  sinceDays: number | null;
  scorecard: Scorecard;
  findings: FindingGroup[];
  claudeMdDiffs: ClaudeMdDiff[];
  digest: HookDigest;
  selfSpend: SelfSpendReport;
  env: EnvEstimate;
}

export function buildReport(db: DB, opts?: { sinceDays?: number }): ReportData {
  const generatedAt = nowMs();
  const cutoff = windowCutoffMs(opts?.sinceDays);

  const scorecard = buildScorecard(db, cutoff);
  const findings = buildFindingGroups(db, cutoff);
  const claudeMdDiffs = buildClaudeMdDiffs(db);
  const digest = buildDigest(db); // reads meta 'last_report_ts' — before update
  const selfSpend = buildSelfSpend(db);
  const env = estimateEnvironment(db, opts);

  metaSet(db, 'last_report_ts', String(generatedAt));

  return {
    generatedAt,
    sinceDays: opts?.sinceDays ?? null,
    scorecard,
    findings,
    claudeMdDiffs,
    digest,
    selfSpend,
    env,
  };
}

function buildScorecard(db: DB, cutoff: number | null): Scorecard {
  const sessionParams = cutoff === null ? [] : [cutoff];
  const sessions = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions ${cutoff === null ? '' : 'WHERE started_at >= ?'}`
      )
      .get(...sessionParams) as { n: number }
  ).n;

  const turnAgg = db
    .prepare(
      `SELECT
         SUM(CASE WHEN t.role = 'user' THEN 1 ELSE 0 END) AS userTurns,
         SUM(CASE WHEN t.role = 'assistant' THEN 1 ELSE 0 END) AS assistantTurns,
         SUM(CASE WHEN t.role = 'user' AND t.is_correction = 1 THEN 1 ELSE 0 END) AS correctionTurns,
         SUM(COALESCE(t.input_tokens, 0)) AS inputTokens,
         SUM(COALESCE(t.output_tokens, 0)) AS outputTokens,
         SUM(COALESCE(t.cache_read_tokens, 0)) AS cacheReadTokens,
         SUM(COALESCE(t.cache_write_tokens, 0)) AS cacheWriteTokens
       FROM turns t JOIN sessions s ON s.id = t.session_id
       ${cutoff === null ? '' : 'WHERE s.started_at >= ?'}`
    )
    .get(...sessionParams) as {
    userTurns: number | null;
    assistantTurns: number | null;
    correctionTurns: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
  };

  const userTurns = turnAgg.userTurns ?? 0;
  const assistantTurns = turnAgg.assistantTurns ?? 0;
  const correctionTurns = turnAgg.correctionTurns ?? 0;
  const inputTokens = turnAgg.inputTokens ?? 0;
  const outputTokens = turnAgg.outputTokens ?? 0;
  const cacheReadTokens = turnAgg.cacheReadTokens ?? 0;
  const cacheWriteTokens = turnAgg.cacheWriteTokens ?? 0;
  const effTokens =
    inputTokens + outputTokens + cacheWriteTokens + CACHED_READ_WEIGHT * cacheReadTokens;

  const correctionRate = userTurns > 0 ? correctionTurns / userTurns : 0;
  const baseline = metaGetJson<BaselineMeta>(db, 'baseline');
  const baselineCorrectionRate =
    baseline && typeof baseline.correctionRate === 'number'
      ? baseline.correctionRate
      : null;
  const correctionDelta =
    baselineCorrectionRate === null ? null : correctionRate - baselineCorrectionRate;

  const turnsDenom = cacheReadTokens + cacheWriteTokens + inputTokens;

  let cacheHitRate: number | null = null;
  let cacheHitSource: 'transcripts' | null = null;
  if (turnsDenom > 0) {
    cacheHitRate = cacheReadTokens / turnsDenom;
    cacheHitSource = 'transcripts';
  }

  return {
    sessions,
    userTurns,
    assistantTurns,
    correctionTurns,
    correctionRate,
    baselineCorrectionRate,
    correctionDelta,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    effTokens,
    cacheHitRate,
    cacheHitSource,
  };
}

function buildFindingGroups(db: DB, cutoff: number | null): FindingGroup[] {
  // When a window is set, findings are scoped to sessions started in it
  // (findings without a matching session row drop out of windowed reports).
  const rows = db
    .prepare(
      `SELECT f.category, f.confidence, f.evidence, f.suggestion, f.source,
              f.session_id AS sessionId, s.project AS project
       FROM findings f LEFT JOIN sessions s ON s.id = f.session_id
       ${cutoff === null ? '' : 'WHERE s.started_at >= ?'}
       ORDER BY f.confidence DESC, f.created_at DESC, f.id DESC`
    )
    .all(...(cutoff === null ? [] : [cutoff])) as {
    category: string | null;
    confidence: number | null;
    evidence: string | null;
    suggestion: string | null;
    source: string | null;
    sessionId: string | null;
    project: string | null;
  }[];

  const groups = new Map<string, FindingGroup>();
  for (const row of rows) {
    const category = row.category ?? 'uncategorized';
    let group = groups.get(category);
    if (!group) {
      group = { category, count: 0, sources: { heuristic: 0, llm: 0 }, examples: [] };
      groups.set(category, group);
    }
    group.count += 1;
    if (row.source === 'heuristic') group.sources.heuristic += 1;
    else if (row.source === 'llm') group.sources.llm += 1;
    if (group.examples.length < 3) {
      group.examples.push({
        sessionId: row.sessionId ?? '',
        project: row.project,
        confidence: row.confidence ?? 0,
        evidence: row.evidence ?? '',
        suggestion: row.suggestion ?? '',
        source: row.source ?? 'heuristic',
      });
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.category.localeCompare(b.category)
  );
}

function buildDigest(db: DB): HookDigest {
  const sinceRaw = metaGet(db, 'last_report_ts');
  const since = sinceRaw ? parseInt(sinceRaw, 10) || 0 : 0;

  const agg = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN fired = 1 THEN 1 ELSE 0 END) AS f
       FROM nudges WHERE ts > ?`
    )
    .get(since) as { n: number; f: number | null };
  const invocations = agg.n;
  const fired = agg.f ?? 0;

  const recentFired = db
    .prepare(
      `SELECT ts, project, pattern, message FROM nudges
       WHERE fired = 1 AND ts > ? ORDER BY ts DESC LIMIT 5`
    )
    .all(since) as HookDigest['recentFired'];

  // The hook stores its mute state in meta 'muted_until' (ms timestamp).
  const mutedRaw = metaGet(db, 'muted_until');
  const mutedParsed = mutedRaw ? parseInt(mutedRaw, 10) : NaN;
  const mutedUntil =
    Number.isFinite(mutedParsed) && mutedParsed > nowMs() ? mutedParsed : null;

  return { invocations, fired, suppressed: invocations - fired, recentFired, mutedUntil };
}

function buildSelfSpend(db: DB): SelfSpendReport {
  const spend = getSelfSpend(db);
  const analyzedTokens = (
    db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS n
         FROM turns`
      )
      .get() as { n: number }
  ).n;
  const selfTokens = spend.inputTokens + spend.outputTokens;
  const overheadPct = analyzedTokens > 0 ? (selfTokens / analyzedTokens) * 100 : null;
  return {
    inputTokens: spend.inputTokens,
    outputTokens: spend.outputTokens,
    usd: spend.usd,
    analyzedTokens,
    overheadPct,
  };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const WIDTH = 78;

/** Plain-text rendering, no color dependency. */
export function renderReport(data: ReportData): string {
  const lines: string[] = [];
  const windowLabel =
    data.sinceDays === null ? 'all time' : `last ${data.sinceDays} day(s)`;
  lines.push(
    `tokenlean report — generated ${new Date(data.generatedAt).toISOString()} — window: ${windowLabel}`
  );
  lines.push('='.repeat(WIDTH));

  renderScorecard(lines, data.scorecard);
  renderFindings(lines, data.findings);
  renderClaudeMd(lines, data.claudeMdDiffs);
  renderDigest(lines, data.digest);
  renderSelfSpend(lines, data.selfSpend);
  renderEnv(lines, data.env);

  lines.push('');
  return lines.join('\n');
}

function renderScorecard(lines: string[], sc: Scorecard): void {
  lines.push('');
  lines.push('SCORECARD');
  const kv = (key: string, value: string) =>
    lines.push(`  ${(key + ':').padEnd(22)}${value}`);

  kv('sessions', String(sc.sessions));
  kv('user turns', String(sc.userTurns));
  kv('assistant turns', String(sc.assistantTurns));
  kv('correction turns', String(sc.correctionTurns));

  let corr = pct(sc.correctionRate);
  if (sc.baselineCorrectionRate !== null && sc.correctionDelta !== null) {
    const deltaPp = sc.correctionDelta * 100;
    corr += ` vs baseline ${pct(sc.baselineCorrectionRate)} (Δ ${
      deltaPp >= 0 ? '+' : ''
    }${deltaPp.toFixed(1)}pp)`;
  }
  kv('correction rate', corr);

  kv('input tokens', fmtTokens(sc.inputTokens));
  kv('output tokens', fmtTokens(sc.outputTokens));
  kv('cache read tokens', fmtTokens(sc.cacheReadTokens));
  kv('cache write tokens', fmtTokens(sc.cacheWriteTokens));
  kv('effective tokens', fmtTokens(sc.effTokens));
  kv(
    'cache hit rate',
    sc.cacheHitRate === null
      ? 'n/a (no token data yet)'
      : `${pct(sc.cacheHitRate)} (${sc.cacheHitSource})`
  );
}

function renderFindings(lines: string[], groups: FindingGroup[]): void {
  lines.push('');
  lines.push('TOP FINDINGS');
  if (groups.length === 0) {
    lines.push('  none yet — run `tokenlean analyze` after a few sessions.');
    return;
  }
  for (const group of groups) {
    const srcBits = [
      group.sources.heuristic > 0 ? `${group.sources.heuristic} heuristic` : '',
      group.sources.llm > 0 ? `${group.sources.llm} llm` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`  ${group.category} (${group.count}${srcBits ? ` — ${srcBits}` : ''})`);
    for (const ex of group.examples) {
      lines.push(`    > "${oneLine(ex.evidence, 68)}"`);
      lines.push(
        `      fix: ${oneLine(ex.suggestion, 60)} (${ex.confidence.toFixed(2)} · ${ex.source})`
      );
    }
  }
}

function renderClaudeMd(lines: string[], diffs: ClaudeMdDiff[]): void {
  lines.push('');
  lines.push('PROPOSED CLAUDE.md ADDITIONS');
  if (diffs.length === 0) {
    lines.push('  none yet — LLM findings of missing conventions produce these.');
    return;
  }
  for (const d of diffs) {
    lines.push(`  project: ${d.project}`);
    lines.push(d.diff);
    lines.push('');
  }
  lines.push(
    '  note: `tokenlean report --write-claude-md` writes these to CLAUDE.md.suggested'
  );
  lines.push('  beside each project — CLAUDE.md itself is never modified.');
}

function renderDigest(lines: string[], digest: HookDigest): void {
  lines.push('');
  lines.push('HOOK DIGEST (since last report)');
  if (digest.invocations === 0) {
    lines.push('  hook not yet installed / no activity');
  } else {
    lines.push(
      `  invocations: ${digest.invocations}   fired: ${digest.fired}   suppressed: ${digest.suppressed}`
    );
    for (const n of digest.recentFired) {
      const when = new Date(n.ts).toISOString().slice(0, 10);
      lines.push(
        `  - ${when} ${n.project ?? '(unknown project)'} [${n.pattern ?? 'pattern'}] ` +
          `"${oneLine(n.message ?? '', 40)}"`
      );
    }
  }
  if (digest.mutedUntil !== null) {
    lines.push(`  nudges muted until ${new Date(digest.mutedUntil).toISOString()}`);
  }
}

function renderSelfSpend(lines: string[], spend: SelfSpendReport): void {
  lines.push('');
  lines.push('SELF-SPEND');
  const selfTokens = spend.inputTokens + spend.outputTokens;
  const overhead =
    spend.overheadPct === null
      ? 'overhead n/a (no analyzed usage yet)'
      : `${spend.overheadPct.toFixed(1)}% overhead`;
  lines.push(
    `  tokenlean spent ${fmtTokens(selfTokens)} tokens ≈ $${spend.usd.toFixed(2)} ` +
      `analyzing ${fmtTokens(spend.analyzedTokens)} tokens — ${overhead}`
  );
}

function renderEnv(lines: string[], env: EnvEstimate): void {
  lines.push('');
  lines.push('ENVIRONMENTAL ESTIMATE');
  const kv = (key: string, value: string) =>
    lines.push(`  ${(key + ':').padEnd(28)}${value}`);

  kv('window footprint', formatRange(env.windowFootprintKwh, 'kWh'));
  if (env.energyKwh === null) {
    lines.push('  baseline not recorded yet — savings appear after week 1');
  } else if ((env.effectiveTokensSaved ?? 0) <= 0) {
    lines.push(
      '  no measured savings vs baseline yet (current usage per session is at or'
    );
    lines.push('  above the baseline) — keep at it.');
  } else {
    kv('energy saved vs baseline', formatRange(env.energyKwh, 'kWh'));
    if (env.waterOnsiteL) kv('water saved (on-site)', formatRange(env.waterOnsiteL, 'L'));
    if (env.waterLifecycleL)
      kv('water saved (lifecycle)', formatRange(env.waterLifecycleL, 'L'));
  }
  for (const note of env.notes) {
    lines.push(`  note: ${note}`);
  }
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function oneLine(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
