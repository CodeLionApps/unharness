// The only read layer. CLI and dashboard both call these, so they always show the same numbers.
// ponytail: per-run metrics are aggregated in memory from a handful of grouped queries; fine to ~100k runs,
// move aggregation into SQL views if it ever gets slow.
import type { DB } from './db.ts';

export interface RunFilter {
  harness?: string;
  repo?: string;
  tag?: string;
  since?: number; // ms epoch, by ended_at
  until?: number;
  rootsOnly?: boolean; // default true
}

export type ChecksState = 'green' | 'red' | 'none';

const ROLLUP = ['requests', 'input', 'output', 'cache_read', 'cache_write', 'reasoning', 'tokens', 'tool_calls', 'tool_errors', 'tool_denied'] as const;
export type Totals = Record<(typeof ROLLUP)[number], number>;

export interface RunRow {
  id: string;
  harness: string;
  harness_version: string | null;
  repo: string | null;
  branch: string | null;
  started_at: string;
  ended_at: string;
  parent_run_id: string | null;
  resumed_from_run_id: string | null;
  setup_fingerprint_id: string | null;
  active_ms: number | null;
  tool_ms: number | null;
  model_ms: number | null;
  tags: string[];
  models: string[];
  requests: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  tokens: number; // input + output + cache_read + cache_write
  cost: number; // own requests
  cost_total: number; // own + all descendants
  cost_missing: boolean; // some request had no price (own or descendants)
  total: Totals; // own + all descendants (subagent runs): what report/compare aggregate
  tool_calls: number;
  tool_errors: number;
  tool_denied: number;
  checks: number;
  checks_state: ChecksState;
  red_before_green: number | null; // failed check runs before the first passing one (null: never green)
  compactions: number;
  subagents: number;
  rereads: number;
  files_read: number;
  files_edited: number;
}

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));

function groupBy<T extends { run_id: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) (m.get(r.run_id) ?? m.set(r.run_id, []).get(r.run_id)!).push(r);
  return m;
}

