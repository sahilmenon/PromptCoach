# PromptCoach

A CLI and Chrome extension that catches wasteful prompting habits in Claude Code and Codex — built in 48 hours as **UNSW CSESoc Flagship Hackathon 2026 Finalist**.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/) [![Python](https://img.shields.io/badge/Python-FastAPI-green)](https://fastapi.tiangolo.com/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![npm](https://img.shields.io/badge/npm-promptcoach-red)](https://www.npmjs.com/package/promptcoach)

---

## What it solves

AI coding assistants produce far worse output when prompted sloppily — vague instructions, missing context, no feedback loop. The problem is invisible: you get a mediocre answer, blame the model, and repeat the same pattern next session. PromptCoach makes the feedback loop explicit: analyze your past sessions, score your habits, and get coached on individual prompts before they're sent.

---

## Architecture

The key design decision: **one shared TypeScript analysis core** (`src/shared/core.ts`) that runs identically in both Node.js (the CLI) and the browser (the Chrome extension). The same scoring rules, the same heuristics, the same local analysis — no duplication, no drift between the two surfaces.

```
src/shared/core.ts          ← shared analysis engine (TypeScript)
       │
       ├── src/             CLI: hooks, analyzer, session ingestion, reports
       │   └── bin/promptcoach.js
       │
       └── extension/       Chrome extension: Analyze UI, Gemini dashboard
           └── lib/promptcoach-core.js   (bundled from core.ts)

apps/api/                   FastAPI backend (PromptLens)
apps/web/                   Vite frontend (PromptLens)
db/                         Drizzle ORM schema → Cloudflare D1
```

**Stack:** TypeScript · Node.js · Next.js · FastAPI · Drizzle ORM · Cloudflare D1 · Chrome Extension APIs · Anthropic / OpenAI / Gemini APIs

---

## Key results

| Feature | Detail |
|---|---|
| **Pre-submit coaching** | Add `review:` to any prompt — PromptCoach intercepts it, sends to Haiku/GPT Nano/Gemini Flash for feedback, lets you revise before the coding model ever sees it |
| **Session analysis** | Ingests Claude Code JSONL transcripts; scores prompts on waste patterns (vagueness, missing context, over-length) |
| **Multi-provider** | Anthropic Haiku (default), OpenAI GPT Nano, Gemini Flash — swappable via env var |
| **Local-only mode** | `--sample 0` runs all heuristics locally with zero API calls |
| **Chrome extension** | Inspect and analyze prompts on AI chat sites; shares the same core as the CLI |
| **Published** | `npm install --global promptcoach` |

---

## Quickstart

```sh
npm install --global promptcoach
promptcoach config set-key        # save your Anthropic/OpenAI/Gemini key
promptcoach hooks install         # wire into Claude Code + Codex
promptcoach analyze --wait        # analyze your sessions
promptcoach report                # see your score and top issues
```

## Repository layout

```text
src/                 promptcoach CLI, hook, analyzer, reports
extension/           Chrome extension (Analyze UI + Gemini audit dashboard)
apps/api             PromptLens FastAPI backend
apps/web             PromptLens Vite frontend
docs/                Documentation index — start at docs/README.md
fixtures/            Synthetic sample data for demos and tests
bin/promptcoach.js      CLI entry point
```

More detail: [docs/README.md](docs/README.md).

---

## What I'd do next

**VS Code extension** — the Chrome extension works on AI chat sites; a VS Code extension would hook into the editor directly, letting PromptCoach intercept prompts before they hit Copilot or the GitHub Copilot Chat panel. The shared core is already browser-runtime-compatible, so the port would be a packaging problem, not an engine rewrite.

**Team-level analytics** — right now analysis is per-developer. Aggregating anonymous session data across a team (opt-in, local aggregation) would let engineering leads see which prompting patterns correlate with slower task completion — the kind of data an eng manager would actually pay for.

**Prompt pattern library** — instead of just flagging bad prompts, build a searchable library of high-scoring prompt patterns from the user's own history. "You solved a similar refactor problem well on 2025-03-12 — here's that prompt structure." Memory-augmented coaching.

**Fine-tuned coaching model** — Haiku/GPT Nano are good enough for basic coaching, but a model fine-tuned on labeled (prompt, quality score) pairs from PromptCoach's own heuristic output would be faster, cheaper, and domain-specific. The labeled dataset already exists implicitly in every user's analysis history.

---

## Before you begin

You need:

- Claude Code and/or Codex CLI;
- [Node.js 20 or newer](https://nodejs.org/en/download); and
- optionally, an Anthropic, OpenAI, or Gemini API key for hosted coaching.
  Transcript analysis with a hosted model specifically requires Anthropic.

An API key is separate from a Claude Pro or Max subscription and may incur
small usage charges. PromptCoach still provides local analysis without one.

To check Node.js, open Terminal and run:

```sh
node --version
```

If the version starts with `v20` or higher, you are ready. If Terminal says
the command was not found, install Node.js from the link above and reopen
Terminal.

## Install once

Open Terminal and run:

```sh
npm install --global promptcoach
```

Confirm that the installation worked:

```sh
promptcoach --version
```

That is the entire installation. The `promptcoach` command now works from every
project folder. To update later, run the installation command again.

## One-time setup

### 1. Save a model provider key

Anthropic (Haiku) is the default:

```sh
promptcoach config set-key
```

For GPT Nano or Gemini Flash coaching, choose the provider:

```sh
promptcoach config set-key --provider openai
promptcoach config set-key --provider gemini
```

Paste your provider API key at the prompt and press Enter. The characters are
hidden while you type. Each key is stored at
`~/.promptcoach/credentials.json`, with owner-only file permissions, and works
from every project directory. You do not need to export it again.

Skip this step if you only want fully local analysis.

### 2. Install prompt coaching

Run:

```sh
promptcoach hooks install
```

This enables coaching for both Claude Code and Codex. To enable only one:

```sh
promptcoach hooks install claude
promptcoach hooks install codex
```

If you use Codex, open Codex afterward, enter `/hooks`, and trust the new
PromptCoach hook when asked.

### 3. Check the setup

Run:

```sh
promptcoach status
```

Lines beginning with `OK` are ready. A `WARN` line explains what is missing;
it does not necessarily mean the rest of PromptCoach is broken.

## Run your first analysis

After you have used Claude Code for at least one session, run:

```sh
promptcoach analyze --wait
promptcoach report
```

`analyze` reads new Claude Code session data, runs local checks, and—when a key
is configured—sends condensed copies of up to 10 high-waste sessions to Haiku.
`--wait` keeps the command open until the Haiku results arrive. `report` then
shows your score, evidence, and practical suggestions.

For analysis that never sends transcript content to an API, run:

```sh
promptcoach analyze --sample 0
promptcoach report
```

Analysis is incremental, so later runs only read new transcript content.
Running it regularly is safe and does not duplicate already analyzed sessions.

## Get feedback on a prompt

With the hook and API key configured, add `review:` to the beginning of a
prompt in Claude Code or Codex:

```text
review: update the login form and run the relevant tests
```

PromptCoach sends that prompt to your configured hosted model and displays
feedback without sending it to the coding model. Revise it with `review:` for
another check. When you are happy, remove `review:` and submit it normally.

Prompts without `review:` pass directly to Claude Code or Codex and are not
sent to the hosted model by the coaching hook.

## Everyday commands

```text
promptcoach analyze --wait         Analyze new sessions and wait for Haiku
promptcoach analyze --sample 0     Analyze locally only
promptcoach report                 Show your latest report
promptcoach status                 Check whether everything is configured
promptcoach hooks mute 1           Pause coaching for one day
promptcoach hooks bypass next      Skip coaching for the next prompt
promptcoach config unset-key       Remove all saved provider keys
promptcoach extension serve        Local bridge for the Chrome extension Analyze button
```

Advanced report options:

```text
promptcoach report --since 7d             Show the last seven days
promptcoach report --json                 Produce machine-readable output
promptcoach report --write-claude-md      Write CLAUDE.md.suggested files
```

PromptCoach never edits an existing `CLAUDE.md`; it only writes a suggested
version for you to review.

## Browser extension

The optional Chrome extension can inspect prompts on supported AI websites.
To install it from this repository:

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `extension` folder inside this project.
5. Pin PromptCoach from Chrome's Extensions menu for easy access.

Keep a local bridge running so Analyze uses the same hosted prompt-review model
as the CLI hook:

```text
# .env with GEMINI_API_KEY (or ANTHROPIC / OPENAI / CURSOR), or promptcoach config set-key
promptcoach extension serve
```

The extension can then:

- review selected prompt text with that model after you click Analyze;
- show a score and advice, plus a suggested rewrite only when needed;
- fall back to a fully local analysis (same rules as the CLI heuristics)
  when the bridge is offline;
- run the Gemini deep prompt-efficiency audit / dashboard from Inspect;
- import JSONL, JSON, or text transcripts locally.

It never submits a prompt to the chat site. Model review sends the selected
prompt to your configured provider through the local bridge on
`127.0.0.1:8787`. Imported files are parsed locally; the optional Re-evaluate
button sends the extracted prompts to the Gemini audit dashboard, which uses
your own Gemini key. Skip Deep Audit and Re-evaluate for fully local use.

The extension and the CLI share one analysis core (`src/shared/core.ts`).
The committed bundle `extension/lib/promptcoach-core.js` is generated from it
with `npm run build:extension-core`; do not edit the bundle by hand.

## Privacy and cost

Local parsing and heuristic analysis stay on your computer, and PromptCoach has
no telemetry. Hosted features use your own provider API key:

- `analyze` may send condensed transcript content to Anthropic, including
  prompt text, code snippets, and file paths;
- coaching sends only prompts beginning with `review:` and the current working
  directory; and
- ordinary prompts are not sent by the coaching hook.

Choose a provider whose data policy fits your work. Do not analyze transcripts
containing secrets you are not permitted to share. To guarantee local-only
analysis, use `promptcoach analyze --sample 0`.

The saved API key is plain text protected by your operating system's
owner-only file permissions. Remove it at any time with:

```sh
promptcoach config unset-key
```

For CI, containers, or temporary overrides, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), and
`PROMPTCOACH_LLM_API_KEY` are supported. Set `PROMPTCOACH_LLM_PROVIDER` when using
the generic key variable.

## Troubleshooting

### `promptcoach: command not found`

Close and reopen Terminal, then try:

```sh
promptcoach status
```

If installation showed a permissions error, do not add `sudo` unless you
understand its effects. You can run PromptCoach without a global installation by
placing `npx` before the command:

```sh
npx promptcoach status
```

### No sessions appear in the report

PromptCoach currently ingests Claude Code transcript files. Complete at least one
Claude Code session, then run `promptcoach analyze` again. Live prompt coaching
works with both Claude Code and Codex.

### Haiku analysis is skipped

Save a key with `promptcoach config set-key`, then use `promptcoach status` to
confirm that hosted review is configured.

### Codex does not show coaching feedback

Run `promptcoach hooks install codex`, open `/hooks` inside Codex, and trust the
PromptCoach hook.

### Remove PromptCoach integrations

```sh
promptcoach hooks uninstall
promptcoach config unset-key
npm uninstall --global promptcoach
```

Hook installation preserves unrelated settings and creates a backup before
the first change.

## Advanced model configuration

Haiku is the default. These environment variables are available for advanced
or automated setups:

```sh
export PROMPTCOACH_LLM_MODEL="claude-haiku-4-5"
export PROMPTCOACH_LLM_BASE_URL="https://api.anthropic.com/v1"
export PROMPTCOACH_LLM_TIMEOUT_MS="7500"
```

The live coaching hook can also use OpenAI GPT Nano:

```sh
export PROMPTCOACH_LLM_PROVIDER="openai"
export OPENAI_API_KEY="your-api-key"
export PROMPTCOACH_LLM_MODEL="gpt-5.4-nano"
```

Or Gemini Flash:

```sh
export PROMPTCOACH_LLM_PROVIDER="gemini"
export GEMINI_API_KEY="your-api-key"
export PROMPTCOACH_LLM_MODEL="gemini-3.1-flash-lite"
```

Transcript analysis itself uses Anthropic's Message Batches API and defaults
to Haiku.

Environmental impact is reported as a sourced range with a mandatory
uncertainty label. See [docs/cli/ASSUMPTIONS.md](docs/cli/ASSUMPTIONS.md).

## License

[MIT](LICENSE)
