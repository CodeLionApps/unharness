import { parseArgs } from 'node:util';
import { writeFileSync, existsSync, rmSync, readFileSync, readdirSync, statSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { openDb, saveBundle, isImported, markImported, repriceAll, tx, type DB } from './db.ts';
import { refreshPricing } from './pricing.ts';
import { parseDuration, home } from './util.ts';
import { activeProfile, dbFile, IMPLICIT, loadConfig, profileNames, routeFor } from './profiles.ts';
import * as q from './queries.ts';
import { hookWarnings, setup, updateSkills } from './setup.ts';
import { updateNotice, version } from './update.ts';
import { claudeCode } from './adapters/claude-code.ts';
import { codex } from './adapters/codex.ts';
import type { HarnessAdapter } from './types.ts';

export const LOG_ADAPTERS: HarnessAdapter[] = [claudeCode, codex];

// ---------- formatting ----------
const money = (v: number | null | undefined, missing = false) => (v == null ? '—' : `$${v.toFixed(v < 1 ? 3 : 2)}${missing ? '*' : ''}`);
const num = (v: number | null | undefined) =>
  v == null ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v));
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const dur = (ms: number | null | undefined) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};
const when = (iso: string) => {
  const d = new Date(iso), p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const delta = (cur: number | null, prev: number | null) =>
  cur == null || prev == null || prev === 0 ? '' : ` (${cur >= prev ? '+' : ''}${(((cur - prev) / prev) * 100).toFixed(0)}%)`;
const CHECK = { green: '✓', red: '✗', none: '·' } as const;
const hitRate = (t: { input: number; cache_read: number; cache_write: number }) =>
  t.input + t.cache_read + t.cache_write ? t.cache_read / (t.input + t.cache_read + t.cache_write) : null;

function table(rows: (string | number)[][], header: string[]) {
  const all = [header, ...rows.map((r) => r.map(String))];
  const w = header.map((_, i) => Math.max(...all.map((r) => [...String(r[i] ?? '')].length)));
  const line = (r: (string | number)[]) => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd();
  console.log(line(header));
  console.log(w.map((x) => '─'.repeat(x)).join('  '));
  for (const r of rows) console.log(line(r));
}

// ---------- commands ----------
// Import new/changed sources into the profile each session routes to (see profiles.ts). Which sources were
// already imported is tracked in <home>/state.sqlite, shared by all profiles.
async function sync(opts: { reprice?: boolean; verbose?: boolean; rebuild?: boolean; yes?: boolean }) {
  updateSkills();
  await refreshPricing();
  const dbs = new Map<string, DB>();
  const dbFor = (p: string) => dbs.get(p) ?? dbs.set(p, openDb(dbFile(p))).get(p)!;
  if (opts.reprice) {
    for (const p of profileNames()) console.log(`${p}: repriced ${repriceAll(dbFor(p))} requests`);
    return;
  }
  const state = openDb(path.join(home(), 'state.sqlite'));
  // --rebuild: re-route everything (e.g. after changing profiles). Manual tags follow their run to its new profile;
  // fingerprints are recomputed from the current setup.
  const tags: { run_id: string; tag: string }[] = [];
  if (opts.rebuild) {
    // only runs that come from log files; eve runs (collector) can't be re-imported
    const fromLogs = `SELECT id FROM run WHERE harness IN (${LOG_ADAPTERS.map((a) => `'${a.id}'`).join(',')})`;
    const counts = profileNames().map((p) => `${p}: ${(dbFor(p).prepare(`SELECT count(*) n FROM run WHERE id IN (${fromLogs})`).get() as { n: number }).n}`);
    console.log(`--rebuild deletes all runs imported from logs (${counts.join(', ')}) and re-imports them from the logs on disk.
Sessions whose logs are gone (Claude Code deletes transcripts after cleanupPeriodDays, default 30) will NOT come back.
A backup of each database is written to db.sqlite.bak first. Manual tags are kept; eve runs are untouched.`);
    if (!opts.yes) {
      if (!process.stdin.isTTY) throw new Error('--rebuild needs --yes when not run interactively');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question('Continue? [y/N] ');
      rl.close();
      if (!/^y/i.test(a.trim())) return console.log('aborted');
    }
    state.exec('DELETE FROM source_file');
    for (const p of profileNames()) {
      const db = dbFor(p);
      const bak = dbFile(p) + '.bak';
      rmSync(bak, { force: true });
      db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
      tags.push(...(db.prepare(`SELECT run_id, tag FROM run_tag WHERE run_id IN (${fromLogs})`).all() as any[]));
      db.exec(`DELETE FROM run_tag WHERE run_id IN (${fromLogs}); DELETE FROM run WHERE id IN (${fromLogs});
        DELETE FROM setup_fingerprint WHERE id NOT IN (SELECT setup_fingerprint_id FROM run WHERE setup_fingerprint_id IS NOT NULL);`);
    }
  }
  const config = loadConfig();
  const perProfile = new Map<string, number>();
  for (const a of LOG_ADAPTERS) {
    let scanned = 0, imported = 0, runs = 0, failed = 0, skipped = 0;
    for await (const src of a.discover!()) {
      scanned++;
      if (isImported(state, a.id, src, a.parserVersion)) continue;
      try {
        const bundles = await a.parse!(src);
        // one source = one session group (+ its subagents): route it as a whole by the main session's cwd
        const profile = bundles.length ? routeFor(bundles[0].cwd, config) : null;
        if (profile) {
          const db = dbFor(profile);
          for (const b of bundles) {
            // fingerprint only for first import; saveBundle keeps an existing one
            const known = db.prepare('SELECT setup_fingerprint_id FROM run WHERE id = ?').get(b.run.id) as { setup_fingerprint_id: string | null } | undefined;
            const fp = known?.setup_fingerprint_id ? null : await a.fingerprint({ cwd: b.cwd, model: b.requests[0]?.model ?? null, harness_version: b.run.harness_version });
            tx(db, () => saveBundle(db, b, fp));
          }
          perProfile.set(profile, (perProfile.get(profile) ?? 0) + bundles.length);
          runs += bundles.length;
        } else if (bundles.length) skipped++;
        markImported(state, a.id, src, a.parserVersion);
        imported++;
      } catch (e) {
        failed++;
        if (opts.verbose) console.error(`  ! ${a.id}: ${(e as Error).message}`);
      }
    }
    console.log(`${a.id.padEnd(12)} ${scanned} sources, ${imported} imported (${runs} runs)${skipped ? `, ${skipped} not collected (no route)` : ''}${failed ? `, ${failed} failed (--verbose)` : ''}`);
  }
  if (perProfile.size > 1 || !perProfile.has(IMPLICIT)) for (const [p, n] of perProfile) console.log(`  → ${p}: ${n} runs`);
  for (const t of tags) {
    for (const db of dbs.values()) if (db.prepare('SELECT 1 FROM run WHERE id = ?').get(t.run_id)) db.prepare('INSERT OR IGNORE INTO run_tag VALUES (?, ?)').run(t.run_id, t.tag);
  }
}

function runs(db: DB, v: Record<string, any>) {
  const rows = q.listRuns(db, {
    harness: v.harness, repo: v.repo, tag: v.tag,
    since: v.since ? Date.now() - parseDuration(v.since) : undefined,
  }, Number(v.limit ?? 30));
  table(rows.map((r) => [
    r.id.length > 20 ? r.id.slice(0, 20) : r.id, when(r.ended_at), r.harness, r.repo ?? '—', (r.models[0] ?? '—').slice(0, 22),
    money(r.cost_total, r.cost_missing), num(r.total.tokens), pct(hitRate(r.total)),
    `${r.total.tool_calls}${r.total.tool_errors ? `/${r.total.tool_errors}err` : ''}`, `${CHECK[r.checks_state]}${r.checks ? ` ${r.checks}` : ''}`,
    r.subagents || '', r.compactions || '', dur(r.active_ms),
  ]), ['run', 'ended', 'harness', 'repo', 'model', 'cost', 'tokens', 'cache', 'tools', 'checks', 'sub', 'cmp', 'active']);
  if (rows.some((r) => r.cost_missing)) console.log('\n* some requests use a model missing from the pricing table');
}

function runShow(db: DB, id: string) {
  const d = q.runDetail(db, id);
  const r = d.run;
  console.log(`${r.id}  ${r.harness} ${r.harness_version ?? ''}`);
  console.log(`repo ${r.repo ?? '—'}  branch ${r.branch ?? '—'}  setup ${r.setup_fingerprint_id ?? '—'}${r.tags.length ? `  tags ${r.tags.join(',')}` : ''}`);
  if (r.parent_run_id) console.log(`parent ${r.parent_run_id}`);
  if (r.resumed_from_run_id) console.log(`resumed from ${r.resumed_from_run_id}`);
  console.log(`${when(r.started_at)} → ${when(r.ended_at)}  active ${dur(r.active_ms)}  in tools ${dur(r.tool_ms)}${r.model_ms ? `  in model ${dur(r.model_ms)}` : ''}`);
  console.log(`\nCOST ${money(r.cost_total, r.cost_missing)} (own ${money(r.cost)})   models ${r.models.join(', ') || '—'}`);
  console.log(`tokens: input ${num(r.input)}  output ${num(r.output)}  reasoning ${num(r.reasoning)}  cache read ${num(r.cache_read)}  cache write ${num(r.cache_write)}  hit rate ${pct(hitRate(r))}`);

  console.log(`\nREQUESTS (${d.requests.length}) — context per request`);
  const maxCtx = Math.max(1, ...d.requests.map((x) => x.context));
  const cmpAt = new Set(d.compactions.map((c: any) => c.at_request_seq));
  const step = Math.max(1, Math.ceil(d.requests.length / 40));
  for (const x of d.requests.filter((_, i) => i % step === 0 || cmpAt.has(d.requests[i].seq))) {
    const bar = '█'.repeat(Math.round((x.context / maxCtx) * 40));
    console.log(`  ${String(x.seq).padStart(4)} ${bar.padEnd(40)} ${num(x.context).padStart(6)} out ${num(x.output).padStart(5)}${cmpAt.has(x.seq) ? '  ⟲ compaction' : ''}`);
  }

  if (d.tools.length) {
    console.log('\nTOOLS');
    table(d.tools.map((t) => [t.tool_name, t.tool_kind, t.calls, t.errors || '', t.denied || '', t.avg_ms == null ? '—' : `${Math.round(t.avg_ms)}ms`, num(t.result_tokens)]),
      ['tool', 'kind', 'calls', 'err', 'denied', 'avg~', 'result tok~']);
  }
  if (d.skills.length) {
    console.log('\nSKILLS');
    table(d.skills.map((s) => [s.skill_name, s.source, s.calls, num(s.tokens_loaded)]), ['skill', 'source', 'calls', 'tokens~']);
  }
  if (d.subagents.length) {
    console.log('\nSUBAGENTS');
    const print = (nodes: q.SubagentNode[], ind: string) => {
      for (const s of nodes) {
        console.log(`${ind}${s.agent_type} [${s.status}] ${s.run ? `${s.run.id}  ${money(s.run.cost_total)}  ${num(s.run.total.tokens)} tok  ${s.run.total.tool_calls} tools` : '(log not found)'}`);
        print(s.children, ind + '  ');
      }
    };
    print(d.subagents, '  ');
  }
  if (d.checks.length) {
    console.log('\nCHECKS  ' + d.checks.map((c: any) => (c.passed === 1 ? '●' : c.passed === 0 ? '○' : '?')).join(''));
    table(d.checks.map((c: any) => [c.seq_in_run, c.check_class, c.runner, c.exit_code ?? '—', c.passed === 1 ? 'pass' : c.passed === 0 ? 'FAIL' : '?', dur(c.duration_ms)]),
      ['at tool#', 'class', 'runner', 'exit', 'result', 'time']);
    console.log(`final state: ${r.checks_state}${r.red_before_green != null ? `, ${r.red_before_green} red before first green` : ''}`);
  }
  if (d.compactions.length) {
    console.log('\nCOMPACTIONS');
    table(d.compactions.map((c: any) => [c.at_request_seq, c.trigger, num(c.tokens_before), num(c.tokens_after)]), ['at request', 'trigger', 'before', 'after']);
  }
  if (d.files.length) {
    console.log(`\nFILES  read ${r.files_read}  edited ${r.files_edited}  re-reads ${r.rereads}`);
    table(d.files.slice(0, 15).map((f: any) => [f.path, f.op, f.count]), ['path', 'op', 'count']);
    if (d.files.length > 15) console.log(`  … ${d.files.length - 15} more`);
  }
}

function summaryTable(rows: [string, q.Summary][]) {
  const metric = (label: string, f: (s: q.Summary) => string) => [label, ...rows.map(([, s]) => f(s))];
  table([
    metric('runs', (s) => String(s.runs)),
    metric('cost', (s) => money(s.cost)),
    metric('cost/run p25·med·p75', (s) => `${money(s.cost_per_run.p25)} · ${money(s.cost_per_run.median)} · ${money(s.cost_per_run.p75)}`),
    metric('tokens', (s) => num(s.tokens)),
    metric('tokens/run median', (s) => num(s.tokens_per_run.median)),
    metric('cache hit rate', (s) => pct(s.cache_hit_rate)),
    metric('tool calls', (s) => num(s.tool_calls)),
    metric('tool error rate', (s) => pct(s.tool_error_rate)),
    metric('green checks at end', (s) => pct(s.pct_green_at_end)),
    metric('runs without checks', (s) => pct(s.pct_no_checks)),
    metric('median red before green', (s) => (s.median_red_before_green == null ? '—' : s.median_red_before_green.toFixed(1))),
    metric('re-reads/run', (s) => (s.rereads_per_run == null ? '—' : s.rereads_per_run.toFixed(1))),
    metric('compactions/run', (s) => (s.compactions_per_run == null ? '—' : s.compactions_per_run.toFixed(2))),
  ], ['', ...rows.map(([k]) => k)]);
}

function reportCmd(db: DB, v: Record<string, any>) {
  const period = v.period ?? '7d';
  const r = q.report(db, parseDuration(period), { harness: v.harness, repo: v.repo });
  const c = r.current, p = r.previous;
  console.log(`${period}: ${when(r.from)} → ${when(r.to)}   (vs previous ${period})\n`);
  console.log(`runs ${c.runs}${delta(c.runs, p.runs)}   cost ${money(c.cost)}${delta(c.cost, p.cost)}   tokens ${num(c.tokens)}${delta(c.tokens, p.tokens)}\n`);
  summaryTable([['current', c], ['previous', p]]);
  for (const [label, rows] of [['harness', r.byHarness], ['model', r.byModel], ['repo', r.byRepo]] as const) {
    console.log(`\nBY ${label.toUpperCase()}`);
    table(rows.map((x) => [x.key, x.runs, money(x.cost), num(x.tokens)]), [label, 'runs', 'cost', 'tokens']);
  }
  if (r.daily.length <= 31) {
    console.log('\nDAILY');
    const max = Math.max(1e-9, ...r.daily.map((d) => d.cost));
    for (const d of r.daily) console.log(`  ${d.day} ${'█'.repeat(Math.round((d.cost / max) * 30)).padEnd(30)} ${money(d.cost)}  ${d.runs} runs`);
  }
}

function compareCmd(db: DB, v: Record<string, any>) {
  const by = (v.by ?? 'harness') as q.CompareBy;
  if (!['harness', 'setup', 'tag', 'model'].includes(by)) throw new Error('--by must be harness|setup|tag|model');
  // same default window as the dashboard's Compare page
  const groups = q.compare(db, by, { harness: v.harness, repo: v.repo, since: Date.now() - parseDuration(v.since ?? '30d') }).slice(0, 6);
  if (!groups.length) return console.log('no runs');
  summaryTable(groups.map((g) => [`${g.key.slice(0, 24)}${g.lowSample ? ' ⚠' : ''}`, g.summary]));
  if (groups.some((g) => g.lowSample)) console.log(`\n⚠ fewer than ${q.MIN_GROUP} runs in group — differences may be noise`);
}

function exportCmd(db: DB, v: Record<string, any>) {
  const format = v.format ?? 'json';
  let out: string;
  if (format === 'csv') {
    const rows = q.filterRuns(q.allRuns(db), { rootsOnly: false });
    const cols = Object.keys(rows[0] ?? {}) as (keyof q.RunRow)[];
    const esc = (x: unknown) => { const s = Array.isArray(x) ? x.join(';') : x == null ? '' : String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    out = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  } else if (format === 'json') {
    const tables = ['run', 'run_tag', 'request', 'tool_call', 'skill_invocation', 'subagent_spawn', 'compaction', 'file_access', 'check_run', 'setup_fingerprint', 'setup_component'];
    out = JSON.stringify(Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()])), null, 1);
  } else throw new Error('--format must be json|csv');
  if (v.out) { writeFileSync(v.out, out); console.log(`wrote ${v.out}`); } else console.log(out);
}

