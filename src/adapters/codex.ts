import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { activeMs, currentUser, estimateTokens, iso, machineId, mcpServer, repoInfo, repoRelative, sha256, toolKind, unionMs } from '../util.ts';
import { dirComponents, fileComponent, makeFingerprint, valueComponent } from '../fingerprint.ts';
import type {
  Compaction, FileAccess, FileOp, HarnessAdapter, Request, RunBundle, SetupComponent, SkillInvocation, SourceRef, ToolCall, ToolKind, ToolStatus,
} from '../types.ts';

// Codex CLI rollouts: <codex home>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, one thread per file (subagents too).
// Envelope {timestamp, type, payload}; researched on cli 0.63 -> 0.164. Text is read in memory only and dropped.

export const codexDir = () => process.env.UNHARNESS_CODEX_DIR ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex');

type Ev = { i: number; ts: number; type: string; p: any };
// Internal tool call; only `tc` leaves this module.
type T = { tc: ToolCall; line: number; start: number; pending: boolean; unknownExit: boolean; sid?: string; nested?: T[] };

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const DENIED = /rejected by user|SandboxDenied|Rejected\(|declined by user/i;
const FAILED = /^(Script failed|apply_patch verification failed|[\w ]+ failed\b|Failed to|aborted by user|error\b|tool call error)/i;
const PATCH = /^\*\*\* (Update File|Add File|Delete File|Move to): (.+)$/gm;
const NESTED_EXEC = /tools\.exec_command\(\s*(?:\{\s*cmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.)*`))?/g;
const SKILL_PATH = /([^\s"'`<>]*\/skills)\/([\w.-]+)\/SKILL\.md/g;
const SKILL_ROOT = /(^|\/)\.(codex|agents)\/skills$|node_modules|\/plugins\//;

const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const parseJson = (s: unknown): any => { if (typeof s !== 'string') return null; try { return JSON.parse(s); } catch { return null; } };
const textOf = (o: unknown): string =>
  typeof o === 'string' ? o : Array.isArray(o) ? o.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n') : o == null ? '' : JSON.stringify(o);
// argv -> command string; `bash -lc "<cmd>"` -> <cmd>
const argvCmd = (a: unknown) =>
  Array.isArray(a) ? (a.length >= 3 && /(^|\/)(ba|z)?sh$/.test(a[0]) && /^-l?c$/.test(a[1]) ? String(a[2]) : a.join(' ')) : typeof a === 'string' ? a : undefined;
const jsLiteral = (s: string) => {
  if (s[0] === '"') { const j = parseJson(s); if (typeof j === 'string') return j; }
  return s.slice(1, -1).replace(/\\(.)/g, '$1');
};
// `namespace:"mcp__server", name:"tool"` (0.140) -> mcp__server__tool; flat mcp__* names (<=0.118) pass through
const nameOf = (p: any) => (typeof p.namespace === 'string' && p.namespace.startsWith('mcp__') ? `${p.namespace}__${p.name}` : String(p.name ?? 'unknown'));
// last path segment of a git remote, credentials and .git stripped
const repoFromUrl = (u: unknown) =>
  typeof u === 'string' && u ? u.replace(/^[a-z+]+:\/\/[^@/]*@/i, '').replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || null : null;

function readEvents(file: string): Ev[] {
  const evs: Ev[] = [];
  let ts = 0;
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    let o: any;
    try { o = JSON.parse(l); } catch { continue; } // truncated last line while the session is being written
    if (!o || typeof o !== 'object') continue;
    if (o.timestamp) ts = Date.parse(o.timestamp) || ts;
    if (o.type && 'payload' in o) evs.push({ i: evs.length, ts, type: o.type, p: o.payload ?? {} });
    // legacy (2025, no envelope): header {id,timestamp,instructions,git}, {record_type:"state"}, bare response items without timestamps
    else if (!evs.length && o.id && !o.type) evs.push({ i: 0, ts, type: 'session_meta', p: { id: o.id, git: o.git } });
    else if (o.type && !o.record_type) evs.push({ i: evs.length, ts, type: 'response_item', p: o });
  }
  return evs;
}

