import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Parse a dotenv-style file. Supports KEY=VALUE, optional quotes, and # comments.
 * Does not expand variables or run shell syntax.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function applyEnv(vars: Record<string, string>, override: boolean): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!override && process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

function readEnvFile(filePath: string): Record<string, string> | null {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Load API keys and other settings from .env files.
 * Existing process.env values win (so real exports still override the file).
 *
 * Search order (later files do not override earlier ones once a key is set):
 * 1. TOKENLEAN_ENV path, if set
 * 2. .env in the current working directory
 * 3. ~/.tokenlean/.env (shared across projects)
 */
export function loadEnvFiles(options?: { override?: boolean; cwd?: string }): string[] {
  const override = options?.override === true;
  const cwd = options?.cwd || process.cwd();
  const loaded: string[] = [];

  const candidates = [
    process.env.TOKENLEAN_ENV,
    path.join(cwd, '.env'),
    path.join(process.env.TOKENLEAN_HOME || path.join(os.homedir(), '.tokenlean'), '.env'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const vars = readEnvFile(resolved);
    if (vars === null) continue;
    applyEnv(vars, override);
    loaded.push(resolved);
  }
  return loaded;
}