// The dashboard runs detached and is reused: a second `unharness dashboard` only opens the browser.
// It is restarted when its build no longer matches, or -p names another profile (the nav switches too).
// It runs Next's standalone server (scripts/build-dashboard.ts). A source checkout rebuilds when any build input
// is newer than the build; an installed package ships its build, so never rebuilds (and has no Next to build with).
const DASHBOARD_PORT = 4319; // next to the collector's 4318; 3000 collides with every dev server
const ROOT = path.join(import.meta.dirname, '..');
const BUILD_INPUTS = ['dashboard/app', 'dashboard/proxy.ts', 'dashboard/next.config.ts', 'scripts/build-dashboard.ts', 'src', 'package.json', 'package-lock.json'];

type Instance = { app: 'unharness'; pid: number; build?: string; profile?: string };

// undefined = nothing answering; 'other' = port taken by something that isn't the dashboard
async function probe(port: string): Promise<Instance | 'other' | undefined> {
  let r: Response;
  try { r = await fetch(`http://127.0.0.1:${port}/api/unharness`, { signal: AbortSignal.timeout(1000) }); } catch { return undefined; }
  const j = await r.json().catch(() => null);
  return j?.app === 'unharness' ? j : 'other';
}

function newestMtime(p: string): number {
  const s = statSync(p);
  if (!s.isDirectory()) return s.mtimeMs;
  return Math.max(s.mtimeMs, ...readdirSync(p, { recursive: true }).map((f) => statSync(path.join(p, String(f))).mtimeMs));
}

