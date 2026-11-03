import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname, userInfo, homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolKind } from './types.ts';

export const OUTSIDE_REPO = '<outside-repo>';

export const home = () => process.env.UNHARNESS_HOME ?? path.join(homedir(), '.unharness');

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

// ponytail: chars/4 heuristic, swap for a real tokenizer if v2 token breakdown needs precision
export const estimateTokens = (s: unknown): number => {
  if (s == null) return 0;
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return Math.ceil(str.length / 4);
};

export const machineId = () => sha256(hostname()).slice(0, 16);
export const currentUser = () => process.env.UNHARNESS_USER ?? userInfo().username;

const repoCache = new Map<string, { root: string | null; name: string | null }>();

// Repo root + name for a cwd. Name from origin remote, falling back to root dir basename.
export function repoInfo(cwd: string | null): { root: string | null; name: string | null } {
  if (!cwd) return { root: null, name: null };
  const hit = repoCache.get(cwd);
  if (hit) return hit;
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
    } catch {
      return null;
    }
  };
  const root = git('rev-parse', '--show-toplevel');
  const remote = root ? git('remote', 'get-url', 'origin') : null;
  // An existing non-git dir (e.g. ~) is not a repo: no name, every path counts as outside. A cwd that no longer
  // exists (deleted worktree / temp checkout) can't be inspected, so fall back to treating it as the repo root.
  // ponytail: that fallback can't tell a deleted non-repo dir from a deleted repo.
  const gone = !root && !existsSync(cwd);
  const base = root ?? (gone ? cwd : null);
  const name = remote ? remote.replace(/\.git$/, '').split(/[/:]/).pop()! : base && path.basename(base);
  const info = { root: base, name: name || null };
  repoCache.set(cwd, info);
  return info;
}

export function repoRelative(p: string | null | undefined, root: string | null, cwd?: string | null): string {
  if (!p || !root) return OUTSIDE_REPO;
  const abs = path.resolve(cwd ?? root, p);
  const rel = path.relative(root, abs);
  return rel === '' ? '.' : rel.startsWith('..') || path.isAbsolute(rel) ? OUTSIDE_REPO : rel;
}

// Server names may contain underscores (mcp__claude_ai_Linear__get_issue): split on the LAST `__`.
export function mcpServer(toolName: string): string | null {
  const m = /^mcp__(.+)__/.exec(toolName);
  return m ? m[1] : null;
}

const KIND: Record<string, ToolKind> = {
  read: 'read', notebookread: 'read', view: 'read', view_image: 'read', read_file: 'read',
  edit: 'edit', write: 'edit', multiedit: 'edit', notebookedit: 'edit', apply_patch: 'edit', write_file: 'edit',
  bash: 'bash', shell: 'bash', shell_command: 'bash', exec_command: 'bash', local_shell: 'bash', container_exec: 'bash', bashoutput: 'bash', write_stdin: 'bash',
  glob: 'search', grep: 'search', ls: 'search', toolsearch: 'search', list_dir: 'search', grep_files: 'search',
  webfetch: 'web', websearch: 'web', web_search: 'web', web_fetch: 'web',
  task: 'task', agent: 'task', spawn_agent: 'task',
};

export function toolKind(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp';
  return KIND[name.toLowerCase()] ?? 'other';
}

export const iso = (v: string | number | Date) => new Date(v).toISOString();

// '7d' | '24h' | '90d' -> ms
export function parseDuration(s: string): number {
  const m = /^(\d+)([hdw])$/.exec(s);
  if (!m) throw new Error(`bad duration: ${s} (use e.g. 24h, 7d, 4w)`);
  return Number(m[1]) * { h: 3.6e6, d: 8.64e7, w: 6.048e8 }[m[2] as 'h' | 'd' | 'w'];
}

// Sum of [start,end] interval union in ms (parallel tool calls overlap).
export function unionMs(intervals: [number, number][]): number {
  const iv = intervals.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  let total = 0, curA = -Infinity, curB = -Infinity;
  for (const [a, b] of iv) {
    if (a > curB) { if (curB > curA) total += curB - curA; curA = a; curB = b; }
    else curB = Math.max(curB, b);
  }
  if (curB > curA) total += curB - curA;
  return total;
}

// Wall time across event timestamps, not counting gaps longer than idleMs (user away).
export function activeMs(timestamps: number[], idleMs = 5 * 60_000): number {
  const t = [...timestamps].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < t.length; i++) { const d = t[i] - t[i - 1]; if (d <= idleMs) total += d; }
  return total;
}
