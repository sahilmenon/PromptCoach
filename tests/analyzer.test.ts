import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, metaGetJson, type DB } from '../src/db';
import { ingestTranscripts } from '../src/analyzer/parser';
import { recordBaselineIfReady, runHeuristics } from '../src/analyzer/heuristics';

let dir: string;
let db: DB;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenlean-analyzer-'));
  db = openDb(path.join(dir, 'db.sqlite'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('real transcript compatibility', () => {
  it('creates a parent session before turns and skips unknown records', () => {
    const project = path.join(dir, 'projects', 'demo');
    fs.mkdirSync(project, { recursive: true });
    const records = [
      { type: 'attachment', timestamp: '2026-07-01T00:00:00Z' },
      { type: 'user', cwd: '/tmp/demo', timestamp: '2026-07-01T00:00:01Z',
        message: { role: 'user', content: 'Actually, use Vitest for this parser.' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-07-01T00:00:02Z',
        message: { id: 'm1', role: 'assistant', model: 'claude-test', content: [
          { type: 'text', text: 'Understood.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/demo/a.ts' } }
        ], usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4 } } }
    ];
    fs.writeFileSync(path.join(project, 'session-1.jsonl'), records.map(x => JSON.stringify(x)).join('\n') + '\n');
    const result = ingestTranscripts(db, dir);
    expect(result.sessionsUpserted).toBe(1);
    expect(result.turnsAdded).toBe(2);
    expect(result.unknownRecordTypes).toBe(1);
  });
});

describe('heuristics and baseline', () => {
  it('flags key patterns idempotently', () => {
    db.prepare("INSERT INTO sessions (id,project,started_at,ended_at,turn_count) VALUES ('s','/p',1,2,2)").run();
    const fence = String.fromCharCode(96).repeat(3);
    db.prepare("INSERT INTO turns (session_id,idx,role,char_len,text_head,has_fence) VALUES ('s',0,'user',9001,?,1)")
      .run('Actually, use the file path.\n' + fence + '\n' + 'x'.repeat(8100));
    db.prepare("INSERT INTO turns (session_id,idx,role,char_len) VALUES ('s',1,'assistant',2)").run();
    const id = (db.prepare("SELECT id FROM turns WHERE role='assistant'").get() as { id: number }).id;
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO tool_calls (turn_id,tool,target) VALUES (?,'Read','/p/a.ts')").run(id);
    expect(runHeuristics(db).findingsAdded).toBe(4);
    expect(runHeuristics(db).findingsAdded).toBe(4);
    expect((db.prepare("SELECT COUNT(*) AS n FROM findings WHERE source='heuristic'").get() as { n: number }).n).toBe(4);
  });

  it('records a first-week baseline only once', () => {
    const day = 86_400_000, start = Date.now() - 8 * day;
    for (let i = 0; i < 2; i++) {
      db.prepare('INSERT INTO sessions (id,project,started_at,ended_at,turn_count) VALUES (?,?,?,?,1)')
        .run('s' + i, '/p', start + i * 7 * day, start + i * 7 * day + 1);
      db.prepare("INSERT INTO turns (session_id,idx,role,char_len,input_tokens,output_tokens) VALUES (?,0,'assistant',1,100,50)").run('s' + i);
    }
    expect(recordBaselineIfReady(db)).toBe(true);
    expect(recordBaselineIfReady(db)).toBe(false);
    expect(metaGetJson<{ sessions: number }>(db, 'baseline')?.sessions).toBe(1);
  });
});
