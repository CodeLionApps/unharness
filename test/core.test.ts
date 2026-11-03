import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, deriveChecks, verdictFromOutput } from '../src/checks.ts';
import { costOf, findPrice, loadPricing } from '../src/pricing.ts';
import { activeMs, mcpServer, repoRelative, toolKind, unionMs, OUTSIDE_REPO } from '../src/util.ts';
import type { Request, ToolCall } from '../src/types.ts';

process.env.UNHARNESS_HOME = '/nonexistent-unharness-home'; // force bundled pricing snapshot, no user rules

const rules = [
  { re: /^(jest|vitest|pytest)\b/, cls: 'test:$1' },
  { re: /^(eslint)\b/, cls: 'lint:$1' },
  { re: /^(tsc)\b/, cls: 'typecheck:$1' },
];
const classes = (cmd: string, scripts = {}) => classify(cmd, scripts, rules).map((h) => `${h.cls}@${h.runner}${h.last ? '' : '~'}`);

test('classify: runners, scripts, prefixes', () => {
  assert.deepEqual(classes('npx jest src/a.test.ts'), ['test:jest@npx']);
  assert.deepEqual(classes('cd pkg && FOO=1 yarn tsc --noEmit'), ['typecheck:tsc@yarn']);
  assert.deepEqual(classes('yarn test', { test: 'vitest run' }), ['test:vitest@yarn']);
  assert.deepEqual(classes('npm run ci', { ci: 'yarn lint && yarn test', lint: 'eslint .', test: 'jest' }), ['lint:eslint@npm~', 'test:jest@npm']);
  assert.deepEqual(classes('yarn test'), ['test:test@yarn']); // no package.json: script name implies class
  assert.deepEqual(classes('yarn jest | tail -20'), ['test:jest@yarn~']); // piped: exit code is tail's
  assert.deepEqual(classes('timeout 60 pytest -q'), ['test:pytest@bare']);
  assert.deepEqual(classes('git status && ls'), []);
  assert.deepEqual(classes('npx jest; echo "exit=$?"'), ['test:jest@npx~']); // exit code is echo's
  assert.deepEqual(classes('npx tsc || echo failed'), ['typecheck:tsc@npx~']);
  assert.deepEqual(classes('npx jest && echo done'), ['test:jest@npx']);
});

const bash = (seq: number, command: string, status: ToolCall['status'], exit_code?: number): ToolCall => ({
  seq, request_seq: 0, tool_name: 'Bash', tool_kind: 'bash', mcp_server: null, status, duration_ms: 10, result_tokens: 1, command, exit_code,
});

test('deriveChecks: pass/fail/unknown', () => {
  const checks = deriveChecks([
    bash(0, 'npx jest', 'error', 1),
    bash(1, 'npx jest | tail', 'ok', 0),
    bash(2, 'npx jest', 'ok'),
    bash(3, 'npx eslint . && npx tsc', 'ok', 0),
    bash(4, 'npx tsc', 'denied'),
  ], null, null);
  assert.deepEqual(checks.map((c) => [c.check_class, c.passed]), [
    ['test:jest', false], ['test:jest', null], ['test:jest', true], ['lint:eslint', true], ['typecheck:tsc', true], ['typecheck:tsc', null],
  ]);
});

const req = (model: string, r: Partial<Request>): Request => ({
  seq: 0, ts: '', model, provider: '', input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, reasoning: 0, duration_ms: null, ...r,
});

test('pricing: anthropic + openai, model id variants', () => {
  const t = loadPricing();
  assert.ok(findPrice(t, 'claude-sonnet-4-5-20250929'));
  assert.ok(findPrice(t, 'anthropic/claude-sonnet-4-5'));
  assert.ok(findPrice(t, 'claude-opus-4-6[1m]'));
  assert.equal(findPrice(t, 'nonexistent-model'), null);
  // sonnet 4.5: $3 in, $15 out, $0.30 cache read, $3.75 5m write, $6 1h write per Mtok
  const c = costOf(req('claude-sonnet-4-5', { input: 1e6, output: 1e6, cache_read: 1e6, cache_write_5m: 1e6, cache_write_1h: 1e6 }), t)!;
  assert.ok(Math.abs(c - (3 + 15 + 0.3 + 3.75 + 6)) < 1e-9, String(c));
  // gpt-5: reasoning is part of output and must not be billed twice
  const g = costOf(req('gpt-5', { input: 1e6, output: 1e6, reasoning: 5e5, cache_read: 1e6 }), t)!;
  assert.ok(Math.abs(g - (1.25 + 10 + 0.125)) < 1e-9, String(g));
  assert.equal(costOf(req('nonexistent-model', { input: 5 }), t), null);
});

