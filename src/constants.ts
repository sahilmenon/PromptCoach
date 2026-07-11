/**
 * Environmental-impact constants.
 *
 * Every constant carries a source URL and a LOW/HIGH bound. There are no
 * first-party energy figures for Claude; these are literature ranges for
 * large-model inference. Reports must always print ranges, never a single
 * unqualified number, and must label the output "rough estimate".
 * See ASSUMPTIONS.md for the full discussion.
 */

export interface BoundedConstant {
  low: number;
  high: number;
  unit: string;
  source: string;
  note: string;
}

/** Energy per million uncached tokens processed (input + output). */
export const ENERGY_KWH_PER_MTOK: BoundedConstant = {
  low: 0.3,
  high: 1.0,
  unit: 'kWh per 1M uncached tokens',
  source: 'https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use',
  note:
    'Literature range for frontier-model inference (Epoch AI 2025; Luccioni et al. 2023, ' +
    'https://arxiv.org/abs/2311.16863). No first-party figures exist for Claude.',
};

/** On-site (scope-1) water use per kWh of datacenter energy. */
export const WATER_L_PER_KWH_ONSITE: BoundedConstant = {
  low: 1.1,
  high: 1.1,
  unit: 'L per kWh (on-site cooling)',
  source: 'https://arxiv.org/abs/2304.03271',
  note: 'Li et al., "Making AI Less Thirsty" — typical on-site WUE.',
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
 * Assumption, not a measurement: cached prefixes skip prefill compute,
 * so we count them at 10%. Flagged in every report.
 */
export const CACHED_READ_WEIGHT = 0.1;

export const ESTIMATE_LABEL =
  'rough estimate — no first-party figures exist for Claude; see ASSUMPTIONS.md';
