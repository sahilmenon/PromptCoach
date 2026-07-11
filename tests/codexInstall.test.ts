import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasCodexPromptCoachHook, installCodexHook, uninstallCodexHook } from '../src/hook/codexInstall';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcoach-codex-hook-'));
  file = path.join(dir, 'hooks.json');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = (): Record<string, any> => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('Codex hook installer', () => {
  it('installs a valid UserPromptSubmit command hook', () => {
    const result = installCodexHook(file);
    const config = read();
    expect(result.already).toBe(false);
    expect(hasCodexPromptCoachHook(config)).toBe(true);
    expect(config.hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({
      type: 'command',
      timeout: 15,
      statusMessage: 'Reviewing prompt with PromptCoach',
    });
  });

  it('preserves foreign hooks, creates one backup, and is idempotent', () => {
    const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } };
    fs.writeFileSync(file, JSON.stringify(original));
    installCodexHook(file);
    expect(read().hooks.Stop).toEqual(original.hooks.Stop);
    expect(fs.existsSync(file + '.promptcoach-backup')).toBe(true);
    expect(installCodexHook(file).already).toBe(true);
    expect(read().hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('uninstalls only PromptCoach', () => {
    installCodexHook(file);
    const config = read();
    config.hooks.UserPromptSubmit.unshift({ hooks: [{ type: 'command', command: 'foreign' }] });
    fs.writeFileSync(file, JSON.stringify(config));
    expect(uninstallCodexHook(file).removed).toBe(true);
    expect(read().hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: 'foreign' }] }]);
  });

  it('refuses to overwrite malformed JSON', () => {
    fs.writeFileSync(file, '{ nope');
    expect(() => installCodexHook(file)).toThrow(/invalid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ nope');
  });
});
