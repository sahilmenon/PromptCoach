import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface StoredCredentials {
  anthropicApiKey?: string;
}

export function credentialsPath(): string {
  const explicitHome = process.env.LLMGUIDE_HOME || process.env.TOKENLEAN_HOME;
  const current = path.join(os.homedir(), '.llmguide');
  const legacy = path.join(os.homedir(), '.tokenlean');
  const home = explicitHome || (!fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current);
  return process.env.LLMGUIDE_CREDENTIALS || process.env.TOKENLEAN_CREDENTIALS ||
    path.join(home, 'credentials.json');
}

export function storedAnthropicApiKey(): string | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    if (value === null || typeof value !== 'object') return null;
    const key = (value as StoredCredentials).anthropicApiKey;
    return typeof key === 'string' && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

/** Environment variables override the persistent key for CI and temporary use. */
export function anthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY ||
    process.env.LLMGUIDE_LLM_API_KEY ||
    process.env.TOKENLEAN_LLM_API_KEY ||
    storedAnthropicApiKey();
}

export function saveAnthropicApiKey(raw: string): string {
  const key = raw.trim();
  if (!key) throw new Error('API key cannot be empty.');
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, JSON.stringify({ anthropicApiKey: key }, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
  return file;
}

export function clearAnthropicApiKey(): boolean {
  const file = credentialsPath();
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
