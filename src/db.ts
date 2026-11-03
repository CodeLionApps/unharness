import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { repoInfo, sha256 } from './util.ts';
import { dbFile } from './profiles.ts';
import { deriveChecks } from './checks.ts';
import { costOf, loadPricing } from './pricing.ts';
import { SCHEMA_VERSION, type RunBundle, type SetupFingerprint, type SourceRef } from './types.ts';

// Migrations indexed by PRAGMA user_version. Append only.
const MIGRATIONS = [
  `
  CREATE TABLE run (
    id TEXT PRIMARY KEY, harness TEXT NOT NULL, harness_version TEXT, user TEXT, machine_id TEXT,
    repo TEXT, branch TEXT, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
    setup_fingerprint_id TEXT, parent_run_id TEXT, resumed_from_run_id TEXT, outcome TEXT,
    active_ms INTEGER, tool_ms INTEGER, schema_version INTEGER NOT NULL
  );
  CREATE INDEX run_ended ON run(ended_at);
  CREATE INDEX run_parent ON run(parent_run_id);
  CREATE TABLE run_tag (run_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (run_id, tag));
  CREATE INDEX run_tag_tag ON run_tag(tag);
  CREATE TABLE request (
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE, seq INTEGER NOT NULL, ts TEXT,
    model TEXT, provider TEXT, input INTEGER, output INTEGER, cache_read INTEGER,
    cache_write_5m INTEGER, cache_write_1h INTEGER, reasoning INTEGER, token_breakdown TEXT,
    duration_ms INTEGER, cost_usd REAL, pricing_version TEXT, PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE tool_call (
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE, seq INTEGER NOT NULL, request_seq INTEGER,
    tool_name TEXT, tool_kind TEXT, mcp_server TEXT, status TEXT, duration_ms INTEGER, result_tokens INTEGER,
    PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE skill_invocation (
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
    skill_name TEXT, source TEXT, tokens_loaded INTEGER, PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE subagent_spawn (
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
    child_run_id TEXT, agent_type TEXT, status TEXT, PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE compaction (
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
    at_request_seq INTEGER, trigger TEXT, tokens_before INTEGER, tokens_after INTEGER, PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE file_access (
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE, path TEXT NOT NULL, op TEXT NOT NULL,
    count INTEGER, PRIMARY KEY (run_id, path, op)
  );
  CREATE TABLE check_run (
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
    check_class TEXT, runner TEXT, exit_code INTEGER, passed INTEGER, duration_ms INTEGER, seq_in_run INTEGER,
    PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE setup_fingerprint (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  CREATE TABLE setup_component (
    fingerprint_id TEXT NOT NULL REFERENCES setup_fingerprint(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, name TEXT NOT NULL, hash TEXT, content_ref TEXT, PRIMARY KEY (fingerprint_id, kind, name)
  );
  CREATE TABLE source_file (
    path_hash TEXT PRIMARY KEY, adapter TEXT, size INTEGER, mtime_ms REAL, parser_version INTEGER, imported_at TEXT
  );
  CREATE TABLE otel_span (
    span_id TEXT PRIMARY KEY, trace_id TEXT, parent_span_id TEXT, session_id TEXT, name TEXT,
    start_ns TEXT, end_ns TEXT, status_code INTEGER, attrs TEXT, received_at TEXT
  );
  CREATE INDEX otel_span_session ON otel_span(session_id);
  `,
];

export type DB = DatabaseSync;

export function openDb(file = dbFile()): DB {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (user_version > MIGRATIONS.length) {
    db.close();
    throw new Error(`${file} was created by a newer Unharness (schema v${user_version}; this version supports v${MIGRATIONS.length}). Update: npm i -g @codelionapps/unharness`);
  }
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function insert(db: DB, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => toSql(row[k])));
}

const toSql = (v: unknown) =>
  v === undefined ? null : typeof v === 'boolean' ? Number(v) : v !== null && typeof v === 'object' ? JSON.stringify(v) : (v as string | number | null);

export function saveFingerprint(db: DB, fp: SetupFingerprint) {
  if (db.prepare('SELECT 1 FROM setup_fingerprint WHERE id = ?').get(fp.id)) return;
  insert(db, 'setup_fingerprint', { id: fp.id, created_at: new Date().toISOString() });
  for (const c of fp.components) insert(db, 'setup_component', { fingerprint_id: fp.id, ...c, content_ref: null });
}