// Every run with its metrics. Filtering happens after, so cost_total can include children outside the window.
export function allRuns(db: DB): RunRow[] {
  const runs = db.prepare('SELECT * FROM run ORDER BY ended_at DESC').all() as any[];
  const req = new Map((db.prepare(`
    SELECT run_id, count(*) requests, sum(input) input, sum(output) output, sum(cache_read) cache_read,
      sum(cache_write_5m + cache_write_1h) cache_write, sum(reasoning) reasoning, sum(coalesce(cost_usd,0)) cost,
      sum(cost_usd IS NULL) cost_missing, group_concat(DISTINCT model) models, sum(duration_ms) model_ms
    FROM request GROUP BY run_id`).all() as any[]).map((r) => [r.run_id, r]));
  const tools = new Map((db.prepare(`
    SELECT run_id, count(*) calls, sum(status='error') errors, sum(status='denied') denied FROM tool_call GROUP BY run_id`).all() as any[]).map((r) => [r.run_id, r]));
  const checks = groupBy(db.prepare('SELECT run_id, check_class, passed FROM check_run ORDER BY run_id, seq').all() as any[]);
  const simpleCount = (sql: string) => new Map((db.prepare(sql).all() as any[]).map((r) => [r.run_id, n(r.c)]));
  const compactions = simpleCount('SELECT run_id, count(*) c FROM compaction GROUP BY run_id');
  const subagents = simpleCount('SELECT run_id, count(*) c FROM subagent_spawn GROUP BY run_id');
  const files = new Map((db.prepare(`
    SELECT run_id, sum(CASE WHEN op='read' AND count>1 THEN count-1 ELSE 0 END) rereads,
      count(DISTINCT CASE WHEN op='read' THEN path END) files_read,
      count(DISTINCT CASE WHEN op IN ('edit','write') THEN path END) files_edited
    FROM file_access WHERE path != '<outside-repo>' GROUP BY run_id`).all() as any[]).map((r) => [r.run_id, r]));
  const tags = groupBy(db.prepare('SELECT run_id, tag FROM run_tag ORDER BY tag').all() as any[]);

  const rows: RunRow[] = runs.map((r) => {
    const q = req.get(r.id) ?? {};
    const t = tools.get(r.id) ?? {};
    const f = files.get(r.id) ?? {};
    const c = checks.get(r.id) ?? [];
    // final state = last known result of each check class
    const last = new Map<string, number | null>();
    for (const x of c) if (x.passed !== null) last.set(x.check_class, x.passed);
    const finals = [...last.values()];
    const firstGreen = c.findIndex((x) => x.passed === 1);
    return {
      id: r.id, harness: r.harness, harness_version: r.harness_version, repo: r.repo, branch: r.branch,
      started_at: r.started_at, ended_at: r.ended_at, parent_run_id: r.parent_run_id,
      resumed_from_run_id: r.resumed_from_run_id, setup_fingerprint_id: r.setup_fingerprint_id,
      active_ms: r.active_ms, tool_ms: r.tool_ms, model_ms: q.model_ms ?? null,
      tags: (tags.get(r.id) ?? []).map((x: any) => x.tag),
      models: q.models ? String(q.models).split(',') : [],
      requests: n(q.requests), input: n(q.input), output: n(q.output), cache_read: n(q.cache_read),
      cache_write: n(q.cache_write), reasoning: n(q.reasoning),
      tokens: n(q.input) + n(q.output) + n(q.cache_read) + n(q.cache_write),
      cost: n(q.cost), cost_total: n(q.cost), cost_missing: n(q.cost_missing) > 0, total: {} as Totals,
      tool_calls: n(t.calls), tool_errors: n(t.errors), tool_denied: n(t.denied),
      checks: c.length,
      checks_state: !finals.length ? 'none' : finals.every((p) => p === 1) ? 'green' : 'red',
      red_before_green: firstGreen < 0 ? null : c.slice(0, firstGreen).filter((x) => x.passed === 0).length,
      compactions: compactions.get(r.id) ?? 0, subagents: subagents.get(r.id) ?? 0,
      rereads: n(f.rereads), files_read: n(f.files_read), files_edited: n(f.files_edited),
    };
  });

  // totals = own + descendants (subagent runs). A run whose parent isn't in the DB counts as a root.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map<string, RunRow[]>();
  for (const r of rows) {
    if (r.parent_run_id && !byId.has(r.parent_run_id)) r.parent_run_id = null;
    if (r.parent_run_id) (kids.get(r.parent_run_id) ?? kids.set(r.parent_run_id, []).get(r.parent_run_id)!).push(r);
  }
  const roll = (r: RunRow, seen: Set<string>): RunRow[] =>
    seen.has(r.id) ? [] : (seen.add(r.id), [r, ...(kids.get(r.id) ?? []).flatMap((k) => roll(k, seen))]);
  for (const r of rows) {
    const tree = roll(r, new Set());
    r.cost_total = tree.reduce((s, x) => s + x.cost, 0);
    r.cost_missing = tree.some((x) => x.cost_missing);
    r.total = Object.fromEntries(ROLLUP.map((k) => [k, tree.reduce((s, x) => s + x[k], 0)])) as Totals;
  }
  return rows;
}

export function filterRuns(rows: RunRow[], f: RunFilter = {}): RunRow[] {
  return rows.filter((r) => {
    if ((f.rootsOnly ?? true) && r.parent_run_id) return false;
    if (f.harness && r.harness !== f.harness) return false;
    if (f.repo && r.repo !== f.repo) return false;
    if (f.tag && !r.tags.includes(f.tag)) return false;
    const end = Date.parse(r.ended_at);
    if (f.since != null && end < f.since) return false;
    if (f.until != null && end >= f.until) return false;
    return true;
  });
}

export function listRuns(db: DB, f: RunFilter = {}, limit = 50): RunRow[] {
  return filterRuns(allRuns(db), f).slice(0, limit);
}

export function resolveRunId(db: DB, prefix: string): string {
  const ids = (db.prepare("SELECT id FROM run WHERE id = ? OR id LIKE ? || '%' OR id LIKE '%:' || ? || '%' LIMIT 6").all(prefix, prefix, prefix) as any[]).map((r) => r.id);
  if (ids.includes(prefix)) return prefix;
  if (!ids.length) throw new Error(`no run matches "${prefix}"`);
  // a session prefix also matches its subagent/resume runs (<id>:<agent>, <id>#n): prefer the session itself
  const root = ids.find((id) => ids.every((o) => o === id || o.startsWith(id + ':') || o.startsWith(id + '#')));
  if (root) return root;
  if (ids.length > 1) throw new Error(`ambiguous run id "${prefix}": ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}`);
  return ids[0];
}

export interface SubagentNode {
  run: RunRow | null; // null when the child run's log was not found
  agent_type: string;
  status: string;
  children: SubagentNode[];
}

