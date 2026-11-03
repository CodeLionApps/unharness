import path from 'node:path';
import { activeMs, currentUser, iso, machineId, mcpServer, toolKind, unionMs } from '../util.ts';
import { dirComponents, fileComponent, makeFingerprint, valueComponent } from '../fingerprint.ts';
import type { HarnessAdapter, OtelSpan, Request, RunBundle, SkillInvocation, SubagentSpawn, ToolCall } from '../types.ts';

// eve (Vercel agent framework) via OTLP spans. eve schema v4: invoke_agent (turn) -> agent.step -> chat <model> | execute_tool <name>.
// Raw AI SDK spans (ai.*.doStream/doGenerate, ai.toolCall) are accepted as a fallback.

type Val = OtelSpan['attrs'][string];
const get = (s: OtelSpan, k: string): Val | undefined => s.attrs[k] ?? s.resource[k];
const str = (s: OtelSpan, ...keys: string[]) => {
  for (const k of keys) { const v = get(s, k); if (v != null && v !== '') return String(v); }
  return null;
};
const num = (s: OtelSpan, ...keys: string[]) => {
  for (const k of keys) { const v = Number(get(s, k)); if (get(s, k) != null && Number.isFinite(v)) return v; }
  return 0;
};
const ms = (ns: string) => Number(BigInt(ns) / 1_000_000n);

const LEGACY_REQ = new Set(['ai.streamText.doStream', 'ai.generateText.doGenerate', 'ai.streamObject.doStream', 'ai.generateObject.doGenerate']);
const isRequest = (s: OtelSpan) => get(s, 'gen_ai.operation.name') === 'chat' || LEGACY_REQ.has(s.name);
const isTool = (s: OtelSpan) => get(s, 'gen_ai.operation.name') === 'execute_tool' || s.name === 'ai.toolCall';
const isTurn = (s: OtelSpan) =>
  get(s, 'gen_ai.operation.name') === 'invoke_agent' && get(s, 'agent.invocation.role') !== 'caller' && get(s, 'agent.turn.id') != null;

// Run key: eve session id; raw AI SDK: a telemetry metadata session id if the app set one, else the trace.
export const sessionKey = (s: OtelSpan) =>
  str(s, 'agent.run.id', 'ai.telemetry.metadata.sessionId', 'ai.telemetry.metadata.session_id') ?? s.trace_id;

// "openai/gpt-5.4-mini" via provider "gateway" -> openai + gpt-5.4-mini; "anthropic.messages" -> anthropic.
function modelOf(s: OtelSpan): { model: string; provider: string } {
  let model = str(s, 'gen_ai.request.model', 'ai.model.id', 'agent.model.id', 'gen_ai.response.model') ?? 'unknown';
  let provider = (str(s, 'gen_ai.provider.name', 'ai.model.provider', 'gen_ai.system') ?? 'unknown').split('.')[0];
  const slash = model.indexOf('/');
  if (slash > 0) {
    if (provider === 'gateway' || provider === 'unknown') provider = model.slice(0, slash);
    model = model.slice(slash + 1);
  }
  return { model, provider };
}

function toRequest(s: OtelSpan, seq: number): Request {
  // eve fills gen_ai.usage.input_tokens from AI SDK LanguageModelUsage.inputTokens, which is the TOTAL
  // (providers set inputTokens.total = noCache + cacheRead + cacheWrite, verified in eve's bundled
  // @ai-sdk/openai and @ai-sdk/anthropic), and cache_read/cache_write from inputTokenDetails. Same for
  // AI SDK ai.usage.inputTokens (v5+). So non-cached input = total - cacheRead - cacheWrite.
  // ponytail: AI SDK v4 promptTokens has no cache split reported here; subtraction is then a no-op.
  const total = num(s, 'gen_ai.usage.input_tokens', 'ai.usage.inputTokens', 'ai.usage.promptTokens');
  const cacheRead = num(s, 'gen_ai.usage.cache_read.input_tokens', 'ai.usage.cachedInputTokens', 'ai.usage.inputTokenDetails.cacheReadTokens');
  const cacheWrite = num(s, 'gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.cache_creation.input_tokens', 'ai.usage.inputTokenDetails.cacheWriteTokens');
  return {
    seq,
    ts: iso(ms(s.start_ns)),
    ...modelOf(s),
    input: Math.max(0, total - cacheRead - cacheWrite),
    output: num(s, 'gen_ai.usage.output_tokens', 'ai.usage.outputTokens', 'ai.usage.completionTokens'), // AI SDK output total includes reasoning
    cache_read: cacheRead,
    // ponytail: eve reports one cache-write count, no TTL split; booked as 5m (Anthropic default TTL)
    cache_write_5m: cacheWrite,
    cache_write_1h: 0,
    reasoning: num(s, 'ai.usage.reasoningTokens', 'ai.usage.outputTokenDetails.reasoningTokens'),
    duration_ms: ms(s.end_ns) - ms(s.start_ns),
  };
}

