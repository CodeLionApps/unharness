// `unharness setup`: detect installed agents, install/remove sync hooks, configure profiles, install the skills.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { claudeDir } from './adapters/claude-code.ts';
import { codexDir } from './adapters/codex.ts';
import { configFile, expand, loadConfig, saveConfig, type Config } from './profiles.ts';

export const MARKER = 'unharness-hook';
// legacy: hooks installed under the old name (agentlens) count as ours, so setup replaces them and --uninstall
// removes them. Can be dropped once nobody has the old hooks installed.
const LEGACY_MARKER = 'agentlens-hook';
const isOurs = (command?: string) => !!command && (command.includes(MARKER) || command.includes(LEGACY_MARKER));

// Claude-Code-style hooks JSON ({"hooks": {"<Event>": [{"hooks": [{"type": "command", "command": ...}]}]}}).
type HookFile = { hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]> };

export function hasHook(f: HookFile, event: string): boolean {
  return !!f.hooks?.[event]?.some((g) => g.hooks?.some((h) => isOurs(h.command)));
}

export function addHook(f: HookFile, event: string, command: string): HookFile {
  const out = removeHook(f, event);
  out.hooks ??= {};
  (out.hooks[event] ??= []).push({ hooks: [{ type: 'command', command }] });
  return out;
}

// Removes only our entries; everything else in the file stays as it was.
export function removeHook(f: HookFile, event: string): HookFile {
  const out: HookFile = structuredClone(f);
  const groups = out.hooks?.[event];
  if (!groups) return out;
  const kept = groups
    .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h.command)) }))
    .filter((g) => g.hooks.length);
  if (kept.length) out.hooks![event] = kept;
  else delete out.hooks![event];
  if (!Object.keys(out.hooks!).length) delete out.hooks;
  return out;
}

interface Agent {
  name: string;
  detected: boolean;
  hook?: { file: string; event: string }; // undefined = Unharness can't collect from it yet
  skillsDir?: string;
}

function agents(): Agent[] {
  const h = homedir();
  const cc = claudeDir(), cx = codexDir();
  return [
    { name: 'Claude Code', detected: existsSync(cc), hook: { file: path.join(cc, 'settings.json'), event: 'SessionEnd' }, skillsDir: path.join(cc, 'skills') },
    // Codex: Stop (end of each turn), because SessionEnd only fires when the app closes / idles 30 min (VS Code)
    { name: 'Codex', detected: existsSync(cx), hook: { file: path.join(cx, 'hooks.json'), event: 'Stop' }, skillsDir: path.join(cx, 'skills') },
    { name: 'opencode', detected: existsSync(path.join(h, '.config', 'opencode')) },
    { name: 'Pi', detected: existsSync(path.join(h, '.pi')) },
    { name: 'Gemini CLI', detected: existsSync(path.join(h, '.gemini')) },
    { name: 'Cursor', detected: existsSync(path.join(h, '.cursor')) },
  ];
}

const readJson = (f: string): HookFile => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});

// Hooks hardcode the node and CLI paths (see hookCommand), so a Node upgrade (nvm) or a moved checkout breaks them
// silently: their output goes to /dev/null. Returns e.g. "missing node (/path)" per broken path, [] when fine.
export function brokenHookPaths(command: string): string[] {
  const m = /^(\S+)\s.*?(\S+)\s+sync\b/.exec(command);
  if (!m) return [];
  return [['node', m[1]], ['CLI', m[2]]].filter(([, p]) => !existsSync(p)).map(([what, p]) => `missing ${what} (${p})`);
}

function brokenHook(a: Agent): string[] {
  let f: HookFile;
  try { f = readJson(a.hook!.file); } catch { return []; }
  const ours = Object.values(f.hooks ?? {}).flat().flatMap((g) => g.hooks ?? []).filter((h) => isOurs(h.command));
  return [...new Set(ours.flatMap((h) => brokenHookPaths(h.command)))];
}

// One line per agent whose installed hook points at a missing path. Cheap: reads two small JSON files.
export function hookWarnings(): string[] {
  return agents().filter((a) => a.hook).flatMap((a) => {
    const broken = brokenHook(a);
    return broken.length ? [`${a.name} hook points at a ${broken.join(' and a ')}; run \`unharness setup\` to fix`] : [];
  });
}

