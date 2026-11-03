// Synthetic dev data for the dashboard: ~40 root runs + subagent children over 60 days.
// Usage: node test/seed.ts <dir>   (writes <dir>/db.sqlite)
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb, saveBundle, tx, type DB } from '../src/db.ts';
import { makeFingerprint } from '../src/fingerprint.ts';
import { addTag } from '../src/queries.ts';
import type { Compaction, FileAccess, Request, RunBundle, SetupComponent, SetupFingerprint, SkillInvocation, SubagentSpawn, ToolCall } from '../src/types.ts';
import { toolKind, mcpServer } from '../src/util.ts';

// deterministic PRNG (mulberry32)
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 8.64e7;
const HARNESS = {
  'claude-code': { prefix: 'cc', version: '2.1.3', models: ['claude-sonnet-4-5', 'claude-opus-4-6'], provider: 'anthropic',
    tools: ['Read', 'Read', 'Edit', 'Bash', 'Grep', 'Glob', 'mcp__github__get_issue'] },
  codex: { prefix: 'codex', version: '0.48.0', models: ['gpt-5-codex'], provider: 'openai', tools: ['shell', 'shell', 'apply_patch', 'read_file'] },
  eve: { prefix: 'eve', version: '0.9.1', models: ['claude-sonnet-4-5', 'kimi-k3-preview'], provider: 'anthropic', tools: ['bash', 'read_file', 'write_file'] },
} as const;
type H = keyof typeof HARNESS;

const REPOS = ['web-app', 'api-server', 'ios-app'];
const FILES = ['src/index.ts', 'src/api/client.ts', 'src/components/Button.tsx', 'src/hooks/useAuth.ts', 'package.json', 'README.md', 'src/utils/date.ts', 'test/client.test.ts', '<outside-repo>'];
const CHECKS = ['npx jest', 'yarn lint', 'npx tsc --noEmit', 'yarn test --watch=false'];

// Setup changes at day -40 and day -15 per harness: v1 -> v2 (CLAUDE.md edited, skill added) -> v3 (mcp removed, settings changed)
function fingerprint(h: H, v: 1 | 2 | 3): SetupFingerprint {
  const c: SetupComponent[] = [
    { kind: 'instructions', name: h === 'codex' ? 'AGENTS.md' : 'CLAUDE.md', hash: v === 1 ? 'a1' : 'a2' },
    { kind: 'harness', name: h, hash: HARNESS[h].version },
    { kind: 'skill', name: 'frontend-design', hash: 's1' },
    { kind: 'settings', name: 'permissions', hash: v === 3 ? 'p2' : 'p1' },
  ];
  if (v >= 2) c.push({ kind: 'skill', name: 'test-runner', hash: 't1' });
  if (v < 3) c.push({ kind: 'mcp', name: 'github', hash: 'g1' });
  return makeFingerprint(c);
}

interface Opts { id: string; h: H; end: number; parent?: string; model?: string; small?: boolean }

