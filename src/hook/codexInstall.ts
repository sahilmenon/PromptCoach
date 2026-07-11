import * as fs from 'fs';
import * as path from 'path';
import { codexHooksPath } from '../config';

const HOOK_TIMEOUT_S = 15;

function hookCommand(): string {
  return `node ${path.join(__dirname, 'hook.js')}`;
}

function isTokenleanCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return command === hookCommand() ||
    (command.includes('tokenlean') && command.includes('hook.js'));
}

function entryIsTokenlean(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const handlers = (entry as Record<string, unknown>).hooks;
  return Array.isArray(handlers) && handlers.some((handler) =>
    handler !== null && typeof handler === 'object' &&
    isTokenleanCommand((handler as Record<string, unknown>).command)
  );
}

export function hasCodexTokenleanHook(config: unknown): boolean {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return false;
  const hooks = (config as Record<string, unknown>).hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  const entries = (hooks as Record<string, unknown>).UserPromptSubmit;
  return Array.isArray(entries) && entries.some(entryIsTokenlean);
}

function readConfig(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Refusing to modify ${file}: invalid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Refusing to modify ${file}: expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function backupOnce(file: string): void {
  if (fs.existsSync(file) && !fs.existsSync(file + '.tokenlean-backup')) {
    fs.copyFileSync(file, file + '.tokenlean-backup');
  }
}

function writeConfig(file: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

export function installCodexHook(file: string = codexHooksPath()): {
  installed: boolean;
  already?: boolean;
  path: string;
} {
  const config = readConfig(file);
  if (hasCodexTokenleanHook(config)) return { installed: true, already: true, path: file };

  const hooks = config.hooks === undefined ? {} : config.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new Error(`Refusing to modify ${file}: "hooks" exists but is not an object.`);
  }
  const hookMap = hooks as Record<string, unknown>;
  const entries = hookMap.UserPromptSubmit === undefined ? [] : hookMap.UserPromptSubmit;
  if (!Array.isArray(entries)) {
    throw new Error(`Refusing to modify ${file}: "hooks.UserPromptSubmit" is not an array.`);
  }

  backupOnce(file);
  entries.push({
    hooks: [{
      type: 'command',
      command: hookCommand(),
      timeout: HOOK_TIMEOUT_S,
      statusMessage: 'Reviewing prompt with TokenLean',
    }],
  });
  hookMap.UserPromptSubmit = entries;
  config.hooks = hookMap;
  writeConfig(file, config);
  return { installed: true, already: false, path: file };
}

export function uninstallCodexHook(file: string = codexHooksPath()): {
  removed: boolean;
  path: string;
} {
  if (!fs.existsSync(file)) return { removed: false, path: file };
  let config: Record<string, unknown>;
  try {
    config = readConfig(file);
  } catch {
    return { removed: false, path: file };
  }
  const hooks = config.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { removed: false, path: file };
  }
  const hookMap = hooks as Record<string, unknown>;
  const entries = hookMap.UserPromptSubmit;
  if (!Array.isArray(entries)) return { removed: false, path: file };
  const kept = entries.filter((entry) => !entryIsTokenlean(entry));
  if (kept.length === entries.length) return { removed: false, path: file };

  backupOnce(file);
  if (kept.length) hookMap.UserPromptSubmit = kept;
  else {
    delete hookMap.UserPromptSubmit;
    if (Object.keys(hookMap).length === 0) delete config.hooks;
  }
  writeConfig(file, config);
  return { removed: true, path: file };
}