// Called by every sync: refresh the package's skills where an older copy is installed, so a package update reaches
// the agents. Never installs a skill that isn't there already. Silent; errors are ignored.
export function updateSkills() {
  const src = path.join(import.meta.dirname, '..', 'skills');
  const name = (md: string) => /^name:\s*(\S+)\s*$/m.exec(md)?.[1];
  try {
    for (const a of agents()) {
      if (!a.skillsDir) continue;
      for (const s of readdirSync(src)) {
        const dst = path.join(a.skillsDir, s, 'SKILL.md');
        if (!existsSync(dst)) continue;
        const want = readFileSync(path.join(src, s, 'SKILL.md'), 'utf8'), have = readFileSync(dst, 'utf8');
        if (have !== want && name(have) === name(want)) writeFileSync(dst, want);
      }
    }
  } catch {}
}

function writeJson(f: string, v: unknown) {
  mkdirSync(path.dirname(f), { recursive: true });
  if (existsSync(f)) copyFileSync(f, `${f}.unharness-bak`);
  writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
}

// Absolute paths: hooks run without the user's shell PATH (nvm etc.). Background + silent so the agent never waits.
function hookCommand(): string {
  const bin = realpathSync(process.argv[1]);
  return `${process.execPath} --disable-warning=ExperimentalWarning ${bin} sync >/dev/null 2>&1 & # ${MARKER}`;
}

// Codex skips user hooks until trusted (`/hooks` in the TUI). Do what the TUI does: ask `codex app-server` for each
// hook's key + current hash (hooks/list) and record ours as trusted in config.toml. Editing the hook untrusts it again.
async function trustCodexHooks() {
  const fallback = () => console.log('  ! could not trust the hook automatically: open `codex`, run /hooks and trust the Unharness hook');
  const hooks = await new Promise<any[] | null>((resolve) => {
    const p = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const done = (v: any[] | null) => { clearTimeout(t); p.kill(); resolve(v); };
    const t = setTimeout(() => done(null), 20_000);
    p.on('error', () => done(null));
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) p.stdin.write(JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [homedir()] } }) + '\n');
        if (m.id === 2) done(m.result?.data?.flatMap((d: any) => d.hooks ?? []) ?? null);
      }
    });
    p.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'unharness', version: '1' } } }) + '\n');
  });
  if (!hooks) return fallback();
  const ours = hooks.filter((h) => h.command?.includes(MARKER) && h.trustStatus !== 'trusted' && h.key && h.currentHash);
  if (!ours.length) return;
  const toml = path.join(codexDir(), 'config.toml');
  const text = existsSync(toml) ? readFileSync(toml, 'utf8') : '';
  if (existsSync(toml)) copyFileSync(toml, `${toml}.unharness-bak`);
  writeFileSync(toml, text.replace(/\n*$/, '\n') + ours.map((h) => `\n[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash = ${JSON.stringify(h.currentHash)}\n`).join(''));
  console.log(`  ✓ trusted in ${toml}`);
}

type Ask = (q: string, def: string) => Promise<string>;
const yes = (a: string) => /^y/i.test(a);