class Seg {
  meta: any;
  evs: Ev[] = [];
  requests: Request[] = [];
  reqLine: number[] = [];
  tools: T[] = [];
  patches: { p: string; op: FileOp }[] = [];
  skills = new Map<string, string | null>(); // name -> path prefix (resolved to a source at the end)
  compactLines: number[] = [];
  spawns: T[] = [];
  children: string[] = [];
  times: number[] = [];
  cwd: string | null = null;
  lastExec: T | null = null;
  webCalls = 0; webItems = 0; compacted = 0; ccItems = 0; // pre-counted totals vs items seen, to dedupe item_completed twins
  constructor(meta: any) { this.meta = meta ?? {}; }
}

// File-level state carried across resume segments.
interface St { prevTotal: number | null; model: string | null; calls: Map<string, T>; running: Map<string, T>; callIds: Set<string> }

function addTool(s: Seg, name: string, e: Ev, extra: Partial<ToolCall> = {}, line = e.i): T {
  const t: T = {
    tc: { seq: 0, request_seq: 0, tool_name: name, tool_kind: toolKind(name), mcp_server: mcpServer(name), status: 'ok', duration_ms: null, result_tokens: null, ...extra },
    line, start: e.ts, pending: false, unknownExit: 'command' in extra,
  };
  s.tools.push(t);
  return t;
}

function addSkills(s: Seg, text: string) {
  for (const m of text.matchAll(SKILL_PATH)) if (SKILL_ROOT.test(m[1]) && !s.skills.has(m[2])) s.skills.set(m[2], m[1]);
}

function addPatch(s: Seg, patch: unknown) {
  if (typeof patch !== 'string') return;
  for (const m of patch.matchAll(PATCH)) s.patches.push({ p: m[2].trim(), op: m[1] === 'Add File' ? 'write' : 'edit' });
}

// Output -> status / exit code / duration. Formats: exec_command text (Chunk ID / Wall time / Process exited with code N,
// optionally preceded by `Command: ...`), shell_command text (Exit code: N / Wall time), JSON {output, metadata:{exit_code,
// duration_seconds}} (apply_patch, some shell versions, legacy), code-mode list (Script completed|failed / Wall time N seconds).
function applyOutput(st: St, t: T, raw: unknown, ts: number) {
  let out = textOf(raw);
  let exit: number | null = null, dur: number | null = null, isError = false;
  const j = out.startsWith('{') ? parseJson(out) : null;
  if (j && typeof j === 'object' && j.metadata) { exit = num(j.metadata.exit_code); dur = num(j.metadata.duration_seconds); out = textOf(j.output); }
  else if (j?.isError === true) isError = true;
  const head = out.split('\nOutput:')[0];
  exit ??= num(/Process exited with code (-?\d+)/.exec(head)?.[1] ?? /^Exit code: (-?\d+)/m.exec(head)?.[1]);
  dur ??= num(/Wall time:? ([\d.]+) seconds/.exec(head)?.[1]);
  const first = out.trimStart().split('\n')[0];
  const sid = /Process running with session ID (\d+)/.exec(head)?.[1];
  t.pending = false;
  t.tc.result_tokens = estimateTokens(raw);
  t.tc.duration_ms = dur != null ? Math.round(dur * 1000) : Math.max(0, ts - t.start);
  const denied = DENIED.test(first);
  const failed = isError || FAILED.test(first);
  if (t.tc.tool_name === 'write_stdin') {
    // the exit code belongs to the exec_command that started the session, not to write_stdin
    t.tc.status = denied ? 'denied' : failed ? 'error' : 'ok';
    const ex = t.sid != null ? st.running.get(t.sid) : undefined;
    if (ex && exit != null) {
      ex.tc.exit_code = exit; ex.unknownExit = false;
      ex.tc.status = exit === 0 ? 'ok' : 'error';
      ex.tc.duration_ms = Math.max(0, ts - ex.start);
      ex.tc.output = `${ex.tc.output ?? ''}\n${out}`;
      st.running.delete(t.sid!);
    }
    return;
  }
  t.tc.status = denied ? 'denied' : (exit != null && exit !== 0) || failed ? 'error' : 'ok';
  if ('command' in t.tc) { t.tc.exit_code = exit; t.tc.output = out; t.unknownExit = exit == null; }
  if (sid && 'command' in t.tc) st.running.set(sid, t);
  // code mode: a nested exec_command's exit code is known only if the script printed exactly one result for exactly one call
  if (t.nested?.length === 1) {
    const n = t.nested[0];
    const printed = out.split('\nOutput:').slice(1).join('\n');
    if ('command' in n.tc) n.tc.output = printed;
    const codes = [...printed.matchAll(/"?exit_code"?\s*:\s*(-?\d+)/g)];
    if (codes.length === 1) {
      n.tc.exit_code = Number(codes[0][1]); n.unknownExit = false;
      n.tc.status = n.tc.exit_code === 0 ? 'ok' : 'error';
    }
  }
}

