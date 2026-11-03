import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = fileURLToPath(new URL('./fixtures/codex', import.meta.url));
process.env.UNHARNESS_HOME = mkdtempSync(path.join(tmpdir(), 'unharness-codex-'));
process.env.UNHARNESS_CODEX_DIR = FIX;

const { codex } = await import('../src/adapters/codex.ts');
const { openDb, saveBundle, tx } = await import('../src/db.ts');
type RunBundle = import('../src/types.ts').RunBundle;

const CANARY = 'CANARY_7f3a9';
const A = 'codex:11111111-1111-7111-8111-111111111111';
const P = 'codex:22222222-2222-7222-8222-222222222222';
const K = 'codex:33333333-3333-7333-8333-333333333333';
const G = 'codex:44444444-4444-7444-8444-444444444444';
const R = 'codex:55555555-5555-7555-8555-555555555555';
const L = 'codex:66666666-6666-4666-8666-666666666666';

async function all(): Promise<RunBundle[]> {
  const out: RunBundle[] = [];
  for await (const src of codex.discover!()) out.push(...(await codex.parse!(src)));
  return out;
}
const bundles = await all();
const by = (id: string) => bundles.find((b) => b.run.id === id)!;
const sum = (b: RunBundle, k: 'input' | 'output' | 'cache_read' | 'cache_write_5m' | 'reasoning') => b.requests.reduce((a, r) => a + r[k], 0);

test('fixtures carry the canary', () => {
  const files = readdirSync(FIX, { recursive: true }).filter((f) => String(f).endsWith('.jsonl'));
  assert.equal(files.length, 6);
  for (const f of files) assert.ok(readFileSync(path.join(FIX, String(f)), 'utf8').includes(CANARY), String(f));
});

test('discover + parse: one run per file, resume split into two', () => {
  assert.deepEqual(bundles.map((b) => b.run.id).sort(), [A, P, K, G, R, `${R}#1`, L].sort());
});

test('classic: token normalization skips info:null, duplicates, compaction estimate; reset counted', () => {
  const b = by(A);
  // R0 10000/8000/200/100, dup, R1 12000/10000/300/50, R2 13000/12000/150/0, estimate, R3 reset 4800/1000/200/0, R4 4800/4000/100/20
  assert.equal(b.requests.length, 5);
  assert.equal(sum(b, 'input'), 2000 + 2000 + 1000 + 3800 + 800);
  assert.equal(sum(b, 'cache_read'), 8000 + 10000 + 12000 + 1000 + 4000);
  assert.equal(sum(b, 'output'), 200 + 300 + 150 + 200 + 100);
  assert.equal(sum(b, 'reasoning'), 100 + 50 + 20);
  assert.equal(sum(b, 'cache_write_5m'), 0);
  assert.ok(b.requests.every((r) => r.model === 'gpt-5.5' && r.provider === 'openai'));
  assert.equal(b.run.harness_version, '0.131.0-alpha.9');
  assert.equal(b.run.repo, 'unharness-fixture'); // from git URL, credentials stripped
  assert.equal(b.run.branch, 'feat/x');
  assert.equal(b.run.started_at, '2026-08-01T10:00:00.000Z');
  assert.equal(b.run.ended_at, '2026-08-01T10:00:56.001Z');
});

test('classic: tools, statuses, MCP normalization, dedupe of item twins', () => {
  const b = by(A);
  assert.deepEqual(b.toolCalls.map((t) => [t.tool_name, t.tool_kind, t.status]), [
    ['exec_command', 'bash', 'error'],
    ['apply_patch', 'edit', 'ok'], // FileChange twin not counted again
    ['shell_command', 'bash', 'error'],
    ['web_search', 'web', 'ok'], // WebSearch item twin not counted again
    ['exec_command', 'bash', 'ok'],
    ['exec_command', 'bash', 'ok'], // "Process running" resolved by write_stdin
    ['write_stdin', 'bash', 'ok'],
    ['exec_command', 'bash', 'denied'],
    ['mcp__serena__find_symbol', 'mcp', 'ok'],
    ['mcp__linear__get_issue', 'mcp', 'error'], // namespace form; McpToolCall twin not counted again
  ]);
  assert.equal(b.toolCalls[9].mcp_server, 'linear');
  assert.deepEqual(b.toolCalls.map((t) => t.request_seq), [0, 1, 2, 2, 3, 3, 3, 3, 4, 4]);
  assert.equal(b.toolCalls[0].duration_ms, 1500); // Wall time
  assert.equal(b.toolCalls[5].exit_code, 0);
  assert.equal(b.toolCalls[5].duration_ms, 16000); // until write_stdin saw the exit
  assert.deepEqual(b.compactions, [{ at_request_seq: 3, trigger: 'auto', tokens_before: 13000, tokens_after: 4800 }]);
  assert.deepEqual(b.skills, [
    { skill_name: 'pdf', source: 'user', tokens_loaded: null },
    { skill_name: 'review', source: 'project', tokens_loaded: null },
  ]);
  assert.deepEqual(b.files, [
    { path: 'src/a.ts', op: 'edit', count: 1 },
    { path: 'src/b.ts', op: 'write', count: 1 },
    { path: '<outside-repo>', op: 'edit', count: 1 },
  ]);
});

