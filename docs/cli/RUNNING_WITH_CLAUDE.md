# Running promptcoach with Claude CLI

promptcoach runs from your normal terminal alongside Claude Code. It is not a
command entered inside Claude's chat.

It uses the local transcripts created by Claude Code and does not require an
Anthropic developer API key, replace subscription authentication, or create
separate API charges.

## 1. Build and install promptcoach locally

```bash
cd /Users/guangsizeng/Documents/myCode/csesoc_flagship_hackathon
npm install
npm run build
npm link
```

Confirm that promptcoach is available:

```bash
promptcoach --help
promptcoach status
```

## 2. Use Claude CLI normally

Start Claude Code using your existing subscription:

```bash
claude
```

Use Claude Code normally for a few sessions. Claude Code stores its local
session transcripts under:

```text
~/.claude/projects/
```

promptcoach reads these files locally. It does not change Claude authentication
or route Claude traffic through a proxy.

## 3. Analyze your Claude Code sessions

Exit Claude Code or open another terminal, then run:

```bash
promptcoach analyze
promptcoach report
```

Useful report variants:

```bash
promptcoach report --since 7d
promptcoach report --json
promptcoach report --write-claude-md
```

`--write-claude-md` creates a `CLAUDE.md.suggested` file. It never edits
your real `CLAUDE.md` directly.

## 4. Enable live coaching

Install the local Claude Code prompt hook:

```bash
promptcoach hooks install
promptcoach status
```

Restart Claude Code after installing the hook:

```bash
claude
```

The hook examines submitted prompts using deterministic local checks. It may
add a short context note that Claude can see, but it never blocks, rewrites, or
submits your prompt. It also makes no model or network calls.

Manage coaching with:

```bash
promptcoach hooks mute 3
promptcoach hooks uninstall
```

## Typical workflow

```bash
# Work normally.
claude

# After the session, analyze recent usage.
promptcoach analyze
promptcoach report --since 7d
```

## If the promptcoach command is not found

Run the compiled CLI directly:

```bash
node /Users/guangsizeng/Documents/myCode/csesoc_flagship_hackathon/dist/cli.js status
node /Users/guangsizeng/Documents/myCode/csesoc_flagship_hackathon/dist/cli.js analyze
```

Alternatively, return to the repository and recreate the global link:

```bash
cd /Users/guangsizeng/Documents/myCode/csesoc_flagship_hackathon
npm run build
npm link
```

## Further reading

Claude Code documents the `UserPromptSubmit` event and local
`transcript_path` in its
[official hooks reference](https://code.claude.com/docs/en/hooks).