export async function setup(v: { yes?: boolean; uninstall?: boolean }) {
  if (!v.yes && !process.stdin.isTTY) throw new Error('setup is interactive; run it in a terminal or pass --yes');
  const rl = v.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (q, def) => (rl ? (await rl.question(`${q} [${def}] `)).trim() || def : def);
  try {
    const list = agents();
    console.log('Agents on this machine:');
    for (const a of list) {
      const state = !a.detected ? 'not found' : !a.hook ? 'found, not supported yet' : hasHook(readJson(a.hook.file), a.hook.event) ? 'hook installed' : 'no hook';
      console.log(`  ${a.name.padEnd(12)} ${state}`);
    }
    for (const w of hookWarnings()) console.log(`  ! ${w}`);
    console.log();

    if (process.argv[1]?.includes('/_npx/') && !v.uninstall) {
      console.log('! running from the npx cache: hooks would point at a temporary copy. Install first: npm i -g @codelionapps/unharness\n');
      return;
    }

    for (const a of list.filter((a) => a.detected && a.hook)) {
      const { file, event } = a.hook!;
      const f = readJson(file);
      if (v.uninstall) {
        if (hasHook(f, event)) { writeJson(file, removeHook(f, event)); console.log(`✓ removed ${a.name} hook from ${file}`); }
        continue;
      }
      const has = hasHook(f, event), ok = has && !brokenHook(a).length;
      if (yes(await ask(`${has ? 'Reinstall' : 'Install'} sync hook for ${a.name} (${file})?`, ok ? 'n' : 'Y'))) {
        writeJson(file, addHook(f, event, hookCommand()));
        console.log(`✓ ${a.name}: ${event} hook → unharness sync (backup: ${path.basename(file)}.unharness-bak)`);
        if (a.name === 'Codex') await trustCodexHooks();
      }
    }
    if (v.uninstall) return;

    await profiles(ask, !!v.yes);

    const skillTargets = list.filter((a) => a.detected && a.skillsDir);
    const skillsSrc = path.join(import.meta.dirname, '..', 'skills');
    const skills = readdirSync(skillsSrc);
    if (skillTargets.length && yes(await ask(`Install the Unharness skills (${skills.join(', ')}) for ${skillTargets.map((a) => a.name).join(' + ')}?`, 'Y'))) {
      for (const a of skillTargets) {
        // legacy: the old `agentlens` skill is replaced by `unharness`. Can be dropped later.
        const legacy = path.join(a.skillsDir!, 'agentlens');
        const legacyMd = path.join(legacy, 'SKILL.md');
        if (existsSync(legacyMd) && /^name:\s*agentlens\s*$/m.test(readFileSync(legacyMd, 'utf8'))) {
          rmSync(legacy, { recursive: true, force: true });
          console.log(`✓ removed legacy skill ${legacy}`);
        }
        for (const s of skills) {
          const dst = path.join(a.skillsDir!, s, 'SKILL.md');
          mkdirSync(path.dirname(dst), { recursive: true });
          copyFileSync(path.join(skillsSrc, s, 'SKILL.md'), dst);
          console.log(`✓ skill → ${dst}`);
        }
      }
    }

    if (yes(await ask('Run the first sync now?', 'Y'))) spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', process.argv[1], 'sync'], { stdio: 'inherit' });
  } finally {
    rl?.close();
  }
}

// Optional: separate databases per group of projects (e.g. work vs private), routed by directory.
async function profiles(ask: Ask, auto: boolean) {
  const c: Config = loadConfig();
  if (c.profiles) {
    console.log(`\nProfiles (${configFile()}):`);
    for (const [n, p] of Object.entries(c.profiles)) {
      const dirs = (c.routes ?? []).filter((r) => r.profile === n).map((r) => r.path);
      console.log(`  ${n.padEnd(10)} ${p.home}${dirs.length ? `  ← ${dirs.join(', ')}` : ''}${c.default === n ? '  (default)' : ''}`);
    }
    if (c.default === null) console.log('  sessions outside these directories are not collected');
    if (!yes(await ask('Change profiles?', 'n'))) return;
  } else if (auto || !yes(await ask('\nKeep separate databases for different projects (e.g. work vs private)?', 'n'))) return;

  const profs: NonNullable<Config['profiles']> = {};
  const routes: NonNullable<Config['routes']> = [];
  for (let i = 0; ; i++) {
    const name = await ask(i === 0 ? 'Profile name' : 'Another profile name (empty to finish)', i === 0 ? 'work' : i === 1 ? 'private' : '');
    if (!name) break;
    const home = await ask(`  data dir for "${name}"`, i === 0 ? '~/.unharness' : `~/.unharness-${name}`);
    profs[name] = { home };
    const dirs = await ask(`  project directories for "${name}" (comma-separated, empty = none)`, '');
    for (const d of dirs.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!existsSync(expand(d))) console.log(`  ! ${d} does not exist (kept anyway)`);
      routes.push({ path: d, profile: name });
    }
    if (i >= 1 && !yes(await ask('  Add another profile?', 'n'))) break;
  }
  if (!Object.keys(profs).length) return;
  const names = Object.keys(profs);
  const def = await ask(`Profile for sessions outside these directories (${names.join(' / ')} / none)`, names[0]);
  saveConfig({ ...c, profiles: profs, routes, default: def === 'none' ? null : names.includes(def) ? def : names[0] });
  console.log(`✓ saved ${configFile()}`);
  console.log('  Per repo override: put {"profile": "<name>"} (or {"profile": null} to skip) in <repo>/.unharness.json');
  console.log('  Already imported sessions stay where they are; `unharness sync --rebuild` re-imports everything into the new profiles (asks first, backs up, tags are kept).');
}
