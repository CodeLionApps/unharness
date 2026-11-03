// Normalized, harness-agnostic records. Adapters produce these; everything else reads only these.
// Privacy contract: no field may contain prompt/response/tool content, commands, or absolute paths.

export const SCHEMA_VERSION = 1;

export type ToolKind = 'read' | 'edit' | 'bash' | 'search' | 'mcp' | 'web' | 'task' | 'other';
export type ToolStatus = 'ok' | 'error' | 'denied';
export type FileOp = 'read' | 'write' | 'edit' | 'search';

export interface Run {
  id: string; // harness-prefixed, e.g. "cc:<sessionId>", "codex:<id>", "eve:<sessionId>"
  harness: string;
  harness_version: string | null;
  user: string;
  machine_id: string;
  repo: string | null; // repo name only
  branch: string | null;
  started_at: string; // ISO
  ended_at: string; // ISO
  setup_fingerprint_id: string | null;
  parent_run_id: string | null;
  resumed_from_run_id: string | null;
  outcome: string | null; // v2
  active_ms: number | null; // wall time minus idle gaps > 5 min (util.activeMs)
  tool_ms: number | null; // union of tool call intervals (util.unionMs)
}

export interface Request {
  seq: number; // 0-based order within run
  ts: string; // ISO
  model: string;
  provider: string; // anthropic | openai | ...
  input: number; // non-cached input tokens only
  output: number; // includes reasoning (reasoning is a subset, never add twice)
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  reasoning: number;
  duration_ms: number | null; // model latency if known
  // filled by db.saveBundle via pricing.ts
  cost_usd?: number | null;
  pricing_version?: string | null;
}

export interface ToolCall {
  seq: number; // order within run
  request_seq: number; // which Request issued it
  tool_name: string; // e.g. "Bash", "mcp__github__get_issue"
  tool_kind: ToolKind;
  mcp_server: string | null;
  status: ToolStatus;
  duration_ms: number | null; // approximate: tool_use -> tool_result, includes permission wait
  result_tokens: number | null; // estimate of tool result size (util.estimateTokens)
  // in-memory only, consumed by checks.ts, never persisted:
  command?: string;
  exit_code?: number | null; // null = unknown
  output?: string; // bash result text: lets checks.ts judge piped commands (`tsc | tail` exits with tail's code)
}

export interface SkillInvocation {
  skill_name: string;
  source: 'user' | 'project' | 'plugin' | 'unknown';
  tokens_loaded: number | null;
}

export interface SubagentSpawn {
  child_run_id: string | null;
  agent_type: string;
  status: ToolStatus;
}

export interface Compaction {
  at_request_seq: number;
  trigger: 'auto' | 'manual';
  tokens_before: number | null;
  tokens_after: number | null;
}

export interface FileAccess {
  path: string; // repo-relative or '<outside-repo>'
  op: FileOp;
  count: number;
}

export interface CheckRun {
  check_class: string; // e.g. "test:jest"
  runner: string; // yarn | npm | pnpm | npx | bunx | bun | bare
  exit_code: number | null;
  passed: boolean | null;
  duration_ms: number | null;
  seq_in_run: number; // tool call seq
}

export interface SetupComponent {
  kind: string; // instructions | skill | agent | command | mcp | hooks | settings | model | harness
  name: string;
  hash: string;
}

export interface SetupFingerprint {
  id: string; // hash of sorted components
  components: SetupComponent[];
}

// Everything known about one run. Saved atomically with delete-and-replace on run.id.
export interface RunBundle {
  run: Run;
  requests: Request[];
  toolCalls: ToolCall[];
  skills: SkillInvocation[];
  subagents: SubagentSpawn[];
  compactions: Compaction[];
  files: FileAccess[];
  checks: CheckRun[]; // usually left empty by adapters; db.saveBundle derives from bash toolCalls
  cwd: string | null; // in-memory only: used for repo-relative paths, check script expansion, fingerprint
}

// One importable unit. For Claude Code: a session file plus its subagent files
// (size = sum, mtime_ms = max, so a changed child re-imports the whole group).
export interface SourceRef {
  path: string;
  size: number;
  mtime_ms: number;
}

export interface RunContext {
  cwd: string | null;
  model: string | null;
  harness_version: string | null;
}

export interface HarnessAdapter {
  id: string;
  parserVersion: number; // bump to force reimport of unchanged sources
  discover?(): AsyncIterable<SourceRef>;
  // A source file may yield several runs (e.g. subagent sidechains inside a session file).
  parse?(src: SourceRef): Promise<RunBundle[]>;
  fromSpans?(spans: OtelSpan[]): RunBundle[];
  fingerprint(ctx: RunContext): Promise<SetupFingerprint>;
}

// Flattened OTLP span (attributes already decoded to plain values).
export interface OtelSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_ns: string; // bigint as string
  end_ns: string;
  status_code: number; // 0 unset, 1 ok, 2 error
  attrs: Record<string, string | number | boolean | string[]>;
  resource: Record<string, string | number | boolean | string[]>;
}