// Delete-and-replace one run. Preserves manual tags (separate table), outcome and the fingerprint
// recorded at first import. Derives checks from bash tool calls and prices requests.
export function saveBundle(db: DB, b: RunBundle, fingerprint?: SetupFingerprint | null) {
  const pricing = loadPricing();
  const prev = db.prepare('SELECT setup_fingerprint_id, outcome FROM run WHERE id = ?').get(b.run.id) as
    | { setup_fingerprint_id: string | null; outcome: string | null } | undefined;
  // a re-imported (grown) session keeps the price its old requests were imported with; `sync --reprice` updates all
  const oldCost = new Map((db.prepare('SELECT seq, model, cost_usd, pricing_version FROM request WHERE run_id = ?').all(b.run.id) as any[])
    .map((r) => [`${r.seq}\0${r.model}`, r]));
  db.prepare('DELETE FROM run WHERE id = ?').run(b.run.id);

  let fpId = prev?.setup_fingerprint_id ?? b.run.setup_fingerprint_id;
  if (!fpId && fingerprint) {
    saveFingerprint(db, fingerprint);
    fpId = fingerprint.id;
  }
  insert(db, 'run', {
    ...b.run, setup_fingerprint_id: fpId, outcome: prev?.outcome ?? b.run.outcome, schema_version: SCHEMA_VERSION,
  });
  for (const r of b.requests) {
    const old = oldCost.get(`${r.seq}\0${r.model}`);
    const cost = old?.pricing_version ? old.cost_usd : costOf(r, pricing);
    insert(db, 'request', { run_id: b.run.id, ...r, token_breakdown: null, cost_usd: cost, pricing_version: old?.pricing_version ?? (cost == null ? null : pricing.version) });
  }
  for (const t of b.toolCalls) {
    const { command: _c, exit_code: _e, output: _o, ...rest } = t; // in-memory only, never persisted
    insert(db, 'tool_call', { run_id: b.run.id, ...rest });
  }
  b.skills.forEach((s, seq) => insert(db, 'skill_invocation', { run_id: b.run.id, seq, ...s }));
  b.subagents.forEach((s, seq) => insert(db, 'subagent_spawn', { run_id: b.run.id, seq, ...s }));
  b.compactions.forEach((c, seq) => insert(db, 'compaction', { run_id: b.run.id, seq, ...c }));
  const files = new Map<string, number>();
  for (const f of b.files) files.set(`${f.op}\0${f.path}`, (files.get(`${f.op}\0${f.path}`) ?? 0) + f.count);
  for (const [k, count] of files) {
    const [op, p] = k.split('\0');
    insert(db, 'file_access', { run_id: b.run.id, path: p, op, count });
  }
  const checks = b.checks.length ? b.checks : deriveChecks(b.toolCalls, repoInfo(b.cwd).root, b.cwd);
  checks.forEach((c, seq) => insert(db, 'check_run', { run_id: b.run.id, seq, ...c }));
}

// Incremental import bookkeeping. Paths are hashed so no absolute path lands in the DB.
export function isImported(db: DB, adapter: string, src: SourceRef, parserVersion: number): boolean {
  const row = db.prepare('SELECT size, mtime_ms, parser_version FROM source_file WHERE path_hash = ?').get(sha256(src.path)) as
    | { size: number; mtime_ms: number; parser_version: number } | undefined;
  return !!row && row.size === src.size && row.mtime_ms === src.mtime_ms && row.parser_version === parserVersion;
}

export function markImported(db: DB, adapter: string, src: SourceRef, parserVersion: number) {
  db.prepare('INSERT OR REPLACE INTO source_file VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(src.path), adapter, src.size, src.mtime_ms, parserVersion, new Date().toISOString());
}

export function repriceAll(db: DB): number {
  const pricing = loadPricing();
  const rows = db.prepare('SELECT run_id, seq, model, input, output, cache_read, cache_write_5m, cache_write_1h FROM request').all() as any[];
  const upd = db.prepare('UPDATE request SET cost_usd = ?, pricing_version = ? WHERE run_id = ? AND seq = ?');
  tx(db, () => {
    for (const r of rows) {
      const c = costOf(r, pricing);
      upd.run(c, c == null ? null : pricing.version, r.run_id, r.seq);
    }
  });
  return rows.length;
}
