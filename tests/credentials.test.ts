import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  anthropicApiKey,
  clearAnthropicApiKey,
  credentialsPath,
  saveAnthropicApiKey,
  storedAnthropicApiKey,
} from '../src/credentials';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmguide-credentials-'));
  process.env.LLMGUIDE_CREDENTIALS = path.join(dir, 'credentials.json');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LLMGUIDE_LLM_API_KEY;
  delete process.env.TOKENLEAN_CREDENTIALS;
  delete process.env.TOKENLEAN_LLM_API_KEY;
});

afterEach(() => {
  delete process.env.LLMGUIDE_CREDENTIALS;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LLMGUIDE_LLM_API_KEY;
  delete process.env.TOKENLEAN_CREDENTIALS;
  delete process.env.TOKENLEAN_LLM_API_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('persistent API credentials', () => {
  it('saves and reads the key with owner-only permissions', () => {
    expect(saveAnthropicApiKey('  saved-key  ')).toBe(credentialsPath());
    expect(storedAnthropicApiKey()).toBe('saved-key');
    expect(fs.statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(credentialsPath())).mode & 0o777).toBe(0o700);
  });

  it('prefers environment overrides and can remove the saved key', () => {
    saveAnthropicApiKey('saved-key');
    process.env.ANTHROPIC_API_KEY = 'temporary-key';
    expect(anthropicApiKey()).toBe('temporary-key');
    expect(clearAnthropicApiKey()).toBe(true);
    expect(clearAnthropicApiKey()).toBe(false);
  });

  it('accepts legacy TokenLean environment variables during migration', () => {
    delete process.env.LLMGUIDE_CREDENTIALS;
    process.env.TOKENLEAN_CREDENTIALS = path.join(dir, 'legacy-credentials.json');
    process.env.TOKENLEAN_LLM_API_KEY = 'legacy-key';
    expect(credentialsPath()).toBe(process.env.TOKENLEAN_CREDENTIALS);
    expect(anthropicApiKey()).toBe('legacy-key');
  });
});