test('code mode: token_usage_record not double counted, nested calls, subagent link', async () => {
  const b = by(P);
  assert.deepEqual(b.requests.map((r) => [r.input, r.cache_read, r.cache_write_5m, r.output, r.reasoning]), [
    [1000, 5000, 14000, 300, 120],
    [100, 20000, 900, 100, 30],
  ]);
  assert.deepEqual(b.toolCalls.map((t) => [t.tool_name, t.status]), [
    ['exec', 'ok'], ['exec_command', 'error'], ['apply_patch', 'ok'], ['mcp__argent__describe', 'ok'],
    ['exec', 'error'], ['exec_command', 'ok'], ['exec_command', 'ok'], ['spawn_agent', 'ok'],
  ]);
  assert.equal(b.toolCalls[3].duration_ms, 1250);
  assert.deepEqual(b.files, [{ path: 'a.ts', op: 'edit', count: 1 }]);
  assert.deepEqual(b.subagents, [{ child_run_id: K, agent_type: 'subagent', status: 'ok' }]);
  assert.deepEqual(b.compactions, [{ at_request_seq: 2, trigger: 'auto', tokens_before: 21000, tokens_after: null }]);
  // one printed exit code for one nested exec -> known; two nested execs, nothing printed -> unknown (passed NULL)
  const { deriveChecks } = await import('../src/checks.ts');
  assert.deepEqual(deriveChecks(b.toolCalls, null, null).map((c) => [c.check_class, c.exit_code, c.passed]), [['test:test', 1, false], ['lint:lint', null, null]]);
});

test('forked child: replayed parent history skipped for tokens and tools', () => {
  const b = by(K);
  assert.equal(b.run.parent_run_id, P);
  assert.deepEqual(b.requests.map((r) => [r.input, r.cache_read, r.cache_write_5m, r.output]), [[4000, 20000, 1000, 200]]);
  assert.deepEqual(b.toolCalls.map((t) => t.tool_name), ['exec_command']);
  assert.equal(b.run.started_at, '2026-10-26T12:00:05.610Z');
});

test('guardian child links to parent; resume split; legacy file', () => {
  assert.equal(by(G).run.parent_run_id, P);
  assert.equal(by(G).requests.length, 1);

  assert.equal(by(R).requests.length, 1);
  const r1 = by(`${R}#1`);
  assert.equal(r1.run.resumed_from_run_id, R);
  assert.deepEqual(r1.requests.map((r) => [r.input, r.cache_read, r.output]), [[1500, 1000, 50]]); // duplicate total skipped, truncated line ignored

  const l = by(L);
  assert.equal(l.requests.length, 0);
  assert.equal(l.run.repo, 'legacy-repo');
  assert.equal(l.run.branch, 'legacy-branch');
  assert.deepEqual(l.toolCalls.map((t) => [t.tool_name, t.status, t.exit_code, t.duration_ms]), [['shell', 'error', 1, 2500], ['apply_patch', 'ok', undefined, 0]]);
});

const dump = (db: ReturnType<typeof openDb>) => {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
};

test('end-to-end: saveBundle derives failing then passing check, no canary anywhere, idempotent', async () => {
  const db = openDb(':memory:');
  const save = (bs: RunBundle[]) => { for (const b of bs) tx(db, () => saveBundle(db, b)); };
  save(bundles);
  const first = dump(db);
  assert.ok(!JSON.stringify(first).includes(CANARY), 'canary leaked into the DB');
  const checks = db.prepare('SELECT check_class, passed FROM check_run WHERE run_id = ? ORDER BY seq').all(A) as any[];
  assert.deepEqual(checks.map((c) => [c.check_class, c.passed]), [['test:vitest', 0], ['test:vitest', 1], ['typecheck:tsc', 1]]);

  save(await all());
  const second = dump(db);
  for (const t of Object.keys(first)) assert.equal(second[t].length, first[t].length, `row count changed in ${t}`);
});

test('fingerprint: MCP servers by name, secrets ignored, nothing secret in names', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'codex-home-'));
  mkdirSync(path.join(home, 'skills', 'pdf'), { recursive: true });
  writeFileSync(path.join(home, 'skills', 'pdf', 'SKILL.md'), 'x');
  writeFileSync(path.join(home, 'AGENTS.md'), CANARY);
  const config = (token: string, url: string) => `model = "gpt-5.5"
developer_instructions = """
${CANARY}
[not_a_section]
"""
[features]
multi_agent = true

[mcp_servers.linear]
url = "${url}"
bearer_token_env_var = "${token}"

[mcp_servers.linear.env]
API_KEY = "${token}"

[mcp_servers."argent"]
command = "npx"
`;
  process.env.UNHARNESS_CODEX_DIR = home;
  try {
    writeFileSync(path.join(home, 'config.toml'), config(CANARY, 'https://a'));
    const fp1 = await codex.fingerprint({ cwd: null, model: 'gpt-5.5', harness_version: '0.164.0' });
    writeFileSync(path.join(home, 'config.toml'), config('other-secret', 'https://a'));
    const fp2 = await codex.fingerprint({ cwd: null, model: 'gpt-5.5', harness_version: '0.164.0' });
    writeFileSync(path.join(home, 'config.toml'), config(CANARY, 'https://b'));
    const fp3 = await codex.fingerprint({ cwd: null, model: 'gpt-5.5', harness_version: '0.164.0' });
    const names = fp1.components.map((c) => `${c.kind}/${c.name}`);
    for (const n of ['mcp/linear', 'mcp/argent', 'skill/user:pdf', 'instructions/user:AGENTS.md', 'instructions/config:developer_instructions', 'settings/config.toml', 'model/model', 'harness/codex'])
      assert.ok(names.includes(n), n);
    assert.ok(!names.some((n) => n.includes('not_a_section')));
    assert.ok(!JSON.stringify(fp1).includes(CANARY));
    assert.equal(fp1.id, fp2.id, 'secret change must not change the fingerprint');
    assert.notEqual(fp1.id, fp3.id, 'MCP url change must change the fingerprint');
  } finally {
    process.env.UNHARNESS_CODEX_DIR = FIX;
  }
});
