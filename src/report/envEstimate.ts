import type { DB } from '../db';
import { metaGetJson } from '../db';
import { nowMs } from '../config';
import {
  AVOIDABLE_EFF_TOKENS_DEFAULT,
  AVOIDABLE_EFF_TOKENS_PER_FINDING,
  CACHED_READ_WEIGHT,
  ENERGY_KWH_PER_MTOK,
  ESTIMATE_LABEL,
  KWH_PER_EV_KM,
  KWH_PER_LED_BULB_HOUR,
  KWH_PER_SMARTPHONE_CHARGE,
  WASTE_PERSIST_TURNS_CAP,
  WATER_L_PER_KWH_LIFECYCLE,
  WATER_L_PER_KWH_ONSITE,
} from '../constants';

/**
 * Environmental estimate (SPEC §7). All conversions use ONLY the bounded
 * constants from constants.ts, and every number is reported as a LOW/HIGH
 * range with the "rough estimate" label — never a single unqualified figure.
 */

export interface Range {
  low: number;
  high: number;
}

/** Shape of the meta 'baseline' JSON recorded by the heuristics pass. */
export interface BaselineMeta {
  recordedAt: number;
  windowStartMs: number;
  windowEndMs: number;
  sessions: number;
  userTurns: number;
  correctionTurns: number;
  correctionRate: number;
  tokensPerSession: number;
  effTokensPerSession: number;
}

/** Human-scale equivalences for an energy range (SPEC §7: still ranges). */
export interface Equivalents {
  smartphoneCharges: Range;
  ledBulbHours: Range;
  evKm: Range;
}

/** All numbers are ranges (SPEC §7): never a single unqualified figure. */
export interface EnvEstimate {
  label: string;
  /** Effective tokens saved vs. baseline (cache reads weighted per constants). */
  effectiveTokensSaved: number | null;
  energyKwh: Range | null;
  waterOnsiteL: Range | null;
  waterLifecycleL: Range | null;
  /** Footprint of the usage in the window itself, always present. */
  windowFootprintKwh: Range;
  /** Tangible equivalences for the window footprint, always present. */
  windowEquivalents: Equivalents;
  notes: string[];
}

/** Convert an energy range into tangible, relatable equivalences. */
export function equivalentsFor(kwh: Range): Equivalents {
  const per = (factor: number): Range => ({
    low: factor > 0 ? kwh.low / factor : 0,
    high: factor > 0 ? kwh.high / factor : 0,
  });
  return {
    smartphoneCharges: per(KWH_PER_SMARTPHONE_CHARGE.low),
    ledBulbHours: per(KWH_PER_LED_BULB_HOUR.low),
    evKm: per(KWH_PER_EV_KM.low),
  };
}

/** One line of the avoidable-waste ledger: a finding category and its cost. */
export interface WasteLedgerRow {
  category: string;
  count: number;
  effTokens: Range;
}

/** Prospective "fix these to consume less" ledger derived from findings. */
export interface WasteLedger {
  rows: WasteLedgerRow[];
  totalEffTokens: Range;
  energyKwh: Range;
  equivalents: Equivalents;
}

/**
 * Recurring-cost multiplier for content injected in a session of `turnCount`
 * turns: paid once uncached, then re-sent (cache-weighted) on later turns up
 * to the compaction cap. min 1 (a single-turn session costs it once).
 */
function persistenceMultiplier(turnCount: number): number {
  const persisted = Math.min(Math.max(turnCount - 1, 0), WASTE_PERSIST_TURNS_CAP);
  return 1 + CACHED_READ_WEIGHT * persisted;
}

/**
 * Estimate avoidable consumption from the findings, using the RECURRING-cost
 * model: each wasteful artifact lingers in its session's context and is
 * re-sent every later turn (constants.ts). Per-pattern base costs are
 * illustrative bounds, NOT measurements; the report labels them as such.
 * Rows are aggregated by category and sorted by worst-case cost.
 */
export function estimateWasteLedger(db: DB, cutoffMs: number | null): WasteLedger {
  // Findings grouped by (category, session) so each group can be scaled by
  // that session's own length — a finding in a long session costs more.
  const groups = db
    .prepare(
      `SELECT f.category AS category,
              COALESCE(s.turn_count, 0) AS turnCount,
              COUNT(*) AS n
       FROM findings f JOIN sessions s ON s.id = f.session_id
       ${cutoffMs === null ? '' : 'WHERE s.started_at >= ?'}
       GROUP BY f.category, f.session_id`
    )
    .all(...(cutoffMs === null ? [] : [cutoffMs])) as {
    category: string;
    turnCount: number;
    n: number;
  }[];

  const byCategory = new Map<string, Range>();
  let low = 0;
  let high = 0;
  for (const g of groups) {
    const per = AVOIDABLE_EFF_TOKENS_PER_FINDING[g.category] ?? AVOIDABLE_EFF_TOKENS_DEFAULT;
    const mult = persistenceMultiplier(g.turnCount);
    const addLow = per.low * g.n * mult;
    const addHigh = per.high * g.n * mult;
    const acc = byCategory.get(g.category) ?? { low: 0, high: 0 };
    byCategory.set(g.category, { low: acc.low + addLow, high: acc.high + addHigh });
    low += addLow;
    high += addHigh;
  }

  // Count per category (for display) comes from the same grouped rows.
  const counts = new Map<string, number>();
  for (const g of groups) counts.set(g.category, (counts.get(g.category) ?? 0) + g.n);

  const rows: WasteLedgerRow[] = [...byCategory.entries()]
    .map(([category, effTokens]) => ({
      category,
      count: counts.get(category) ?? 0,
      effTokens,
    }))
    .sort((a, b) => b.effTokens.high - a.effTokens.high);

  const totalEffTokens: Range = { low, high };
  const energyKwh: Range = {
    low: (low / 1e6) * ENERGY_KWH_PER_MTOK.low,
    high: (high / 1e6) * ENERGY_KWH_PER_MTOK.high,
  };
  return { rows, totalEffTokens, energyKwh, equivalents: equivalentsFor(energyKwh) };
}

