# Tech Stacks & Recommended Tools

For approval alongside [`ARCHITECTURE.md`](ARCHITECTURE.md).  
Constraint: **cheap, efficient models** for all processing (Improve / Judge / Strip).

---

## Default recommendation (approve this unless you prefer an alternative)

### Stack R — FastAPI + React (best balance)

| Layer | Choice |
|-------|--------|
| UI | React + Vite + TypeScript |
| Styling | Tailwind (+ simple component set) |
| Charts | Recharts |
| API | FastAPI (Python 3.11+) |
| DB | SQLite + SQLModel/SQLAlchemy |
| Scoring heuristics | tiktoken + YAML rule packs |
| Embeddings (optional) | `sentence-transformers` MiniLM **or** cheap embedding API |
| Improve / Judge | `gpt-4.1-mini` / Claude Haiku / Gemini Flash / Ollama `qwen2.5:7b` |
| Strip | Heuristic first; optional `llmlingua` (LLMLingua-2) |
| Target AI call | `openai` Python SDK (OpenAI-compatible) |
| Schemas | Pydantic v2 |
| Package managers | `uv` (Python) + `pnpm` (JS) |

**Why this stack for the hackathon**

- Technical complexity: real ML/NLP path in Python + product UI in React  
- Practicality: local proxy other tools can use  
- UX: dashboard quality for Design criterion  
- Cost: processing never needs GPT-4-class models  

```
cse_hackathon/
  apps/web/
  apps/api/
  packages/rules/     # anti-pattern YAML
  fixtures/
  docs/
```

---

## Alternative stacks

### Stack A — All TypeScript (fastest ship)

- **Next.js** App Router + Server Actions  
- **Vercel AI SDK**, `js-tiktoken`, Zod, SQLite (`better-sqlite3`)  
- Strip = heuristic + mini-model “delete only”  
- **Pros:** one language. **Cons:** weaker offline compression story.

### Stack B — Python UI (max ML demo)

- **Streamlit or Gradio** + FastAPI logic  
- Full **LLMLingua** path  
- **Pros:** compression depth. **Cons:** less “product” UX polish.

### Stack C — Systems gateway

- **Go/Rust** reverse proxy + Python worker for Improve/Strip  
- **Pros:** infra flex. **Cons:** high weekend risk.

### Stack D — Browser extension

- **Plasmo/WXT** + local API  
- **Pros:** wow demo. **Cons:** DOM fragility; UX completeness risk.

---

## Model policy (hard rule)

| Role | Allowed | Forbidden for MVP processing |
|------|---------|------------------------------|
| Improver | Mini / Haiku / Flash / local 7–8B | Frontier “max” models |
| Output judge | Same as improver | Frontier |
| Strip assist | Heuristic, LLMLingua-2, or mini delete-only | Frontier |
| User’s target AI | Whatever they already pay for | — |

---

## Decision tree

```
Need fastest MVP? ──yes──▶ Stack A
        │
        no
        ▼
Want strongest ML + product UI? ──yes──▶ Stack R (default)
        │
        no
        ▼
Compression-first research demo? ──yes──▶ Stack B
```

---

## Approval

- [x] **Stack R** approved (aligned with Q1=D, Q2=D, Q3=C)  
- [ ] Stretch only if time: Stack D (browser extension)

### Processing models (Q3=C hybrid)

| Role | Default (cloud) | Fallback (local) |
|------|-----------------|------------------|
| Improver | `gpt-4.1-mini` (or Haiku / Flash) | Ollama `qwen2.5:7b` |
| Judge | same as Improver | same Ollama model |
| Strip assist | heuristic (+ optional mini) | heuristic only / Ollama |
| Target AI | user’s cloud frontier (or local) | unchanged |

Env sketch:

```
PROCESSING_PROVIDER=auto   # auto | openai | anthropic | ollama
IMPROVER_MODEL=gpt-4.1-mini
JUDGE_MODEL=gpt-4.1-mini
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b
OPENAI_API_KEY=
```
