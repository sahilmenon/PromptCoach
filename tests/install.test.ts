import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installHook, uninstallHook, muteHooks } from '../src/hook/install';
import { openDb, metaGet } from '../src/db';

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenlean-install-'));
  settingsPath = path.join(dir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readSettings(p: string = settingsPath): Record<string, any> {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const FOREIGN_UPS_ENTRY = {
  matcher: '',
  hooks: [{ type: 'command', command: 'other-tool --run' }],
};

const EXISTING_SETTINGS = {
  env: { FOO: 'bar', ANTHROPIC_MODEL: 'claude-haiku-4-5' },
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    UserPromptSubmit: [FOREIGN_UPS_ENTRY],
  },
};

describe('installHook', () => {
  it('creates the settings file with one hook entry when none exists', () => {
    const res = installHook(settingsPath);
    expect(res.installed).toBe(true);
    expect(res.already).toBeFalsy();
    expect(res.path).toBe(settingsPath);

    const s = readSettings();
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    const entry = s.hooks.UserPromptSubmit[0];
    expect(entry.matcher).toBe('');
    expect(entry.hooks).toHaveLength(1);
    expect(entry.hooks[0].type).toBe('command');
    expect(entry.hooks[0].command).toMatch(/^node .+hook\.js$/);
    expect(path.isAbsolute(entry.hooks[0].command.replace(/^node /, ''))).toBe(true);
    expect(entry.hooks[0].timeout).toBe(10);
    // No pre-existing file means nothing to back up.
    expect(fs.existsSync(settingsPath + '.tokenlean-backup')).toBe(false);
  });

  it('preserves existing unrelated hooks and top-level keys exactly', () => {
    fs.writeFileSync(settingsPath, JSON.stringify(EXISTING_SETTINGS, null, 2));
    installHook(settingsPath);

    const s = readSettings();
    expect(s.env).toEqual(EXISTING_SETTINGS.env);
    expect(s.permissions).toEqual(EXISTING_SETTINGS.permissions);
    expect(s.hooks.PreToolUse).toEqual(EXISTING_SETTINGS.hooks.PreToolUse);
    expect(s.hooks.UserPromptSubmit).toHaveLength(2);
    expect(s.hooks.UserPromptSubmit[0]).toEqual(FOREIGN_UPS_ENTRY);
    expect(s.hooks.UserPromptSubmit[1].hooks[0].command).toMatch(/hook\.js$/);
  });

  it('is idempotent: a second install reports already and adds no duplicate', () => {
    installHook(settingsPath);
    const second = installHook(settingsPath);
    expect(second.installed).toBe(true);
    expect(second.already).toBe(true);
    expect(readSettings().hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('recognises an npm-installed tokenlean command as already installed', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'node /home/u/node_modules/tokenlean/dist/hook/hook.js',
                  timeout: 10,
                },
              ],
            },
          ],
        },
      })
    );
    const res = installHook(settingsPath);
    expect(res.already).toBe(true);
    expect(readSettings().hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('throws on corrupt JSON and leaves the file byte-identical', () => {
    const corrupt = '{ "hooks": definitely not json';
    fs.writeFileSync(settingsPath, corrupt);
    expect(() => installHook(settingsPath)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(corrupt);
    expect(fs.existsSync(settingsPath + '.tokenlean-backup')).toBe(false);
  });

  it('creates the backup once, keeping the original content forever', () => {
    const original = JSON.stringify({ env: { KEEP: '1' } }, null, 2);
    fs.writeFileSync(settingsPath, original);
    const backupPath = settingsPath + '.tokenlean-backup';

    installHook(settingsPath);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(original);

    // A later modifying write (uninstall) must not overwrite the backup.
    uninstallHook(settingsPath);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(original);

    installHook(settingsPath);
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(original);
  });

  it('honours the TOKENLEAN_CLAUDE_SETTINGS env override when no path is given', () => {
    const envPath = path.join(dir, 'env-override', 'settings.json');
    const prev = process.env.TOKENLEAN_CLAUDE_SETTINGS;
    process.env.TOKENLEAN_CLAUDE_SETTINGS = envPath;
    try {
      const res = installHook();
      expect(res.path).toBe(envPath);
      expect(readSettings(envPath).hooks.UserPromptSubmit).toHaveLength(1);
      const un = uninstallHook();
      expect(un.removed).toBe(true);
      expect(un.path).toBe(envPath);
    } finally {
      if (prev === undefined) delete process.env.TOKENLEAN_CLAUDE_SETTINGS;
      else process.env.TOKENLEAN_CLAUDE_SETTINGS = prev;
    }
  });
});

describe('uninstallHook', () => {
  it('removes only the tokenlean entry; foreign hooks and keys survive', () => {
    fs.writeFileSync(settingsPath, JSON.stringify(EXISTING_SETTINGS, null, 2));
    installHook(settingsPath);

    const res = uninstallHook(settingsPath);
    expect(res.removed).toBe(true);

    const s = readSettings();
    expect(s.env).toEqual(EXISTING_SETTINGS.env);
    expect(s.permissions).toEqual(EXISTING_SETTINGS.permissions);
    expect(s.hooks.PreToolUse).toEqual(EXISTING_SETTINGS.hooks.PreToolUse);
    expect(s.hooks.UserPromptSubmit).toEqual([FOREIGN_UPS_ENTRY]);
  });

  it('drops empty UserPromptSubmit and hooks containers after removal', () => {
    installHook(settingsPath);
    const res = uninstallHook(settingsPath);
    expect(res.removed).toBe(true);
    const s = readSettings();
    expect(s.hooks).toBeUndefined();
  });

  it('returns removed:false when the file is missing', () => {
    expect(uninstallHook(settingsPath)).toEqual({ removed: false, path: settingsPath });
  });

  it('returns removed:false and does not touch a corrupt file', () => {
    const corrupt = '{ nope';
    fs.writeFileSync(settingsPath, corrupt);
    const res = uninstallHook(settingsPath);
    expect(res.removed).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(corrupt);
  });

  it('returns removed:false when no tokenlean entry is present', () => {
    fs.writeFileSync(settingsPath, JSON.stringify(EXISTING_SETTINGS, null, 2));
    const before = fs.readFileSync(settingsPath, 'utf8');
    const res = uninstallHook(settingsPath);
    expect(res.removed).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });
});

describe('muteHooks', () => {
  it('stores muted_until N days ahead in meta', () => {
    const db = openDb(path.join(dir, 'db.sqlite'));
    try {
      const before = Date.now();
      const res = muteHooks(db, 3);
      expect(res.mutedUntil).toBeGreaterThanOrEqual(before + 3 * 86_400_000);
      expect(res.mutedUntil).toBeLessThan(before + 3 * 86_400_000 + 60_000);
      expect(Number(metaGet(db, 'muted_until'))).toBe(res.mutedUntil);
    } finally {
      db.close();
    }
  });
});