export function runDetail(db: DB, idOrPrefix: string) {
  const id = resolveRunId(db, idOrPrefix);
  const rows = allRuns(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const run = byId.get(id)!;
  const requests = (db.prepare('SELECT * FROM request WHERE run_id = ? ORDER BY seq').all(id) as any[]).map((r) => ({
    ...r, context: n(r.input) + n(r.cache_read) + n(r.cache_write_5m) + n(r.cache_write_1h),
  }));
  const toolCalls = db.prepare('SELECT * FROM tool_call WHERE run_id = ? ORDER BY seq').all(id) as any[];
  const tools = db.prepare(`
    SELECT tool_name, tool_kind, mcp_server, count(*) calls, sum(status='error') errors, sum(status='denied') denied,
      avg(duration_ms) avg_ms, sum(result_tokens) result_tokens
    FROM tool_call WHERE run_id = ? GROUP BY tool_name ORDER BY calls DESC`).all(id) as any[];
  const skills = db.prepare('SELECT skill_name, source, count(*) calls, sum(tokens_loaded) tokens_loaded FROM skill_invocation WHERE run_id = ? GROUP BY skill_name, source').all(id) as any[];
  const checks = db.prepare('SELECT * FROM check_run WHERE run_id = ? ORDER BY seq').all(id) as any[];
  const compactions = db.prepare('SELECT * FROM compaction WHERE run_id = ? ORDER BY seq').all(id) as any[];
  const files = db.prepare('SELECT path, op, count FROM file_access WHERE run_id = ? ORDER BY count DESC, path').all(id) as any[];
  // spawn rows, plus child runs that point at this run without one (e.g. Codex auto-review threads)
  const tree = (runId: string, depth = 0): SubagentNode[] => {
    if (depth > 5) return [];
    const spawns = db.prepare('SELECT * FROM subagent_spawn WHERE run_id = ? ORDER BY seq').all(runId) as any[];
    const linked = new Set(spawns.map((s) => s.child_run_id));
    const orphans = rows.filter((r) => r.parent_run_id === runId && !linked.has(r.id))
      .map((r) => ({ child_run_id: r.id, agent_type: 'subagent', status: 'ok' }));
    return [...spawns, ...orphans].map((s) => ({
      run: (s.child_run_id && byId.get(s.child_run_id)) || null,
      agent_type: s.agent_type, status: s.status,
      children: s.child_run_id ? tree(s.child_run_id, depth + 1) : [],
    }));
  };
  const fingerprint = run.setup_fingerprint_id
    ? db.prepare('SELECT kind, name, hash FROM setup_component WHERE fingerprint_id = ? ORDER BY kind, name').all(run.setup_fingerprint_id) as any[]
    : [];
  return { run, requests, toolCalls, tools, skills, checks, compactions, files, subagents: tree(id), fingerprint };
}

// ---- aggregation ----

export const median = (xs: number[]) => quantile(xs, 0.5);
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.ceil(pos)] - s[lo]) * (pos - lo);
}

export interface Summary {
  runs: number;
  cost: number;
  tokens: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  cache_hit_rate: number | null;
  tool_calls: number;
  tool_error_rate: number | null;
  pct_green_at_end: number | null; // among runs that ran checks
  pct_no_checks: number | null;
  median_red_before_green: number | null;
  rereads_per_run: number | null;
  compactions_per_run: number | null;
  cost_per_run: { p25: number | null; median: number | null; p75: number | null };
  tokens_per_run: { p25: number | null; median: number | null; p75: number | null };
  cost_missing_runs: number;
}

const sum = (rows: RunRow[], k: keyof RunRow) => rows.reduce((s, r) => s + n(r[k]), 0);
const tsum = (rows: RunRow[], k: keyof Totals) => rows.reduce((s, r) => s + r.total[k], 0);
const ratio = (a: number, b: number) => (b ? a / b : null);
const spread = (xs: number[]) => ({ p25: quantile(xs, 0.25), median: quantile(xs, 0.5), p75: quantile(xs, 0.75) });

