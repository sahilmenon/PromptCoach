import * as fs from 'fs';
import * as path from 'path';
import type { DB } from '../db';
import { metaSet } from '../db';
import { claudeSettingsPath } from '../config';

const DAY_MS = 86_400_000;
/** Claude Code hook timeout, in seconds — comfortably above the 500ms budget. */
const HOOK_TIMEOUT_S = 10;

/**
 * Command written into settings.json. __dirname resolves to dist/hook in the
 * built package, so this points at the compiled hook — never at src/*.ts.
 */
function hookCommand(): string {
  return `node ${path.join(__dirname, 'hook.js')}`;
}

/**
 * A command is ours if it carries the tokenlean marker (the npm-installed
 * path always contains both substrings) or exactly matches the command this
 * checkout would write (covers dev checkouts whose path lacks "tokenlean").
 */
function isTokenleanCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  if (command === hookCommand()) return true;
  return command.includes('tokenlean') && command.includes('hook.js');
}

function entryIsTokenlean(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (isTokenleanCommand(e.command)) return true;
  if (Array.isArray(e.hooks)) {
    for (const h of e.hooks) {
      if (h !== null && typeof h === 'object' && isTokenleanCommand((h as Record<string, unknown>).command)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Read settings for a modifying operation. A missing or empty file starts
 * from {}; a file that exists but does not parse throws WITHOUT writing —
 * we never clobber a settings file we cannot read (SPEC §5.1).
 */
function readSettingsForWrite(settingsPath: string): Record<string, unknown> {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8');
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Refusing to modify ${settingsPath}: the existing file is not valid JSON (${detail}). ` +
        'Fix the file manually, then re-run.'
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Refusing to modify ${settingsPath}: expected a JSON object at the top level.`
    );
  }
  return parsed as Record<string, unknown>;
}

/** Copy settings to <path>.tokenlean-backup before the first modifying write. */
function backupOnce(settingsPath: string): void {
  if (!fs.existsSync(settingsPath)) return;
  const backupPath = settingsPath + '.tokenlean-backup';
  if (fs.existsSync(backupPath)) return;
  fs.copyFileSync(settingsPath, backupPath);
}

function writeSettings(settingsPath: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * Install the UserPromptSubmit hook into Claude Code settings.json,
 * merging non-destructively (SPEC §5.1): every existing key and every
 * existing hook entry is preserved. Idempotent. Backs up the settings file
 * before the first write.
 */
export function installHook(settingsPath?: string): {
  installed: boolean;
  already?: boolean;
  path: string;
} {
  const p = settingsPath || claudeSettingsPath();
  const settings = readSettingsForWrite(p);

  let hooks: Record<string, unknown>;
  if (settings.hooks === undefined) {
    hooks = {};
  } else if (
    settings.hooks !== null &&
    typeof settings.hooks === 'object' &&
    !Array.isArray(settings.hooks)
  ) {
    hooks = settings.hooks as Record<string, unknown>;
  } else {
    throw new Error(`Refusing to modify ${p}: "hooks" exists but is not an object.`);
  }

  let entries: unknown[];
  if (hooks.UserPromptSubmit === undefined) {
    entries = [];
  } else if (Array.isArray(hooks.UserPromptSubmit)) {
    entries = hooks.UserPromptSubmit;
  } else {
    throw new Error(
      `Refusing to modify ${p}: "hooks.UserPromptSubmit" exists but is not an array.`
    );
  }

  if (entries.some(entryIsTokenlean)) {
    return { installed: true, already: true, path: p };
  }

  backupOnce(p);
  entries.push({
    matcher: '',
    hooks: [{ type: 'command', command: hookCommand(), timeout: HOOK_TIMEOUT_S }],
  });
  hooks.UserPromptSubmit = entries;
  settings.hooks = hooks;
  writeSettings(p, settings);
  return { installed: true, already: false, path: p };
}

/**
 * Remove only tokenlean's hook entries; every other hook and key survives.
 * Drops hooks.UserPromptSubmit (and hooks) if they end up empty. A missing
 * or unreadable file is left alone and reported as not removed.
 */
export function uninstallHook(settingsPath?: string): { removed: boolean; path: string } {
  const p = settingsPath || claudeSettingsPath();
  if (!fs.existsSync(p)) return { removed: false, path: p };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { removed: false, path: p };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { removed: false, path: p };
  }
  const settings = parsed as Record<string, unknown>;

  const hooks = settings.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { removed: false, path: p };
  }
  const hooksObj = hooks as Record<string, unknown>;
  const entries = hooksObj.UserPromptSubmit;
  if (!Array.isArray(entries)) return { removed: false, path: p };

  const kept = entries.filter((entry) => !entryIsTokenlean(entry));
  if (kept.length === entries.length) return { removed: false, path: p };

  backupOnce(p);
  if (kept.length > 0) {
    hooksObj.UserPromptSubmit = kept;
  } else {
    delete hooksObj.UserPromptSubmit;
    if (Object.keys(hooksObj).length === 0) delete settings.hooks;
  }
  writeSettings(p, settings);
  return { removed: true, path: p };
}

/** Silence nudges for N days (meta 'muted_until') — SPEC §5.4 escape hatch. */
export function muteHooks(db: DB, days: number): { mutedUntil: number } {
  const mutedUntil = Date.now() + days * DAY_MS;
  metaSet(db, 'muted_until', String(mutedUntil));
  return { mutedUntil };
}
