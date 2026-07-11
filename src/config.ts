import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * All filesystem locations and environment lookups in one place.
 * Every path can be overridden via environment variables so tests
 * never touch the user's real state.
 */

/** Root for tokenlean's own local state. Override: TOKENLEAN_HOME. */
export function tokenleanHome(): string {
  return process.env.TOKENLEAN_HOME || path.join(os.homedir(), '.tokenlean');
}

export function dbPath(): string {
  return process.env.TOKENLEAN_DB || path.join(tokenleanHome(), 'db.sqlite');
}

/** The Claude Code config dir (contains projects/ and settings.json). */
export function defaultClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Resolve the directory that holds per-project transcript folders.
 * Accepts either the Claude config dir (~/.claude) or a direct path
 * to a projects dir.
 */
export function resolveProjectsDir(claudeDir: string): string {
  const nested = path.join(claudeDir, 'projects');
  if (fs.existsSync(nested)) return nested;
  return claudeDir;
}

/** Claude Code settings.json (hook + env live here). Override: TOKENLEAN_CLAUDE_SETTINGS. */
export function claudeSettingsPath(): string {
  return (
    process.env.TOKENLEAN_CLAUDE_SETTINGS ||
    path.join(defaultClaudeDir(), 'settings.json')
  );
}

export function nowMs(): number {
  return Date.now();
}
