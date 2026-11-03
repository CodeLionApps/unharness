// Cross-adapter privacy contract: import every fixture of every adapter into one on-disk DB and assert the
// canary never lands anywhere (rows, DB file, WAL). Also pins the set of TEXT columns: adding one is a
// deliberate decision that must be reviewed against the "metadata only" rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fixtures = path.join(import.meta.dirname, 'fixtures');
const tmp = mkdtempSync(path.join(tmpdir(), 'unharness-privacy-'));
process.env.UNHARNESS_HOME = tmp;
process.env.UNHARNESS_CLAUDE_DIR = path.join(fixtures, 'claude-code');
process.env.UNHARNESS_CODEX_DIR = path.join(fixtures, 'codex', 'sessions');

const CANARY = 'CANARY_7f3a9';

const { openDb, saveBundle, tx } = await import('../src/db.ts');
const { claudeCode } = await import('../src/adapters/claude-code.ts');
const { codex } = await import('../src/adapters/codex.ts');
const { ingest, decodeOtlp } = await import('../src/collector.ts');

// Every TEXT column that may hold a string. Values must be ids, names, enums, versions, timestamps,
// hashes, repo-relative paths or JSON of those — never content.
const TEXT_ALLOWLIST = new Set([
  'run.id', 'run.harness', 'run.harness_version', 'run.user', 'run.machine_id', 'run.repo', 'run.branch',
  'run.started_at', 'run.ended_at', 'run.setup_fingerprint_id', 'run.parent_run_id', 'run.resumed_from_run_id', 'run.outcome',
  'run_tag.run_id', 'run_tag.tag',
  'request.run_id', 'request.ts', 'request.model', 'request.provider', 'request.token_breakdown', 'request.pricing_version',
  'tool_call.run_id', 'tool_call.tool_name', 'tool_call.tool_kind', 'tool_call.mcp_server', 'tool_call.status',
  'skill_invocation.run_id', 'skill_invocation.skill_name', 'skill_invocation.source',
  'subagent_spawn.run_id', 'subagent_spawn.child_run_id', 'subagent_spawn.agent_type', 'subagent_spawn.status',
  'compaction.run_id', 'compaction.trigger',
  'file_access.run_id', 'file_access.path', 'file_access.op',
  'check_run.run_id', 'check_run.check_class', 'check_run.runner',
  'setup_fingerprint.id', 'setup_fingerprint.created_at',
  'setup_component.fingerprint_id', 'setup_component.kind', 'setup_component.name', 'setup_component.hash', 'setup_component.content_ref',
  'source_file.path_hash', 'source_file.adapter', 'source_file.imported_at',
  'otel_span.span_id', 'otel_span.trace_id', 'otel_span.parent_span_id', 'otel_span.session_id', 'otel_span.name',
  'otel_span.start_ns', 'otel_span.end_ns', 'otel_span.attrs', 'otel_span.received_at',
]);

async function importAll(db: ReturnType<typeof openDb>) {
  for (const a of [claudeCode, codex]) {
    for await (const src of a.discover!()) {
      for (const b of await a.parse!(src)) tx(db, () => saveBundle(db, b, null));
    }
  }
  const eveFile = path.join(fixtures, 'eve', 'spans.json');
  if (existsSync(eveFile)) await ingest(db, decodeOtlp(JSON.parse(readFileSync(eveFile, 'utf8'))));
}

test('every TEXT column is allowlisted', () => {
  const db = openDb(path.join(tmp, 'schema.sqlite'));
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  const textCols = tables.flatMap((t) =>
    (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string }[])
      .filter((c) => c.type === 'TEXT' || c.type === '').map((c) => `${t}.${c.name}`));
  assert.deepEqual(textCols.filter((c) => !TEXT_ALLOWLIST.has(c)), []);
});

test('canary from any fixture never reaches the database', async () => {
  const file = path.join(tmp, 'db.sqlite');
  const db = openDb(file);
  await importAll(db);
  const runs = (db.prepare('SELECT count(*) n FROM run').get() as { n: number }).n;
  assert.ok(runs >= 3, `expected runs from all adapters, got ${runs}`);

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  for (const t of tables) {
    const dump = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());
    assert.ok(!dump.includes(CANARY), `canary found in table ${t}`);
    assert.ok(!/\/Users\/|\/home\//.test(dump) || t === 'otel_span', `absolute home path found in table ${t}`);
  }
  // bytes on disk, before and after checkpoint (WAL may hold pages not yet in the main file)
  for (const f of readdirSync(tmp).filter((f) => f.startsWith('db.sqlite'))) {
    assert.ok(!readFileSync(path.join(tmp, f)).includes(CANARY), `canary in ${f}`);
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(!readFileSync(file).includes(CANARY), 'canary in db file after checkpoint');
});

test('reimport is idempotent and keeps manual tags', async () => {
  const db = openDb(path.join(tmp, 'idem.sqlite'));
  await importAll(db);
  const counts = () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    return Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n]));
  };
  const someRun = (db.prepare('SELECT id FROM run LIMIT 1').get() as { id: string }).id;
  db.prepare('INSERT INTO run_tag VALUES (?, ?)').run(someRun, 'exp:keep');
  const before = counts();
  await importAll(db);
  assert.deepEqual(counts(), before);
  assert.ok(db.prepare('SELECT 1 FROM run_tag WHERE run_id = ? AND tag = ?').get(someRun, 'exp:keep'));
});