/** Resolve a --since window into a started_at cutoff; null means all time. */
export function windowCutoffMs(sinceDays?: number): number | null {
  if (sinceDays === undefined) return null;
  return nowMs() - sinceDays * 86_400_000;
}

/**
 * Effective tokens over the window's turns:
 * input + output + cacheWrite + CACHED_READ_WEIGHT x cacheRead.
 */
export function effectiveTokensInWindow(db: DB, cutoffMs: number | null): number {
  const sql = `
    SELECT COALESCE(SUM(
      COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0)
      + COALESCE(t.cache_write_tokens, 0)
      + ? * COALESCE(t.cache_read_tokens, 0)
    ), 0) AS eff
    FROM turns t JOIN sessions s ON s.id = t.session_id
    ${cutoffMs === null ? '' : 'WHERE s.started_at >= ?'}`;
  const params: number[] =
    cutoffMs === null ? [CACHED_READ_WEIGHT] : [CACHED_READ_WEIGHT, cutoffMs];
  const row = db.prepare(sql).get(...params) as { eff: number };
  return row.eff;
}

export function sessionCountInWindow(db: DB, cutoffMs: number | null): number {
  const sql = `SELECT COUNT(*) AS n FROM sessions ${
    cutoffMs === null ? '' : 'WHERE started_at >= ?'
  }`;
  const row = (cutoffMs === null
    ? db.prepare(sql).get()
    : db.prepare(sql).get(cutoffMs)) as { n: number };
  return row.n;
}

/**
 * Convert tokens-saved-vs-baseline into energy/water ranges using
 * constants.ts. Returns saved-* fields null when no baseline exists yet.
 */
export function estimateEnvironment(
  db: DB,
  opts?: { sinceDays?: number }
): EnvEstimate {
  const cutoff = windowCutoffMs(opts?.sinceDays);
  const windowEff = effectiveTokensInWindow(db, cutoff);
  const windowFootprintKwh: Range = {
    low: (windowEff / 1e6) * ENERGY_KWH_PER_MTOK.low,
    high: (windowEff / 1e6) * ENERGY_KWH_PER_MTOK.high,
  };
  const windowEquivalents = equivalentsFor(windowFootprintKwh);
  const notes: string[] = [
    `cache-read tokens are weighted at ${Math.round(
      CACHED_READ_WEIGHT * 100
    )}% of uncached tokens (assumption, not a measurement)`,
    ESTIMATE_LABEL,
  ];

  const baseline = metaGetJson<BaselineMeta>(db, 'baseline');
  if (!baseline || typeof baseline.effTokensPerSession !== 'number') {
    notes.push('baseline not recorded yet — savings appear after week 1');
    return {
      label: ESTIMATE_LABEL,
      effectiveTokensSaved: null,
      energyKwh: null,
      waterOnsiteL: null,
      waterLifecycleL: null,
      windowFootprintKwh,
      windowEquivalents,
      notes,
    };
  }

  const sessionCount = sessionCountInWindow(db, cutoff);
  const effPerSession = sessionCount > 0 ? windowEff / sessionCount : 0;
  const savedEff =
    sessionCount > 0
      ? Math.max(0, baseline.effTokensPerSession - effPerSession) * sessionCount
      : 0;

  const energyKwh: Range = {
    low: (savedEff / 1e6) * ENERGY_KWH_PER_MTOK.low,
    high: (savedEff / 1e6) * ENERGY_KWH_PER_MTOK.high,
  };
  const waterOnsiteL: Range = {
    low: energyKwh.low * WATER_L_PER_KWH_ONSITE.low,
    high: energyKwh.high * WATER_L_PER_KWH_ONSITE.high,
  };
  const waterLifecycleL: Range = {
    low: energyKwh.low * WATER_L_PER_KWH_LIFECYCLE.low,
    high: energyKwh.high * WATER_L_PER_KWH_LIFECYCLE.high,
  };

  return {
    label: ESTIMATE_LABEL,
    effectiveTokensSaved: savedEff,
    energyKwh,
    waterOnsiteL,
    waterLifecycleL,
    windowFootprintKwh,
    windowEquivalents,
    notes,
  };
}

/** "0.4–1.3 kWh"-style rendering. Always a range, never a bare number. */
export function formatRange(range: Range, unit: string): string {
  return `${formatEnvNumber(range.low)}–${formatEnvNumber(range.high)} ${unit}`;
}

export function formatEnvNumber(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 100) return String(Math.round(n));
  if (n >= 0.095) return n.toFixed(1);
  return n.toPrecision(2);
}