function onResponseItem(s: Seg, st: St, e: Ev) {
  const p = e.p;
  switch (p.type) {
    case 'function_call': {
      let name = nameOf(p);
      const args = parseJson(p.arguments) ?? {};
      let cmd: string | undefined;
      if (name === 'exec_command') cmd = args.cmd;
      else if (name === 'shell_command') cmd = args.command;
      else if (name === 'shell' || name === 'local_shell') {
        // legacy `shell` takes argv; ["apply_patch", "<patch>"] is a patch, not a command
        if (Array.isArray(args.command) && args.command[0] === 'apply_patch') { name = 'apply_patch'; addPatch(s, args.command[1]); }
        else cmd = argvCmd(args.command);
      }
      const t = addTool(s, name, e, typeof cmd === 'string' ? { command: cmd, exit_code: null } : {});
      t.pending = true;
      if (name === 'write_stdin') t.sid = String(args.session_id);
      if (name === 'spawn_agent') s.spawns.push(t);
      if (typeof cmd === 'string') addSkills(s, cmd);
      if (p.call_id) st.calls.set(p.call_id, t);
      break;
    }
    case 'custom_tool_call': {
      const name = nameOf(p);
      const t = addTool(s, name, e);
      t.pending = true;
      if (name === 'apply_patch') addPatch(s, p.input);
      if (name === 'exec' && typeof p.input === 'string') {
        // Code mode: the model writes JS calling nested tools. Each `tools.exec_command(` becomes a nested bash call;
        // its command is kept (in memory, for check classification) only when it is a plain string literal.
        // ponytail: other nested tools (write_stdin, update_plan, web__run) are not counted; MCP / patches / web searches
        // inside code mode come from item_completed records instead. Ceiling: a JS parser, if code mode stats matter more.
        s.lastExec = t;
        t.nested = [...p.input.matchAll(NESTED_EXEC)].map((m) => {
          const n = addTool(s, 'exec_command', e, { command: m[1] ? jsLiteral(m[1]) : undefined, exit_code: null });
          if (!m[1]) delete n.tc.command;
          n.unknownExit = true;
          return n;
        });
        addSkills(s, p.input);
      }
      if (p.call_id) st.calls.set(p.call_id, t);
      break;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const t = st.calls.get(p.call_id);
      if (t) applyOutput(st, t, p.output, e.ts);
      break;
    }
    case 'web_search_call':
      addTool(s, 'web_search', e, { status: !p.status || p.status === 'completed' ? 'ok' : 'error' });
      break;
    case 'message': {
      // explicit skill invocation ($skill): Codex injects <skill><name>..</name><path>..</path>body</skill> as a user message
      if (p.role !== 'user') break;
      for (const c of p.content ?? []) {
        const m = typeof c?.text === 'string' ? /<skill>\s*<name>([^<]+)<\/name>\s*(?:<path>([^<]+)<\/path>)?/.exec(c.text) : null;
        if (m && !s.skills.has(m[1].trim())) s.skills.set(m[1].trim(), m[2] ? m[2].trim().replace(/\/[^/]+\/SKILL\.md$/, '') : null);
      }
      break;
    }
  }
}

