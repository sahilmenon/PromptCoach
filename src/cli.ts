import { Command } from 'commander';
import * as readline from 'readline';
import { openDb } from './db';
import { defaultClaudeDir } from './config';
import { ingestTranscripts } from './analyzer/parser';
import { runHeuristics, recordBaselineIfReady } from './analyzer/heuristics';
import { collectLlmResults, submitLlmBatch } from './analyzer/llm';
import { buildReport, renderReport } from './report/report';
import { writeClaudeMdSuggestions } from './report/claudeMdDiff';
import { getHookBypass, installHook, setHookBypass, uninstallHook, muteHooks } from './hook/install';
import { installCodexHook, uninstallCodexHook } from './hook/codexInstall';
import { runStatus } from './status';
import {
  anthropicApiKey,
  clearApiKey,
  saveApiKey,
  type LlmProvider,
} from './credentials';

function parseProvider(raw: string): LlmProvider {
  const provider = raw.toLowerCase();
  if (provider === 'anthropic' || provider === 'openai' || provider === 'gemini') return provider;
  throw new Error('provider must be anthropic, openai, or gemini');
}

function parseSince(raw?: string): number | undefined {
  if (!raw) return undefined;
  const match = /^(\d+)\s*d$/i.exec(raw.trim());
  if (!match) throw new Error('--since expects a value such as 7d');
  return Number(match[1]);
}

function parseSample(raw: string): number {
  const sample = Number(raw);
  if (!Number.isInteger(sample) || sample < 0) {
    throw new Error('--sample expects a non-negative integer');
  }
  return sample;
}

async function readSecret(provider: LlmProvider): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }

  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = '';
    const wasRaw = input.isRaw;
    const finish = (error?: Error): void => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write('\n');
      error ? reject(error) : resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') return finish(new Error('Cancelled.'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (char >= ' ') {
          value += char;
          process.stdout.write('*');
        }
      }
    };
    readline.emitKeypressEvents(input);
    process.stdout.write(`${provider[0].toUpperCase() + provider.slice(1)} API key: `);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

const program = new Command();
program.name('llmguide')
  .description('Prompt-efficiency coach for Claude Code and Codex CLI.')
  .version('0.1.0');

program.command('analyze')
  .description('Analyze Claude Code transcripts locally and optionally refine findings with Haiku')
  .option('--claude-dir <path>', 'override the Claude Code config directory')
  .option('--sample <count>', 'sessions to send to Haiku; 0 keeps analysis local', '10')
  .option('--wait', 'wait for Haiku batch results (up to 30 minutes)')
  .action(async (opts: { claudeDir?: string; sample: string; wait?: boolean }) => {
    const sample = parseSample(opts.sample);
    const db = openDb();
    try {
      const ing = ingestTranscripts(db, opts.claudeDir || defaultClaudeDir());
      console.log('Ingest: ' + ing.filesParsed + '/' + ing.filesScanned + ' files read (' +
        ing.filesSkippedUnchanged + ' unchanged), ' + ing.sessionsUpserted + ' sessions, ' +
        ing.turnsAdded + ' new turns, ' + ing.malformedLines + ' malformed lines skipped.');
      const heur = runHeuristics(db);
      console.log('Heuristics: ' + heur.sessionsScored + ' sessions scored, ' +
        heur.findingsAdded + ' findings written.');
      if (recordBaselineIfReady(db)) console.log('Baseline recorded (week-one reference).');
      if (sample === 0) {
        console.log('Haiku analysis skipped (--sample 0); analysis stayed local.');
      } else if (!anthropicApiKey()) {
        console.log('Haiku analysis skipped: run `llmguide config set-key` to enable it.');
      } else {
        const collected = await collectLlmResults(db, { log: console.log });
        if (collected.batchesCompleted > 0) {
          console.log(`Collected ${collected.findingsAdded} Haiku finding(s) from ${collected.batchesCompleted} prior batch(es).`);
        }
        const submitted = await submitLlmBatch(db, {
          sample,
          wait: opts.wait,
          model: process.env.LLMGUIDE_LLM_MODEL || process.env.TOKENLEAN_LLM_MODEL,
          log: console.log,
        });
        console.log(submitted.message);
      }
    } finally { db.close(); }
  });

