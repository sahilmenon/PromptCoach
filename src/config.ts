import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  anthropicApiKey,
  providerApiKey as storedProviderApiKey,
  storedLlmProvider,
} from './credentials';

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

export type HookLlmProvider = 'anthropic' | 'openai' | 'cursor' | 'gemini';

export interface HookLlmConfig {
  provider: HookLlmProvider;
  apiKey: string;
  /** Empty for Cursor native (SDK / CLI / Cloud Agents). Otherwise an HTTP API root. */
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/** Default low-cost model for hosted transcript and prompt analysis. */
export const DEFAULT_LLM_MODEL = 'claude-haiku-4-5';

function resolveHookLlmProvider(): HookLlmProvider {
  const requested = (
    process.env.LLMGUIDE_LLM_PROVIDER || process.env.TOKENLEAN_LLM_PROVIDER
  )?.toLowerCase();
  if (
    requested === 'openai'
    || requested === 'anthropic'
    || requested === 'cursor'
    || requested === 'gemini'
  ) {
    return requested;
  }
  // The provider last saved with `llmguide config set-key` wins when its key
  // is still available; environment detection is the fallback.
  const saved = storedLlmProvider();
  if (saved && storedProviderApiKey(saved)) return saved;
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'gemini';
  if (anthropicApiKey()) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.CURSOR_API_KEY) return 'cursor';
  return 'anthropic';
}

function providerApiKey(provider: HookLlmProvider): string | undefined {
  if (provider === 'anthropic') {
    return anthropicApiKey()
      || process.env.LLMGUIDE_LLM_API_KEY
      || process.env.TOKENLEAN_LLM_API_KEY
      || undefined;
  }
  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY
      || storedProviderApiKey('openai')
      || process.env.LLMGUIDE_LLM_API_KEY
      || process.env.TOKENLEAN_LLM_API_KEY;
  }
  if (provider === 'gemini') {
    return process.env.GEMINI_API_KEY
      || process.env.GOOGLE_API_KEY
      || storedProviderApiKey('gemini')
      || process.env.LLMGUIDE_LLM_API_KEY
      || process.env.TOKENLEAN_LLM_API_KEY;
  }
  return process.env.CURSOR_API_KEY
    || process.env.LLMGUIDE_LLM_API_KEY
    || process.env.TOKENLEAN_LLM_API_KEY;
}

function defaultModel(provider: HookLlmProvider): string {
  if (provider === 'anthropic') return DEFAULT_LLM_MODEL;
  if (provider === 'openai') return 'gpt-5.4-nano';
  if (provider === 'gemini') return 'gemini-2.5-flash';
  return 'composer-2.5';
}

function defaultBaseUrl(provider: HookLlmProvider): string {
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1';
  if (provider === 'openai') return 'https://api.openai.com/v1';
  if (provider === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta/openai';
  // Cursor native paths do not use an OpenAI-style base URL unless the user
  // points TOKENLEAN_LLM_BASE_URL / LLMGUIDE_LLM_BASE_URL at a proxy.
  return '';
}

/** Hosted prompt-review model used by the UserPromptSubmit hook. */
export function hookLlmConfig(): HookLlmConfig | null {
  const provider = resolveHookLlmProvider();
  const apiKey = providerApiKey(provider);
  if (!apiKey) return null;

  const cursorish = provider === 'cursor';
  const defaultTimeout = cursorish ? 60_000 : 7_500;
  const maxTimeout = cursorish ? 180_000 : 9_000;
  const rawTimeout = Number(
    process.env.LLMGUIDE_LLM_TIMEOUT_MS
      || process.env.TOKENLEAN_LLM_TIMEOUT_MS
      || defaultTimeout
  );
  const timeoutMs = Number.isFinite(rawTimeout)
    ? Math.min(maxTimeout, Math.max(500, rawTimeout))
    : defaultTimeout;

  const rawBase = process.env.LLMGUIDE_LLM_BASE_URL ?? process.env.TOKENLEAN_LLM_BASE_URL;
  const baseUrl = (rawBase !== undefined ? rawBase : defaultBaseUrl(provider)).replace(/\/+$/, '');

  return {
    provider,
    apiKey,
    baseUrl,
    model: process.env.LLMGUIDE_LLM_MODEL
      || process.env.TOKENLEAN_LLM_MODEL
      || defaultModel(provider),
    timeoutMs,
  };
}
