# Contributing

LLMGuide is a Node 20+ prompt-efficiency companion for Claude Code and Codex.

```text
npm install
npm run build
npm test
npm run extension:check
```

## Architecture

- `src/analyzer/`: defensive JSONL parsing, local heuristics, and optional Haiku analysis
- `src/hook/`: Claude Code and Codex `UserPromptSubmit` coaching
- `src/report/`: plain-text and JSON reports
- `src/credentials.ts`: persistent API-key storage and environment overrides
- `src/extensionServer.ts`: local bridge for the Chrome extension Analyze button
- `extension/`: Chrome MV3 floating coach + Gemini audit dashboard
- `apps/api` + `apps/web`: PromptLens improve / score / strip stack
- `docs/`: documentation index ([docs/README.md](docs/README.md))

## Hard rules

1. Hosted analysis is explicit, uses the user's API key, and must clearly
   disclose what leaves the device. Local-only operation must remain available.
2. The hook reviews only prompts beginning with `review:`. It never rewrites or
   submits a prompt to the coding model on the user's behalf.
3. The parser never crashes on a transcript. Unknown and malformed records are
   skipped.
4. Never commit real transcripts. Use synthetic fixtures containing invented
   paths and text.
5. Suggestions are plain text with visible evidence. `CLAUDE.md` is never
   edited directly.
