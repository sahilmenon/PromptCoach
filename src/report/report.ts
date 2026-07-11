import type { DB } from '../db';
import { getSelfSpend, metaGet, metaGetJson, metaSet } from '../db';
import { nowMs } from '../config';
import { CACHED_READ_WEIGHT, WASTE_PERSIST_TURNS_CAP } from '../constants';
import {
  equivalentsFor,
  estimateEnvironment,
  estimateWasteLedger,
  formatRange,
  windowCutoffMs,
  type BaselineMeta,
  type EnvEstimate,
  type Range,
  type WasteLedger,
} from './envEstimate';
import { buildClaudeMdDiffs, type ClaudeMdDiff } from './claudeMdDiff';

/**
 * Report data (SPEC §4.5). `promptcoach report --json` dumps this verbatim,
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
  /** Input + output over all turns, all time (the usage PromptCoach analyzed). */
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
  /** Estimated avoidable consumption if the findings were fixed. */
  wasteLedger: WasteLedger;
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
  const wasteLedger = estimateWasteLedger(db, cutoff);

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
    wasteLedger,
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
export function renderReport(data: ReportData, opts?: { full?: boolean }): string {
  return opts?.full ? renderFull(data) : renderCompact(data);
}

function renderFull(data: ReportData): string {
  const lines: string[] = [];
  const windowLabel =
    data.sinceDays === null ? 'all time' : `last ${data.sinceDays} day(s)`;
  lines.push(
    `PromptCoach report — generated ${new Date(data.generatedAt).toISOString()} — window: ${windowLabel}`
  );
  lines.push('='.repeat(WIDTH));

  renderHeadline(lines, data.env);
  renderScorecard(lines, data.scorecard);
  renderFindings(lines, data.findings);
  renderWasteLedger(lines, data.wasteLedger, data.env.windowFootprintKwh);
  renderClaudeMd(lines, data.claudeMdDiffs);
  renderDigest(lines, data.digest);
  renderSelfSpend(lines, data.selfSpend);
  renderEnv(lines, data.env);

  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Compact view (default): scannable, prioritized, low-noise.          */
/* Lead with the footprint, a health snapshot, the ranked fixes that   */
/* matter, and one call to action. `--full` still prints everything.   */
/* ------------------------------------------------------------------ */

const COMPACT_WIDTH = 62;

/** Plain-language label + one-line explanation for each finding category. */
const CATEGORY_INFO: Record<string, { label: string; blurb: string }> = {
  repeated_file_read: { label: 'Repeated file reads', blurb: 'Claude re-read the same files within a session.' },
  resupplied_context: { label: 'Re-supplied context', blurb: 'The same context was gathered again across turns.' },
  oversized_paste: { label: 'Oversized pastes', blurb: 'A large block was pasted inline instead of referenced by path.' },
  correction_turn: { label: 'Correction turns', blurb: 'You had to correct Claude mid-task.' },
  overscoped_ask: { label: 'Overscoped asks', blurb: 'One prompt bundled several separate tasks.' },
  rework_loop: { label: 'Rework loops', blurb: 'Repeated corrections circling the same change.' },
  abandonment: { label: 'Abandoned sessions', blurb: 'Session stopped right after a correction.' },
  vague_opening: { label: 'Vague openings', blurb: 'The opening prompt lacked a concrete target.' },
  missing_convention: { label: 'Missing conventions', blurb: 'A recurring project rule was never written down.' },
};

function prettyCategory(category: string): { label: string; blurb: string } {
  return (
    CATEGORY_INFO[category] ?? {
      label: category.replace(/_/g, ' ').replace(/^\w/, (m) => m.toUpperCase()),
      blurb: '',
    }
  );
}

function renderCompact(data: ReportData): string {
  // Color only on a real terminal; honour NO_COLOR. Tests capture the string
  // (no TTY) so they stay ANSI-free.
  const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
  const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = paint('1');
  const dim = paint('2');
  const green = paint('32');
  const yellow = paint('33');
  const red = paint('31');
  const cyan = paint('36');

  const out: string[] = [];
  const rule = () => out.push(dim('─'.repeat(COMPACT_WIDTH)));
  const date = new Date(data.generatedAt).toISOString().slice(0, 10);
  const windowLabel = data.sinceDays === null ? 'all time' : `last ${data.sinceDays}d`;

  out.push(bold('PromptCoach') + dim(`  ·  ${windowLabel}  ·  ${date}`));
  rule();

  // FOOTPRINT --------------------------------------------------------
  const env = data.env;
  out.push('');
  out.push(bold('FOOTPRINT'));
  out.push(
    '  ≈ ' +
      cyan(formatRange(env.windowFootprintKwh, 'kWh')) +
      dim('   ·   ' + formatRange(env.windowEquivalents.smartphoneCharges, 'phone charges')) +
      dim('   ·   ' + formatRange(env.windowEquivalents.evKm, 'km in an EV'))
  );
  if (env.energyKwh === null) {
    out.push(dim('  Building your week-1 baseline — savings appear after a few days.'));
  } else if ((env.effectiveTokensSaved ?? 0) <= 0) {
    out.push(dim('  No savings vs your baseline yet — fixing the habits below is the fastest win.'));
  } else {
    out.push(
      '  ' +
        green('↓ saved ' + formatRange(env.energyKwh, 'kWh')) +
        dim(
          ' vs baseline (≈ ' +
            formatRange(equivalentsFor(env.energyKwh).smartphoneCharges, 'phone charges') +
            ') — keep it up'
        )
    );
  }

  // HEALTH -----------------------------------------------------------
  const sc = data.scorecard;
  const verdict = (good: boolean, ok: boolean) =>
    good ? green('great') : ok ? yellow('ok') : red('high');
  const rowLabel = (s: string) => '  ' + s.padEnd(13);
  out.push('');
  out.push(bold('HEALTH'));

  let corrLine =
    rowLabel('corrections') +
    pct(sc.correctionRate).padEnd(7) +
    ' ' +
    verdict(sc.correctionRate <= 0.05, sc.correctionRate <= 0.12);
  if (sc.baselineCorrectionRate !== null && sc.correctionDelta !== null) {
    const pp = sc.correctionDelta * 100;
    const arrow = pp <= 0 ? '↓' : '↑';
    corrLine += dim(`   (baseline ${pct(sc.baselineCorrectionRate)}, ${arrow}${Math.abs(pp).toFixed(1)}pp)`);
  }
  out.push(corrLine);

  if (sc.cacheHitRate !== null) {
    out.push(
      rowLabel('cache hits') +
        pct(sc.cacheHitRate).padEnd(7) +
        ' ' +
        verdict(sc.cacheHitRate >= 0.9, sc.cacheHitRate >= 0.7)
    );
  }
  out.push(
    rowLabel('volume') +
      dim(
        `${fmtInt(sc.sessions)} sessions · ${fmtInt(sc.userTurns)} prompts · ${fmtTokens(sc.outputTokens)} out tok`
      )
  );

  // TOP FIXES --------------------------------------------------------
  out.push('');
  out.push(bold('TOP FIXES') + dim('  ·  ranked by wasted tokens'));
  const rows = data.wasteLedger.rows;
  if (rows.length === 0) {
    out.push(dim('  none yet — run `promptcoach analyze` after a few sessions.'));
  } else {
    const suggestionByCat = new Map<string, string>();
    for (const g of data.findings) {
      if (g.examples[0]) suggestionByCat.set(g.category, g.examples[0].suggestion);
    }
    const maxHigh = Math.max(...rows.map((r) => r.effTokens.high), 1);
    rows.slice(0, 3).forEach((row, i) => {
      const info = prettyCategory(row.category);
      const blocks = Math.max(1, Math.round((row.effTokens.high / maxHigh) * 11));
      out.push(
        bold(` ${i + 1} `) +
          bold(info.label.padEnd(22)) +
          dim(`${row.count}×`.padStart(5) + '  ') +
          `~${fmtTokenRange(row.effTokens)} tok`.padEnd(20) +
          cyan('█'.repeat(blocks))
      );
      if (info.blurb) out.push(dim('     ' + info.blurb));
      const fix = suggestionByCat.get(row.category);
      if (fix) out.push('     ' + green('→ ') + oneLine(fix, 66));
    });
    if (rows.length > 3) {
      const restCount = rows.slice(3).reduce((n, r) => n + r.count, 0);
      out.push(
        dim(
          `  +${rows.length - 3} more patterns · ${restCount}× · ~${fmtTokenRange(
            data.wasteLedger.totalEffTokens
          )} tok total avoidable  →  promptcoach report --full`
        )
      );
    } else {
      out.push(dim(`  total avoidable ~${fmtTokenRange(data.wasteLedger.totalEffTokens)} tok`));
    }
  }

  // CLAUDE.md --------------------------------------------------------
  const diffs = data.claudeMdDiffs;
  if (diffs.length > 0) {
    const additions = diffs.reduce((n, d) => n + (d.diff.match(/^\+[^+]/gm)?.length ?? 0), 0);
    out.push('');
    out.push(bold('CLAUDE.md SUGGESTIONS'));
    out.push(`  ${additions} addition(s) ready across ${diffs.length} project(s).`);
    out.push(
      '  ' +
        green('→ ') +
        'promptcoach report --write-claude-md' +
        dim('   (writes *.suggested; never edits CLAUDE.md)')
    );
  }

  // FOOTER -----------------------------------------------------------
  out.push('');
  rule();
  const spend = data.selfSpend;
  const selfTokens = spend.inputTokens + spend.outputTokens;
  const overhead = spend.overheadPct === null ? 'n/a overhead' : `${spend.overheadPct.toFixed(1)}% overhead`;
  out.push(dim(`Analyzer cost ${fmtTokens(selfTokens)} tok · ~$${spend.usd.toFixed(2)} · ${overhead}`));
  out.push(dim('Rough estimate — see docs/cli/ASSUMPTIONS.md · full breakdown: promptcoach report --full'));

  out.push('');
  return out.join('\n');
}

/**
 * The hero block: lead with what you consumed and what you've saved, in
 * tangible terms. Consumption is invisible and weightless by default — making
 * it concrete is the whole point of the tool.
 */
function renderHeadline(lines: string[], env: EnvEstimate): void {
  lines.push('');
  lines.push('CONSUMPTION (this window)');
  lines.push(
    `  ≈ ${formatRange(env.windowFootprintKwh, 'kWh')} of AI compute — like ` +
      `${formatRange(env.windowEquivalents.smartphoneCharges, 'phone charges')} · ` +
      `${formatRange(env.windowEquivalents.evKm, 'km in an EV')}`
  );
  if (env.energyKwh === null) {
    lines.push('  building your week-1 baseline — reduction appears after a few days');
  } else if ((env.effectiveTokensSaved ?? 0) <= 0) {
    lines.push('  no reduction vs. your baseline yet — trim the avoidable waste below to start');
  } else {
    const eq = equivalentsFor(env.energyKwh);
    lines.push(
      `  ↓ saved ${formatRange(env.energyKwh, 'kWh')} vs. your baseline ` +
        `(≈ ${formatRange(eq.smartphoneCharges, 'phone charges')}) — keep it up`
    );
  }
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
    lines.push('  none yet — run `promptcoach analyze` after a few sessions.');
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

/**
 * The "consume less" ledger: each identified habit, what it costs, and the
 * total avoidable footprint if you fixed them. Turns findings into a number
 * you can act on. Costs are illustrative bounds (see constants.ts), so the
 * section is explicit that it is an estimate.
 */
function renderWasteLedger(
  lines: string[],
  ledger: WasteLedger,
  footprintKwh: Range
): void {
  lines.push('');
  lines.push('AVOIDABLE WASTE (fix these to consume less)');
  if (ledger.rows.length === 0) {
    lines.push('  none identified — run `tokenlean analyze` after a few sessions.');
    return;
  }
  for (const row of ledger.rows) {
    lines.push(
      `  ${row.category.padEnd(20)} ${String(row.count).padStart(3)}×  ` +
        `≈ ${fmtTokenRange(row.effTokens)} tokens`
    );
  }
  const share = shareOfFootprint(ledger.energyKwh, footprintKwh);
  lines.push(
    `  total avoidable ≈ ${fmtTokenRange(ledger.totalEffTokens)} tokens ` +
      `≈ ${formatRange(ledger.energyKwh, 'kWh')} ` +
      `(≈ ${formatRange(ledger.equivalents.smartphoneCharges, 'phone charges')})`
  );
  if (share) lines.push(`  that is ≈ ${share} of your footprint above`);
  lines.push(
    '  note: recurring cost — waste lingers in context and is re-sent each turn ' +
      `(capped at ${WASTE_PERSIST_TURNS_CAP} turns)`
  );
  lines.push('  note: per-pattern token costs are rough illustrative bounds, not measurements');
}

/** "1.2–3.4%"-style share of the footprint, or null if the footprint is 0. */
function shareOfFootprint(waste: Range, footprint: Range): string | null {
  if (footprint.low <= 0 || footprint.high <= 0) return null;
  const low = (waste.low / footprint.high) * 100;
  const high = (waste.high / footprint.low) * 100;
  return `${low.toFixed(1)}–${high.toFixed(1)}%`;
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
    '  note: `promptcoach report --write-claude-md` writes these to CLAUDE.md.suggested'
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
    `  PromptCoach spent ${fmtTokens(selfTokens)} tokens ≈ $${spend.usd.toFixed(2)} ` +
      `analyzing ${fmtTokens(spend.analyzedTokens)} tokens — ${overhead}`
  );
}

function renderEnv(lines: string[], env: EnvEstimate): void {
  lines.push('');
  lines.push('ENVIRONMENTAL ESTIMATE');
  const kv = (key: string, value: string) =>
    lines.push(`  ${(key + ':').padEnd(28)}${value}`);

  kv('window footprint', formatRange(env.windowFootprintKwh, 'kWh'));
  kv(
    '  ≈ same as',
    `${formatRange(env.windowEquivalents.smartphoneCharges, 'phone charges')} · ` +
      `${formatRange(env.windowEquivalents.ledBulbHours, 'h of an LED bulb')} · ` +
      `${formatRange(env.windowEquivalents.evKm, 'km in an EV')}`
  );
  if (env.energyKwh === null) {
    lines.push('  baseline not recorded yet — savings appear after week 1');
  } else if ((env.effectiveTokensSaved ?? 0) <= 0) {
    lines.push(
      '  no measured savings vs baseline yet (current usage per session is at or'
    );
    lines.push('  above the baseline) — keep at it.');
  } else {
    kv('energy saved vs baseline', formatRange(env.energyKwh, 'kWh'));
    kv('  ≈ that is', formatRange(equivalentsFor(env.energyKwh).smartphoneCharges, 'phone charges'));
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

/** "1.0k–4.0k"-style rendering for a token range. */
function fmtTokenRange(r: Range): string {
  return `${fmtTokens(r.low)}–${fmtTokens(r.high)}`;
}

/** Thousands-grouped integer, locale-independent so output is deterministic. */
function fmtInt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function oneLine(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
