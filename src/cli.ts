import { Command } from 'commander';
import { openDb } from './db';
import { defaultClaudeDir } from './config';
import { ingestTranscripts } from './analyzer/parser';
import { runHeuristics, recordBaselineIfReady } from './analyzer/heuristics';
import { buildReport, renderReport } from './report/report';
import { writeClaudeMdSuggestions } from './report/claudeMdDiff';
import { getHookBypass, installHook, setHookBypass, uninstallHook, muteHooks } from './hook/install';
import { installCodexHook, uninstallCodexHook } from './hook/codexInstall';
import { runStatus } from './status';

function parseSince(raw?: string): number | undefined {
  if (!raw) return undefined;
  const match = /^(\d+)\s*d$/i.exec(raw.trim());
  if (!match) throw new Error('--since expects a value such as 7d');
  return Number(match[1]);
}

const program = new Command();
program.name('tokenlean')
  .description('Prompt-efficiency companion for your Claude Code subscription.')
  .version('0.2.0');

program.command('analyze')
  .description('Analyze local Claude Code transcripts; no API key or network call')
  .option('--claude-dir <path>', 'override the Claude Code config directory')
  .action((opts: { claudeDir?: string }) => {
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
      console.log('Analysis stayed local and used no developer API.');
    } finally { db.close(); }
  });

program.command('report')
  .description('Print the local scorecard, findings, and CLAUDE.md suggestions')
  .option('--json', 'machine-readable output')
  .option('--write-claude-md', 'write CLAUDE.md.suggested files; never edits CLAUDE.md')
  .option('--since <window>', 'restrict to a recent window, for example 7d')
  .action((opts: { json?: boolean; writeClaudeMd?: boolean; since?: string }) => {
    const db = openDb();
    try {
      const data = buildReport(db, { sinceDays: parseSince(opts.since) });
      console.log(opts.json ? JSON.stringify(data, null, 2) : renderReport(data));
      if (opts.writeClaudeMd) {
        const written = writeClaudeMdSuggestions(db);
        console.log(written.length ? written.map(p => 'Wrote ' + p).join('\n') : 'No suggestions to write yet.');
      }
    } finally { db.close(); }
  });

const hooks = program.command('hooks').description('Manage subscription-layer Claude Code coaching');
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
  console.log(messages.join('\n') + '\nPrefix a prompt with review: for in-terminal Haiku feedback.');
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
            : 'Hook bypass disabled; Haiku review and blocking resumed.');
      } else {
        throw new Error('bypass expects next, on, off, or status');
      }
    } finally { db.close(); }
  });

program.command('status').description('Check local transcripts, hook, and analysis database')
  .action(async () => console.log(await runStatus()));

program.parseAsync(process.argv).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
