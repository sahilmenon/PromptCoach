import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { providerApiKey, storedLlmProvider, type LlmProvider } from './credentials';

/**
 * All filesystem locations and environment lookups in one place.
 * Every path can be overridden via environment variables so tests
 * never touch the user's real state.
 */

/** Root for LLMGuide state. Legacy TokenLean variables and data remain readable. */
export function llmguideHome(): string {
  const override = process.env.LLMGUIDE_HOME || process.env.TOKENLEAN_HOME;
  if (override) return override;
  const current = path.join(os.homedir(), '.llmguide');
  const legacy = path.join(os.homedir(), '.tokenlean');
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

export function dbPath(): string {
  return process.env.LLMGUIDE_DB || process.env.TOKENLEAN_DB || path.join(llmguideHome(), 'db.sqlite');
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

/** Claude Code settings.json. LLMGUIDE_CLAUDE_SETTINGS overrides the default. */
export function claudeSettingsPath(): string {
  return (
    process.env.LLMGUIDE_CLAUDE_SETTINGS ||
    process.env.TOKENLEAN_CLAUDE_SETTINGS ||
    path.join(defaultClaudeDir(), 'settings.json')
  );
}

/** Codex CLI state root and user-level hook file. */
export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function codexHooksPath(): string {
  return process.env.LLMGUIDE_CODEX_HOOKS || process.env.TOKENLEAN_CODEX_HOOKS ||
    path.join(codexHome(), 'hooks.json');
}

export function nowMs(): number {
  return Date.now();
}

export interface HookLlmConfig {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/** Default low-cost model for hosted transcript and prompt analysis. */
export const DEFAULT_LLM_MODEL = 'claude-haiku-4-5';

const DEFAULT_HOOK_MODELS: Record<LlmProvider, string> = {
  anthropic: DEFAULT_LLM_MODEL,
  openai: 'gpt-5.4-nano',
  gemini: 'gemini-3.1-flash-lite',
};

const DEFAULT_HOOK_BASE_URLS: Record<LlmProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

/** Hosted prompt-review model used by the UserPromptSubmit hook. */
export function hookLlmConfig(): HookLlmConfig | null {
  const requested = (process.env.LLMGUIDE_LLM_PROVIDER || process.env.TOKENLEAN_LLM_PROVIDER)?.toLowerCase();
  const supported = requested === 'openai' || requested === 'anthropic' || requested === 'gemini';
  const savedProvider = storedLlmProvider();
  const provider: LlmProvider = supported
    ? requested
    : savedProvider && providerApiKey(savedProvider)
      ? savedProvider
      : (['anthropic', 'openai', 'gemini'] as const).find(candidate => providerApiKey(candidate)) || 'anthropic';
  const apiKey = providerApiKey(provider) || process.env.LLMGUIDE_LLM_API_KEY ||
    process.env.TOKENLEAN_LLM_API_KEY;
  if (!apiKey) return null;

  const rawTimeout = Number(process.env.LLMGUIDE_LLM_TIMEOUT_MS ||
    process.env.TOKENLEAN_LLM_TIMEOUT_MS || 7_500);
  const timeoutMs = Number.isFinite(rawTimeout)
    ? Math.min(9_000, Math.max(500, rawTimeout))
    : 7_500;

  return {
    provider,
    apiKey,
    baseUrl: (process.env.LLMGUIDE_LLM_BASE_URL || process.env.TOKENLEAN_LLM_BASE_URL ||
      DEFAULT_HOOK_BASE_URLS[provider])
      .replace(/\/+$/, ''),
    model: process.env.LLMGUIDE_LLM_MODEL || process.env.TOKENLEAN_LLM_MODEL ||
      DEFAULT_HOOK_MODELS[provider],
    timeoutMs,
  };
}