function makeRun(r: () => number, o: Opts): RunBundle {
  const H = HARNESS[o.h];
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const model = o.model ?? pick(H.models);
  const nReq = o.small ? 3 + Math.floor(r() * 8) : 6 + Math.floor(r() * 45);
  const durMs = nReq * (20_000 + r() * 40_000);
  const start = o.end - durMs;
  const requests: Request[] = [], toolCalls: ToolCall[] = [], compactions: Compaction[] = [];
  const failUntil = r() * 0.7; // checks fail during the first part of the run
  let ctx = 9_000 + Math.floor(r() * 6_000);
  for (let seq = 0; seq < nReq; seq++) {
    const ts = start + (durMs * seq) / nReq;
    if (ctx > 160_000) {
      const after = 25_000 + Math.floor(r() * 10_000);
      compactions.push({ at_request_seq: seq, trigger: r() < 0.8 ? 'auto' : 'manual', tokens_before: ctx, tokens_after: after });
      ctx = after;
    }
    const added = 800 + Math.floor(r() * 7_000);
    const write = Math.floor(added * 0.9);
    requests.push({
      seq, ts: new Date(ts).toISOString(), model, provider: model.startsWith('gpt') ? 'openai' : H.provider,
      input: added - write + 3, output: 150 + Math.floor(r() * 1_800), cache_read: ctx, cache_write_5m: write, cache_write_1h: 0,
      reasoning: model.startsWith('gpt') ? Math.floor(r() * 600) : 0, duration_ms: 2_000 + Math.floor(r() * 12_000),
    });
    ctx += added;
    const nTools = Math.floor(r() * 3);
    for (let k = 0; k < nTools; k++) {
      const name = r() < 0.18 ? (o.h === 'claude-code' ? 'Bash' : o.h === 'codex' ? 'shell' : 'bash') : pick(H.tools);
      const kind = toolKind(name);
      const tc: ToolCall = {
        seq: toolCalls.length, request_seq: seq, tool_name: name, tool_kind: kind, mcp_server: mcpServer(name),
        status: r() < 0.04 ? 'error' : r() < 0.02 ? 'denied' : 'ok', duration_ms: 50 + Math.floor(r() * 4_000), result_tokens: Math.floor(r() * 3_000),
      };
      if (kind === 'bash') {
        tc.command = r() < 0.6 ? pick(CHECKS) : pick(['git status', 'ls src', 'git diff --stat']);
        const fail = seq / nReq < failUntil && r() < 0.7;
        tc.exit_code = fail ? 1 : 0;
        tc.status = fail ? 'error' : 'ok';
      }
      toolCalls.push(tc);
    }
  }
  const files: FileAccess[] = [];
  for (let i = 0; i < 2 + Math.floor(r() * 6); i++) files.push({ path: pick(FILES), op: 'read', count: 1 + Math.floor(r() * (r() < 0.3 ? 5 : 2)) });
  for (let i = 0; i < Math.floor(r() * 4); i++) files.push({ path: pick(FILES.slice(0, 8)), op: pick(['edit', 'write'] as const), count: 1 + Math.floor(r() * 3) });
  files.push({ path: 'src', op: 'search', count: 1 + Math.floor(r() * 4) });
  const skills: SkillInvocation[] = o.h === 'claude-code' && r() < 0.4
    ? [{ skill_name: pick(['frontend-design', 'test-runner', 'pdf']), source: pick(['user', 'project', 'plugin'] as const), tokens_loaded: 800 + Math.floor(r() * 3_000) }]
    : [];
  return {
    run: {
      id: o.id, harness: o.h, harness_version: H.version, user: 'dev', machine_id: 'seed-machine', repo: pick(REPOS),
      branch: pick(['main', 'feat/auth', 'fix/flaky-test']), started_at: new Date(start).toISOString(), ended_at: new Date(o.end).toISOString(),
      setup_fingerprint_id: null, parent_run_id: o.parent ?? null, resumed_from_run_id: null, outcome: null,
      active_ms: Math.floor(durMs * (0.6 + r() * 0.4)), tool_ms: Math.floor(durMs * (0.1 + r() * 0.3)),
    },
    requests, toolCalls, skills, subagents: [], compactions, files, checks: [], cwd: null,
  };
}

export function seed(db: DB, now = Date.now()) {
  const r = rng(42);
  const harnesses: H[] = ['claude-code', 'claude-code', 'claude-code', 'codex', 'codex', 'eve'];
  tx(db, () => {
    for (let i = 0; i < 40; i++) {
      const h = harnesses[Math.floor(r() * harnesses.length)];
      const end = now - Math.floor(r() * 60 * DAY);
      const age = (now - end) / DAY;
      const v = age > 40 ? 1 : age > 15 ? 2 : 3;
      const id = `${HARNESS[h].prefix}:seed-${String(i).padStart(3, '0')}`;
      const b = makeRun(r, { id, h, end });
      b.run.repo = h === 'eve' ? 'support-agent' : b.run.repo;
      // a few Claude Code roots spawn subagents (child runs + spawn rows; one spawn has no child log)
      if (h === 'claude-code' && r() < 0.35) {
        const spawns: SubagentSpawn[] = [];
        for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
          const childId = `${id}:agent${k}`;
          const child = makeRun(r, { id: childId, h, end: end - 60_000 * (k + 1), parent: id, model: 'claude-haiku-4-5', small: true });
          child.run.repo = b.run.repo;
          saveBundle(db, child, fingerprint(h, v));
          spawns.push({ child_run_id: childId, agent_type: k % 2 ? 'general-purpose' : 'Explore', status: 'ok' });
          b.toolCalls.push({ seq: b.toolCalls.length, request_seq: b.requests.length - 1, tool_name: 'Task', tool_kind: 'task', mcp_server: null, status: 'ok', duration_ms: 45_000, result_tokens: 900 });
        }
        if (r() < 0.4) spawns.push({ child_run_id: null, agent_type: 'Explore', status: 'error' });
        b.subagents = spawns;
      }
      saveBundle(db, b, fingerprint(h, v));
      if (i % 5 === 0) addTag(db, id, 'exp:a');
      else if (i % 5 === 1) addTag(db, id, 'exp:b');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node test/seed.ts <dir>'); process.exit(1); }
  process.env.UNHARNESS_HOME = path.resolve(dir);
  const db = openDb(path.join(process.env.UNHARNESS_HOME, 'db.sqlite'));
  seed(db);
  console.log(`seeded ${(db.prepare('SELECT count(*) n FROM run').get() as { n: number }).n} runs into ${process.env.UNHARNESS_HOME}/db.sqlite`);
}
