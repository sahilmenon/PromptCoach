import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenlean-status-'));
process.env.TOKENLEAN_HOME = dir;
process.env.TOKENLEAN_DB = path.join(dir, 'db.sqlite');
process.env.TOKENLEAN_CLAUDE_SETTINGS = path.join(dir, 'settings.json');
process.env.CLAUDE_CONFIG_DIR = path.join(dir, '.claude');

import { runStatus } from '../src/status';
import { openDb } from '../src/db';

beforeEach(() => {
  fs.mkdirSync(path.join(dir, '.claude', 'projects'), { recursive: true });
});
afterEach(() => {
  for (const name of ['db.sqlite','db.sqlite-wal','db.sqlite-shm','settings.json']) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
});

describe('subscription-layer status', () => {
  it('reports local transcripts, hosted-review configuration, and no proxy', async () => {
    const output = await runStatus();
    expect(output).toContain('local Claude Code transcripts found');
    expect(output).toContain('hosted prompt review needs');
    expect(output).not.toContain('ANTHROPIC_BASE_URL');
    expect(output).not.toContain('[proxy]');
  });

  it('detects the local hook and database counts', async () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type:'command', command:'node tokenlean/hook.js' }] }] }
    }));
    const db = openDb(path.join(dir, 'db.sqlite'));
    db.prepare("INSERT INTO sessions (id,project) VALUES ('s','p')").run();
    db.close();
    const output = await runStatus();
    expect(output).toContain('coaching hook installed');
    expect(output).toContain('sessions 1');
    expect(output).toContain('hosted prompt review needs');
  });
});
