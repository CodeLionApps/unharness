import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'unharness-setup-'));
const fixtures = path.join(import.meta.dirname, 'fixtures');
process.env.UNHARNESS_HOME = path.join(tmp, 'home');
process.env.UNHARNESS_CLAUDE_DIR = path.join(fixtures, 'claude-code');
process.env.UNHARNESS_CODEX_DIR = path.join(fixtures, 'codex', 'sessions');

const { addHook, removeHook, hasHook, hookWarnings, updateSkills } = await import('../src/setup.ts');
const { routeFor, dbFile, saveConfig } = await import('../src/profiles.ts');
const { openDb } = await import('../src/db.ts');

test('hooks: add/remove only touch our entry', () => {
  const theirs = { model: 'x', hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'say bye' }] }], Stop: [{ hooks: [{ type: 'command', command: 'beep' }] }] } };
  const added = addHook(theirs, 'SessionEnd', 'node unharness sync & # unharness-hook');
  assert.ok(hasHook(added, 'SessionEnd'));
  assert.equal(added.hooks!.SessionEnd.length, 2);
  assert.equal(addHook(added, 'SessionEnd', 'node unharness sync & # unharness-hook').hooks!.SessionEnd.length, 2); // idempotent
  assert.deepEqual(removeHook(added, 'SessionEnd'), theirs);
  assert.deepEqual(removeHook(addHook({}, 'SessionEnd', '# unharness-hook'), 'SessionEnd'), {});
});

// Runs fn with Claude Code's directory pointed at a fresh temp dir (Codex's stays on the fixtures, which have neither).
function withClaudeDir(fn: (dir: string) => void) {
  const prev = process.env.UNHARNESS_CLAUDE_DIR;
  process.env.UNHARNESS_CLAUDE_DIR = mkdtempSync(path.join(tmp, 'claude-'));
  try { fn(process.env.UNHARNESS_CLAUDE_DIR); } finally { process.env.UNHARNESS_CLAUDE_DIR = prev; }
}

test('hooks: warns when the hook points at a missing node or CLI', () => withClaudeDir((dir) => {
  const write = (cmd: string) => writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(addHook({}, 'SessionEnd', cmd)));
  write(`${process.execPath} --disable-warning=ExperimentalWarning ${import.meta.filename} sync >/dev/null 2>&1 & # unharness-hook`);
  assert.deepEqual(hookWarnings(), []);
  write(`/gone/node --disable-warning=ExperimentalWarning ${import.meta.filename} sync >/dev/null 2>&1 & # unharness-hook`);
  assert.deepEqual(hookWarnings(), ['Claude Code hook points at a missing node (/gone/node); run `unharness setup` to fix']);
  write(`${process.execPath} /moved/unharness.js sync >/dev/null 2>&1 & # unharness-hook`);
  assert.match(hookWarnings()[0], /missing CLI \(\/moved\/unharness\.js\)/);
}));

test('skills: sync refreshes stale installed copies, never installs new ones', () => withClaudeDir((dir) => {
  const md = (s: string) => path.join(dir, 'skills', s, 'SKILL.md');
  mkdirSync(path.dirname(md('unharness')), { recursive: true });
  writeFileSync(md('unharness'), '---\nname: unharness\ndescription: old\n---\nold');
  mkdirSync(path.dirname(md('summarize-run')), { recursive: true });
  writeFileSync(md('summarize-run'), '---\nname: someone-elses\n---\nmine'); // same dir name, not our skill
  updateSkills();
  assert.equal(readFileSync(md('unharness'), 'utf8'), readFileSync(path.join(import.meta.dirname, '..', 'skills', 'unharness', 'SKILL.md'), 'utf8'));
  assert.equal(readFileSync(md('summarize-run'), 'utf8'), '---\nname: someone-elses\n---\nmine');

  const fresh = mkdtempSync(path.join(tmp, 'claude-')); // nothing installed: nothing appears
  process.env.UNHARNESS_CLAUDE_DIR = fresh;
  updateSkills();
  assert.equal(existsSync(path.join(fresh, 'skills')), false);
}));