program.command('report')
  .description('Print the local scorecard, findings, and CLAUDE.md suggestions')
  .option('--json', 'machine-readable output')
  .option('--write-claude-md', 'write CLAUDE.md.suggested files; never edits CLAUDE.md')
  .option('--since <window>', 'restrict to a recent window, for example 7d')
  .action(async (opts: { json?: boolean; writeClaudeMd?: boolean; since?: string }) => {
    const db = openDb();
    try {
      if (anthropicApiKey()) {
        const collected = await collectLlmResults(db, { log: opts.json ? undefined : console.log });
        if (!opts.json && collected.batchesCompleted > 0) {
          console.log(`Collected ${collected.findingsAdded} Haiku finding(s) from ${collected.batchesCompleted} batch(es).`);
        }
      }
      const data = buildReport(db, { sinceDays: parseSince(opts.since) });
      console.log(opts.json ? JSON.stringify(data, null, 2) : renderReport(data));
      if (opts.writeClaudeMd) {
        const written = writeClaudeMdSuggestions(db);
        console.log(written.length ? written.map(p => 'Wrote ' + p).join('\n') : 'No suggestions to write yet.');
      }
    } finally { db.close(); }
  });

const hooks = program.command('hooks').description('Manage Claude Code and Codex prompt coaching');
function hookTargets(raw?: string): Array<'claude' | 'codex'> {
  const target = (raw || 'all').toLowerCase();
  if (target === 'all') return ['claude', 'codex'];
  if (target === 'claude' || target === 'codex') return [target];
  throw new Error('hook target must be claude, codex, or all');
}

hooks.command('install [target]').action((raw?: string) => {
  const messages = hookTargets(raw).map((target) => {
    const result = target === 'claude' ? installHook() : installCodexHook();
    return `${target}: ${result.already ? 'already installed' : 'installed'}`;
  });
  console.log(messages.join('\n') + '\nPrefix a prompt with review: for in-terminal hosted-model feedback.');
});
hooks.command('uninstall [target]').action((raw?: string) => {
  const messages = hookTargets(raw).map((target) => {
    const removed = target === 'claude' ? uninstallHook().removed : uninstallCodexHook().removed;
    return `${target}: ${removed ? 'removed' : 'not installed'}`;
  });
  console.log(messages.join('\n'));
});
hooks.command('mute <days>').action((raw: string) => {
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) throw new Error('mute expects a positive number of days');
  const db = openDb();
  try { console.log('Nudges muted until ' + new Date(muteHooks(db, days).mutedUntil).toLocaleString() + '.'); }
  finally { db.close(); }
});
hooks.command('bypass <mode>')
  .description('Control direct-to-model mode: next, on, off, or status')
  .action((raw: string) => {
    const mode = raw.toLowerCase();
    const db = openDb();
    try {
      if (mode === 'status') {
        console.log('Hook bypass: ' + getHookBypass(db));
      } else if (mode === 'next' || mode === 'on' || mode === 'off') {
        setHookBypass(db, mode);
        console.log(mode === 'next'
          ? 'The next prompt will go directly to the coding model; review resumes afterward.'
          : mode === 'on'
            ? 'Hook bypass enabled; prompts go directly to the coding model.'
            : 'Hook bypass disabled; hosted review and blocking resumed.');
      } else {
        throw new Error('bypass expects next, on, off, or status');
      }
    } finally { db.close(); }
  });

program.command('status').description('Check local transcripts, hook, and analysis database')
  .action(async () => console.log(await runStatus()));

const config = program.command('config').description('Manage persistent LLMGuide configuration');
config.command('set-key [key]')
  .description('Save an Anthropic, OpenAI, or Gemini API key for use in every directory')
  .option('-p, --provider <provider>', 'anthropic, openai, or gemini', 'anthropic')
  .action(async (key: string | undefined, opts: { provider: string }) => {
    const provider = parseProvider(opts.provider);
    const file = saveApiKey(provider, key ?? await readSecret(provider));
    console.log(`${provider[0].toUpperCase() + provider.slice(1)} API key saved in ${file} (owner-readable only).`);
  });
config.command('unset-key')
  .description('Remove saved API keys, or one provider key with --provider')
  .option('-p, --provider <provider>', 'anthropic, openai, or gemini')
  .action((opts: { provider?: string }) => {
    const provider = opts.provider ? parseProvider(opts.provider) : undefined;
    console.log(clearApiKey(provider)
      ? `Saved ${provider || 'API'} key${provider ? '' : 's'} removed.`
      : `No saved ${provider || 'API'} key${provider ? '' : 's'} found.`);
  });

program.parseAsync(process.argv).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
