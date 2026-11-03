import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunBundle } from '../src/types.ts';

// Fixture cwd is a deliberately nonexistent path: repoInfo falls back to root = cwd, name = basename ('demo-repo').
const dir = path.join(import.meta.dirname, 'fixtures', 'claude-code');
process.env.UNHARNESS_CLAUDE_DIR = dir;
process.env.UNHARNESS_HOME = mkdtempSync(path.join(tmpdir(), 'unharness-cc-')); // bundled pricing snapshot, no user rules
process.env.UNHARNESS_USER = 'tester';

const { claudeCode } = await import('../src/adapters/claude-code.ts');
const { openDb, saveBundle, tx } = await import('../src/db.ts');

const SID = '00000000-0000-4000-8000-000000000003';
const MAIN = `cc:${SID}`, RESUMED = `cc:${SID}#1`, EXPLORE = `cc:${SID}:a000000000000002a`, FORK = `cc:${SID}:a00000000000000fb`;
const CANARY = 'CANARY_7f3a9';

async function load(): Promise<RunBundle[]> {
  const out: RunBundle[] = [];
  for await (const src of claudeCode.discover!()) out.push(...(await claudeCode.parse!(src)));
  return out;
}
const bundles = await load();
const byId = (id: string) => bundles.find((b) => b.run.id === id)!;
const sum = (b: RunBundle, k: 'input' | 'output' | 'cache_read' | 'cache_write_5m' | 'cache_write_1h' | 'reasoning') => b.requests.reduce((s, r) => s + r[k], 0);

test('discover: one source per session group, size = sum, mtime = max', async () => {
  const srcs = [];
  for await (const s of claudeCode.discover!()) srcs.push(s);
  assert.equal(srcs.length, 1);
  const proj = path.join(dir, 'projects', '-nonexistent-unharness-fixture-demo-repo');
  const files = [`${SID}.jsonl`, `${SID}/subagents/agent-a000000000000002a.jsonl`, `${SID}/subagents/agent-a00000000000000fb.jsonl`].map((f) => statSync(path.join(proj, f)));
  assert.equal(srcs[0].size, files.reduce((s, f) => s + f.size, 0));
  assert.equal(srcs[0].mtime_ms, Math.max(...files.map((f) => f.mtimeMs)));
});

test('parse: runs, resume split, truncated last line tolerated', () => {
  assert.deepEqual(bundles.map((b) => b.run.id).sort(), [MAIN, RESUMED, EXPLORE, FORK].sort());
  const r = byId(RESUMED).run;
  assert.equal(r.resumed_from_run_id, MAIN); // two SessionStart:resume hooks in a row = one boundary
  assert.equal(r.harness_version, '2.1.310');
  assert.equal(byId(MAIN).run.harness_version, '2.1.304');
  assert.equal(byId(MAIN).run.repo, 'demo-repo');
  assert.equal(byId(MAIN).run.branch, 'main');
  assert.equal(byId(MAIN).run.started_at, '2026-10-20T11:15:13.957Z');
  assert.equal(byId(MAIN).run.ended_at, '2026-10-20T15:30:00.000Z');
  assert.ok(bundles.every((b) => b.requests.every((q) => q.model !== '<synthetic>')));
});

test('requests: deduped by message.id, partial usage lines ignored, fork replay counted once', () => {
  const m = byId(MAIN);
  assert.equal(m.requests.length, 13);
  assert.deepEqual(m.requests.map((q) => q.seq), [...Array(13).keys()]);
  // msg_0008 spans 2 lines (partial output 300, final 669): counted once with 669
  assert.equal(m.requests[0].output, 669);
  assert.equal(m.requests[0].reasoning, 357);
  assert.equal(sum(m, 'output'), 669 + 122 + 50 + 966 + 40 + 1366 + 5476 + 300 + 60 + 70 + 80 + 90 + 100);
  assert.equal(sum(m, 'cache_write_1h'), 59039 + 450 + 13040 + 1320 + 6595 + 29000);
  assert.equal(sum(m, 'cache_write_5m'), 100 + 200);
  assert.equal(sum(m, 'reasoning'), 357 + 204 + 114 + 846);
  assert.equal(sum(m, 'input'), 12 * 2 + 5);
  // fork replays parent's msg_0045 line: only the parent owns it (request and its Agent tool_use)
  const f = byId(FORK);
  assert.equal(f.requests.length, 2);
  assert.equal(sum(f, 'output'), 70);
  assert.deepEqual(f.toolCalls.map((t) => t.tool_name), ['Read']);
  assert.equal(f.run.started_at, '2026-10-20T11:18:31.500Z'); // replayed line's timestamp not used
  assert.equal(bundles.reduce((s, b) => s + b.requests.length, 0), 19); // distinct non-synthetic message ids
  assert.equal(sum(byId(EXPLORE), 'cache_write_5m'), 42772 + 1005); // no cache_creation fallback needed
});

