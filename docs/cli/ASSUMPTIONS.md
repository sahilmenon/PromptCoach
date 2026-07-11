# Assumptions

Every environmental figure PromptCoach prints is derived from the constants in [`src/constants.ts`](src/constants.ts). This file documents each constant, where it comes from, and why the output is always a labeled range rather than a number.

## Constants

| Constant | Value | Unit | Source | Why this value |
|---|---|---|---|---|
| `ENERGY_KWH_PER_MTOK` | 0.3 – 2.0 | kWh per 1M uncached tokens | [Oviedo et al., Joule (2026)](https://arxiv.org/abs/2509.20241); [Couch (2026)](https://simonpcouch.com/blog/2026-01-20-cc-impact/) | 2026 literature range. The low end reflects optimized production serving of input-heavy mixes: Oviedo et al. measure a median 0.31 Wh/query (IQR 0.16–0.60) for frontier-scale (>200B) models on H100-class nodes, and find earlier public estimates were overstated 4–20x. The high end is an output-token-dominated bound: Epoch-derived Claude Code figures put output tokens at ~1.95 kWh/MTok (input ~0.39, cache write ~0.49). No first-party figures exist for Claude as of mid-2026, so we borrow the published range for comparable models. |
| `WATER_L_PER_KWH_ONSITE` | 0.4 – 4.3 | L per kWh (on-site cooling) | [Li et al., "Making AI Less Thirsty" (2023)](https://arxiv.org/abs/2304.03271); 2026 regional compilations (Stanford AI Index 2026 / ML.Energy / IEA) | On-site water usage effectiveness (WUE) varies by site and season far more than a single representative figure suggests: ~0.4 L/kWh in cool regions (Iceland, Pacific Northwest, Scandinavia) to ~4.3 L/kWh in hot regions (Phoenix, Singapore, Texas), global average ~1.8. Replaced the earlier 1.1 point value with the regional range. |
| `WATER_L_PER_KWH_LIFECYCLE` | 1.8 – 12.0 | L per kWh (lifecycle) | [Li et al. (2023)](https://arxiv.org/abs/2304.03271) | On-site cooling plus the water embedded in electricity generation. The range is wide because it is dominated by the grid mix behind the datacenter — hydro-heavy grids sit near the top, wind/solar-heavy grids near the bottom. No 2026 replacement study found; still the canonical source. |
| `CACHED_READ_WEIGHT` | 0.1 | dimensionless (fraction of uncached cost) | assumption with 2026 empirical support — see below | Cached-prefix reads skip prefill compute; serving them is not free, but far cheaper than recomputation. 2026 Epoch-derived Claude Code figures (cache read ~39 Wh/MTok vs input ~390 Wh/MTok) land on exactly this 10% ratio. |
| `ESTIMATE_LABEL` | — | — | — | The string appended to every environmental figure: "rough estimate — no first-party figures exist for Claude; see docs/cli/ASSUMPTIONS.md". Printing it is mandatory, not optional. |

## 2026 reference points

Per-query snapshots from 2026 sources, for sanity-checking the constants above.
These are third-party estimates (typical variance 2–3x), not provider
disclosures:

| Model / scenario | Energy | Source |
|---|---|---|
| Frontier-scale median query (optimized production serving) | 0.31 Wh (IQR 0.16–0.60) | [Oviedo et al., Joule 2026](https://arxiv.org/abs/2509.20241) |
| Same, long reasoning workload (~5k output tokens) | 3.91 Wh (IQR 2.15–7.05) | Oviedo et al. 2026 |
| GPT-5.5 standard chat (~500 in / ~300 out tokens) | ~0.84 Wh | [Digital Applied (Apr 2026)](https://www.digitalapplied.com/blog/ai-model-sustainability-energy-report-2026) |
| Claude Opus 4.7 standard chat | ~0.78 Wh | Digital Applied 2026 |
| Claude Opus 4.7 long-context (800K–1M) | ~14.1–18.3 Wh | Digital Applied 2026 |
| Gemini 3 standard chat / Deep Think | ~0.61 / ~6.2 Wh | Digital Applied 2026 |
| Median Claude Code session (~592k tokens, 24 requests) | ~41 Wh | [Couch (Jan 2026)](https://simonpcouch.com/blog/2026-01-20-cc-impact/) |

Notes on source quality:

- Earlier per-query estimates — including "How Hungry is AI?" (Jegham et al.
  2025, [arXiv:2505.09598](https://arxiv.org/abs/2505.09598)) and the 2025
  Epoch AI blog figure this file previously cited — assumed non-production
  serving conditions; Oviedo et al. (peer-reviewed, Joule 2026) find such
  estimates overstated by 4–20x and they are no longer used here.
- No 2026 figures exist for Claude Fable or Claude Mythos; Anthropic had
  published no per-model energy or water metrics as of mid-2026 (joining the
  Frontier Climate coalition in June 2026 involved no per-model disclosure).
  The `ESTIMATE_LABEL` claim therefore still holds. Revisit if Anthropic
  publishes first-party figures.

## The cached-read weighting (10%)

Agentic Claude Code sessions are dominated by cache reads — the system prompt, tool definitions, and conversation prefix are re-read on every turn, and cache-read tokens routinely make up the large majority of input tokens. How they are weighted therefore moves the estimate more than any other single choice.

We count a cache-read token at **10% of an uncached token**. Rationale: a cached prefix skips prefill compute entirely; what remains is storage, retrieval, and attention over the cached KV entries. There is still no first-party measurement of this ratio, so we adopt 10% as an order-of-magnitude proxy — it is consistent with cache reads being priced at roughly a tenth of base input tokens, and the 2026 Epoch-derived Claude Code estimates ([Couch 2026](https://simonpcouch.com/blog/2026-01-20-cc-impact/): cache read ~39 Wh/MTok vs input ~390 Wh/MTok) land on exactly this ratio. It remains an estimate, not a measurement, and reports flag it as such.

**Sensitivity:** because cache reads dominate token counts, the estimate scales almost linearly with this weight in cache-heavy usage. If the true ratio were 5%, our figures overstate cached-token impact by about 2x; if it were 20%, they understate it by the same factor. Read the totals as order-of-magnitude, and comparisons over time (same assumption on both sides) as more trustworthy than absolute values.

## Why ranges, and why the "rough estimate" label is mandatory

There are no first-party energy or water figures for Claude inference. Everything else that determines the real number is also unknown to us: model size and architecture, hardware generation, batch sizes and utilization, context-length distribution, datacenter PUE and WUE, the grid mix at the sites serving a given request, and how these change over time. Each of these plausibly moves the result by a factor of 2 or more.

A single number would therefore convey false precision, which is worse than no number: it invites downstream citation as fact. So PromptCoach always prints a LOW–HIGH range derived from sourced bounds, always attaches the "rough estimate" label, and never emits an unqualified figure — this is a hard output rule, not a formatting preference. The direction, however, is not uncertain: fewer wasted tokens is strictly less compute, less energy, and less water. The ranges exist to keep the magnitude honest while the direction does the motivating.
