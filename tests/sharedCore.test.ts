import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import * as core from '../src/shared/core';

describe('shared core: prompt analysis', () => {
  it('does not treat "please" as a goal signal (dashboard counts it as filler)', () => {
    const polite = core.analyzePromptText('please please please');
    expect(polite.tips).toContain('State the goal in one clear sentence.');
  });

  it('flags oversized pastes at the same threshold as the CLI hook', () => {
    const paste = 'fix this\n```\n' + 'x'.repeat(core.OVERSIZED_PASTE_CHARS + 100) + '\n```';
    const result = core.analyzePromptText(paste);
    expect(result.tips.join(' ')).toContain('Large pasted code');

    const smallCode = 'fix this\n```\nconst a = 1;\n```';
    expect(core.analyzePromptText(smallCode).tips.join(' ')).not.toContain('Large pasted code');
  });

  it('never penalizes brevity in the score', () => {
    const brief = core.analyzePromptText('fix the login bug');
    const briefNoGoal = core.analyzePromptText('hmm okay');
    expect(brief.score).toBeGreaterThanOrEqual(briefNoGoal.score);
    expect(briefNoGoal.score).toBeGreaterThanOrEqual(1);
  });

  it('scores a fully structured prompt at the top of the range', () => {
    const structured = core.analyzePromptText(
      'Goal: fix the auth bug. Requirements: must not change the API. Done when: tests pass.'
    );
    expect(structured.score).toBe(10);
  });

  it('estimates tokens at the shared chars-per-token divisor', () => {
    expect(core.analyzePromptText('a'.repeat(400)).approxTokens).toBe(
      400 / core.APPROX_CHARS_PER_TOKEN
    );
  });
});

describe('shared core: similarity', () => {
  it('matches the CLI resupplied-context behavior for identical long prompts', () => {
    const text = 'the quick brown fox jumps over the lazy dog again and again today';
    expect(core.jaccard(core.shingles(text), core.shingles(text))).toBe(1);
  });

  it('returns 0 for prompts too short to shingle', () => {
    expect(core.jaccard(core.shingles('too short'), core.shingles('too short'))).toBe(0);
  });

  it('detects consecutive rework via word-bag similarity', () => {
    const a = 'write a node script to fetch all headings from google';
    const b = 'write a node script fetching headings from google please';
    expect(core.wordBagSimilarity(a, b)).toBeGreaterThan(core.REWORK_SIMILARITY);
    expect(core.wordBagSimilarity(a, 'summarize this pdf for me')).toBeLessThan(
      core.REWORK_SIMILARITY
    );
  });
});

describe('shared core: filler words', () => {
  it('counts filler words case-insensitively around punctuation', () => {
    expect(core.countFillerWords('Please, THANKS! just do it — pls.')).toBe(4);
  });
});

describe('shared core: environmental ranges', () => {
  it('converts a million tokens using the sourced bounds', () => {
    expect(core.energyRangeKwh(1e6)).toEqual({
      low: core.ENERGY_KWH_PER_MTOK.low,
      high: core.ENERGY_KWH_PER_MTOK.high,
    });
  });

  it('never emits a negative range', () => {
    expect(core.energyRangeKwh(-5)).toEqual({ low: 0, high: 0 });
  });

  it('renders ranges, not single figures', () => {
    expect(core.formatRange({ low: 0.4, high: 1.3 }, 'kWh')).toBe('0.4–1.3 kWh');
  });
});

describe('shared core: transcript prompt extraction', () => {
  it('extracts user text from Claude Code JSONL shapes', () => {
    const node = {
      message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
    };
    expect(core.extractUserText(node)).toBe('fix the bug');
    expect(core.extractUserText({ role: 'assistant', content: 'hi' })).toBe('');
  });

  it('walks wrapper objects and counts turns', () => {
    const wrapped = {
      conversation: [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'reply' },
        { message: { role: 'user', content: 'second prompt' } },
      ],
    };
    const collected = core.collectPrompts(wrapped);
    expect(collected.prompts).toEqual(['first prompt', 'second prompt']);
    expect(collected.turns).toBe(3);
  });
});

describe('generated extension bundle', () => {
  it('exposes the same constants and behavior as the TypeScript source', () => {
    const require = createRequire(import.meta.url);
    require('../extension/lib/promptcoach-core.js');
    const bundled = (globalThis as Record<string, any>).PromptCoachCore;
    expect(bundled).toBeDefined();

    expect(bundled.OVERSIZED_PASTE_CHARS).toBe(core.OVERSIZED_PASTE_CHARS);
    expect(bundled.APPROX_CHARS_PER_TOKEN).toBe(core.APPROX_CHARS_PER_TOKEN);
    expect(bundled.RESUPPLIED_SIMILARITY).toBe(core.RESUPPLIED_SIMILARITY);
    expect(bundled.REWORK_SIMILARITY).toBe(core.REWORK_SIMILARITY);
    expect(bundled.CACHED_READ_WEIGHT).toBe(core.CACHED_READ_WEIGHT);
    expect(bundled.ESTIMATE_LABEL).toBe(core.ESTIMATE_LABEL);
    expect(bundled.ENERGY_KWH_PER_MTOK).toEqual(core.ENERGY_KWH_PER_MTOK);
    expect(bundled.WATER_L_PER_KWH_ONSITE).toEqual(core.WATER_L_PER_KWH_ONSITE);
    expect(bundled.WATER_L_PER_KWH_LIFECYCLE).toEqual(core.WATER_L_PER_KWH_LIFECYCLE);
    expect(bundled.DEFAULT_MODELS).toEqual(core.DEFAULT_MODELS);

    const sample = 'Goal: refactor the parser. Requirements: must keep tests green. Done when: CI passes.';
    expect(bundled.analyzePromptText(sample)).toEqual(core.analyzePromptText(sample));
    expect(bundled.structurePrompt('do the thing')).toBe(core.structurePrompt('do the thing'));
    expect(bundled.wordBagSimilarity('a b c', 'a b d')).toBe(core.wordBagSimilarity('a b c', 'a b d'));
  });
});
