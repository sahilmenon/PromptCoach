import * as http from 'http';
import { hookLlmConfig } from './config';
import { reviewPromptWithLlm, type PromptReview } from './hook/llm';

export const DEFAULT_EXTENSION_PORT = 8787;

export function extensionServerPort(): number {
  const raw = Number(process.env.TOKENLEAN_EXTENSION_PORT || DEFAULT_EXTENSION_PORT);
  if (!Number.isFinite(raw) || raw < 1 || raw > 65535) return DEFAULT_EXTENSION_PORT;
  return Math.trunc(raw);
}

export function extensionServerUrl(port = extensionServerPort()): string {
  return `http://127.0.0.1:${port}`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (chunks.reduce((n, c) => n + c.length, 0) > 256_000) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

export interface ExtensionReviewResponse {
  ok: boolean;
  review?: PromptReview;
  provider?: string;
  model?: string;
  error?: string;
}

/**
 * Local-only bridge so the browser extension can reuse the same hosted
 * prompt-review path as the CLI UserPromptSubmit hook.
 */
export function createExtensionServer(options?: {
  port?: number;
  reviewer?: typeof reviewPromptWithLlm;
}): http.Server {
  const reviewer = options?.reviewer || reviewPromptWithLlm;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      const config = hookLlmConfig();
      sendJson(res, 200, {
        ok: true,
        service: 'tokenlean-extension',
        configured: config !== null,
        provider: config?.provider ?? null,
        model: config?.model ?? null,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/review') {
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid_json' } satisfies ExtensionReviewResponse);
        return;
      }

      const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
      const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
      const cwd = typeof record.cwd === 'string' && record.cwd.trim()
        ? record.cwd.trim()
        : process.cwd();

      if (!prompt) {
        sendJson(res, 400, { ok: false, error: 'missing_prompt' } satisfies ExtensionReviewResponse);
        return;
      }

      const config = hookLlmConfig();
      if (config === null) {
        sendJson(res, 503, {
          ok: false,
          error: 'not_configured',
        } satisfies ExtensionReviewResponse);
        return;
      }

      const review = await reviewer(prompt, cwd, config);
      if (review === null) {
        sendJson(res, 502, {
          ok: false,
          error: 'unavailable',
          provider: config.provider,
          model: config.model,
        } satisfies ExtensionReviewResponse);
        return;
      }

      sendJson(res, 200, {
        ok: true,
        review,
        provider: config.provider,
        model: config.model,
      } satisfies ExtensionReviewResponse);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  });
}

export function startExtensionServer(port = extensionServerPort()): Promise<http.Server> {
  const server = createExtensionServer({ port });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
