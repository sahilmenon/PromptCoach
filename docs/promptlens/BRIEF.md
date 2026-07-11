# PromptLens — One-Page Brief

**From:** [`REQUIREMENTS.md`](./REQUIREMENTS.md)  
**Decisions locked:** Q1=D · Q2=D · Q3=C · Stack R  
**Scope note:** Context token-stripping middleware is **out of MVP**.

## What we build

App that (1) analyzes past prompting history, (2) finds style inefficiencies, (3) scores prompts **0–100**, (4) optionally improves via a **cheap** small LLM before send.

## Locked MVP shape

| Choice | MVP |
|--------|-----|
| History | Upload exports **+** live OpenAI-compatible proxy |
| UX | React web dashboard first; extension = stretch |
| Processing | Cloud mini default **+** Ollama fallback |
| Stack | FastAPI + React/Vite + SQLite + tiktoken |
| Not in MVP | Low-info token strip / compression middleware |

## Marking fit

Innovation (style fingerprint) · Complexity (detect + score + improve + proxy) · UX (web scores) · Practical (better prompts, less waste) · Pitch · Collaboration.

## Next step

Run via README (Docker or local).