function onItem(s: Seg, st: St, e: Ev) {
  const it = e.p.item ?? {};
  const twin = it.id && st.callIds.has(it.id) ? st.calls.get(it.id) : undefined; // same call already seen as a response_item
  if (twin && it.status === 'failed' && twin.tc.status === 'ok') twin.tc.status = 'error';
  const nestedLine = s.lastExec?.line ?? e.i;
  switch (it.type) {
    case 'CommandExecution': {
      const exit = num(it.exit_code);
      const t = twin ?? s.lastExec?.nested?.find((n) => n.unknownExit && n.tc.command === argvCmd(it.command));
      if (t && exit != null && t.unknownExit) { t.tc.exit_code = exit; t.unknownExit = false; t.tc.status = exit === 0 ? 'ok' : 'error'; }
      break;
    }
    case 'FileChange':
      if (twin) break; // paths already taken from the apply_patch input
      addTool(s, 'apply_patch', e, { status: it.status === 'failed' ? 'error' : 'ok' }, nestedLine);
      for (const [p, ch] of Object.entries<any>(it.changes ?? {})) {
        s.patches.push({ p, op: ch?.type === 'add' ? 'write' : 'edit' });
        if (ch?.move_path) s.patches.push({ p: ch.move_path, op: 'edit' });
      }
      break;
    case 'McpToolCall': {
      // only record of MCP calls made inside code mode (0.140+)
      if (twin || !it.server || !it.tool) break;
      const d = it.duration ? (num(it.duration.secs) ?? 0) * 1000 + (num(it.duration.nanos) ?? 0) / 1e6 : null;
      addTool(s, `mcp__${it.server}__${it.tool}`, e, {
        status: it.status === 'failed' || it.result?.isError ? 'error' : 'ok',
        duration_ms: d == null ? null : Math.round(d), result_tokens: estimateTokens(it.result ?? it.error),
      }, nestedLine).start = e.ts - (d ?? 0);
      break;
    }
    case 'WebSearch': // twin of web_search_call when both exist (counts per file are then equal); code mode has items only
      if (++s.webItems > s.webCalls) addTool(s, 'web_search', e, {}, nestedLine);
      break;
    case 'ContextCompaction': // twin of the `compacted` line (0.126+)
      if (++s.ccItems > s.compacted) s.compactLines.push(e.i);
      break;
    case 'SubAgentActivity':
      if (it.kind === 'started' && it.agent_thread_id && !s.children.includes(it.agent_thread_id)) s.children.push(it.agent_thread_id);
      break;
  }
}

function onEvent(s: Seg, st: St, e: Ev, counted: boolean) {
  if (e.type === 'turn_context') {
    st.model = e.p.model ?? e.p.collaboration_mode?.settings?.model ?? st.model;
    s.cwd ??= e.p.cwd ?? null;
    return;
  }
  if (e.type === 'event_msg' && e.p.type === 'token_count') {
    // Counting rule: one Request per token_count with info, whose cumulative total changed (28% are exact repeats).
    // last_token_usage is the request; a decreasing total is a reset (new baseline), still counted. The post-compaction
    // context estimate (input = output = 0, total unchanged) is skipped. token_usage_record (0.154+) duplicates these
    // and is ignored, as is compacted.latest_token_usage_record.
    const info = e.p.info;
    const total = num(info?.total_token_usage?.total_tokens);
    if (total == null) return;
    const dup = total === st.prevTotal;
    st.prevTotal = total;
    const u = info.last_token_usage;
    if (dup || !counted || !u || (!u.input_tokens && !u.output_tokens)) return;
    // Codex input_tokens includes cached and cache-write tokens; output_tokens includes reasoning.
    const cached = num(u.cached_input_tokens) ?? 0, cw = num(u.cache_write_input_tokens) ?? 0;
    s.requests.push({
      seq: s.requests.length, ts: iso(e.ts), model: st.model ?? 'unknown', provider: s.meta.model_provider ?? 'openai',
      input: Math.max(0, (num(u.input_tokens) ?? 0) - cached - cw), output: num(u.output_tokens) ?? 0,
      cache_read: cached, cache_write_5m: cw, cache_write_1h: 0, reasoning: num(u.reasoning_output_tokens) ?? 0, duration_ms: null,
    });
    s.reqLine.push(e.i);
    return;
  }
  if (!counted) return;
  if (e.type === 'compacted') s.compactLines.push(e.i);
  else if (e.type === 'response_item') onResponseItem(s, st, e);
  else if (e.type === 'event_msg' && e.p.type === 'item_completed') onItem(s, st, e);
}

