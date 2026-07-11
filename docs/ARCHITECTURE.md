# Technical Architecture

Per [`Requirement.md`](../Requirement.md) Immediate Instructions §3.

**Clarifying answers locked:** Q1=D, Q2=D, Q3=C — see [`CLARIFYING_QUESTIONS.md`](CLARIFYING_QUESTIONS.md).  
**Stack:** R (FastAPI + React + SQLite) — see [`TECH_STACKS.md`](TECH_STACKS.md).  
**Scope:** history audit · score · improve · proxy. **Token-strip middleware is out of MVP.**

---

## System name

**PromptLens** — prompting coach (audit · score · improve).

## Design principles (from constraints)

1. **Cheap processing** — Improve / Judge use mini or local models only.  
2. **Practical** — helps before send; works with real history.  
3. **Explainable scores** — 0–100 with reasons, not vibes.  
4. **Opt-in automation** — Improve is a toggle.  
5. **Local-first** — history in SQLite on the user’s machine by default.  
6. **Clean code** — modular services, commented public APIs.

---

## High-level architecture

```
                    ┌─────────────────────────────────────┐
                    │           Web Dashboard             │
                    │  Style Report │ Playground          │
                    └─────────────┬───────────────────────┘
                                  │ HTTP/JSON
┌──────────────┐        ┌─────────▼─────────┐        ┌─────────────┐
│ History      │───────▶│   PromptLens API  │───────▶│ Target LLM  │
│ upload/JSON  │        │   (FastAPI)       │        │ (user’s AI) │
└──────────────┘        └─────────┬─────────┘        └─────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
              ┌──────────┐ ┌──────────┐ ┌────────────┐
              │ Detector │ │ Improver │ │  Gateway   │
              │ + Scorer │ │ (cheap   │ │  / proxy   │
              │ (0–100)  │ │  LLM)    │ └────────────┘
              └──────────┘ └──────────┘
                    │
                    ▼
              ┌──────────┐
              │ SQLite   │
              └──────────┘
```

### Pre-call pipeline (core UX)

```
User prompt (+ optional context)
        │
        ▼
 [1] Score Input (0–100) + findings/suggestions
        │
        ▼
 [2] if Improve ON → cheap LLM rewrite → re-score
        │
        ▼
 [3] Send to target AI
        │
        ▼
 [4] Score Output (0–100) + tokens/$ logged
```

---

## Component responsibilities

| Component | Responsibility |
|-----------|----------------|
| **Ingest** | Parse exports / generic turns → SQLite |
| **Detector** | Regex/rules for inefficiencies |
| **Scorer** | Weighted 0–100 InputScore / OutputScore |
| **Improver** | Cheap LLM structured rewrite |
| **Gateway** | OpenAI-compatible proxy |
| **UI** | Report + playground |

---

## Recommended tools (Stack R)

| Layer | Tool |
|-------|------|
| API | Python FastAPI |
| UI | React + Vite + TypeScript |
| DB | SQLite |
| Tokens | tiktoken |
| Cheap LLM | GPT-4.1-mini / Haiku / Flash / Ollama 7–8B |
| Validation | Pydantic |
| Charts | Recharts |

---

## Locked from clarifying answers

| Decision | MVP requirement |
|----------|-----------------|
| Q1=D | History **upload** + **proxy** both in MVP |
| Q2=D | **Web app** is primary UX; extension = stretch only |
| Q3=C | Processing: **cloud mini default**, **Ollama fallback** |

## Approval checklist

- [x] Pipeline: Score → Improve? → Call  
- [x] FastAPI + React + SQLite (Stack R)  
- [x] Cheap models only for Improve/Judge  
- [x] Token-strip middleware **excluded** from MVP  
- [x] OpenAI-compatible proxy in MVP  

**Status:** ✅ Locked  

Implement per [`PROJECT_PLAN.md`](PROJECT_PLAN.md).
