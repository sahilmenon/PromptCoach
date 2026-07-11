import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import { createExtensionServer } from '../src/extensionServer';
import type { PromptReview } from '../src/hook/llm';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('extension review bridge', () => {
  it('reviews prompts through the same LLM path as the CLI hook', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const review: PromptReview = {
      needsImprovement: true,
      category: 'vague',
      score: 4,
      feedback: 'Name the target page and the outcome you want.',
      polishedPrompt: 'Improve the homepage hero copy so it clearly states the product benefit.',
    };
    const reviewer = vi.fn(async () => review);
    const server = createExtensionServer({ reviewer });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'make it better', cwd: '/repo' }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        review,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      });
      expect(reviewer).toHaveBeenCalledWith('make it better', '/repo', expect.objectContaining({
        provider: 'anthropic',
        apiKey: 'test-key',
      }));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('reports when no API key is configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('CURSOR_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('TOKENLEAN_LLM_API_KEY', '');
    const server = createExtensionServer({
      reviewer: async () => null,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
      await expect(health.json()).resolves.toMatchObject({ ok: true, configured: false });

      const response = await fetch(`http://127.0.0.1:${port}/v1/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ ok: false, error: 'not_configured' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