function skillSource(prefix: string | null, root: string | null): SkillInvocation['source'] {
  if (prefix == null) return 'unknown';
  if (/node_modules|\/plugins\//.test(prefix)) return 'plugin';
  if (!path.isAbsolute(prefix) && !prefix.startsWith('~')) return 'project';
  if (root && prefix.startsWith(root + path.sep)) return 'project';
  return /\.(codex|agents)\/skills$/.test(prefix) ? 'user' : 'unknown';
}

const ctxOf = (r: Request | undefined) => (r ? r.input + r.cache_read + r.cache_write_5m : null);

function toBundle(s: Seg, n: number, baseId: string): RunBundle {
  const m = s.meta;
  const cwd: string | null = m.cwd ?? s.cwd ?? null;
  const ri = repoInfo(cwd);
  const root = cwd ? ri.root : null;
  // request_seq of a tool call = the first Request logged after the call line (Codex writes token_count after the
  // response's items, so that is the response that issued the call); clamped to the last Request.
  const reqSeqAt = (line: number) => Math.max(0, Math.min(s.reqLine.filter((l) => l < line).length, s.requests.length - 1));
  const toolCalls = s.tools.map((t, seq) => {
    if (t.pending) { t.tc.status = 'error'; t.unknownExit = true; } // no output: interrupted / turn aborted
    // explicit null = unknown exit (code mode, never-finished): checks.ts then judges by output, not by tool status
    if (t.unknownExit && t.tc.command !== undefined) t.tc.exit_code = null;
    return { ...t.tc, seq, request_seq: reqSeqAt(t.line) };
  });
  const compactions: Compaction[] = s.compactLines.sort((a, b) => a - b).map((line) => {
    const k = s.reqLine.filter((l) => l < line).length;
    return { at_request_seq: k, trigger: 'auto', tokens_before: ctxOf(s.requests[k - 1]), tokens_after: ctxOf(s.requests[k]) };
  });
  const files: FileAccess[] = s.patches.map((f) => ({ path: repoRelative(f.p, root, cwd), op: f.op, count: 1 }));
  const nSub = Math.max(s.spawns.length, s.children.length);
  const parent = m.parent_thread_id ?? m.source?.subagent?.thread_spawn?.parent_thread_id ?? (m.session_id && m.id && m.session_id !== m.id ? m.session_id : null);
  const times = s.times.filter((t) => t > 0);
  const t0 = times.length ? Math.min(...times) : Date.parse(m.timestamp) || 0;
  const t1 = times.length ? Math.max(...times) : t0;
  return {
    run: {
      id: n === 0 ? `codex:${baseId}` : `codex:${baseId}#${n}`,
      harness: 'codex',
      harness_version: m.cli_version ?? null,
      user: currentUser(),
      machine_id: machineId(),
      repo: repoFromUrl(m.git?.repository_url) ?? ri.name,
      branch: m.git?.branch ?? null,
      started_at: iso(t0),
      ended_at: iso(t1),
      setup_fingerprint_id: null,
      parent_run_id: parent ? `codex:${parent}` : null,
      resumed_from_run_id: n === 0 ? null : n === 1 ? `codex:${baseId}` : `codex:${baseId}#${n - 1}`,
      outcome: null,
      active_ms: activeMs(times),
      tool_ms: unionMs(s.tools.flatMap((t) => (t.tc.duration_ms == null ? [] : [[t.start, t.start + t.tc.duration_ms] as [number, number]]))),
    },
    requests: s.requests,
    toolCalls,
    skills: [...s.skills].map(([skill_name, prefix]) => ({ skill_name, source: skillSource(prefix, root), tokens_loaded: null })),
    subagents: Array.from({ length: nSub }, (_, k) => ({
      child_run_id: s.children[k] ? `codex:${s.children[k]}` : null,
      // ponytail: agent_role is null in every observed spawn and agent_path is the model-chosen task name (content), so no finer type
      agent_type: 'subagent',
      status: (s.spawns[k]?.tc.status ?? 'ok') as ToolStatus,
    })),
    compactions,
    files,
    checks: [], // derived in saveBundle
    cwd,
  };
}

export function parseFile(file: string): RunBundle[] {
  const evs = readEvents(file);
  if (!evs.length) return [];
  // Resume appends to the same file with no explicit marker; in some 0.164 files a second session_meta (same id) starts
  // the resumed part. Each later session_meta opens a new segment = separate run `codex:<id>#<n>` resumed from the previous.
  // ponytail: resumes without a second session_meta stay in one run (only a time gap would tell).
  const segs: Seg[] = [];
  for (const e of evs) {
    if (!segs.length || (e.type === 'session_meta' && segs.at(-1)!.evs.some((x) => x.type === 'session_meta'))) segs.push(new Seg(e.type === 'session_meta' ? e.p : null));
    const s = segs.at(-1)!;
    if (e.type === 'session_meta' && !s.evs.length) s.meta = e.p;
    s.evs.push(e);
  }
  const meta0 = segs[0].meta;
  // A forked subagent (fork_turns "all") replays the parent's history, token_count events included, at the top of its file.
  // Its own work starts at the last task_started before the first inter_agent_communication_metadata (held in 24/24 files).
  // ponytail: a fork without that marker is imported whole (would double count its replayed prefix).
  let cutoff = 0;
  if (meta0.forked_from_id) {
    const iac = evs.findIndex((e) => e.type === 'inter_agent_communication_metadata');
    if (iac > 0) cutoff = evs.findLastIndex((e) => e.i < iac && e.type === 'event_msg' && e.p.type === 'task_started');
    if (cutoff < 0) cutoff = iac;
  }
  const st: St = {
    prevTotal: null, model: null, calls: new Map(), running: new Map(),
    callIds: new Set(evs.flatMap((e) => (e.type === 'response_item' && e.p.call_id && /call$/.test(e.p.type) ? [e.p.call_id] : []))),
  };
  // model for token events logged before the first turn_context
  const firstCtx = evs.find((e) => e.type === 'turn_context')?.p;
  st.model = firstCtx?.model ?? firstCtx?.collaboration_mode?.settings?.model ?? null;
  const baseId = meta0.id ?? UUID.exec(file)?.[1] ?? sha256(file).slice(0, 16);
  return segs.map((s, n) => {
    for (const e of s.evs) {
      if (e.i < cutoff) continue;
      if (e.type === 'response_item' && e.p.type === 'web_search_call') s.webCalls++;
      if (e.type === 'compacted') s.compacted++;
    }
    for (const e of s.evs) {
      const counted = e.i >= cutoff;
      if (counted) s.times.push(e.ts);
      onEvent(s, st, e, counted);
    }
    return toBundle(s, n, baseId);
  });
}

// ---------- fingerprint ----------

const SECRET = /env|token|key|secret|header|auth|password|bearer/i;

// Tiny TOML section splitter (no dependency): [table] headers -> lines. Secret-ish keys/sub-tables are dropped before
// hashing; only server/plugin names leave this function.
function configComponents(file: string): SetupComponent[] {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out: SetupComponent[] = [];
  const dev = /^developer_instructions\s*=\s*("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')/m.exec(text);
  if (dev) out.push({ kind: 'instructions', name: 'config:developer_instructions', hash: sha256(dev[1]) });
  text = text.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""'); // multi-line strings can't fake headers below
  const sections = new Map<string, string[]>([['', []]]);
  let cur = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const h = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (h) { cur = h[1]; if (!sections.has(cur)) sections.set(cur, []); continue; }
    if (line && !line.startsWith('#') && !SECRET.test(line.split('=')[0])) sections.get(cur)!.push(line);
  }
  const unq = (k: string) => k.replace(/^["']|["']$/g, '');
  const mcp = new Map<string, string[]>();
  for (const [name, lines] of sections) {
    const m = /^(mcp_servers|plugins)\.("[^"]+"|'[^']+'|[^.]+)(.*)$/.exec(name);
    if (!m || SECRET.test(m[3])) continue;
    const key = `${m[1]}\0${unq(m[2])}`;
    mcp.set(key, [...(mcp.get(key) ?? []), `[${m[3]}]`, ...lines]);
  }
  for (const [key, lines] of mcp) {
    const [table, name] = key.split('\0');
    out.push({ kind: table === 'plugins' ? 'plugin' : 'mcp', name, hash: sha256(lines.join('\n')) });
  }
  const top = sections.get('')!.filter((l) => /^(model|model_provider|model_reasoning_effort|model_reasoning_summary|personality|service_tier|approval_policy|sandbox_mode|profile)\s*=/.test(l));
  const settings = [...top, '[features]', ...(sections.get('features') ?? []), '[sandbox_workspace_write]', ...(sections.get('sandbox_workspace_write') ?? [])];
  if (top.length || sections.has('features')) out.push({ kind: 'settings', name: 'config.toml', hash: sha256(settings.join('\n')) });
  return out;
}

export const codex: HarnessAdapter = {
  id: 'codex',
  parserVersion: 2,

  async *discover() {
    const dir = path.join(codexDir(), 'sessions');
    let names: string[];
    try { names = (readdirSync(dir, { recursive: true }) as string[]).filter((n) => /(^|[/\\])rollout-[^/\\]*\.jsonl$/.test(n)).sort(); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      try { const st = statSync(p); yield { path: p, size: st.size, mtime_ms: st.mtimeMs } satisfies SourceRef; } catch { /* vanished */ }
    }
  },

  async parse(src) {
    return parseFile(src.path);
  },

  async fingerprint(ctx) {
    const base = codexDir();
    const { root } = repoInfo(ctx.cwd);
    const comps: SetupComponent[] = [
      ...fileComponent('instructions', 'user:AGENTS.md', path.join(base, 'AGENTS.md')),
      ...fileComponent('instructions', 'user:AGENTS.override.md', path.join(base, 'AGENTS.override.md')),
      ...dirComponents('skill', path.join(base, 'skills'), 'user:'),
      ...dirComponents('skill', path.join(homedir(), '.agents', 'skills'), 'user:.agents/'),
      ...dirComponents('rules', path.join(base, 'rules')),
      ...configComponents(path.join(base, 'config.toml')),
      ...valueComponent('model', 'model', ctx.model),
      ...valueComponent('harness', 'codex', ctx.harness_version),
    ];
    if (root && ctx.cwd) {
      // AGENTS.md (+ override) in the repo root and every directory down to cwd, named repo-relative
      const rel = path.relative(root, ctx.cwd);
      const parts = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep) : [];
      for (let i = 0; i <= parts.length; i++) {
        for (const f of ['AGENTS.md', 'AGENTS.override.md']) {
          const r = path.join(...parts.slice(0, i), f);
          comps.push(...fileComponent('instructions', `project:${r}`, path.join(root, r)));
        }
      }
      comps.push(...dirComponents('skill', path.join(root, '.codex', 'skills'), 'project:'));
      comps.push(...dirComponents('skill', path.join(root, '.agents', 'skills'), 'project:.agents/'));
    }
    return makeFingerprint(comps);
  },
};