test('tool calls: status, kinds, mcp server, bash exit code, request link', () => {
  const t = byId(MAIN).toolCalls;
  assert.deepEqual(t.map((x) => [x.tool_name, x.status]), [
    ['Bash', 'error'], ['Read', 'ok'], ['Read', 'ok'], ['Edit', 'ok'], ['Grep', 'ok'], ['Skill', 'ok'],
    ['Agent', 'ok'], ['Agent', 'ok'], ['mcp__claude_ai_Linear__get_issue', 'ok'], ['Bash', 'denied'], ['Agent', 'ok'],
  ]);
  assert.equal(t[0].exit_code, 1);
  assert.equal(t[0].duration_ms, 4000);
  assert.equal(t[9].exit_code, null);
  assert.equal(t[8].mcp_server, 'claude_ai_Linear');
  assert.equal(t[8].tool_kind, 'mcp');
  assert.equal(t[6].tool_kind, 'task');
  assert.deepEqual(t.map((x) => x.request_seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const r = byId(RESUMED).toolCalls;
  assert.deepEqual(r.map((x) => [x.tool_name, x.status, x.exit_code ?? null]), [['Bash', 'ok', 0], ['Glob', 'error', null]]); // no result -> error
});

test('subagents: spawn links, missing child, parent ids', () => {
  assert.deepEqual(byId(MAIN).subagents, [
    { child_run_id: EXPLORE, agent_type: 'Explore', status: 'ok' },
    { child_run_id: null, agent_type: 'general-purpose', status: 'ok' },
    { child_run_id: FORK, agent_type: 'fork', status: 'ok' },
  ]);
  assert.equal(byId(EXPLORE).run.parent_run_id, MAIN);
  assert.equal(byId(FORK).run.parent_run_id, MAIN);
  assert.equal(byId(MAIN).run.parent_run_id, null);
});

test('skills, compaction, files', () => {
  const [s] = byId(MAIN).skills;
  assert.equal(s.skill_name, 'demo-skill');
  assert.equal(s.source, 'user'); // fixtures/claude-code/skills/demo-skill exists
  assert.ok(s.tokens_loaded! > 100);
  assert.deepEqual(byId(RESUMED).skills.map((x) => [x.skill_name, x.source]), [['demo-skill', 'user']]); // slash command
  assert.deepEqual(byId(MAIN).compactions, [{ at_request_seq: 12, trigger: 'manual', tokens_before: 639799, tokens_after: 29005 }]);
  assert.deepEqual(byId(MAIN).files.map((f) => `${f.op}:${f.path}`), ['read:<outside-repo>', 'read:src/app.ts', 'edit:src/app.ts', 'search:src']);
  assert.deepEqual(byId(RESUMED).files.map((f) => `${f.op}:${f.path}`), ['search:src']);
});

test('fingerprint: names only, user skill + model + harness', async () => {
  const fp = await claudeCode.fingerprint({ cwd: byId(MAIN).cwd, model: 'claude-opus-5-5', harness_version: '2.1.304' });
  const names = fp.components.map((c) => `${c.kind}/${c.name}`);
  for (const n of ['skill/user:demo-skill', 'model/model', 'harness/claude-code']) assert.ok(names.includes(n), n);
  assert.ok(!JSON.stringify(fp).includes(CANARY));
});

const counts = (db: ReturnType<typeof openDb>) => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n]));
};

test('end-to-end: checks derived, canary never stored, reimport idempotent', async () => {
  const db = openDb(':memory:');
  const save = (bs: RunBundle[]) => bs.forEach((b) => tx(db, () => saveBundle(db, b, null)));
  save(await load());
  const checks = db.prepare('SELECT run_id, check_class, exit_code, passed FROM check_run ORDER BY run_id').all();
  assert.deepEqual(checks.map((c) => ({ ...c })), [
    { run_id: MAIN, check_class: 'test:jest', exit_code: 1, passed: 0 },
    { run_id: RESUMED, check_class: 'test:jest', exit_code: 0, passed: 1 },
  ]);
  assert.equal((db.prepare('SELECT count(*) n FROM request WHERE cost_usd IS NOT NULL').get() as { n: number }).n > 0, true);
  for (const t of Object.keys(counts(db))) {
    const dump = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());
    assert.ok(!dump.includes(CANARY), `canary in ${t}`);
    assert.ok(!dump.includes('/nonexistent/') && !dump.includes('/Users/'), `absolute path in ${t}`);
  }
  const before = counts(db);
  save(await load());
  assert.deepEqual(counts(db), before);
});

test('resume without SessionStart hooks: transcript after cost-state starts a new run', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { claudeCode } = await import('../src/adapters/claude-code.ts');
  const sid = '11111111-2222-4333-8444-555555555555';
  const dir = mkdtempSync(path.join(tmpdir(), 'unharness-cc-resume-'));
  const env = { sessionId: sid, cwd: '/nonexistent/unharness-fixture/demo-repo', version: '2.1.314', isSidechain: false };
  const asst = (n: number, ts: string) => ({ ...env, type: 'assistant', uuid: `a${n}`, parentUuid: `u${n}`, timestamp: ts,
    message: { id: `msg_${n}`, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'CANARY_7f3a9' }], usage: { input_tokens: 10, output_tokens: 5 } } });
  const user = (n: number, ts: string) => ({ ...env, type: 'user', uuid: `u${n}`, parentUuid: null, timestamp: ts, message: { role: 'user', content: 'CANARY_7f3a9' } });
  const lines = [user(1, '2026-10-30T10:00:00Z'), asst(1, '2026-10-30T10:00:01Z'), { type: 'cost-state', sessionId: sid }, { type: 'cost-state', sessionId: sid },
    user(2, '2026-10-30T11:00:00Z'), asst(2, '2026-10-30T11:00:01Z'), { type: 'cost-state', sessionId: sid }];
  const file = path.join(dir, 'p', `${sid}.jsonl`);
  mkdirSync(path.dirname(file));
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const st = statSync(file);
  const runs = await claudeCode.parse!({ path: file, size: st.size, mtime_ms: st.mtimeMs });
  assert.deepEqual(runs.map((b) => [b.run.id, b.run.resumed_from_run_id, b.requests.length]), [[`cc:${sid}`, null, 1], [`cc:${sid}#1`, `cc:${sid}`, 1]]);
});