test('util: paths, kinds, time', () => {
  assert.equal(repoRelative('/r/src/a.ts', '/r'), 'src/a.ts');
  assert.equal(repoRelative('src/a.ts', '/r', '/r'), 'src/a.ts');
  assert.equal(repoRelative('/etc/passwd', '/r'), OUTSIDE_REPO);
  assert.equal(repoRelative('../x', '/r', '/r'), OUTSIDE_REPO);
  assert.equal(toolKind('mcp__github__get_issue'), 'mcp');
  assert.equal(mcpServer('mcp__github__get_issue'), 'github');
  assert.equal(mcpServer('mcp__claude_ai_Linear__get_issue'), 'claude_ai_Linear');
  assert.equal(mcpServer('Bash'), null);
  assert.equal(toolKind('Bash'), 'bash');
  assert.equal(toolKind('apply_patch'), 'edit');
  assert.equal(toolKind('Whatever'), 'other');
  assert.equal(unionMs([[0, 10], [5, 15], [20, 30]]), 25);
  assert.equal(activeMs([0, 1000, 2000, 2000 + 10 * 60_000]), 2000);
});

test('verdictFromOutput: piped checks judged by output', () => {
  assert.equal(verdictFromOutput('typecheck:tsc', "src/a.ts(1,2): error TS2322: Type 'x'"), false);
  assert.equal(verdictFromOutput('typecheck:tsc', ''), true);
  assert.equal(verdictFromOutput('test:jest', 'Tests:       1 failed, 3 passed, 4 total'), false);
  assert.equal(verdictFromOutput('test:jest', 'Tests:       4 passed, 4 total'), true);
  assert.equal(verdictFromOutput('test:node', 'ℹ pass 2\nℹ fail 0'), true);
  assert.equal(verdictFromOutput('lint:eslint', '✖ 3 problems (3 errors, 0 warnings)'), false);
  assert.equal(verdictFromOutput('test:jest', 'some unrelated output'), null);
  const [c] = deriveChecks([{ ...bash(0, 'npx tsc --noEmit 2>&1 | tail -5', 'ok', 0), output: 'error TS1005: x' }], null, null);
  assert.equal(c.passed, false);
  const [u] = deriveChecks([bash(1, 'npx jest', 'error')], null, null); // interrupted: no exit code
  assert.equal(u.passed, null);
});

test('dashboard build is stale when an input is newer than BUILD_ID; installed packages never rebuild', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { buildIsStale, BUILD_DONE } = await import('../src/cli.ts');
  const make = (root: string) => {
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'dashboard/.next'), { recursive: true });
    writeFileSync(path.join(root, 'src/a.ts'), '');
    const id = path.join(root, 'dashboard/.next/BUILD_ID');
    writeFileSync(id, 'x');
    writeFileSync(path.join(root, 'dashboard/.next', BUILD_DONE), '');
    for (const f of [path.join(root, 'src/a.ts'), path.join(root, 'src'), id]) utimesSync(f, 1000, 1000);
    return id;
  };
  const checkout = mkdtempSync(path.join(tmpdir(), 'al-'));
  const id = make(checkout);
  assert.equal(buildIsStale(checkout, id), false);
  utimesSync(path.join(checkout, 'src/a.ts'), 2000, 2000);
  assert.equal(buildIsStale(checkout, id), true);
  assert.equal(buildIsStale(checkout, path.join(checkout, 'missing')), true);
  utimesSync(path.join(checkout, 'src/a.ts'), 1000, 1000);
  rmSync(path.join(checkout, 'dashboard/.next', BUILD_DONE)); // build interrupted after BUILD_ID was written
  assert.equal(buildIsStale(checkout, id), true);

  const installed = path.join(mkdtempSync(path.join(tmpdir(), 'al-')), 'node_modules', 'unharness');
  const id2 = make(installed);
  utimesSync(path.join(installed, 'src/a.ts'), 2000, 2000);
  assert.equal(buildIsStale(installed, id2), false);
});

test('update notice: semver comparison', async () => {
  const { isNewer } = await import('../src/update.ts');
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.10.0', '0.9.0'), true); // numeric, not lexical
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.0-beta.1'), true); // release beats its prerelease
  assert.equal(isNewer('1.0.0-beta.1', '1.0.0'), false);
  assert.equal(isNewer('garbage', '1.0.0'), false);
});
