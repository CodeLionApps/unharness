import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { activeMs, currentUser, estimateTokens, iso, machineId, mcpServer, repoInfo, repoRelative, toolKind, unionMs } from '../util.ts';
import { dirComponents, fileComponent, makeFingerprint, valueComponent } from '../fingerprint.ts';
import type {
  Compaction, FileAccess, FileOp, HarnessAdapter, Request, RunBundle, SetupComponent, SkillInvocation, SourceRef, SubagentSpawn, ToolCall, ToolStatus,
} from '../types.ts';

// Claude Code session logs: ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl (+ <sessionId>/subagents/agent-<id>.jsonl|.meta.json).
// Format notes (observed across 2.1.276–2.1.314): one content block per assistant line, usage repeated on each line of a
// response, tool_result in the following user line. Only metadata leaves this module; text is read in memory and dropped.

type Line = Record<string, any>;

export const claudeDir = () => process.env.UNHARNESS_CLAUDE_DIR ?? path.join(homedir(), '.claude');

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const TRANSCRIPT = new Set(['user', 'assistant', 'system', 'attachment']);
const DENIAL = /^(Permission for this (action|command) was denied|The user doesn't want to proceed with this tool use|PreToolUse:\S+ hook error)/;
const EXIT = /^(?:Error: )?Exit code (\d+)/;
const SKILL_BODY = 'Base directory for this skill';

const ls = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };
const readJson = (f: string): any => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

function readJsonl(file: string): Line[] {
  const out: Line[] = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l || l.startsWith('{"type":"api-request')) continue; // request-replay bookkeeping, bulk of file size
    try { out.push(JSON.parse(l)); } catch { /* truncated last line while the session is being written */ }
  }
  return out;
}

const subagentFiles = (sessionFile: string) => {
  const dir = path.join(path.dirname(sessionFile), path.basename(sessionFile, '.jsonl'), 'subagents');
  return ls(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl')).map((f) => path.join(dir, f));
};

// Text of a tool_result / user content (string or block list); non-text blocks (images) are ignored.
const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text ?? '' : '')).join('\n') : '';

const isResumeHook = (l: Line) => l.type === 'attachment' && l.attachment?.hookName === 'SessionStart:resume';
const isStartHook = (l: Line) => l.type === 'attachment' && String(l.attachment?.hookName ?? '').startsWith('SessionStart');

// Resume appends to the SAME file. Boundaries: (1) the `SessionStart:resume` hook_success attachment (only when a
// SessionStart hook is configured), (2) transcript lines after a `cost-state` line — cost-state is written when a CLI
// process exits, so anything after it came from a new process (`claude --resume`, also `-p --resume`, which fires no
// resume hook). Checked on real logs: every hook-marked resume also has (2); cost-state lines otherwise only repeat
// at the very end. `session_id` is the process' initial session (a /clear chain, not a resume), entrypoint never changes.
function splitResumes(lines: Line[]): Line[][] {
  const segs: Line[][] = [[]];
  let real = false; // current segment has transcript lines other than SessionStart hooks
  let exited = false; // a cost-state line was seen since the last transcript line
  for (const l of lines) {
    const transcript = TRANSCRIPT.has(l.type);
    if (real && (isResumeHook(l) || (exited && transcript))) { segs.push([]); real = false; }
    if (l.type === 'cost-state') exited = true;
    else if (transcript) exited = false;
    if (transcript && !isStartHook(l)) real = true;
    segs.at(-1)!.push(l);
  }
  return segs;
}

interface Unit { id: string; file: string; lines: Line[]; resumedFrom: string | null; agentId: string | null; meta: any }
interface FileIndex { results: Map<string, { line: Line; block: Line }>; skillBody: Map<string, number> }

function indexFile(lines: Line[]): FileIndex {
  const results = new Map<string, { line: Line; block: Line }>(), skillBody = new Map<string, number>();
  for (const l of lines) {
    if (l.type !== 'user') continue;
    const c = l.message?.content;
    if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool_result' && !results.has(b.tool_use_id)) results.set(b.tool_use_id, { line: l, block: b });
    if (l.isMeta && l.sourceToolUseID && textOf(c).startsWith(SKILL_BODY)) skillBody.set(l.sourceToolUseID, estimateTokens(textOf(c)));
  }
  return { results, skillBody };
}

