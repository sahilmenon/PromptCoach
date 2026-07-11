import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, metaSet, type DB } from '../src/db';
import { decideNudge } from '../src/hook/hook';
import type { HookInput } from '../src/types';

const PROJECT = '/tmp/tokenlean-test-project';

interface NudgeRow {
  id: number;
  session_id: string;
  project: string;
  ts: number;
  fired: number;
  pattern: string;
  message: string | null;
}

let dir: string;
let db: DB;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenlean-hook-'));
  db = openDb(path.join(dir, 'db.sqlite'));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function nudgeRows(): NudgeRow[] {
  return db.prepare('SELECT * FROM nudges ORDER BY id').all() as NudgeRow[];
}

function input(over: Partial<HookInput> = {}): HookInput {
  return {
    session_id: 's-1',
    cwd: PROJECT,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'fix it',
    ...over,
  };
}

function seedFiredNudge(sessionId: string): void {
  db.prepare(
    'INSERT INTO nudges (session_id, project, ts, fired, pattern, message) VALUES (?, ?, ?, 1, ?, ?)'
  ).run(sessionId, PROJECT, Date.now(), 'vague_opening', 'seeded');
}

function seedConventionFinding(sessionId: string, suggestion: string): void {
  db.prepare('INSERT INTO sessions (id, project) VALUES (?, ?)').run(sessionId, PROJECT);
  db.prepare(
    `INSERT INTO findings (session_id, category, confidence, evidence, suggestion, created_at, source, claude_md_line)
     VALUES (?, 'missing_convention', 0.9, 'evidence snippet', ?, ?, 'llm', 'Use vitest for all tests.')`
  ).run(sessionId, suggestion, Date.now());
}