// build-dashboard.ts writes this next to BUILD_ID as its last step; without it the build was interrupted halfway
export const BUILD_DONE = 'UNHARNESS_BUILD_DONE';

export function buildIsStale(root: string, buildIdFile: string): boolean {
  if (!existsSync(buildIdFile) || !existsSync(path.join(path.dirname(buildIdFile), BUILD_DONE))) return true;
  if (root.includes(`${path.sep}node_modules${path.sep}`)) return false;
  const built = statSync(buildIdFile).mtimeMs;
  return BUILD_INPUTS.map((f) => path.join(root, f)).filter(existsSync).some((f) => newestMtime(f) > built);
}

async function stopInstance(inst: Instance, port: string) {
  try { process.kill(inst.pid); } catch {}
  for (let i = 0; i < 40; i++) {
    if (!(await probe(port))) return;
    await sleep(250);
  }
  throw new Error(`dashboard (pid ${inst.pid}) did not stop`);
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function dashboard(v: Record<string, any>) {
  const dir = path.join(ROOT, 'dashboard', '.next', 'standalone', 'dashboard');
  const buildIdFile = path.join(dir, '.next', 'BUILD_ID');
  const port = String(v.port ?? DASHBOARD_PORT);
  const url = `http://127.0.0.1:${port}`;
  const profile = process.env.UNHARNESS_PROFILE;
  const running = await probe(port);
  if (running === 'other') throw new Error(`port ${port} is taken by something else; use --port`);

  if (v.stop) {
    if (!running) return console.log('dashboard is not running');
    await stopInstance(running, port);
    return console.log(`stopped dashboard (pid ${running.pid})`);
  }

  const stale = buildIsStale(ROOT, buildIdFile);
  if (running && !stale && running.build === readFileSync(buildIdFile, 'utf8').trim() && (!v.profile || running.profile === profile)) {
    console.log(`dashboard already running on ${url}`);
    return openBrowser(url);
  }
  if (running) {
    console.log('restarting dashboard (build or profile changed)…');
    await stopInstance(running, port);
  }

  if (stale) {
    console.log('building dashboard…');
    const b = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-dashboard.ts')], { stdio: 'inherit' });
    if (b.status !== 0) process.exit(b.status ?? 1);
  }

  mkdirSync(home(), { recursive: true });
  const log = path.join(home(), 'dashboard.log');
  const fd = openSync(log, 'w');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(dir, 'server.js')], {
    cwd: dir, detached: true, stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: port, HOSTNAME: '127.0.0.1', UNHARNESS_BUILD: readFileSync(buildIdFile, 'utf8').trim() },
  });
  closeSync(fd);
  child.unref();
  let exited = false;
  child.on('exit', () => { exited = true; });
  for (let i = 0; i < 120 && !exited; i++) {
    const inst = await probe(port);
    if (inst && inst !== 'other' && inst.pid === child.pid) {
      console.log(`dashboard on ${url}  (profile: ${profile}; logs: ${log}; stop: unharness dashboard --stop)`);
      return openBrowser(url);
    }
    await sleep(250);
  }
  if (!exited) try { process.kill(child.pid!); } catch {}
  throw new Error(`dashboard did not start; last log lines:\n${readFileSync(log, 'utf8').split('\n').slice(-15).join('\n')}`);
}

