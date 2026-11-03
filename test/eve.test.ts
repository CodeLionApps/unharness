import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { eve } from '../src/adapters/eve.ts';
import { decodeOtlp, ingest, startCollector } from '../src/collector.ts';

const raw = readFileSync(new URL('./fixtures/eve/spans.json', import.meta.url), 'utf8');
const payload = JSON.parse(raw);
const CANARY = 'CANARY_7f3a9';

test('fixture actually carries the canary', () => assert.ok(raw.includes(CANARY)));

test('eve: fromSpans maps tokens, tools, skills, subagent link', () => {
  const bundles = eve.fromSpans!(decodeOtlp(payload));
  const parent = bundles.find((b) => b.run.id === 'eve:sess_01JABCDEF')!;
  const child = bundles.find((b) => b.run.id === 'eve:sess_01JCHILD')!;
  assert.equal(bundles.length, 2);

  // only chat spans count; turn/step aggregates are ignored. input = total - cache_read - cache_write
  assert.equal(parent.requests.length, 2);
  const sum = (k: 'input' | 'output' | 'cache_read') => parent.requests.reduce((a, r) => a + r[k], 0);
  assert.deepEqual([sum('input'), sum('output'), sum('cache_read')], [1200 + (1400 - 1024), 290, 1024]);
  assert.equal(parent.requests[0].model, 'gpt-5.4-mini');
  assert.equal(parent.requests[0].provider, 'openai');
  assert.equal(parent.requests[0].duration_ms, 2000);
  assert.equal(parent.run.harness_version, '0.91.0');
  assert.equal(parent.run.started_at, '2026-10-31T00:00:00.000Z');
  assert.equal(parent.run.ended_at, '2026-10-31T00:00:06.500Z');

  const st = Object.fromEntries(parent.toolCalls.map((t) => [t.tool_name, t.status]));
  assert.deepEqual(st, { get_weather: 'ok', search_docs: 'error', 'pdf-extract': 'ok', researcher: 'ok' });
  assert.equal(parent.toolCalls.find((t) => t.tool_name === 'researcher')!.tool_kind, 'task');
  assert.equal(parent.toolCalls.find((t) => t.tool_name === 'search_docs')!.duration_ms, 1700);
  assert.deepEqual(parent.skills, [{ skill_name: 'pdf-extract', source: 'project', tokens_loaded: null }]);
  assert.deepEqual(parent.subagents, [{ child_run_id: 'eve:sess_01JCHILD', agent_type: 'researcher', status: 'ok' }]);

  assert.equal(child.run.parent_run_id, 'eve:sess_01JABCDEF');
  assert.deepEqual(
    [child.requests[0].input, child.requests[0].cache_read, child.requests[0].cache_write_5m, child.requests[0].output],
    [1000, 3000, 1000, 400],
  );
  assert.equal(child.requests[0].model, 'claude-sonnet-4-5');
  assert.equal(child.requests[0].provider, 'anthropic');
});

test('eve: raw AI SDK spans fallback', () => {
  const at = (ms: number) => String(BigInt(ms) * 1_000_000n);
  const base = { trace_id: 't1', parent_span_id: null, status_code: 0, resource: {} };
  const [b] = eve.fromSpans!([
    { ...base, span_id: 's1', name: 'ai.streamText', start_ns: at(0), end_ns: at(5000), attrs: { 'ai.usage.inputTokens': 999 } },
    { ...base, span_id: 's2', name: 'ai.streamText.doStream', start_ns: at(10), end_ns: at(900),
      attrs: { 'ai.model.id': 'gpt-5', 'ai.model.provider': 'openai.responses', 'ai.usage.inputTokens': 500, 'ai.usage.cachedInputTokens': 200, 'ai.usage.outputTokens': 50, 'ai.usage.reasoningTokens': 20 } },
    { ...base, span_id: 's3', name: 'ai.toolCall', start_ns: at(1000), end_ns: at(1200), status_code: 2, attrs: { 'ai.toolCall.name': 'bash' } },
  ]);
  assert.equal(b.run.id, 'eve:t1');
  assert.deepEqual(b.requests.map((r) => [r.provider, r.model, r.input, r.cache_read, r.output, r.reasoning]), [['openai', 'gpt-5', 300, 200, 50, 20]]);
  assert.deepEqual(b.toolCalls.map((t) => [t.tool_name, t.tool_kind, t.status]), [['bash', 'bash', 'error']]);
});

const dump = (db: ReturnType<typeof openDb>) => {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
};

test('collector: ingest keeps no content (canary) and is idempotent', async () => {
  const db = openDb(':memory:');
  await ingest(db, decodeOtlp(payload));
  const first = dump(db);
  assert.ok(!JSON.stringify(first).includes(CANARY), 'canary leaked into the DB');
  assert.equal(first.run.length, 2);
  assert.equal(first.otel_span.length, decodeOtlp(payload).length);
  const spawn = first.subagent_spawn as { child_run_id: string }[];
  assert.equal(spawn[0].child_run_id, 'eve:sess_01JCHILD');

  await ingest(db, decodeOtlp(payload));
  const second = dump(db);
  for (const t of Object.keys(first)) assert.equal(second[t].length, first[t].length, `row count changed in ${t}`);
});

