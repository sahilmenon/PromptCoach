# LLMGuide

LLMGuide helps you spot wasteful prompting habits in Claude Code and Codex.
It can analyze past Claude Code sessions, produce a readable report, and give
optional Haiku, GPT Nano, or Gemini Flash feedback before you submit a prompt.

You do not need to be a developer to set it up. The basic setup takes a few
minutes and only needs to be completed once.

## Before you begin

You need:

- Claude Code and/or Codex CLI;
- [Node.js 20 or newer](https://nodejs.org/en/download); and
- optionally, an Anthropic, OpenAI, or Gemini API key for hosted coaching.
  Transcript analysis with a hosted model specifically requires Anthropic.

An API key is separate from a Claude Pro or Max subscription and may incur
small usage charges. LLMGuide still provides local analysis without one.

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
npm install --global llmguide
```

Confirm that the installation worked:

```sh
llmguide --version
```

That is the entire installation. The `llmguide` command now works from every
project folder. To update later, run the installation command again.

## One-time setup

### 1. Save a model provider key

Anthropic (Haiku) is the default:

```sh
llmguide config set-key
```

For GPT Nano or Gemini Flash coaching, choose the provider:

```sh
llmguide config set-key --provider openai
llmguide config set-key --provider gemini
```

Paste your provider API key at the prompt and press Enter. The characters are
hidden while you type. Each key is stored at
`~/.llmguide/credentials.json`, with owner-only file permissions, and works
from every project directory. You do not need to export it again.

Skip this step if you only want fully local analysis.

### 2. Install prompt coaching

Run:

```sh
llmguide hooks install
```

This enables coaching for both Claude Code and Codex. To enable only one:

```sh
llmguide hooks install claude
llmguide hooks install codex
```

If you use Codex, open Codex afterward, enter `/hooks`, and trust the new
LLMGuide hook when asked.

### 3. Check the setup

Run:

```sh
llmguide status
```

Lines beginning with `OK` are ready. A `WARN` line explains what is missing;
it does not necessarily mean the rest of LLMGuide is broken.

## Run your first analysis

After you have used Claude Code for at least one session, run:

```sh
llmguide analyze --wait
llmguide report
```

`analyze` reads new Claude Code session data, runs local checks, and—when a key
is configured—sends condensed copies of up to 10 high-waste sessions to Haiku.
`--wait` keeps the command open until the Haiku results arrive. `report` then
shows your score, evidence, and practical suggestions.

For analysis that never sends transcript content to an API, run:

```sh
llmguide analyze --sample 0
llmguide report
```

Analysis is incremental, so later runs only read new transcript content.
Running it regularly is safe and does not duplicate already analyzed sessions.

## Get feedback on a prompt

With the hook and API key configured, add `review:` to the beginning of a
prompt in Claude Code or Codex:

```text
review: update the login form and run the relevant tests
```

LLMGuide sends that prompt to your configured hosted model and displays
feedback without sending it to the coding model. Revise it with `review:` for
another check. When you are happy, remove `review:` and submit it normally.

Prompts without `review:` pass directly to Claude Code or Codex and are not
sent to the hosted model by the coaching hook.

## Everyday commands

```text
llmguide analyze --wait         Analyze new sessions and wait for Haiku
llmguide analyze --sample 0     Analyze locally only
llmguide report                 Show your latest report
llmguide status                 Check whether everything is configured
llmguide hooks mute 1           Pause coaching for one day
llmguide hooks bypass next      Skip coaching for the next prompt
llmguide config unset-key       Remove all saved provider keys
```

Advanced report options:

```text
llmguide report --since 7d             Show the last seven days
llmguide report --json                 Produce machine-readable output
llmguide report --write-claude-md      Write CLAUDE.md.suggested files
```

LLMGuide never edits an existing `CLAUDE.md`; it only writes a suggested
version for you to review.

## Browser extension

The optional Chrome extension can inspect prompts on supported AI websites.
To install it from this repository:

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `extension` folder inside this project.
5. Pin LLMGuide from Chrome's Extensions menu for easy access.

The extension only reads a page after you click its controls. It never submits
a prompt for you. Imported files are parsed locally.

## Privacy and cost

Local parsing and heuristic analysis stay on your computer, and LLMGuide has
no telemetry. Hosted features use your own provider API key:

- `analyze` may send condensed transcript content to Anthropic, including
  prompt text, code snippets, and file paths;
- coaching sends only prompts beginning with `review:` and the current working
  directory; and
- ordinary prompts are not sent by the coaching hook.

Choose a provider whose data policy fits your work. Do not analyze transcripts
containing secrets you are not permitted to share. To guarantee local-only
analysis, use `llmguide analyze --sample 0`.

The saved API key is plain text protected by your operating system's
owner-only file permissions. Remove it at any time with:

```sh
llmguide config unset-key
```

For CI, containers, or temporary overrides, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), and
`LLMGUIDE_LLM_API_KEY` are supported. Set `LLMGUIDE_LLM_PROVIDER` when using
the generic key variable.

## Troubleshooting

### `llmguide: command not found`

Close and reopen Terminal, then try:

```sh
llmguide status
```

If installation showed a permissions error, do not add `sudo` unless you
understand its effects. You can run LLMGuide without a global installation by
placing `npx` before the command:

```sh
npx llmguide status
```

### No sessions appear in the report

LLMGuide currently ingests Claude Code transcript files. Complete at least one
Claude Code session, then run `llmguide analyze` again. Live prompt coaching
works with both Claude Code and Codex.

### Haiku analysis is skipped

Save a key with `llmguide config set-key`, then use `llmguide status` to
confirm that hosted review is configured.

### Codex does not show coaching feedback

Run `llmguide hooks install codex`, open `/hooks` inside Codex, and trust the
LLMGuide hook.

### Remove LLMGuide integrations

```sh
llmguide hooks uninstall
llmguide config unset-key
npm uninstall --global llmguide
```

Hook installation preserves unrelated settings and creates a backup before
the first change.

## Advanced model configuration

Haiku is the default. These environment variables are available for advanced
or automated setups:

```sh
export LLMGUIDE_LLM_MODEL="claude-haiku-4-5"
export LLMGUIDE_LLM_BASE_URL="https://api.anthropic.com/v1"
export LLMGUIDE_LLM_TIMEOUT_MS="7500"
```

The live coaching hook can also use OpenAI GPT Nano:

```sh
export LLMGUIDE_LLM_PROVIDER="openai"
export OPENAI_API_KEY="your-api-key"
export LLMGUIDE_LLM_MODEL="gpt-5.4-nano"
```

Or Gemini Flash:

```sh
export LLMGUIDE_LLM_PROVIDER="gemini"
export GEMINI_API_KEY="your-api-key"
export LLMGUIDE_LLM_MODEL="gemini-3.1-flash-lite"
```

Transcript analysis itself uses Anthropic's Message Batches API and defaults
to Haiku.

Environmental impact is reported as a sourced range with a mandatory
uncertainty label. See [ASSUMPTIONS.md](ASSUMPTIONS.md).

## License

[MIT](LICENSE)
