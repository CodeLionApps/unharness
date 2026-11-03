import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { home } from './util.ts';
import type { CheckRun, ToolCall } from './types.ts';

// Rules: regex over a single command segment (runner prefix already stripped) -> check class.
// "$1" in the class is replaced by the first capture group (tool name).
interface Rule { re: RegExp; cls: string }

const BUILTIN: [string, string][] = [
  ['^(jest|vitest|mocha|ava|playwright test|cypress run|pytest|phpunit|rspec)\\b', 'test:$1'],
  ['^(go|cargo|deno|bun) test\\b', 'test:$1'],
  ['^node --test\\b', 'test:node'],
  ['^python3? -m (pytest|unittest)\\b', 'test:$1'],
  ['^(eslint|biome (?:check|lint)|ruff check|ruff|oxlint|stylelint|golangci-lint|clippy|swiftlint|ktlint)\\b', 'lint:$1'],
  ['^cargo clippy\\b', 'lint:clippy'],
  ['^(prettier|biome format|ruff format|gofmt|rustfmt|black)\\b.*(--check|-l|--diff)', 'format:$1'],
  ['^(tsc|vue-tsc|mypy|pyright)\\b', 'typecheck:$1'],
  ['^(cargo build|go build|next build|vite build|webpack|xcodebuild|gradlew? \\S*assemble)', 'build:$1'],
];

// Script names (package.json) that imply a class when we can't expand them further.
const SCRIPT_NAMES: [RegExp, string][] = [
  [/^test(:|$)/, 'test'], [/^lint(:|$)/, 'lint'], [/^(typecheck|type-check|tsc|types)(:|$)/, 'typecheck'],
  [/^build(:|$)/, 'build'], [/^(format|fmt)(:check)?$/, 'format'],
];

let userRules: Rule[] | null = null;
function loadRules(repoRoot: string | null): Rule[] {
  // Config shape: { "checks": [{ "match": "<regex>", "class": "test:custom" }] }
  const read = (f: string): Rule[] => {
    if (!existsSync(f)) return [];
    try {
      return (JSON.parse(readFileSync(f, 'utf8')).checks ?? []).map((r: { match: string; class: string }) => ({ re: new RegExp(r.match), cls: r.class }));
    } catch { return []; }
  };
  userRules ??= read(path.join(home(), 'config.json'));
  const repo = repoRoot ? read(path.join(repoRoot, '.unharness.json')) : [];
  return [...repo, ...userRules, ...BUILTIN.map(([re, cls]) => ({ re: new RegExp(re), cls }))];
}

const RUNNER = /^(yarn|npm|pnpm|npx|bunx|bun)\s+/;

function readScripts(dir: string | null): Record<string, string> {
  if (!dir) return {};
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {};
  } catch { return {}; }
}

const NOISE = /^(cd|export|echo|printf|source|\.|true)\b/;

// Split on shell separators, drop env assignments / leading `time`. `last` = the command's exit code is this
// segment's: everything after it is noise (echo, cd) joined only by `&&`. `jest; echo $?` or `tsc || echo x` or
// `jest | tail` exit with the trailing command's code instead.
function segments(cmd: string): { seg: string; last: boolean }[] {
  const parts = cmd.split(/(&&|\|\||;|\||\n)/);
  const segs = parts.filter((_, i) => i % 2 === 0)
    .map((s) => s.trim().replace(/^(\w+=\S*\s+)+/, '').replace(/^(time|exec|timeout\s+\S+)\s+/, ''));
  const seps = parts.filter((_, i) => i % 2 === 1);
  return segs.flatMap((seg, i) => {
    if (!seg || NOISE.test(seg)) return [];
    const after = segs.slice(i + 1).every((s, j) => seps[i + j] === '&&' && (!s || NOISE.test(s)));
    return [{ seg, last: after }];
  });
}

interface Hit { cls: string; runner: string; last: boolean } // last: check is the final pipeline segment, so its exit code is the command's