test('collector: child spans arriving later still link the parent spawn', async () => {
  const db = openDb(':memory:');
  const spans = decodeOtlp(payload);
  const isChild = (s: (typeof spans)[number]) => s.attrs['agent.run.id'] === 'sess_01JCHILD';
  await ingest(db, spans.filter((s) => !isChild(s)));
  assert.equal((db.prepare('SELECT child_run_id FROM subagent_spawn').get() as any).child_run_id, null);
  await ingest(db, spans.filter(isChild));
  assert.equal((db.prepare('SELECT child_run_id FROM subagent_spawn').get() as any).child_run_id, 'eve:sess_01JCHILD');
});

test('collector: HTTP JSON 200, gzip 200, protobuf 415', async () => {
  const db = openDb(':memory:');
  const server = await startCollector(db, 0);
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
    const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {});
    const gz = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gzipSync(raw) });
    assert.equal(gz.status, 200);
    const pb = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: 'x' });
    assert.equal(pb.status, 415);
    assert.match((await pb.json()).error, /OTEL_EXPORTER_OTLP_PROTOCOL=http\/json/);
    assert.equal((db.prepare('SELECT count(*) n FROM run').get() as any).n, 2);
  } finally {
    server.close();
  }
});

// one eve chat span + extra spans in the same session, as an OTLP request body
const otlp = (...extra: object[]) => {
  const attr = (key: string, v: string | number) => ({ key, value: typeof v === 'number' ? { intValue: v } : { stringValue: v } });
  const chat = {
    traceId: 't9', spanId: 'c1', name: 'chat openai/gpt-5', startTimeUnixNano: '1793404800000000000', endTimeUnixNano: 1793404801000000000,
    attributes: [attr('agent.run.id', 'sess_X'), attr('gen_ai.operation.name', 'chat'), attr('gen_ai.request.model', 'openai/gpt-5'), attr('gen_ai.usage.input_tokens', 10)],
  };
  return { resourceSpans: [{ scopeSpans: [{ scope: { name: 'eve.agent' }, spans: [chat, ...extra.map((e) => ({ traceId: 't9', attributes: [attr('agent.run.id', 'sess_X')], ...e }))] }] }] };
};

test('collector: span names are allowlisted; non-eve spans (fetch URLs) never stored', async () => {
  const db = openDb(':memory:');
  const t = { startTimeUnixNano: '1793404800100000000', endTimeUnixNano: '1793404800200000000' };
  await ingest(db, decodeOtlp(otlp(
    { spanId: 'f1', name: `fetch GET https://api.example.com/v1/x?api_key=${CANARY}`, ...t },
    { spanId: 'x1', name: `execute_tool https://evil/${CANARY}?k=v`, ...t,
      attributes: [{ key: 'agent.run.id', value: { stringValue: 'sess_X' } }, { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } }] },
    { spanId: 'a1', name: 'ai.toolCall', ...t, attributes: [{ key: 'agent.run.id', value: { stringValue: 'sess_X' } }, { key: 'ai.toolCall.name', value: { stringValue: 'bash' } }] },
  )));
  assert.ok(!JSON.stringify(dump(db)).includes(CANARY), 'canary leaked into the DB');
  const names = Object.fromEntries((db.prepare('SELECT span_id, name FROM otel_span').all() as any[]).map((r) => [r.span_id, r.name]));
  assert.deepEqual(names, { c1: 'chat openai/gpt-5', x1: 'execute_tool', a1: 'ai.toolCall' });
  assert.equal((db.prepare('SELECT count(*) n FROM tool_call').get() as any).n, 2);
});

test('collector: malformed timestamp is skipped, session still saved', async () => {
  const skipped = { n: 0 };
  const spans = decodeOtlp(otlp(
    { spanId: 'bad', name: 'execute_tool bash', startTimeUnixNano: '1730000000123.5', endTimeUnixNano: '1730000000200000000' },
    { spanId: 'bad2', name: 'agent.step', startTimeUnixNano: 1.5 },
  ), skipped);
  assert.equal(skipped.n, 2);
  assert.deepEqual(spans.map((s) => [s.span_id, s.end_ns]), [['c1', '1793404801000000000']]);
  const db = openDb(':memory:');
  await ingest(db, spans);
  assert.equal((db.prepare('SELECT count(*) n FROM run').get() as any).n, 1);
});

test('collector: text/plain 415, Origin 403', async () => {
  const db = openDb(':memory:');
  const server = await startCollector(db, 0);
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
    const post = (headers: Record<string, string>) => fetch(url, { method: 'POST', headers, body: raw });
    assert.equal((await post({ 'content-type': 'text/plain; x=json' })).status, 415);
    assert.equal((await post({ 'content-type': 'application/jsonx' })).status, 415);
    assert.equal((await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ 'content-type': 'Application/JSON; charset=utf-8' })).status, 200);
    assert.equal((db.prepare('SELECT count(*) n FROM run').get() as any).n, 2);
  } finally {
    server.close();
  }
});
