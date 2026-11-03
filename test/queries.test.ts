import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, saveBundle, tx } from '../src/db.ts';
import { allRuns, report, runDetail } from '../src/queries.ts';
import type { RunBundle } from '../src/types.ts';

process.env.UNHARNESS_HOME = '/nonexistent-unharness-home';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const bundle = (id: string, model: string, endedAgoH: number, extra: Partial<RunBundle> = {}, parent: string | null = null): RunBundle => {
  const ended = new Date(NOW - endedAgoH * 3.6e6).toISOString();
  return {
    run: {
      id, harness: 'claude-code', harness_version: null, user: 'u', machine_id: 'm', repo: 'r', branch: null,
      started_at: ended, ended_at: ended, setup_fingerprint_id: null, parent_run_id: parent, resumed_from_run_id: null,
      outcome: null, active_ms: null, tool_ms: null,
    },
    requests: [{ seq: 0, ts: ended, model, provider: 'anthropic', input: 1e6, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, reasoning: 0, duration_ms: null }],
    toolCalls: [], skills: [], subagents: [], compactions: [], files: [], checks: [], cwd: null, ...extra,
  };
};

test('subagent rollup, by-model split, full daily series, re-reads, orphans', () => {
  const db = openDb(':memory:');
  tx(db, () => {
    saveBundle(db, bundle('p', 'claude-opus-4-6', 1, {
      subagents: [{ child_run_id: 'p:c', agent_type: 'Explore', status: 'ok' }],
      files: [{ path: '<outside-repo>', op: 'read', count: 5 }, { path: 'a.ts', op: 'read', count: 3 }],
    }));
    saveBundle(db, bundle('p:c', 'claude-sonnet-4-5', 1, {}, 'p'));
    saveBundle(db, bundle('orphan', 'claude-sonnet-4-5', 2, {}, 'gone-parent'));
    saveBundle(db, bundle('early', 'claude-sonnet-4-5', 23.5)); // inside 1d window, previous calendar day
  });
  const p = allRuns(db).find((r) => r.id === 'p')!;
  assert.equal(p.total.tokens, 2e6);
  assert.ok(Math.abs(p.cost_total - (5 + 3)) < 1e-9); // opus 4.6 $5/Mtok + sonnet child $3/Mtok
  assert.equal(p.rereads, 2); // outside-repo reads excluded
  assert.equal(p.files_read, 1);

  const r = report(db, 8.64e7, {}, NOW);
  assert.equal(r.current.runs, 3); // p, orphan (parent missing -> root), early
  assert.equal(r.current.tokens, 4e6);
  assert.deepEqual(r.byModel.map((m) => [m.key, m.runs, m.tokens]), [['claude-sonnet-4-5', 3, 3e6], ['claude-opus-4-6', 1, 1e6]]);
  assert.equal(r.daily.reduce((s, d) => s + d.runs, 0), 3);
  assert.equal(runDetail(db, 'p').subagents[0].run?.id, 'p:c');
});

test('reimport keeps the price a request was imported with', () => {
  const db = openDb(':memory:');
  tx(db, () => saveBundle(db, bundle('x', 'claude-sonnet-4-5', 1)));
  db.prepare("UPDATE request SET cost_usd = 99, pricing_version = 'old' WHERE run_id = 'x'").run();
  const grown = bundle('x', 'claude-sonnet-4-5', 1);
  grown.requests.push({ ...grown.requests[0], seq: 1 });
  tx(db, () => saveBundle(db, grown));
  assert.deepEqual(db.prepare("SELECT cost_usd, pricing_version FROM request WHERE run_id = 'x' ORDER BY seq").all().map((r: any) => [r.cost_usd, r.pricing_version.slice(0, 7)]),
    [[99, 'old'], [3, 'litellm']]);
});