const HELP = `Unharness — metadata-only analytics for AI agent runs

  setup [--uninstall] [--yes]        detect agents, install sync hooks, configure profiles
  sync [--reprice] [--rebuild [--yes]] [--verbose]
                                     import new sessions (each into the profile its project routes to);
                                     --rebuild: wipe log-imported runs and re-import (asks first, backs up)
  collect [--port 4318]              local OTLP/HTTP (JSON) collector for eve
  runs [--harness] [--repo] [--tag] [--since 7d] [--limit 30]
  run <id>                           run detail (id or unique prefix)
  report [--period 1d|7d|30d|90d]    period aggregate vs previous period
  compare --by harness|setup|tag|model [--since 30d]  (default window 30d)
  tag <run> <tag> [--rm]             add/remove experiment tag (e.g. exp:new-claude-md)
  dashboard [--port 4319] [--stop]   local web dashboard in the background (reused if running, opens browser)
  export --format json|csv [--out f] export metadata (csv: runs only)

  -p, --profile <name>               which profile's database to read (see config.json)
  -v, --version

  data: ${process.env.UNHARNESS_HOME ?? '~/.unharness'}  (override with UNHARNESS_HOME)`;

export async function main(argv = process.argv.slice(2)) {
  const { values: v, positionals: pos } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      harness: { type: 'string' }, repo: { type: 'string' }, tag: { type: 'string' }, since: { type: 'string' },
      limit: { type: 'string' }, period: { type: 'string' }, by: { type: 'string' }, format: { type: 'string' },
      out: { type: 'string' }, port: { type: 'string' }, rm: { type: 'boolean' }, reprice: { type: 'boolean' },
      verbose: { type: 'boolean' }, rebuild: { type: 'boolean' }, stop: { type: 'boolean' }, profile: { type: 'string', short: 'p' }, yes: { type: 'boolean', short: 'y' }, uninstall: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
  const [cmd, ...args] = pos;
  if (v.version) return console.log(version());
  if (!cmd || v.help) return console.log(HELP);
  if (cmd === 'sync') return sync(v); // also what the hooks run: no notices
  // Interactive use only (stderr is a terminal); setup lists broken hooks itself. The update check runs alongside the
  // command and its notice comes after the output.
  const interactive = cmd !== 'collect' && process.stderr.isTTY;
  const notice = interactive ? updateNotice() : undefined;
  if (interactive && cmd !== 'setup') for (const w of hookWarnings()) console.error(`! ${w}`);
  await command(cmd, args, v);
  const msg = await notice;
  if (msg) console.error(msg);
}

