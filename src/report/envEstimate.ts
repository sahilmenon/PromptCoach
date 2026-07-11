import type { DB } from '../db';
import { metaGetJson } from '../db';
import { nowMs } from '../config';
import {
  CACHED_READ_WEIGHT,
  ENERGY_KWH_PER_MTOK,
  ESTIMATE_LABEL,
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
  notes: string[];
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
