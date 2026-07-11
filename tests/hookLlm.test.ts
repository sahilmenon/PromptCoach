import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, type DB } from '../src/db';
import { decideNudgeWithLlm, renderHookOutput } from '../src/hook/hook';
import { PROMPT_REVIEW_SYSTEM, parsePromptReview, reviewPromptWithLlm } from '../src/hook/llm';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenlean-hook-llm-'));
  db = openDb(path.join(dir, 'db.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('hosted prompt review', () => {
  it('accepts general questions rather than requiring coding tasks', () => {
    expect(PROMPT_REVIEW_SYSTEM).toContain('A clear question is a complete and valid prompt');
    expect(PROMPT_REVIEW_SYSTEM).toContain('Never criticize a prompt for being the wrong kind of task');
    expect(PROMPT_REVIEW_SYSTEM).toContain('simple HTML/CSS/JS website');
  });

  it('parses a useful review and normalizes good results', () => {
    expect(parsePromptReview('{"needs_improvement":true,"category":"vague","feedback":"Name the target file.","score":4,"polished_prompt":"Update parser.ts to handle empty input and explain the change."}'))
      .toEqual({
        needsImprovement: true,
        category: 'vague',
        score: 4,
        feedback: 'Name the target file.',
        polishedPrompt: 'Update parser.ts to handle empty input and explain the change.',
      });
    expect(parsePromptReview('{"needs_improvement":false,"category":"other","feedback":"Clear scope and acceptance criteria.","score":8,"polished_prompt":null}'))
      .toEqual({
        needsImprovement: false,
        category: 'good',
        score: 8,
        feedback: 'Clear scope and acceptance criteria.',
        polishedPrompt: null,
      });
    expect(parsePromptReview('{"needs_improvement":true,"category":"vague","feedback":"Name the target file.","score":4}')).toBeNull();
    expect(parsePromptReview('{"needs_improvement":true,"category":"vague","feedback":"Add any useful detail.","score":0,"polished_prompt":"Explain what you need help with and the outcome you want."}'))
      .toEqual({
        needsImprovement: true,
        category: 'vague',
        score: 0,
        feedback: 'Add any useful detail.',
        polishedPrompt: 'Explain what you need help with and the outcome you want.',
      });
    expect(PROMPT_REVIEW_SYSTEM).toContain('polished_prompt');
    expect(PROMPT_REVIEW_SYSTEM).toContain('score: integer from 0 to 10');
  });

  it('uses the model review instead of local prompt heuristics', async () => {
    const reviewer = vi.fn(async () => ({
      needsImprovement: true as const,
      category: 'missing_context' as const,
      score: 4,
      feedback: 'Name the failing behavior and the file or command that reproduces it.',
      polishedPrompt: 'Reproduce the failing parser behavior in parser.ts and describe the expected output.',
    }));
    const decision = await decideNudgeWithLlm(
      db,
      { session_id: 's1', cwd: '/repo', prompt: 'review: this looks perfectly specific to local rules' },
      reviewer
    );
    expect(reviewer).toHaveBeenCalledOnce();
    expect(reviewer).toHaveBeenCalledWith('this looks perfectly specific to local rules', '/repo');
    expect(decision.pattern).toBe('missing_context');
    expect(decision.message).toContain('Name the failing behavior');
  });

  it('fails closed when the API is unavailable', async () => {
    const decision = await decideNudgeWithLlm(
      db,
      { session_id: 's2', cwd: '/repo', prompt: 'review: fix it' },
      async () => null
    );
    expect(decision.message).toContain('not sent');
    expect(decision.pattern).toBe('llm_unavailable');
    expect(JSON.parse(renderHookOutput(decision)!)).toMatchObject({ decision: 'block' });
  });

  it('reviews every normal prompt, including modifications', async () => {
    const reviewer = vi.fn(async () => ({
      needsImprovement: false as const,
      category: 'good' as const,
      score: 9,
      feedback: 'The target, scope, and verification step are all explicit.',
      polishedPrompt: null,
    }));
    const input = { session_id: 'same-session', cwd: '/repo', prompt: 'review: Update parser.ts and run its tests.' };
    const first = await decideNudgeWithLlm(db, input, reviewer);
    const modified = await decideNudgeWithLlm(db, { ...input, prompt: 'review: Now add the regression test.' }, reviewer);
    expect(first.message).toContain('🟢 READY');
    expect(modified.message).toContain('🟢 READY');
    expect(reviewer).toHaveBeenCalledTimes(2);
  });

  it('reviews an unchanged bad prompt every time', async () => {
    const reviewer = vi.fn(async () => ({
      needsImprovement: true as const,
      category: 'vague' as const,
      score: 3,
      feedback: 'Name the desired outcome.',
      polishedPrompt: 'Describe the desired outcome for this fix.',
    }));
    const input = { session_id: 'bad-session', cwd: '/repo', prompt: 'review: fix it' };
    expect((await decideNudgeWithLlm(db, input, reviewer)).pattern).toBe('vague');
    expect((await decideNudgeWithLlm(db, input, reviewer)).pattern).toBe('vague');
    expect(reviewer).toHaveBeenCalledTimes(2);
  });

  it('sends ordinary prompts directly without calling Haiku', async () => {
    const reviewer = vi.fn();
    const decision = await decideNudgeWithLlm(
      db,
      { session_id: 'send-session', cwd: '/repo', prompt: 'implement the parser' },
      reviewer
    );
    expect(decision.message).toBeNull();
    expect(decision.suppressReason).toBe('review_not_requested');
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('blocks both improvement and good feedback', () => {
    const blocked = renderHookOutput({
      pattern: 'vague',
      message: '🟡 SUGGESTION\n\nName the desired outcome.',
    });
    expect(JSON.parse(blocked!)).toMatchObject({ decision: 'block' });
    expect(JSON.parse(blocked!).reason).toContain('with review: for another review');
    expect(JSON.parse(renderHookOutput({
      pattern: 'good',
      message: '🟢 READY\n\nClear and testable.',
    })!)).toMatchObject({ decision: 'block' });
  });

  it('supports a one-shot bypass without calling Haiku', async () => {
    const reviewer = vi.fn(async () => ({
      needsImprovement: false as const,
      category: 'good' as const,
      score: 8,
      feedback: 'Clear.',
      polishedPrompt: null,
    }));
    db.prepare("INSERT INTO meta (key,value) VALUES ('hook_bypass','next')").run();
    const first = await decideNudgeWithLlm(db, { session_id: 'b1', prompt: 'review: send this' }, reviewer);
    expect(first.suppressReason).toBe('bypass_next');
    expect(reviewer).not.toHaveBeenCalled();
    expect((db.prepare("SELECT value FROM meta WHERE key='hook_bypass'").get() as { value: string }).value).toBe('off');

    const second = await decideNudgeWithLlm(db, { session_id: 'b1', prompt: 'review: review this' }, reviewer);
    expect(second.pattern).toBe('good');
    expect(reviewer).toHaveBeenCalledOnce();
  });

  it('calls the OpenAI Responses endpoint and extracts output text', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: '{"needs_improvement":false,"category":"good","feedback":"The request is concrete and testable.","score":8,"polished_prompt":null}' }] }],
    }), { status: 200 }));
    const review = await reviewPromptWithLlm('Implement the parser and run its tests.', '/repo', {
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      model: 'cheap-model',
      timeoutMs: 1000,
    });
    expect(review).toEqual({
      needsImprovement: false,
      category: 'good',
      score: 8,
      feedback: 'The request is concrete and testable.',
      polishedPrompt: null,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/v1/responses');
  });

  it('calls Anthropic Messages with Haiku-compatible request fields', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"needs_improvement":true,"category":"vague","feedback":"Name the desired outcome.","score":4,"polished_prompt":"Help me choose a clear outcome for this task."}' }],
    }), { status: 200 }));
    const review = await reviewPromptWithLlm('help', '/repo', {
      provider: 'anthropic',
      apiKey: 'anthropic-test-key',
      baseUrl: 'https://api.anthropic.test/v1',
      model: 'claude-haiku-4-5',
      timeoutMs: 1000,
    });
    expect(review?.category).toBe('vague');
    expect(review?.score).toBe(4);
    expect(review?.feedback).toContain('outcome');
    expect(review?.polishedPrompt).toContain('outcome');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.test/v1/messages');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('anthropic-test-key');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 700,
    });
  });

  it('calls a Cursor OpenAI-compatible proxy via chat/completions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"needs_improvement":false,"category":"good","feedback":"Clear comparison question.","score":8,"polished_prompt":null}' } }],
    }), { status: 200 }));
    const review = await reviewPromptWithLlm('Claude or GPT for a landing page?', '/repo', {
      provider: 'cursor',
      apiKey: 'cursor-test-key',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'composer-2.5',
      timeoutMs: 1000,
    });
    expect(review).toEqual({
      needsImprovement: false,
      category: 'good',
      score: 8,
      feedback: 'Clear comparison question.',
      polishedPrompt: null,
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8080/v1/chat/completions');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cursor-test-key');
  });

  it('calls Gemini OpenAI-compatible chat/completions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"needs_improvement":false,"category":"good","feedback":"Clear question.","score":8,"polished_prompt":null}' } }],
    }), { status: 200 }));
    const review = await reviewPromptWithLlm('who is richest in australia', '/repo', {
      provider: 'gemini',
      apiKey: 'gemini-test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash',
      timeoutMs: 1000,
    });
    expect(review?.score).toBe(8);
    expect(review?.feedback).toContain('Clear');
    expect(review?.polishedPrompt).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gemini-test-key');
  });

  it('polls the Cursor Cloud Agents API when no local runtime is available', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/agents') && !url.includes('/runs')) {
        return new Response(JSON.stringify({
          agent: { id: 'bc-1' },
          run: { id: 'run-1', status: 'CREATING' },
        }), { status: 200 });
      }
      if (url.includes('/runs/run-1') && !url.includes('/archive')) {
        return new Response(JSON.stringify({
          id: 'run-1',
          status: 'FINISHED',
          result: '{"needs_improvement":true,"category":"vague","feedback":"Name the desired outcome.","score":4,"polished_prompt":"Help me define a clear desired outcome."}',
        }), { status: 200 });
      }
      if (url.includes('/archive')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    const review = await reviewPromptWithLlm('help', '/tmp', {
      provider: 'cursor',
      apiKey: 'cursor-cloud-key',
      baseUrl: '',
      model: 'composer-2.5',
      timeoutMs: 5_000,
    });
    expect(review?.category).toBe('vague');
    expect(review?.score).toBe(4);
    expect(review?.feedback).toContain('outcome');
    expect(review?.polishedPrompt).toContain('outcome');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('https://api.cursor.com/v1/agents'))).toBe(true);
  });
});
