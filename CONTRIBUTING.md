# Contributing

tokenlean is a Node 20+ local companion for Claude Code subscription users.

```text
npm install
npm run build
npm test
npm run extension:check
```

## Architecture

- `src/analyzer/`: defensive local JSONL parsing and deterministic heuristics
- `src/hook/`: Claude Code `UserPromptSubmit` coaching
- `src/report/`: plain-text and JSON reports
- `extension/`: optional Chrome side panel

## Hard rules

1. No Anthropic developer API calls, API keys, custom base URLs, or traffic
   proxies. The product runs on top of the user's normal Claude Code
   subscription and local artifacts.
2. The hook never blocks. It must never exit 2, call a model, use the network,
   or rewrite a prompt.
3. The parser never crashes on a transcript. Unknown and malformed records are
   skipped.
4. Never commit real transcripts. Use synthetic fixtures containing invented
   paths and text.
5. Suggestions are plain text with visible evidence. `CLAUDE.md` is never
   edited directly.
