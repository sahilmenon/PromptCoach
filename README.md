# tokenlean

tokenlean is a prompt-efficiency companion for Claude Code and Codex CLI. It
reads Claude Code transcripts locally and uses each CLI's `UserPromptSubmit`
hook for optional hosted-model coaching.

The transcript analyzer stays local. Live prompt coaching uses a separate,
user-funded API key and defaults to Anthropic's `claude-haiku-4-5` model.
It does not proxy Claude traffic or replace subscription authentication.

## How it fits

1. You use Claude Code normally through your existing Pro, Max, Team, or
   Enterprise subscription.
2. Claude Code writes session JSONL files under `~/.claude/projects/`.
3. `tokenlean analyze` parses new transcript content locally and stores
   aggregate analysis in `~/.tokenlean/db.sqlite`.
4. The optional `UserPromptSubmit` hook sends prompts beginning with `review:`
   to a cheap hosted model and displays feedback directly in the terminal.
5. The optional browser extension displays local findings and can inspect or
   edit a browser prompt only after an explicit button click.

## Commands

```text
npx tokenlean analyze [--claude-dir PATH]
npx tokenlean report [--json] [--write-claude-md] [--since 7d]
npx tokenlean hooks install [claude|codex|all]
npx tokenlean hooks uninstall [claude|codex|all]
npx tokenlean hooks mute <days>
npx tokenlean hooks bypass next|on|off|status
npx tokenlean status
```

There is deliberately no proxy command and no API-based transcript analysis.

## Local analyzer

The parser treats Claude Code's JSONL shape as unstable. Malformed and unknown
records are skipped instead of crashing, and byte offsets make repeat analysis
incremental. The heuristic pass detects correction turns, repeated reads,
oversized pasted code, abandoned sessions, and other locally measurable
patterns. Reports show evidence and plain-text fixes.

`tokenlean report --write-claude-md` writes `CLAUDE.md.suggested`. It never
changes `CLAUDE.md` directly.

## Live coaching

Set an API key before starting Claude Code, then install the hook:

```sh
export ANTHROPIC_API_KEY="your-api-key"
npx tokenlean hooks install
```

`TOKENLEAN_LLM_API_KEY` is also accepted. To use OpenAI instead:

```sh
export TOKENLEAN_LLM_PROVIDER="openai"
export OPENAI_API_KEY="your-api-key"
export TOKENLEAN_LLM_BASE_URL="https://api.openai.com/v1"
export TOKENLEAN_LLM_MODEL="gpt-5.4-nano"
export TOKENLEAN_LLM_TIMEOUT_MS="7500"
```

`tokenlean hooks install` merges a command hook into
`~/.claude/settings.json` and `~/.codex/hooks.json`, creating backups before
the first change. Pass `claude` or `codex` to install only one integration.
After installing the Codex hook, open `/hooks` in Codex CLI and trust the new
TokenLean command. The hook:

- sends prompts beginning with `review:` and the current working directory to the configured API;
- blocks with terminal feedback and instructions to restore/edit the prompt;
- blocks when review is unconfigured, unavailable, or times out;
- returns brief feedback for every reviewed prompt, including prompts judged good;
- can be muted or uninstalled.

Ordinary prompts go directly to the coding model. Prefix a prompt with
`review:` to send it only to Haiku and block with feedback. Keep the prefix
while revising to request another review; remove it and resubmit when you want
the prompt sent to the coding model. Because reviewed submissions are blocked,
the coding model never sees the `review:` prefix.
`bypass next`, `bypass on`, `bypass off`, and `mute <days>` remain available as
manual controls.

Both CLIs supply the submitted prompt, `session_id`, project directory, and
local `transcript_path`. Transcript ingestion currently supports Claude Code's
JSONL format only; live coaching supports both CLIs.

## Browser extension

Load `extension/` as an unpacked Chrome extension. Its side panel can:

- inspect the active page after you click Inspect;
- read, suggest, and insert prompt text after separate approval clicks;
- import JSONL, JSON, or text transcripts locally.

It never submits a prompt. Imported raw text is not uploaded; only a small
aggregate summary is stored in extension storage.

## Privacy

Transcript analysis stays on the device and there is no telemetry. Prompts
beginning with `review:` and their working directory are sent to the configured
model provider. Ordinary prompts are not sent by TokenLean. The full transcript is
not sent. Prompts and transcripts can contain source code, paths, and user
prose, so choose a provider whose data policy fits your needs and do not commit
real transcript files. Tests use synthetic fixtures only.

Environmental impact is reported as a sourced range with a mandatory
uncertainty label. See [ASSUMPTIONS.md](ASSUMPTIONS.md).

## License

[MIT](LICENSE)