// Cost, tokens and tool metrics include subagent runs (RunRow.total); checks, files and compactions are the run's own.
export function summarize(rows: RunRow[]): Summary {
  const input = tsum(rows, 'input'), cr = tsum(rows, 'cache_read'), cw = tsum(rows, 'cache_write');
  const withChecks = rows.filter((r) => r.checks_state !== 'none');
  const rbg = rows.map((r) => r.red_before_green).filter((x): x is number => x != null);
  return {
    runs: rows.length,
    cost: sum(rows, 'cost_total'),
    tokens: tsum(rows, 'tokens'), input, output: tsum(rows, 'output'), cache_read: cr, cache_write: cw,
    reasoning: tsum(rows, 'reasoning'),
    cache_hit_rate: ratio(cr, input + cr + cw),
    tool_calls: tsum(rows, 'tool_calls'),
    tool_error_rate: ratio(tsum(rows, 'tool_errors'), tsum(rows, 'tool_calls')),
    pct_green_at_end: ratio(withChecks.filter((r) => r.checks_state === 'green').length, withChecks.length),
    pct_no_checks: ratio(rows.length - withChecks.length, rows.length),
    median_red_before_green: median(rbg),
    rereads_per_run: ratio(sum(rows, 'rereads'), rows.length),
    compactions_per_run: ratio(sum(rows, 'compactions'), rows.length),
    cost_per_run: spread(rows.map((r) => r.cost_total)),
    tokens_per_run: spread(rows.map((r) => r.total.tokens)),
    cost_missing_runs: rows.filter((r) => r.cost_missing).length,
  };
}

const DAY = 8.64e7;
const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function breakdown(rows: RunRow[], key: (r: RunRow) => string[]) {
  const m = new Map<string, RunRow[]>();
  for (const r of rows) for (const k of key(r)) (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  return [...m].map(([k, rs]) => ({ key: k, runs: rs.length, cost: sum(rs, 'cost_total'), tokens: tsum(rs, 'tokens') }))
    .sort((a, b) => b.cost - a.cost);
}

// Cost/tokens per model from the requests themselves (incl. subagent runs), so multi-model runs split correctly.
function byModel(db: DB, all: RunRow[], roots: RunRow[]) {
  const reqs = groupBy(db.prepare(`
    SELECT run_id, model, sum(coalesce(cost_usd, 0)) cost, sum(input + output + cache_read + cache_write_5m + cache_write_1h) tokens
    FROM request GROUP BY run_id, model`).all() as any[]);
  const kids = new Map<string, string[]>();
  for (const r of all) if (r.parent_run_id) (kids.get(r.parent_run_id) ?? kids.set(r.parent_run_id, []).get(r.parent_run_id)!).push(r.id);
  const m = new Map<string, { key: string; runs: number; cost: number; tokens: number }>();
  for (const root of roots) {
    const seen = new Set<string>();
    const stack = [root.id];
    const used = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(kids.get(id) ?? []));
      for (const x of reqs.get(id) ?? []) {
        const e = m.get(x.model) ?? m.set(x.model, { key: x.model, runs: 0, cost: 0, tokens: 0 }).get(x.model)!;
        e.cost += n(x.cost); e.tokens += n(x.tokens);
        if (!used.has(x.model)) { used.add(x.model); e.runs++; }
      }
    }
  }
  return [...m.values()].sort((a, b) => b.cost - a.cost);
}

// Period report: rolling window [now-N, now) vs previous [now-2N, now-N). Runs belong to their ended_at.
export function report(db: DB, periodMs: number, f: RunFilter = {}, now = Date.now()) {
  const rows = allRuns(db);
  const cur = filterRuns(rows, { ...f, since: now - periodMs, until: now });
  const prev = filterRuns(rows, { ...f, since: now - 2 * periodMs, until: now - periodMs });
  // daily series by local calendar day, first (partial) day through today
  const days: { day: string; runs: number; cost: number; tokens: number }[] = [];
  const last = localDay(new Date(now).toISOString());
  for (let t = now - periodMs; ; t += DAY) {
    const day = localDay(new Date(t).toISOString());
    if (days.at(-1)?.day !== day) days.push({ day, runs: 0, cost: 0, tokens: 0 });
    if (day === last) break;
  }
  const idx = new Map(days.map((d, i) => [d.day, i]));
  for (const r of cur) {
    const d = days[idx.get(localDay(r.ended_at)) ?? -1];
    if (d) { d.runs++; d.cost += r.cost_total; d.tokens += r.total.tokens; }
  }
  return {
    from: new Date(now - periodMs).toISOString(), to: new Date(now).toISOString(),
    current: summarize(cur), previous: summarize(prev), daily: days,
    byHarness: breakdown(cur, (r) => [r.harness]),
    byModel: byModel(db, rows, cur),
    byRepo: breakdown(cur, (r) => [r.repo ?? 'unknown']),
  };
}

