# Research Summary

Supports innovation + technical complexity for the hackathon brief in [`Requirement.md`](../Requirement.md).

---

## Why the idea is practical

- LLM APIs bill per token; filler and redundant context are a real cost.  
- “Prompt bloat” categories (vague filler, excessive context, redundant instructions, hedges) increase cost and often hurt quality.  
- Users lack a feedback loop: they never see a **score** or a **style report** on their habits.

## Why the idea is technically interesting

| Technique | Prior art | Our use |
|-----------|-----------|---------|
| Prompt defect taxonomy | Surveys of prompt failure modes (spec, structure, context, efficiency, …) | Detector categories + coaching copy |
| Hard prompt compression | Microsoft **LLMLingua** / LLMLingua-2 — small model drops low-info tokens | **Strip** toggle |
| Automated prompt optimization | DSPy, OPRO, Promptolution | Lighter **Improve** pass with cheap LLM (not full optimizer search) |
| LLM-as-judge | Eval platforms (Promptfoo, Braintrust, small judge models) | **OutputScore** with mini model |
| Token accounting | tiktoken / provider usage | Efficiency + $ estimates |

## Competitive white space

| Existing | Gap |
|----------|-----|
| One-shot “improve my prompt” GPTs | No longitudinal **history style** analysis |
| Promptfoo / Braintrust | Team/CI eval, not personal coaching UX |
| LLMLingua library | Not a product with score + toggles + history |
| Provider usage dashboards | Show spend, not *why* prompts are inefficient |

**PromptLens positioning:** personal inefficiency analytics + 0–100 scoring + cheap Improve + Strip firewall.

## Design implications

1. Heuristics first (reliable demo) + cheap LLM for rewrite/judge.  
2. Always show **why** a score is low (spans + pattern IDs).  
3. Strip must be previewable (trust + UX marks).  
4. Never use expensive frontier models for processing (requirement constraint).  

## References (starting points)

- LLMLingua / LLMLingua-2 (Microsoft Research) — prompt compression  
- Prompt defect taxonomies (software-engineering framing of bad prompts)  
- DSPy / prompt optimization literature — automated improvement  
- Industry notes on prompt bloat & token waste (2025–2026)  
