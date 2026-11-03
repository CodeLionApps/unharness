import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { saveBundle, tx, type DB } from './db.ts';
import { eve, sessionKey } from './adapters/eve.ts';
import type { OtelSpan } from './types.ts';

// Local OTLP/HTTP JSON trace receiver for eve. Spans are stripped to a metadata whitelist BEFORE storage,
// staged in otel_span, then each touched session is re-derived via eve.fromSpans and saved delete-and-replace.

const MAX_BODY = 20 * 1024 * 1024;

// Only ids, names, model/provider, usage counts, action kinds/outcomes, run linkage, error type.
// Everything else (prompts, responses, tool args/results, error messages, ...) is dropped at the door.
const KEEP = new Set([
  'agent.run.id', 'ai.telemetry.metadata.sessionId', 'ai.telemetry.metadata.session_id', 'gen_ai.conversation.id',
  'gen_ai.operation.name', 'agent.invocation.role', 'agent.turn.id', 'agent.turn.outcome',
  'agent.run.type', 'agent.parent_run.id', 'agent.parent_call.id', 'agent.subagent.name',
  'agent.name', 'gen_ai.agent.name', 'agent.framework.name', 'agent.framework.version',
  'gen_ai.request.model', 'gen_ai.response.model', 'agent.model.id', 'ai.model.id', 'ai.model.provider', 'gen_ai.provider.name', 'gen_ai.system',
  'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.cache_creation.input_tokens',
  'ai.usage.inputTokens', 'ai.usage.outputTokens', 'ai.usage.promptTokens', 'ai.usage.completionTokens',
  'ai.usage.cachedInputTokens', 'ai.usage.reasoningTokens', 'ai.usage.inputTokenDetails.cacheReadTokens',
  'ai.usage.inputTokenDetails.cacheWriteTokens', 'ai.usage.outputTokenDetails.reasoningTokens',
  'gen_ai.tool.name', 'gen_ai.tool.call.id', 'ai.toolCall.name', 'ai.toolCall.id',
  'agent.action.kind', 'agent.action.name', 'agent.action.outcome', 'error.type',
  'otel.scope.name', 'otel.scope.version',
]);

type Attr = OtelSpan['attrs'][string];
const anyValue = (v: any): Attr | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return String(v.stringValue);
  if ('intValue' in v) return Number(v.intValue); // JS exporters send a number, others a decimal string
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('arrayValue' in v) return (v.arrayValue?.values ?? []).map((x: any) => String(anyValue(x) ?? ''));
  return undefined; // kvlist/bytes: nothing we need
};
const attrMap = (list: any): OtelSpan['attrs'] => {
  const out: OtelSpan['attrs'] = {};
  for (const kv of Array.isArray(list) ? list : []) {
    const v = anyValue(kv?.value);
    if (typeof kv?.key === 'string' && v !== undefined) out[kv.key] = v;
  }
  return out;
};

// Unix nanos as a decimal string, or undefined if malformed (eve.ts BigInt()s these; one bad span would 400 its session forever).
// JSON numbers are accepted when integral (ns values exceed 2^53, so they're already rounded to ~256ns; fine for ms).
const nanos = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\d{1,19}$/.test(v) ? v
  : typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e19 ? BigInt(v).toString()
  : undefined;

// ExportTraceServiceRequest (JSON) -> flat spans. Scope name/version are folded into `resource`.
// Spans with malformed timestamps are skipped and counted in `skipped.n`.
export function decodeOtlp(body: unknown, skipped = { n: 0 }): OtelSpan[] {
  const spans: OtelSpan[] = [];
  for (const rs of (body as any)?.resourceSpans ?? []) {
    const resource = attrMap(rs?.resource?.attributes);
    for (const ss of rs?.scopeSpans ?? []) {
      const scope = { ...resource, 'otel.scope.name': String(ss?.scope?.name ?? ''), 'otel.scope.version': String(ss?.scope?.version ?? '') };
      for (const s of ss?.spans ?? []) {
        if (typeof s?.spanId !== 'string' || !s.spanId) continue;
        const start = nanos(s.startTimeUnixNano);
        const end = s.endTimeUnixNano == null ? start : nanos(s.endTimeUnixNano);
        if (!start || !end) { skipped.n++; continue; }
        spans.push({
          trace_id: String(s.traceId ?? ''),
          span_id: s.spanId,
          parent_span_id: s.parentSpanId || null,
          name: String(s.name ?? ''),
          start_ns: start,
          end_ns: end,
          status_code: Number(s.status?.code ?? 0),
          attrs: attrMap(s.attributes),
          resource: scope,
        });
      }
    }
  }
  return spans;
}

const whitelist = (a: OtelSpan['attrs']) => Object.fromEntries(Object.entries(a).filter(([k]) => KEEP.has(k)));

