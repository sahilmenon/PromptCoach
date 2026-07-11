import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hookLlmConfig } from '../src/config';
import { saveApiKey } from '../src/credentials';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmguide-config-'));
  process.env.LLMGUIDE_CREDENTIALS = path.join(dir, 'credentials.json');
  for (const name of [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'LLMGUIDE_LLM_API_KEY', 'LLMGUIDE_LLM_PROVIDER', 'LLMGUIDE_LLM_MODEL',
    'LLMGUIDE_LLM_BASE_URL', 'TOKENLEAN_LLM_API_KEY', 'TOKENLEAN_LLM_PROVIDER',
    'TOKENLEAN_LLM_MODEL', 'TOKENLEAN_LLM_BASE_URL',
  ]) delete process.env[name];
});

afterEach(() => {
  delete process.env.LLMGUIDE_CREDENTIALS;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('hosted model configuration', () => {
  it('selects GPT Nano for a saved OpenAI key', () => {
    saveApiKey('openai', 'openai-key');
    expect(hookLlmConfig()).toMatchObject({
      provider: 'openai',
      apiKey: 'openai-key',
      model: 'gpt-5.4-nano',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('selects Gemini Flash for a saved Gemini key', () => {
    saveApiKey('gemini', 'gemini-key');
    expect(hookLlmConfig()).toMatchObject({
      provider: 'gemini',
      apiKey: 'gemini-key',
      model: 'gemini-2.5-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
  });

  it('uses the most recently saved provider when several keys exist', () => {
    saveApiKey('anthropic', 'anthropic-key');
    saveApiKey('openai', 'openai-key');
    expect(hookLlmConfig()).toMatchObject({ provider: 'openai', apiKey: 'openai-key' });
  });
});