function toBundle(key: string, spans: OtelSpan[], all: Map<string, OtelSpan[]>): RunBundle | null {
  spans.sort((a, b) => ms(a.start_ns) - ms(b.start_ns));
  const reqSpans = spans.filter(isRequest);
  const toolSpans = spans.filter(isTool);
  if (!reqSpans.length && !toolSpans.length) return null;

  const requests = reqSpans.map((s, i) => toRequest(s, i));
  const reqStarts = reqSpans.map((s) => ms(s.start_ns));
  // the request that issued a tool = last provider call that started before the tool
  const requestSeqOf = (t: number) => Math.max(0, reqStarts.findLastIndex((r) => r <= t));

  // child subagent sessions point back via agent.parent_run.id + agent.parent_call.id
  const childByCall = new Map<string, string>();
  for (const [k, ss] of all) {
    const turn = ss.find((s) => get(s, 'agent.parent_run.id') === key && get(s, 'agent.parent_call.id') != null);
    if (turn) childByCall.set(String(get(turn, 'agent.parent_call.id')), `eve:${k}`);
  }

  const toolCalls: ToolCall[] = [];
  const skills: SkillInvocation[] = [];
  const subagents: SubagentSpawn[] = [];
  for (const s of toolSpans) {
    const name = str(s, 'gen_ai.tool.name', 'ai.toolCall.name', 'agent.action.name') ?? 'unknown';
    const kind = str(s, 'agent.action.kind');
    const outcome = str(s, 'agent.action.outcome');
    const status = outcome === 'rejected' ? 'denied' : s.status_code === 2 || (outcome && outcome !== 'completed') ? 'error' : 'ok';
    const isAgent = kind === 'subagent-call' || kind === 'remote-agent-call';
    toolCalls.push({
      seq: toolCalls.length,
      request_seq: requestSeqOf(ms(s.start_ns)),
      tool_name: name,
      tool_kind: isAgent ? 'task' : toolKind(name),
      mcp_server: mcpServer(name),
      status,
      duration_ms: ms(s.end_ns) - ms(s.start_ns),
      result_tokens: null, // results are never ingested
    });
    if (kind === 'load-skill') skills.push({ skill_name: name, source: 'project', tokens_loaded: null });
    if (isAgent) {
      const callId = str(s, 'gen_ai.tool.call.id');
      subagents.push({
        child_run_id: (callId && childByCall.get(callId)) ?? null,
        agent_type: str(s, 'gen_ai.agent.name') ?? name,
        status,
      });
    }
  }

  const turn = spans.find(isTurn);
  const parent = turn && get(turn, 'agent.run.type') === 'subagent' ? str(turn, 'agent.parent_run.id') : null;
  const scope = spans.find((s) => get(s, 'otel.scope.name') === 'eve.agent');
  const times = spans.flatMap((s) => [ms(s.start_ns), ms(s.end_ns)]);
  return {
    run: {
      id: `eve:${key}`,
      harness: 'eve',
      harness_version: (turn && str(turn, 'agent.framework.version')) ?? (scope ? str(scope, 'otel.scope.version') : null),
      user: currentUser(),
      machine_id: machineId(),
      repo: null, // eve spans carry no cwd/repo
      branch: null,
      started_at: iso(Math.min(...times)),
      ended_at: iso(Math.max(...times)),
      setup_fingerprint_id: null,
      parent_run_id: parent ? `eve:${parent}` : null,
      resumed_from_run_id: null,
      outcome: null,
      active_ms: activeMs(times),
      tool_ms: unionMs(toolSpans.map((s) => [ms(s.start_ns), ms(s.end_ns)])),
    },
    requests,
    toolCalls,
    skills,
    subagents,
    compactions: [],
    files: [],
    checks: [],
    cwd: null,
  };
}

export const eve: HarnessAdapter = {
  id: 'eve',
  parserVersion: 1,

  fromSpans(spans) {
    const bySpan = new Map(spans.map((s) => [s.span_id, s])); // eve replays durable steps: dedupe
    const groups = new Map<string, OtelSpan[]>();
    for (const s of bySpan.values()) {
      const k = sessionKey(s);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(s);
    }
    return [...groups].flatMap(([k, ss]) => toBundle(k, ss, groups) ?? []);
  },

  async fingerprint(ctx) {
    const dir = ctx.cwd ? path.join(ctx.cwd, 'agent') : null;
    return makeFingerprint([
      ...(dir
        ? [
            ...fileComponent('instructions', 'instructions.md', path.join(dir, 'instructions.md')),
            ...fileComponent('settings', 'agent.ts', path.join(dir, 'agent.ts')),
            ...dirComponents('skill', path.join(dir, 'skills')),
            ...dirComponents('agent', path.join(dir, 'subagents')),
            ...dirComponents('tool', path.join(dir, 'tools')),
            ...dirComponents('mcp', path.join(dir, 'connections')),
          ]
        : []),
      ...valueComponent('model', 'model', ctx.model),
      ...valueComponent('harness', 'eve', ctx.harness_version),
    ]);
  },
};