// Span names can carry anything (e.g. @vercel/otel `fetch GET https://...?api_key=...`). Only spans eve.ts can use are
// stored, and their name only if it has a known shape: eve's `chat <model>` / `execute_tool <tool>` / `invoke_agent <agent>`
// (model/tool/agent names only), `agent.step`, or AI SDK `ai.*` (eve.ts matches ai.*.doStream/doGenerate, ai.toolCall).
const EVE_NAME = /^(?:invoke_agent|chat|execute_tool)(?: (?!.*\/\/)[\w.:@\/-]{1,128})?$|^agent\.step$/;
const AI_NAME = /^ai\.[\w.]{1,128}$/;
const opName = (s: OtelSpan) => { const v = s.attrs['gen_ai.operation.name'] ?? s.resource['gen_ai.operation.name']; return v == null ? null : String(v); };
const usable = (s: OtelSpan) => opName(s) != null || EVE_NAME.test(s.name) || AI_NAME.test(s.name);
const safeName = (s: OtelSpan) => (EVE_NAME.test(s.name) || AI_NAME.test(s.name) ? s.name : opName(s));

const loadSpans = (db: DB, keys: string[]): OtelSpan[] =>
  (db.prepare(`SELECT * FROM otel_span WHERE session_id IN (${keys.map(() => '?').join(',')})`).all(...keys) as any[]).map((r) => ({
    trace_id: r.trace_id, span_id: r.span_id, parent_span_id: r.parent_span_id, name: r.name ?? '',
    start_ns: r.start_ns, end_ns: r.end_ns, status_code: r.status_code, attrs: JSON.parse(r.attrs), resource: {},
  }));

// Stage spans (whitelisted; resource keys merged into attrs) and rebuild every touched run.
export async function ingest(db: DB, spans: OtelSpan[]): Promise<string[]> {
  const touched = new Set<string>();
  const put = db.prepare('INSERT OR REPLACE INTO otel_span VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const now = new Date().toISOString();
  tx(db, () => {
    for (const s of spans) {
      if (!usable(s)) continue;
      const key = sessionKey(s);
      touched.add(key);
      const parent = s.attrs['agent.parent_run.id'];
      if (parent != null) touched.add(String(parent)); // parent's SubagentSpawn gains child_run_id
      const attrs = { ...whitelist(s.resource), ...whitelist(s.attrs) };
      put.run(s.span_id, s.trace_id, s.parent_span_id, key, safeName(s), s.start_ns, s.end_ns, s.status_code, JSON.stringify(attrs), now);
    }
  });
  if (!touched.size) return [];
  // children of touched sessions are needed so parent spawns can link to them
  const keys = [...touched];
  const children = db.prepare(
    `SELECT DISTINCT session_id FROM otel_span WHERE json_extract(attrs, '$."agent.parent_run.id"') IN (${keys.map(() => '?').join(',')})`,
  ).all(...keys) as { session_id: string }[];
  const bundles = eve.fromSpans!(loadSpans(db, [...new Set([...keys, ...children.map((c) => c.session_id)])]));
  for (const b of bundles) {
    const known = db.prepare('SELECT setup_fingerprint_id FROM run WHERE id = ?').get(b.run.id) as { setup_fingerprint_id: string | null } | undefined;
    // wait for a model before fingerprinting so an early tool-only batch doesn't pin a model-less setup
    const fp = known?.setup_fingerprint_id || !b.requests[0] ? null : await eve.fingerprint({ cwd: null, model: b.requests[0].model, harness_version: b.run.harness_version });
    tx(db, () => saveBundle(db, b, fp));
  }
  return keys;
}

const send = (res: import('node:http').ServerResponse, code: number, body: object) =>
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));

export function startCollector(db: DB, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/traces') return send(res, 404, { error: 'POST /v1/traces only' });
    // browsers can POST text/plain cross-origin without preflight; OTLP exporters never send Origin
    if (req.headers.origin != null) return send(res, 403, { error: 'cross-origin requests are not accepted' });
    const type = req.headers['content-type'] ?? '';
    if (type.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return send(res, 415, {
        error: `unsupported content-type "${type}": only OTLP/HTTP JSON is accepted. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json or use OTLPHttpJsonTraceExporter from @vercel/otel.`,
      });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { send(res, 413, { error: 'body too large' }); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', async () => {
      if (size > MAX_BODY) return;
      try {
        let buf = Buffer.concat(chunks);
        if (/gzip/i.test(String(req.headers['content-encoding'] ?? ''))) buf = gunzipSync(buf, { maxOutputLength: 5 * MAX_BODY });
        const skipped = { n: 0 };
        const spans = decodeOtlp(JSON.parse(buf.toString('utf8')), skipped);
        const sessions = await ingest(db, spans);
        console.log(`eve: ${spans.length} spans${skipped.n ? ` (${skipped.n} with malformed timestamps skipped)` : ''}, sessions: ${sessions.join(', ') || '—'}`);
        send(res, 200, {});
      } catch (e) {
        send(res, 400, { error: (e as Error).message });
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      console.log(`Unharness collector on http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}/v1/traces`);
      resolve(server);
    }),
  );
}
