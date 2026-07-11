import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HookLlmConfig } from '../config';

const execFileAsync = promisify(execFile);

const CURSOR_API = 'https://api.cursor.com/v1';
const TERMINAL = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);

type CursorAgentModule = {
  Agent: {
    prompt: (
      message: string,
      options: {
        apiKey: string;
        model: { id: string };
        mode?: 'agent' | 'plan';
        local?: { cwd: string };
      }
    ) => Promise<{ status: string; result?: string }>;
  };
};

let cachedSdk: CursorAgentModule['Agent'] | false | null = null;
let cachedCli: string | false | null = null;

function cursorAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

function extractChatCompletionsText(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (first === null || typeof first !== 'object') return null;
  const message = (first as Record<string, unknown>).message;
  if (message === null || typeof message !== 'object') return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : null;
}

async function loadCursorSdk(): Promise<CursorAgentModule['Agent'] | null> {
  if (cachedSdk === false) return null;
  if (cachedSdk) return cachedSdk;
  try {
    const mod = (await import('@cursor/sdk')) as CursorAgentModule;
    cachedSdk = mod.Agent;
    return cachedSdk;
  } catch {
    cachedSdk = false;
    return null;
  }
}

async function resolveCursorCli(): Promise<string | null> {
  if (cachedCli === false) return null;
  if (cachedCli) return cachedCli;
  const bin = process.env.TOKENLEAN_CURSOR_CLI || 'agent';
  try {
    await execFileAsync(bin, ['--help'], { timeout: 3_000, maxBuffer: 64 * 1024 });
    cachedCli = bin;
    return cachedCli;
  } catch {
    cachedCli = false;
    return null;
  }
}

async function completeViaOpenAICompatible(
  system: string,
  user: string,
  config: HookLlmConfig,
  signal: AbortSignal
): Promise<string | null> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 700,
      temperature: 0,
    }),
    signal,
  });
  if (!response.ok) return null;
  return extractChatCompletionsText(await response.json());
}

async function completeViaSdk(
  message: string,
  cwd: string,
  config: HookLlmConfig
): Promise<string | null | undefined> {
  const Agent = await loadCursorSdk();
  if (!Agent) return undefined;
  try {
    const result = await Agent.prompt(message, {
      apiKey: config.apiKey,
      model: { id: config.model },
      mode: 'plan',
      local: { cwd },
    });
    if (result.status !== 'finished' || typeof result.result !== 'string') return null;
    return result.result;
  } catch {
    return null;
  }
}

async function completeViaCli(
  message: string,
  cwd: string,
  config: HookLlmConfig
): Promise<string | null | undefined> {
  const bin = await resolveCursorCli();
  if (!bin) return undefined;
  try {
    const { stdout } = await execFileAsync(bin, ['-p', '--output-format', 'text', message], {
      cwd,
      timeout: config.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, CURSOR_API_KEY: config.apiKey },
    });
    return stdout;
  } catch {
    return null;
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('aborted');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function archiveAgent(agentId: string, apiKey: string): Promise<void> {
  try {
    await fetch(`${CURSOR_API}/agents/${encodeURIComponent(agentId)}/archive`, {
      method: 'POST',
      headers: cursorAuthHeaders(apiKey),
    });
  } catch {
    // Best-effort cleanup.
  }
}

async function completeViaCloudAgentsApi(
  message: string,
  config: HookLlmConfig,
  signal: AbortSignal
): Promise<string | null> {
  const created = await fetch(`${CURSOR_API}/agents`, {
    method: 'POST',
    headers: cursorAuthHeaders(config.apiKey),
    body: JSON.stringify({
      prompt: { text: message },
      model: { id: config.model },
      mode: 'plan',
      name: 'tokenlean-prompt-review',
    }),
    signal,
  });
  if (!created.ok) return null;

  const body = (await created.json()) as {
    agent?: { id?: string };
    run?: { id?: string; status?: string; result?: string };
  };
  const agentId = body.agent?.id;
  const runId = body.run?.id;
  if (!agentId || !runId) return null;

  try {
    let status = body.run?.status || 'CREATING';
    let resultText = typeof body.run?.result === 'string' ? body.run.result : null;
    const deadline = Date.now() + config.timeoutMs;

    while (!TERMINAL.has(status)) {
      if (Date.now() >= deadline || signal.aborted) return null;
      await sleep(1_500, signal);
      const runRes = await fetch(
        `${CURSOR_API}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
        { headers: cursorAuthHeaders(config.apiKey), signal }
      );
      if (!runRes.ok) return null;
      const run = (await runRes.json()) as { status?: string; result?: string };
      status = run.status || status;
      if (typeof run.result === 'string') resultText = run.result;
    }

    if (status !== 'FINISHED' || !resultText) return null;
    return resultText;
  } finally {
    void archiveAgent(agentId, config.apiKey);
  }
}

/**
 * Complete a prompt-review request with a Cursor API key.
 * Prefers TOKENLEAN_LLM_BASE_URL (OpenAI-compatible proxy), then @cursor/sdk,
 * then the Cursor CLI (`agent`), then the Cloud Agents API.
 */
export async function completeWithCursor(
  system: string,
  user: string,
  cwd: string,
  config: HookLlmConfig,
  signal: AbortSignal
): Promise<string | null> {
  if (config.baseUrl) {
    return completeViaOpenAICompatible(system, user, config, signal);
  }

  const message = [
    'Do not use tools. Do not read or modify files. Reply with a single JSON object only.',
    system,
    '',
    'Review this prompt:',
    user,
  ].join('\n');

  const viaSdk = await completeViaSdk(message, cwd, config);
  if (viaSdk !== undefined) return viaSdk;

  const viaCli = await completeViaCli(message, cwd, config);
  if (viaCli !== undefined) return viaCli;

  return completeViaCloudAgentsApi(message, config, signal);
}