async function command(cmd: string, args: string[], v: Record<string, any>) {
  if (cmd === 'setup') return setup(v);
  const profile = activeProfile(v.profile);
  process.env.UNHARNESS_PROFILE = profile; // inherited by the dashboard server
  if (profileNames().length > 1 && cmd !== 'export') console.error(`profile: ${profile}`);
  if (cmd === 'dashboard') return dashboard(v);
  if (cmd === 'collect') {
    const { startCollector } = await import('./collector.ts');
    return startCollector(openDb(dbFile(profile)), Number(v.port ?? 4318));
  }
  const db = openDb(dbFile(profile));
  switch (cmd) {
    case 'runs': return runs(db, v);
    case 'run': {
      if (!args[0]) throw new Error('usage: unharness run <id>');
      // without -p the run may live in another profile (e.g. /summarize-run in a repo routed elsewhere)
      const found = v.profile ? undefined : profileNames().find((p) => {
        try { q.resolveRunId(p === profile ? db : openDb(dbFile(p)), args[0]); return true; } catch { return false; }
      });
      if (found && found !== profile) console.error(`(found in profile ${found})`);
      return runShow(found && found !== profile ? openDb(dbFile(found)) : db, args[0]);
    }
    case 'report': return reportCmd(db, v);
    case 'compare': return compareCmd(db, v);
    case 'tag': {
      if (args.length < 2) throw new Error('usage: unharness tag <run> <tag> [--rm]');
      const id = v.rm ? q.removeTag(db, args[0], args[1]) : q.addTag(db, args[0], args[1]);
      return console.log(`${v.rm ? 'untagged' : 'tagged'} ${id}`);
    }
    case 'export': return exportCmd(db, v);
    default: throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}