function filesOf(name: string, input: any): { p: string; op: FileOp }[] {
  if (!input || typeof input !== 'object') return [];
  switch (name) {
    case 'Read': return [{ p: input.file_path, op: 'read' }];
    case 'Write': return [{ p: input.file_path, op: 'write' }];
    case 'Edit': case 'MultiEdit': return [{ p: input.file_path, op: 'edit' }];
    case 'NotebookEdit': return [{ p: input.notebook_path ?? input.file_path, op: 'edit' }];
    case 'Grep': return [{ p: input.path ?? '.', op: 'search' }];
    case 'Glob': {
      if (input.path) return [{ p: input.path, op: 'search' }];
      const segs = String(input.pattern ?? '').split('/');
      const i = segs.findIndex((s) => /[*?[{]/.test(s));
      return [{ p: segs.slice(0, i < 0 ? segs.length - 1 : i).join('/') || (input.pattern?.startsWith('/') ? '/' : '.'), op: 'search' }];
    }
    default: return [];
  }
}

function skillSource(name: string, cwd: string | null, root: string | null): SkillInvocation['source'] {
  if (name.includes(':')) return 'plugin';
  if (existsSync(path.join(claudeDir(), 'skills', name))) return 'user';
  if ([cwd, root].some((d) => d && existsSync(path.join(d, '.claude', 'skills', name)))) return 'project';
  return 'unknown';
}

interface Ctx {
  sessionId: string;
  msgOwner: Map<string, string>; // message.id -> run id (first owner; fork subagents replay parent lines)
  toolOwner: Map<string, string>; // tool_use id -> run id
  childOf: Map<string, string>; // tool_use id -> agentId it spawned
  units: Map<string, Unit>; // by agentId
  index: Map<string, FileIndex>; // by file
}

function build(u: Unit, ctx: Ctx): RunBundle | null {
  const { results, skillBody } = ctx.index.get(u.file)!;
  const reqs = new Map<string, { req: Request; out: number; blk: number }>();
  const toolCalls: ToolCall[] = [], intervals: [number, number][] = [], times: number[] = [];
  const skills: SkillInvocation[] = [], subagents: SubagentSpawn[] = [], compactions: Compaction[] = [];
  const fileOps: { p: string; op: FileOp }[] = [];
  let cwd: string | null = null, version: string | null = null, branch: string | null = null;
  let pendingCommand: string | null = null; // `/skill` typed by the user, confirmed by the next meta line

  for (const l of u.lines) {
    if (!TRANSCRIPT.has(l.type)) continue;
    const m = l.message;
    if (l.type === 'assistant' && ctx.msgOwner.get(m?.id) !== u.id) continue; // replayed by a fork / no id
    const ts = Date.parse(l.timestamp);
    if (!Number.isFinite(ts)) continue; // every transcript line carries one
    times.push(ts);
    cwd ??= l.cwd ?? null;
    if (l.version) version = l.version;
    if (l.gitBranch) branch = l.gitBranch === 'HEAD' ? null : l.gitBranch;

    if (l.type === 'system' && l.subtype === 'compact_boundary') {
      const cm = l.compactMetadata ?? {};
      compactions.push({
        at_request_seq: reqs.size, trigger: cm.trigger === 'manual' ? 'manual' : 'auto',
        tokens_before: cm.preTokens ?? null, tokens_after: cm.postTokens ?? null,
      });
      continue;
    }

    if (l.type === 'user') {
      const text = textOf(m?.content);
      if (pendingCommand && l.isMeta && !l.sourceToolUseID && text.startsWith(SKILL_BODY)) {
        skills.push({ skill_name: pendingCommand, source: skillSource(pendingCommand, cwd, repoInfo(cwd).root), tokens_loaded: estimateTokens(text) });
      }
      pendingCommand = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text)?.[1] ?? null;
      continue;
    }
    if (l.type !== 'assistant' || m.model === '<synthetic>') continue;

    // Each line holds one block of response m.id; usage repeats per line and earlier lines may be partial:
    // keep the line with the highest output_tokens (ties -> highest apiBlockIndex). Never sum.
    const usage = m.usage ?? {};
    const out = usage.output_tokens ?? 0, blk = l.apiBlockIndex ?? 0;
    let r = reqs.get(m.id);
    if (!r) {
      r = { req: { seq: reqs.size, ts: iso(l.timestamp), model: m.model, provider: 'anthropic', input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, reasoning: 0, duration_ms: null }, out: -1, blk: -1 };
      reqs.set(m.id, r);
    }
    if (out > r.out || (out === r.out && blk >= r.blk)) {
      const cc = usage.cache_creation;
      Object.assign(r.req, {
        input: usage.input_tokens ?? 0,
        output: out,
        cache_read: usage.cache_read_input_tokens ?? 0,
        cache_write_5m: cc ? cc.ephemeral_5m_input_tokens ?? 0 : usage.cache_creation_input_tokens ?? 0,
        cache_write_1h: cc ? cc.ephemeral_1h_input_tokens ?? 0 : 0,
        reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
      });
      r.out = out; r.blk = blk;
    }

    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type !== 'tool_use') continue;
      const res = results.get(b.id);
      const resText = res ? textOf(res.block.content) : '';
      // No result (crash / interrupted / still running) counts as error: 'ok' requires evidence.
      const status: ToolStatus = !res ? 'error'
        : res.line.toolDenialKind || res.line.permissionDecision?.decision === 'reject' || (res.block.is_error && DENIAL.test(resText)) ? 'denied'
          : res.block.is_error ? 'error' : 'ok';
      const end = res ? Date.parse(res.line.timestamp) : NaN;
      const tc: ToolCall = {
        seq: toolCalls.length, request_seq: r.req.seq, tool_name: b.name, tool_kind: toolKind(b.name), mcp_server: mcpServer(b.name), status,
        duration_ms: Number.isFinite(end) ? Math.max(0, end - ts) : null,
        result_tokens: res ? estimateTokens(resText) : null,
      };
      if (tc.duration_ms != null) intervals.push([ts, end]);
      // Bash: in-memory only, consumed by db.saveBundle check derivation. Background runs have no exit status yet
      // (ponytail: their later BashOutput isn't linked, so they never become checks).
      if (b.name === 'Bash' && typeof b.input?.command === 'string' && !b.input.run_in_background) {
        tc.command = b.input.command;
        tc.exit_code = status === 'ok' ? 0 : status === 'error' && res ? Number(EXIT.exec(resText)?.[1] ?? NaN) : null;
        if (Number.isNaN(tc.exit_code)) tc.exit_code = null;
        tc.output = res ? resText : undefined; // no result: unknown, not silent success
      }
      toolCalls.push(tc);
      fileOps.push(...filesOf(b.name, b.input));

      const forked = b.name === 'Skill' && res?.line.toolUseResult?.status === 'forked';
      if (b.name === 'Skill') {
        const name = String(b.input?.skill ?? '').replace(/^\//, '');
        if (name) skills.push({ skill_name: name, source: skillSource(name, cwd, repoInfo(cwd).root), tokens_loaded: skillBody.get(b.id) ?? null });
      }
      if (b.name === 'Agent' || b.name === 'Task' || forked) {
        const agentId = ctx.childOf.get(b.id);
        const child = agentId ? ctx.units.get(agentId) : undefined;
        subagents.push({
          child_run_id: child?.id ?? null,
          agent_type: child?.meta?.agentType ?? b.input?.subagent_type ?? (forked ? 'skill' : 'general-purpose'),
          status,
        });
      }
    }
  }
  if (!times.length) return null;

  const requests = [...reqs.values()].map((x) => x.req);
  for (const c of compactions) {
    const next = requests[c.at_request_seq];
    c.tokens_after ??= next ? next.input + next.cache_read + next.cache_write_5m + next.cache_write_1h : null;
  }
  const { root, name } = repoInfo(cwd);
  const files: FileAccess[] = fileOps.map(({ p, op }) => ({ path: repoRelative(typeof p === 'string' ? p : null, root, cwd), op, count: 1 }));
  const parent = u.agentId ? ctx.toolOwner.get(u.meta?.toolUseId ?? [...ctx.childOf].find(([, a]) => a === u.agentId)?.[0] ?? '') ?? `cc:${ctx.sessionId}` : null;
  return {
    run: {
      id: u.id, harness: 'claude-code', harness_version: version, user: currentUser(), machine_id: machineId(),
      repo: name, branch, started_at: iso(Math.min(...times)), ended_at: iso(Math.max(...times)),
      setup_fingerprint_id: null, parent_run_id: parent, resumed_from_run_id: u.resumedFrom, outcome: null,
      active_ms: activeMs(times), tool_ms: unionMs(intervals),
    },
    requests, toolCalls, skills, subagents, compactions, files, checks: [], cwd,
  };
}

