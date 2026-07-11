import * as fs from 'fs';
import * as path from 'path';
import { claudeSettingsPath, codexHooksPath, dbPath, defaultClaudeDir, hookLlmConfig } from './config';
import { metaGet, openDb } from './db';
import { getHookBypass, hasLlmGuideHook } from './hook/install';
import { hasCodexLlmGuideHook } from './hook/codexInstall';
import { storedApiKey } from './credentials';

type Level = 'OK' | 'WARN' | 'FAIL' | '--';
const line = (level: Level, text: string): string => level.padEnd(4) + ' ' + text;

export async function runStatus(): Promise<string> {
  const out = [line('--', 'llmguide status'), line('--', '[claude subscription layer]')];
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
  const installed = hasLlmGuideHook(settings);
  out.push(installed ? line('OK', 'UserPromptSubmit coaching hook installed')
    : line('--', 'coaching hook not installed (run llmguide hooks install)'));

  out.push(line('--', '[codex cli]'));
  const codexPath = codexHooksPath();
  let codexConfig: unknown = null;
  try {
    codexConfig = JSON.parse(fs.readFileSync(codexPath, 'utf8'));
    out.push(line('OK', 'Codex hooks readable: ' + codexPath));
  } catch {
    out.push(fs.existsSync(codexPath)
      ? line('WARN', 'Codex hooks are not valid JSON: ' + codexPath)
      : line('--', 'Codex hooks not found yet: ' + codexPath));
  }
  out.push(hasCodexLlmGuideHook(codexConfig)
    ? line('OK', 'Codex UserPromptSubmit coaching hook installed')
    : line('--', 'Codex coaching hook not installed (run llmguide hooks install codex)'));

  const llm = hookLlmConfig();
  out.push(llm
    ? line('OK', `hosted prompt review configured: ${llm.model} via ${llm.provider}` +
        (llm.provider !== 'cursor' && storedApiKey(llm.provider) ? ' (saved key)' : ''))
    : line('WARN', 'hosted prompt review needs a key in .env, `llmguide config set-key`, or GEMINI/ANTHROPIC/OPENAI/CURSOR_API_KEY'));

  out.push(line('--', '[local analysis]'));
  const file = dbPath();
  if (!fs.existsSync(file)) {
    out.push(line('--', 'database not created yet (run llmguide analyze)'));
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
    const bypass = getHookBypass(db);
    out.push(bypass === 'off'
      ? line('OK', 'review: trigger active; ordinary prompts go directly to the coding model')
      : line('WARN', 'hook bypass ' + bypass + '; prompt review is being skipped'));
    db.close();
  } catch (error) {
    out.push(line('FAIL', 'database could not be read: ' + (error instanceof Error ? error.message : String(error))));
  }
  return out.join('\n');
}
