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

Put an API key in a `.env` file (project directory or `~/.tokenlean/.env`), then
install the hook:

```sh
cp .env.example .env
# edit .env and set GEMINI_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY / CURSOR_API_KEY)
npx tokenlean hooks install
```

Shell `export` still works and overrides `.env`. `TOKENLEAN_LLM_API_KEY` is also
accepted. To use Google Gemini (free tier):

```sh
# in .env
TOKENLEAN_LLM_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-api-key
TOKENLEAN_LLM_MODEL=gemini-2.5-flash
```

Get a key at [Google AI Studio](https://aistudio.google.com/app/apikey). To use OpenAI instead:

```sh
# in .env
TOKENLEAN_LLM_PROVIDER=openai
OPENAI_API_KEY=your-api-key
TOKENLEAN_LLM_BASE_URL=https://api.openai.com/v1
TOKENLEAN_LLM_MODEL=gpt-5.4-nano
TOKENLEAN_LLM_TIMEOUT_MS=7500
```

To use a Cursor API key (from [Cursor Dashboard → API Keys](https://cursor.com/dashboard)):

```sh
# in .env
CURSOR_API_KEY=your-cursor-api-key
# optional: TOKENLEAN_LLM_MODEL=composer-2.5
# optional faster path: npm i @cursor/sdk  (Node 22.13+)
# or install the Cursor CLI (`agent`) and keep it on PATH
```

Without `@cursor/sdk` or the Cursor CLI, tokenlean falls back to Cursor's Cloud Agents API (slower). You can also point `TOKENLEAN_LLM_BASE_URL` at a local OpenAI-compatible Cursor proxy and keep `TOKENLEAN_LLM_PROVIDER=cursor`.

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

Load `extension/` as an unpacked Chrome extension. Keep a local bridge running so
Analyze uses the same hosted prompt-review model as the CLI hook:

```text
# .env with GEMINI_API_KEY (or ANTHROPIC / OPENAI / CURSOR)
npx tokenlean extension serve
```

The extension can then:

- review selected prompt text with that model after you click Analyze;
- inspect the active page after you click Inspect;
- read, suggest, and insert prompt text after separate approval clicks;
- import JSONL, JSON, or text transcripts locally.

It never submits a prompt to the chat site. Imported raw transcript text is not
uploaded; only a small aggregate summary is stored in extension storage. Model
review sends the selected prompt to your configured Anthropic, OpenAI, or Cursor
API through the local bridge on `127.0.0.1:8787`.

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