test('db: refuses a database from a newer Unharness', () => {
  const f = path.join(tmp, 'newer', 'db.sqlite');
  openDb(f).exec('PRAGMA user_version = 99');
  assert.throws(() => openDb(f), /created by a newer Unharness \(schema v99; this version supports v\d+\)/);
});

test('routing: repo marker > longest route > default', () => {
  const repo = path.join(tmp, 'code', 'private', 'secret-repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const c = {
    profiles: { work: { home: path.join(tmp, 'work') }, private: { home: path.join(tmp, 'private') } },
    routes: [{ path: path.join(tmp, 'code'), profile: 'work' }, { path: path.join(tmp, 'code', 'private'), profile: 'private' }],
    default: null,
  };
  assert.equal(routeFor(path.join(tmp, 'code', 'x'), c), 'work');
  assert.equal(routeFor(repo, c), 'private');
  assert.equal(routeFor('/somewhere/else', c), null);
  assert.equal(routeFor(null, c), null);
  writeFileSync(path.join(repo, '.unharness.json'), JSON.stringify({ profile: 'work' }));
  assert.equal(routeFor(repo, c), 'work');
  writeFileSync(path.join(repo, '.unharness.json'), JSON.stringify({ profile: null }));
  assert.equal(routeFor(repo, c), null);
  assert.equal(routeFor('/x', {}), 'default'); // no profiles: everything goes to the single implicit db
  assert.equal(dbFile('private', c), path.join(tmp, 'private', 'db.sqlite'));
});

test('routing: a worktree outside the routes follows its main checkout', () => {
  const base = realpathSync(tmp); // git reports realpaths (macOS: /var -> /private/var)
  const main = path.join(base, 'wt-code', 'work-repo'), wt = path.join(base, 'elsewhere', 'wt');
  mkdirSync(main, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  git('worktree', 'add', '-q', wt);
  const c = { profiles: { work: { home: 'w' }, private: { home: 'p' } }, routes: [{ path: path.join(base, 'wt-code'), profile: 'work' }], default: 'private' };
  assert.equal(routeFor(wt, c), 'work');
  assert.equal(routeFor(path.join(base, 'elsewhere'), c), 'private');
  writeFileSync(path.join(main, '.unharness.json'), JSON.stringify({ profile: 'private' })); // untracked: only in main
  assert.equal(routeFor(wt, c), 'private');
});

test('sync routes each session to its profile; --rebuild re-routes and keeps tags', async () => {
  const { main } = await import('../src/cli.ts');
  const count = (p: string) => (openDb(dbFile(p)).prepare("SELECT count(*) n FROM run WHERE harness = 'claude-code'").get() as { n: number }).n;
  // claude-code fixtures work in /nonexistent/unharness-fixture/demo-repo; codex fixtures elsewhere
  saveConfig({
    profiles: { work: { home: path.join(tmp, 'w') }, private: { home: path.join(tmp, 'p') } },
    routes: [{ path: '/nonexistent/unharness-fixture', profile: 'private' }], default: 'work',
  });
  const log = console.log;
  console.log = () => {};
  try {
    await main(['sync']);
    assert.ok(count('private') > 0);
    assert.equal(count('work'), 0);
    const id = (openDb(dbFile('private')).prepare("SELECT id FROM run WHERE harness = 'claude-code' LIMIT 1").get() as { id: string }).id;
    openDb(dbFile('private')).prepare('INSERT INTO run_tag VALUES (?, ?)').run(id, 'exp:moved');

    saveConfig({ profiles: { work: { home: path.join(tmp, 'w') }, private: { home: path.join(tmp, 'p') } }, routes: [], default: 'work' });
    await main(['sync', '--rebuild', '--yes']);
    assert.ok(existsSync(dbFile('work') + '.bak'));
    assert.equal(count('private'), 0);
    assert.ok(count('work') > 0);
    assert.ok(openDb(dbFile('work')).prepare('SELECT 1 FROM run_tag WHERE run_id = ? AND tag = ?').get(id, 'exp:moved'));
  } finally {
    console.log = log;
  }
});