describe('decideNudge', () => {
  it('fires on a vague first prompt and logs a fired row', () => {
    const d = decideNudge(db, input({ prompt: 'fix it' }));
    expect(d.pattern).toBe('vague_opening');
    expect(d.message).toBe(
      "Note: this project's past sessions show rework when the opening prompt lacks " +
        'constraints (files, scope, acceptance criteria). If the request is ambiguous, ' +
        'a single clarifying question is warranted before starting work.'
    );
    const rows = nudgeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].fired).toBe(1);
    expect(rows[0].pattern).toBe('vague_opening');
    expect(rows[0].session_id).toBe('s-1');
    expect(rows[0].project).toBe(PROJECT);
    expect(rows[0].message).toBe(d.message);
  });

  it('suppresses (but still logs) a second prompt in the same session', () => {
    decideNudge(db, input({ prompt: 'fix it' }));
    const d2 = decideNudge(db, input({ prompt: 'make it work' }));
    expect(d2.message).toBeNull();
    expect(d2.suppressReason).toBe('not_first_prompt');
    const rows = nudgeRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].fired).toBe(0);
    expect(rows[1].pattern).toBe('not_first_prompt');
  });

  it('suppresses with daily_cap after 5 fired nudges since local midnight', () => {
    for (let i = 0; i < 5; i++) seedFiredNudge(`seed-${i}`);
    const d = decideNudge(db, input({ session_id: 'fresh-session', prompt: 'fix it' }));
    expect(d.message).toBeNull();
    expect(d.suppressReason).toBe('daily_cap');
    const rows = nudgeRows();
    expect(rows).toHaveLength(6);
    expect(rows[5].fired).toBe(0);
    expect(rows[5].pattern).toBe('daily_cap');
  });

  it('suppresses while muted_until is in the future', () => {
    metaSet(db, 'muted_until', String(Date.now() + 86_400_000));
    const d = decideNudge(db, input({ prompt: 'fix it' }));
    expect(d.message).toBeNull();
    expect(d.suppressReason).toBe('muted');
  });

  it('fires again once the mute has expired', () => {
    metaSet(db, 'muted_until', String(Date.now() - 1_000));
    const d = decideNudge(db, input({ prompt: 'fix it' }));
    expect(d.pattern).toBe('vague_opening');
    expect(d.message).not.toBeNull();
  });

  it('fires oversized_paste on a >8000-char prompt containing a code fence', () => {
    const prompt = 'please review this\n```\n' + 'x'.repeat(8200) + '\n```';
    const d = decideNudge(db, input({ prompt }));
    expect(d.pattern).toBe('oversized_paste');
    expect(d.message).toBe(
      'Note: this prompt embeds a large paste. Past sessions saved tokens when Claude read ' +
        'files by path instead. If the pasted content exists on disk in this project, prefer ' +
        'referencing the file path.'
    );
    expect(nudgeRows()[0].fired).toBe(1);
  });

  it('does not fire oversized_paste on a long prompt without a code fence', () => {
    const d = decideNudge(db, input({ prompt: 'y'.repeat(9000) }));
    expect(d.suppressReason).toBe('no_match');
  });

  it('fires missing_convention when the prompt shares a keyword with a learned topic', () => {
    seedConventionFinding(
      'past-1',
      'Specify the testing framework: the repo uses vitest, not jest. Add this to CLAUDE.md.'
    );
    const d = decideNudge(
      db,
      input({ session_id: 'conv-1', prompt: 'add coverage for the parser with vitest' })
    );
    expect(d.pattern).toBe('missing_convention');
    expect(d.message).toMatch(/^Note: this project's past sessions show rework when /);
    expect(d.message).toContain('vitest');
    expect(d.message).toContain('is unstated');
    expect(d.message).toContain('a single clarifying question is warranted');
    expect(nudgeRows()[0].pattern).toBe('missing_convention');
  });

  it('does not fire missing_convention without keyword overlap', () => {
    seedConventionFinding(
      'past-2',
      'Specify the testing framework: the repo uses vitest, not jest.'
    );
    const d = decideNudge(
      db,
      input({ session_id: 'conv-2', prompt: 'tweak the colour palette on the landing hero' })
    );
    expect(d.message).toBeNull();
    expect(d.suppressReason).toBe('no_match');
  });

  it('does not fire missing_convention for a different project (cwd mismatch)', () => {
    seedConventionFinding(
      'past-3',
      'Specify the testing framework: the repo uses vitest, not jest.'
    );
    const d = decideNudge(
      db,
      input({
        session_id: 'conv-3',
        cwd: '/some/other/project',
        prompt: 'add coverage for the parser with vitest',
      })
    );
    expect(d.message).toBeNull();
    expect(d.suppressReason).toBe('no_match');
  });

  it('logs no_match (message null, fired=0) for a well-scoped prompt', () => {
    const d = decideNudge(
      db,
      input({
        prompt:
          'Refactor src/analyzer/parser.ts to split JSONL reading into its own module; keep the public API unchanged.',
      })
    );
    expect(d.message).toBeNull();
    expect(d.suppressReason).toBe('no_match');
    const rows = nudgeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].fired).toBe(0);
    expect(rows[0].pattern).toBe('no_match');
  });

  it('does not treat a vague phrase as vague when a path or extension is present', () => {
    const withPath = decideNudge(db, input({ prompt: 'fix it in src/cli.ts' }));
    expect(withPath.suppressReason).toBe('no_match');
    const withExt = decideNudge(
      db,
      input({ session_id: 's-ext', prompt: 'fix it inside cli.ts' })
    );
    expect(withExt.suppressReason).toBe('no_match');
  });

  it('logs nothing for an empty or missing prompt', () => {
    for (const prompt of [undefined, '', '   \n']) {
      const d = decideNudge(db, input({ session_id: 'empty', prompt }));
      expect(d.message).toBeNull();
      expect(d.pattern).toBe('none');
      expect(d.suppressReason).toBe('no_prompt');
    }
    expect(nudgeRows()).toHaveLength(0);
  });

  it('never throws on weird input shapes', () => {
    const weird: unknown[] = [
      null,
      undefined,
      {},
      'just a string',
      42,
      { prompt: 123 },
      { prompt: {} },
      { prompt: ['fix it'] },
      { prompt: 'fix it', session_id: 42, cwd: { nested: true } },
      { prompt: ' �', session_id: null },
    ];
    for (const w of weird) {
      expect(() => decideNudge(db, w as HookInput)).not.toThrow();
    }
  });

  it('coerces non-string session_id/cwd instead of crashing, and still decides', () => {
    const d = decideNudge(db, { prompt: 'fix it', session_id: 42, cwd: {} } as unknown as HookInput);
    expect(d.pattern).toBe('vague_opening');
    const rows = nudgeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('');
    expect(rows[0].project).toBe('');
  });
});
