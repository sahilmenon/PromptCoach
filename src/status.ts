import * as fs from 'fs';
import * as path from 'path';
import { claudeSettingsPath, dbPath, defaultClaudeDir } from './config';
import { metaGet, openDb } from './db';

type Level = 'OK' | 'WARN' | 'FAIL' | '--';
const line = (level: Level, text: string): string => level.padEnd(4) + ' ' + text;

export async function runStatus(): Promise<string> {
  const out = [line('--', 'tokenlean status'), line('--', '[claude subscription layer]')];
  const projects = path.join(defaultClaudeDir(), 'projects');
  out.push(fs.existsSync(projects)
    ? line('OK', 'local Claude Code transcripts found: ' + projects)
    : line('WARN', 'local transcript directory not found yet: ' + projects));

  const settingsPath = claudeSettingsPath();
  let settings: any = null;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    out.push(line('OK', 'Claude Code settings readable: ' + settingsPath));
  } catch {
    out.push(fs.existsSync(settingsPath)
      ? line('WARN', 'Claude Code settings are not valid JSON: ' + settingsPath)
      : line('--', 'Claude Code settings not found yet: ' + settingsPath));
  }
  const installed = !!settings?.hooks?.UserPromptSubmit &&
    JSON.stringify(settings.hooks.UserPromptSubmit).includes('tokenlean');
  out.push(installed ? line('OK', 'local UserPromptSubmit coaching hook installed')
    : line('--', 'coaching hook not installed (run tokenlean hooks install)'));

  out.push(line('--', '[local analysis]'));
  const file = dbPath();
  if (!fs.existsSync(file)) {
    out.push(line('--', 'database not created yet (run tokenlean analyze)'));
    return out.join('\n');
  }
  try {
    const db = openDb(file);
    const count = (table: string): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n;
    out.push(line('OK', 'database: ' + file));
    out.push(line('--', 'sessions ' + count('sessions') + ' · turns ' + count('turns') +
      ' · findings ' + count('findings') + ' · nudges ' + count('nudges')));
    const mute = Number(metaGet(db, 'muted_until'));
    if (Number.isFinite(mute) && mute > Date.now()) out.push(line('WARN', 'nudges muted until ' + new Date(mute).toISOString()));
    db.close();
  } catch (error) {
    out.push(line('FAIL', 'database could not be read: ' + (error instanceof Error ? error.message : String(error))));
  }
  out.push(line('OK', 'developer API disabled; no proxy or custom API base URL is used'));
  return out.join('\n');
}
