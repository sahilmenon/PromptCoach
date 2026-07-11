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

/** Codex CLI state root and user-level hook file. */
export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function codexHooksPath(): string {
  return process.env.TOKENLEAN_CODEX_HOOKS || path.join(codexHome(), 'hooks.json');
}

export function nowMs(): number {
  return Date.now();
}

export interface HookLlmConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/** Hosted prompt-review model used by the UserPromptSubmit hook. */
export function hookLlmConfig(): HookLlmConfig | null {
  const requested = process.env.TOKENLEAN_LLM_PROVIDER?.toLowerCase();
  const provider = requested === 'openai' || requested === 'anthropic'
    ? requested
    : process.env.ANTHROPIC_API_KEY
      ? 'anthropic'
      : process.env.OPENAI_API_KEY
        ? 'openai'
        : 'anthropic';
  const apiKey = (provider === 'anthropic'
    ? process.env.ANTHROPIC_API_KEY
    : process.env.OPENAI_API_KEY) || process.env.TOKENLEAN_LLM_API_KEY;
  if (!apiKey) return null;

  const rawTimeout = Number(process.env.TOKENLEAN_LLM_TIMEOUT_MS || 7_500);
  const timeoutMs = Number.isFinite(rawTimeout)
    ? Math.min(9_000, Math.max(500, rawTimeout))
    : 7_500;

  return {
    provider,
    apiKey,
    baseUrl: (process.env.TOKENLEAN_LLM_BASE_URL ||
      (provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'))
      .replace(/\/+$/, ''),
    model: process.env.TOKENLEAN_LLM_MODEL ||
      (provider === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-5.4-nano'),
    timeoutMs,
  };
}