function settingsOf(f: string): { hooks: unknown; settings: unknown } {
  const s = readJson(f);
  if (!s) return { hooks: null, settings: null };
  // whitelist; env contributes key names only (values may be secrets)
  const { permissions, model, enabledPlugins, outputStyle } = s;
  return { hooks: s.hooks ?? null, settings: { permissions, model, enabledPlugins, outputStyle, envKeys: Object.keys(s.env ?? {}).sort() } };
}

const firstTs = (u: Unit) => u.lines.find((l) => TRANSCRIPT.has(l.type) && l.timestamp)?.timestamp ?? '';

export const claudeCode: HarnessAdapter = {
  id: 'claude-code',
  parserVersion: 3,

  // One SourceRef per session group: main file + subagent files (size = sum, mtime = max).
  async *discover() {
    const projects = path.join(claudeDir(), 'projects');
    for (const proj of ls(projects)) {
      for (const f of ls(path.join(projects, proj))) {
        if (!SESSION_FILE.test(f)) continue;
        const file = path.join(projects, proj, f);
        let size = 0, mtime_ms = 0;
        for (const p of [file, ...subagentFiles(file)]) {
          try { const st = statSync(p); size += st.size; mtime_ms = Math.max(mtime_ms, st.mtimeMs); } catch { /* raced deletion */ }
        }
        yield { path: file, size, mtime_ms };
      }
    }
  },

  async parse(src: SourceRef) {
    const sessionId = path.basename(src.path, '.jsonl');
    const mainLines = readJsonl(src.path);
    const units: Unit[] = splitResumes(mainLines).map((lines, i) => ({
      id: i ? `cc:${sessionId}#${i}` : `cc:${sessionId}`, file: src.path, lines,
      resumedFrom: i === 0 ? null : i === 1 ? `cc:${sessionId}` : `cc:${sessionId}#${i - 1}`, agentId: null, meta: null,
    }));
    const subs: Unit[] = subagentFiles(src.path).map((f) => {
      const agentId = path.basename(f, '.jsonl').slice('agent-'.length);
      return { id: `cc:${sessionId}:${agentId}`, file: f, lines: readJsonl(f), resumedFrom: null, agentId, meta: readJson(f.replace(/\.jsonl$/, '.meta.json')) };
    });
    // parents before children so the original owner of a replayed message.id is the parent
    subs.sort((a, b) => firstTs(a).localeCompare(firstTs(b)));
    units.push(...subs);

    const ctx: Ctx = { sessionId, msgOwner: new Map(), toolOwner: new Map(), childOf: new Map(), units: new Map(subs.map((s) => [s.agentId!, s])), index: new Map() };
    for (const u of units) {
      if (!ctx.index.has(u.file)) ctx.index.set(u.file, indexFile(u.file === src.path ? mainLines : u.lines));
      if (u.meta?.toolUseId) ctx.childOf.set(u.meta.toolUseId, u.agentId!);
      for (const l of u.lines) {
        const id = l.type === 'assistant' ? l.message?.id : null;
        if (!id || (ctx.msgOwner.has(id) && ctx.msgOwner.get(id) !== u.id)) continue;
        ctx.msgOwner.set(id, u.id);
        for (const b of Array.isArray(l.message.content) ? l.message.content : []) if (b?.type === 'tool_use') ctx.toolOwner.set(b.id, u.id);
      }
    }
    // forked Skills (no meta.toolUseId) and anything else: link via toolUseResult.agentId
    for (const { results } of ctx.index.values()) {
      for (const [toolUseId, { line }] of results) {
        const a = line.toolUseResult?.agentId;
        if (typeof a === 'string' && !ctx.childOf.has(toolUseId)) ctx.childOf.set(toolUseId, a);
      }
    }
    return units.flatMap((u) => build(u, ctx) ?? []);
  },

  async fingerprint(ctx) {
    const dir = claudeDir();
    const { root } = repoInfo(ctx.cwd);
    const user = settingsOf(path.join(dir, 'settings.json'));
    const c: SetupComponent[] = [
      ...fileComponent('instructions', 'user:CLAUDE.md', path.join(dir, 'CLAUDE.md')),
      ...dirComponents('instructions', path.join(dir, 'rules'), 'user:rules/'),
      ...dirComponents('skill', path.join(dir, 'skills'), 'user:'),
      ...dirComponents('agent', path.join(dir, 'agents'), 'user:'),
      ...dirComponents('command', path.join(dir, 'commands'), 'user:'),
      ...valueComponent('hooks', 'user', user.hooks),
      ...valueComponent('settings', 'user', user.settings),
      ...valueComponent('model', 'model', ctx.model),
      ...valueComponent('harness', 'claude-code', ctx.harness_version),
    ];
    // ~/.claude.json sits next to ~/.claude; projects are keyed by launch cwd
    const cfg = readJson(path.join(path.dirname(dir), '.claude.json')) ?? {};
    const mcp = (scope: string, servers: unknown) =>
      Object.entries(servers && typeof servers === 'object' ? servers : {}).forEach(([n, v]) => c.push(...valueComponent('mcp', `${scope}:${n}`, v)));
    mcp('user', cfg.mcpServers);
    if (root) {
      mcp('local', (ctx.cwd && cfg.projects?.[ctx.cwd]?.mcpServers) ?? cfg.projects?.[root]?.mcpServers);
      mcp('project', readJson(path.join(root, '.mcp.json'))?.mcpServers);
      c.push(
        ...fileComponent('instructions', 'project:CLAUDE.md', path.join(root, 'CLAUDE.md')),
        ...fileComponent('instructions', 'project:.claude/CLAUDE.md', path.join(root, '.claude', 'CLAUDE.md')),
        ...fileComponent('instructions', 'project:CLAUDE.local.md', path.join(root, 'CLAUDE.local.md')),
        ...dirComponents('instructions', path.join(root, '.claude', 'rules'), 'project:rules/'),
        ...dirComponents('skill', path.join(root, '.claude', 'skills'), 'project:'),
        ...dirComponents('agent', path.join(root, '.claude', 'agents'), 'project:'),
        ...dirComponents('command', path.join(root, '.claude', 'commands'), 'project:'),
      );
      // nested CLAUDE.md between repo root and cwd (repo-relative names only)
      const rel = ctx.cwd ? path.relative(root, ctx.cwd) : '';
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        const parts = rel.split(path.sep);
        parts.forEach((_, i) => {
          const sub = parts.slice(0, i + 1).join('/');
          c.push(...fileComponent('instructions', `project:${sub}/CLAUDE.md`, path.join(root, sub, 'CLAUDE.md')));
        });
      }
      const proj = settingsOf(path.join(root, '.claude', 'settings.json'));
      c.push(...valueComponent('hooks', 'project', proj.hooks), ...valueComponent('settings', 'project', proj.settings));
    }
    return makeFingerprint(c);
  },
};
