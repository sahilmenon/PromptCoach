import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadEnvFiles, parseEnvFile } from '../src/loadEnv';

describe('loadEnv', () => {
  it('parses quoted values and ignores comments', () => {
    expect(parseEnvFile([
      '# comment',
      'CURSOR_API_KEY="crsr_test"',
      "OPENAI_API_KEY='sk-test'",
      'EMPTY=',
      'BAD LINE',
      'TOKENLEAN_LLM_MODEL=composer-2.5',
    ].join('\n'))).toEqual({
      CURSOR_API_KEY: 'crsr_test',
      OPENAI_API_KEY: 'sk-test',
      EMPTY: '',
      TOKENLEAN_LLM_MODEL: 'composer-2.5',
    });
  });

  it('loads .env from cwd without overriding existing env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenlean-env-'));
    const prev = process.env.CURSOR_API_KEY;
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'CURSOR_API_KEY=from-file\nTOKENLEAN_LLM_MODEL=from-file\n');
      process.env.CURSOR_API_KEY = 'from-shell';
      delete process.env.TOKENLEAN_LLM_MODEL;
      const loaded = loadEnvFiles({ cwd: dir });
      expect(loaded).toContain(path.join(dir, '.env'));
      expect(process.env.CURSOR_API_KEY).toBe('from-shell');
      expect(process.env.TOKENLEAN_LLM_MODEL).toBe('from-file');
    } finally {
      if (prev === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prev;
      delete process.env.TOKENLEAN_LLM_MODEL;
      fs.rmSync(dir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
});
