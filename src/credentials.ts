import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface StoredCredentials {
  provider?: LlmProvider;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
}

export type LlmProvider = 'anthropic' | 'openai' | 'gemini';

type StoredKeyField = 'anthropicApiKey' | 'openaiApiKey' | 'geminiApiKey';

const storedField: Record<LlmProvider, StoredKeyField> = {
  anthropic: 'anthropicApiKey',
  openai: 'openaiApiKey',
  gemini: 'geminiApiKey',
};

function readStoredCredentials(): StoredCredentials {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    return value !== null && typeof value === 'object' ? value as StoredCredentials : {};
  } catch {
    return {};
  }
}

export function credentialsPath(): string {
  const explicitHome = process.env.PROMPTCOACH_HOME || process.env.TOKENLEAN_HOME;
  const current = path.join(os.homedir(), '.promptcoach');
  const legacy = path.join(os.homedir(), '.tokenlean');
  const home = explicitHome || (!fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current);
  return process.env.PROMPTCOACH_CREDENTIALS || process.env.TOKENLEAN_CREDENTIALS ||
    path.join(home, 'credentials.json');
}

export function storedAnthropicApiKey(): string | null {
  return storedApiKey('anthropic');
}

export function storedApiKey(provider: LlmProvider): string | null {
  const key = readStoredCredentials()[storedField[provider]];
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

export function storedLlmProvider(): LlmProvider | null {
  const provider = readStoredCredentials().provider;
  return provider === 'anthropic' || provider === 'openai' || provider === 'gemini' ? provider : null;
}

/** Environment variables override the persistent key for CI and temporary use. */
export function anthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY ||
    process.env.PROMPTCOACH_LLM_API_KEY ||
    process.env.TOKENLEAN_LLM_API_KEY ||
    storedAnthropicApiKey();
}

export function providerApiKey(provider: LlmProvider): string | null {
  const environmentKey = provider === 'anthropic'
    ? process.env.ANTHROPIC_API_KEY
    : provider === 'openai'
      ? process.env.OPENAI_API_KEY
      : process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return environmentKey || storedApiKey(provider) || null;
}

export function saveApiKey(provider: LlmProvider, raw: string): string {
  const key = raw.trim();
  if (!key) throw new Error('API key cannot be empty.');
  const file = credentialsPath();
  const credentials = readStoredCredentials();
  credentials.provider = provider;
  credentials[storedField[provider]] = key;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function saveAnthropicApiKey(raw: string): string {
  return saveApiKey('anthropic', raw);
}

export function clearApiKey(provider?: LlmProvider): boolean {
  const file = credentialsPath();
  if (!provider) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  const credentials = readStoredCredentials();
  const field = storedField[provider];
  if (!credentials[field]) return false;
  delete credentials[field];
  const remaining = (['anthropic', 'openai', 'gemini'] as const)
    .find(candidate => typeof credentials[storedField[candidate]] === 'string');
  credentials.provider = remaining;
  if (remaining) {
    fs.writeFileSync(file, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  } else {
    fs.unlinkSync(file);
  }
  return true;
}

export function clearAnthropicApiKey(): boolean {
  return clearApiKey('anthropic');
}
