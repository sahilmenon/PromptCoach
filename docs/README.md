# Documentation

Index of project docs. Product entry point remains [`../README.md`](../README.md).

## CLI & coaching (`docs/cli/`)

| Doc | Purpose |
|-----|---------|
| [ASSUMPTIONS.md](./cli/ASSUMPTIONS.md) | Environmental-impact estimate ranges and sources |
| [RUNNING_WITH_CLAUDE.md](./cli/RUNNING_WITH_CLAUDE.md) | Claude Code / Codex hook setup notes |

## PromptLens app (`docs/promptlens/`)

Hackathon product docs for the `apps/api` + `apps/web` stack.

| Doc | Purpose |
|-----|---------|
| [REQUIREMENTS.md](./promptlens/REQUIREMENTS.md) | Original brief and marking criteria |
| [BRIEF.md](./promptlens/BRIEF.md) | Condensed product brief |
| [PRODUCT.md](./promptlens/PRODUCT.md) | Product definition |
| [MVP_SPEC.md](./promptlens/MVP_SPEC.md) | MVP feature spec |
| [ARCHITECTURE.md](./promptlens/ARCHITECTURE.md) | Technical architecture |
| [DATA_MODEL.md](./promptlens/DATA_MODEL.md) | Data model |
| [API.md](./promptlens/API.md) | HTTP API |
| [SCORING.md](./promptlens/SCORING.md) | Prompt scoring |
| [DOCKER.md](./promptlens/DOCKER.md) | Docker Compose |
| [PROJECT_PLAN.md](./promptlens/PROJECT_PLAN.md) | Phased plan |
| [ROADMAP.md](./promptlens/ROADMAP.md) | Roadmap |
| [RESEARCH.md](./promptlens/RESEARCH.md) | Research notes |
| [TECH_STACKS.md](./promptlens/TECH_STACKS.md) | Stack choices |
| [HACKATHON.md](./promptlens/HACKATHON.md) | Pitch / demo |
| [CLARIFYING_QUESTIONS.md](./promptlens/CLARIFYING_QUESTIONS.md) | Clarifying Q&A |

## Repository map

```text
apps/api          PromptLens FastAPI backend
apps/web          PromptLens Vite frontend
app/              Next.js preview / site helpers (legacy)
bin/              llmguide CLI entry
docs/             This documentation tree
extension/        Chrome MV3 extension (Analyze + Gemini audit)
fixtures/         Synthetic sample data
packages/rules    Shared rule patterns
src/              llmguide CLI + hook + report + analyzer
tests/            Vitest suite
```