export type CompareBy = 'harness' | 'setup' | 'tag' | 'model';
export const MIN_GROUP = 10;

export function compare(db: DB, by: CompareBy, f: RunFilter = {}) {
  const rows = filterRuns(allRuns(db), f);
  const key = (r: RunRow): string[] =>
    by === 'harness' ? [r.harness]
      : by === 'setup' ? [r.setup_fingerprint_id ?? 'unknown']
        : by === 'tag' ? r.tags
          : r.models.length ? r.models : ['unknown'];
  const groups = new Map<string, RunRow[]>();
  for (const r of rows) for (const k of key(r)) (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  return [...groups].map(([k, rs]) => ({
    key: k,
    n: rs.length,
    lowSample: rs.length < MIN_GROUP,
    summary: summarize(rs),
    // raw per-run values for distribution plots
    dist: {
      cost: rs.map((r) => r.cost_total),
      tokens: rs.map((r) => r.total.tokens),
      tool_error_rate: rs.filter((r) => r.total.tool_calls).map((r) => r.total.tool_errors / r.total.tool_calls),
      rereads: rs.map((r) => r.rereads),
      red_before_green: rs.map((r) => r.red_before_green).filter((x): x is number => x != null),
    },
  })).sort((a, b) => b.n - a.n);
}

// Fingerprint timeline per harness+repo: each change with metrics before/after and changed components.
export function setupHistory(db: DB, f: RunFilter = {}) {
  const rows = filterRuns(allRuns(db), f).filter((r) => r.setup_fingerprint_id).reverse(); // oldest first
  const comps = (id: string) =>
    new Map((db.prepare('SELECT kind, name, hash FROM setup_component WHERE fingerprint_id = ?').all(id) as any[]).map((c) => [`${c.kind}/${c.name}`, c.hash]));
  const streams = new Map<string, RunRow[]>();
  for (const r of rows) {
    const k = `${r.harness} · ${r.repo ?? 'unknown'}`;
    (streams.get(k) ?? streams.set(k, []).get(k)!).push(r);
  }
  return [...streams].map(([stream, rs]) => {
    // consecutive segments of the same fingerprint
    const segs: { fingerprint: string; from: string; to: string; runs: RunRow[] }[] = [];
    for (const r of rs) {
      const last = segs.at(-1);
      if (last && last.fingerprint === r.setup_fingerprint_id) { last.runs.push(r); last.to = r.ended_at; }
      else segs.push({ fingerprint: r.setup_fingerprint_id!, from: r.ended_at, to: r.ended_at, runs: [r] });
    }
    return {
      stream,
      changes: segs.map((s, i) => {
        const prev = segs[i - 1];
        let changed: { component: string; change: 'added' | 'removed' | 'modified' }[] = [];
        if (prev) {
          const a = comps(prev.fingerprint), b = comps(s.fingerprint);
          for (const [k, h] of b) if (!a.has(k)) changed.push({ component: k, change: 'added' }); else if (a.get(k) !== h) changed.push({ component: k, change: 'modified' });
          for (const k of a.keys()) if (!b.has(k)) changed.push({ component: k, change: 'removed' });
        }
        return { fingerprint: s.fingerprint, from: s.from, to: s.to, summary: summarize(s.runs), before: prev ? summarize(prev.runs) : null, changed };
      }),
    };
  });
}

export function overview(db: DB, days: number, now = Date.now()) {
  return report(db, days * DAY, {}, now);
}

export function addTag(db: DB, idOrPrefix: string, tag: string) {
  const id = resolveRunId(db, idOrPrefix);
  db.prepare('INSERT OR IGNORE INTO run_tag VALUES (?, ?)').run(id, tag);
  return id;
}

export function removeTag(db: DB, idOrPrefix: string, tag: string) {
  const id = resolveRunId(db, idOrPrefix);
  db.prepare('DELETE FROM run_tag WHERE run_id = ? AND tag = ?').run(id, tag);
  return id;
}

export function distinct(db: DB) {
  const col = (sql: string) => (db.prepare(sql).all() as any[]).map((r) => r.v);
  return {
    harnesses: col('SELECT DISTINCT harness v FROM run ORDER BY v'),
    repos: col('SELECT DISTINCT repo v FROM run WHERE repo IS NOT NULL ORDER BY v'),
    tags: col('SELECT DISTINCT tag v FROM run_tag ORDER BY v'),
  };
}
