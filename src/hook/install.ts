import * as fs from 'fs';
import * as path from 'path';
import type { DB } from '../db';
import { metaGet, metaSet } from '../db';
import { claudeSettingsPath } from '../config';

const DAY_MS = 86_400_000;
/** Allow time for the hosted review; no interactive child process is used. */
const HOOK_TIMEOUT_S = 15;

/**
 * Command written into settings.json. __dirname resolves to dist/hook in the
 * built package, so this points at the compiled hook — never at src/*.ts.
 */
function hookCommand(): string {
  return `node ${path.join(__dirname, 'hook.js')}`;
}

/**
 * A command is ours if it carries the current or legacy package marker, or
 * exactly matches the command this checkout would write.
 */
function isPromptCoachCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  if (command === hookCommand()) return true;
  return (command.includes('promptcoach') || command.includes('tokenlean')) && command.includes('hook.js');
}

function entryIsPromptCoach(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (isPromptCoachCommand(e.command)) return true;
  if (Array.isArray(e.hooks)) {
    for (const h of e.hooks) {
      if (h !== null && typeof h === 'object' && isPromptCoachCommand((h as Record<string, unknown>).command)) {
        return true;
      }
    }
  }
  return false;
}

/** Detect this package's hook using the same rules as install/uninstall. */
export function hasPromptCoachHook(settings: unknown): boolean {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const hooks = (settings as Record<string, unknown>).hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  const entries = (hooks as Record<string, unknown>).UserPromptSubmit;
  return Array.isArray(entries) && entries.some(entryIsPromptCoach);
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

/** Copy settings before the first modifying write. */
function backupOnce(settingsPath: string): void {
  if (!fs.existsSync(settingsPath)) return;
  const backupPath = settingsPath + '.promptcoach-backup';
  if (fs.existsSync(settingsPath + '.tokenlean-backup')) return;
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

  if (entries.some(entryIsPromptCoach)) {
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
 * Remove only PromptCoach's current or legacy hook entries; every other hook survives.
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

  const kept = entries.filter((entry) => !entryIsPromptCoach(entry));
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

export type HookBypassMode = 'off' | 'next' | 'on';

export function setHookBypass(db: DB, mode: HookBypassMode): HookBypassMode {
  metaSet(db, 'hook_bypass', mode);
  return mode;
}

export function getHookBypass(db: DB): HookBypassMode {
  const value = metaGet(db, 'hook_bypass');
  return value === 'next' || value === 'on' ? value : 'off';
}