export function classify(cmd: string, scripts: Record<string, string>, rules: Rule[], depth = 0): Hit[] {
  const hits: Hit[] = [];
  segments(cmd).forEach(({ seg, last }) => {
    const rm = RUNNER.exec(seg);
    const runner = rm ? rm[1] : 'bare';
    let rest = rm ? seg.slice(rm[0].length) : seg;
    if (runner === 'npm' || runner === 'pnpm' || runner === 'bun' || runner === 'yarn') rest = rest.replace(/^(run(-script)?|exec|dlx)\s+/, '');
    rest = rest.replace(/^-{1,2}\S+\s+/, ''); // e.g. npx --yes
    const [name] = rest.split(/\s+/);
    // package.json script -> expand recursively, keep the outer runner
    if (runner !== 'bare' && runner !== 'npx' && runner !== 'bunx' && scripts[name] && depth < 3) {
      const inner = classify(scripts[name], scripts, rules, depth + 1);
      if (inner.length) { hits.push(...inner.map((h) => ({ ...h, runner, last: last && h.last }))); return; }
      const byName = SCRIPT_NAMES.find(([re]) => re.test(name));
      if (byName) { hits.push({ cls: `${byName[1]}:${name}`, runner, last }); return; }
    }
    for (const r of rules) {
      const m = r.re.exec(rest);
      if (m) { hits.push({ cls: r.cls.replace('$1', (m[1] ?? '').split(/\s+/)[0]), runner, last }); return; }
    }
    // `yarn test` without package.json available
    if (runner !== 'bare' && !scripts[name]) {
      const byName = SCRIPT_NAMES.find(([re]) => re.test(name ?? ''));
      if (byName) hits.push({ cls: `${byName[1]}:${name}`, runner, last });
    }
  });
  // dedupe same class within one command
  return hits.filter((h, i) => hits.findIndex((x) => x.cls === h.cls) === i);
}

// Verdict from a check's output, for when the exit code isn't the check's (piped into tail/grep/...).
// ponytail: signature regexes for common runners; unknown output stays null. Extend FAIL/PASS as runners appear.
const FAIL = /error TS\d+|✖ \d+ problems?|\b[1-9]\d* errors?\b.*\bwarnings?\b|Tests:.*\b[1-9]\d* failed|Tests? +[1-9]\d* failed|[#ℹ] fail [1-9]|\b[1-9]\d* failed\b|^FAIL\s|npm ERR!|ERR_PNPM|Command failed with exit code [1-9]|Found [1-9]\d* errors?|error: (?:script|command)|\bFAILED\b/m;
const PASS = /Tests:\s+\d+ passed, \d+ total|Tests +\d+ passed|[#ℹ] fail 0\b|\b\d+ passed\b|Found 0 errors|All files pass|No (?:ESLint )?(?:errors|problems|issues) found|Checked \d+ files? in/m;
export function verdictFromOutput(cls: string, output: string | undefined): boolean | null {
  if (output == null) return null;
  if (FAIL.test(output)) return false;
  if (PASS.test(output)) return true;
  // silent success is the norm for typecheckers/linters/formatters
  return /^(typecheck|lint|format):/.test(cls) && output.replace(/\(no output\)|Exit code 0/g, '').trim() === '' ? true : null;
}

// Derive CheckRuns from bash tool calls. The command is only read here, never stored.
export function deriveChecks(toolCalls: ToolCall[], repoRoot: string | null, cwd: string | null): CheckRun[] {
  const rules = loadRules(repoRoot);
  const scripts = { ...readScripts(repoRoot), ...readScripts(cwd) };
  const out: CheckRun[] = [];
  for (const tc of toolCalls) {
    if (tc.tool_kind !== 'bash' || !tc.command) continue;
    // `a && b` that exited 0 means every segment passed
    const okChain = tc.status === 'ok' && (tc.exit_code ?? 0) === 0 && !/;|\||\n/.test(tc.command.replace(/&&/g, ''));
    for (const h of classify(tc.command, scripts, rules)) {
      if (okChain) h.last = true;
      // Piped checks: the exit code is the last command's (agents' shells run without pipefail) -> judge by output
      // exit_code null = adapter knows it's unknown; undefined = not reported, so infer from tool status
      const exit = !h.last || tc.status === 'denied' ? null : tc.exit_code !== undefined ? tc.exit_code : tc.status === 'ok' ? 0 : null;
      out.push({
        check_class: h.cls, runner: h.runner, exit_code: exit,
        passed: tc.status === 'denied' ? null : exit !== null ? exit === 0 : verdictFromOutput(h.cls, tc.output),
        duration_ms: tc.duration_ms, seq_in_run: tc.seq,
      });
    }
  }
  return out;
}
