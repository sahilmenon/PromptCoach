# tokenlean

tokenlean is a local companion for Claude Code subscriptions. It sits beside
the `claude` CLI, reads the transcripts Claude Code already writes, and uses a
fast `UserPromptSubmit` hook for optional coaching.

It does not require an Anthropic developer API key. It does not call the
Messages or Message Batches APIs. It does not set `ANTHROPIC_BASE_URL`, proxy
Claude traffic, replace subscription authentication, or create separate API
charges.

## How it fits

1. You use Claude Code normally through your existing Pro, Max, Team, or
   Enterprise subscription.
2. Claude Code writes session JSONL files under `~/.claude/projects/`.
3. `tokenlean analyze` parses new transcript content locally and stores
   aggregate analysis in `~/.tokenlean/db.sqlite`.
4. The optional `UserPromptSubmit` hook performs deterministic checks in the
   Claude CLI process flow. It can add a short context note, but never rewrites
   or blocks the prompt and never invokes another model.
5. The optional browser extension displays local findings and can inspect or
   edit a browser prompt only after an explicit button click.

## Commands

```text
npx tokenlean analyze [--claude-dir PATH]
npx tokenlean report [--json] [--write-claude-md] [--since 7d]
npx tokenlean hooks install | uninstall | mute <days>
npx tokenlean status
```

There is deliberately no proxy command and no API-analysis option.

## Local analyzer

The parser treats Claude Code's JSONL shape as unstable. Malformed and unknown
records are skipped instead of crashing, and byte offsets make repeat analysis
incremental. The heuristic pass detects correction turns, repeated reads,
oversized pasted code, abandoned sessions, and other locally measurable
patterns. Reports show evidence and plain-text fixes.

`tokenlean report --write-claude-md` writes `CLAUDE.md.suggested`. It never
changes `CLAUDE.md` directly.

## Live coaching

`tokenlean hooks install` merges a command hook into
`~/.claude/settings.json` and creates a backup before the first change. The
hook:

- runs only deterministic local code;
- exits 0 on errors and never uses the blocking exit code 2;
- never calls a model or network service;
- fires at most once per session and five times per day;
- can be muted or uninstalled.

Claude Code's official hook interface supplies the submitted prompt,
`session_id`, project directory, and local `transcript_path`.

## Browser extension

Load `extension/` as an unpacked Chrome extension. Its side panel can:

- inspect the active page after you click Inspect;
- read, suggest, and insert prompt text after separate approval clicks;
- import JSONL, JSON, or text transcripts locally.

It never submits a prompt. Imported raw text is not uploaded; only a small
aggregate summary is stored in extension storage.

## Privacy

All CLI analysis stays on the device. There is no telemetry and no developer
API integration. Transcripts can contain source code, paths, and user prose, so
do not commit real transcript files. Tests use synthetic fixtures only.

Environmental impact is reported as a sourced range with a mandatory
uncertainty label. See [ASSUMPTIONS.md](ASSUMPTIONS.md).

## License

[MIT](LICENSE)
