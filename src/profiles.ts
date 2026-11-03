// Profiles: separate databases for separate worlds (e.g. work vs private). Configured in <home>/config.json:
//   { "profiles": { "work": { "home": "~/.unharness" }, "private": { "home": "~/.unharness-private" } },
//     "routes": [{ "path": "~/Code/private", "profile": "private" }], "default": "work" }
// A run goes to: the profile named in its repo's .unharness.json ({"profile": "..."}), else the longest matching
// route, else "default" (null = don't collect). Without "profiles" there is one implicit profile in <home>.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { home, repoInfo } from './util.ts';

export interface Config {
  profiles?: Record<string, { home: string }>;
  routes?: { path: string; profile: string }[];
  default?: string | null;
  [k: string]: unknown; // e.g. "checks" (checks.ts)
}

export const IMPLICIT = 'default';
export const configFile = () => path.join(home(), 'config.json');
export const expand = (p: string) => path.resolve(p.replace(/^~(?=$|\/)/, homedir()));

export function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(c: Config) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(c, null, 2) + '\n');
}

export function profileNames(c = loadConfig()): string[] {
  return c.profiles && Object.keys(c.profiles).length ? Object.keys(c.profiles) : [IMPLICIT];
}

// Profile used by read commands: explicit > UNHARNESS_PROFILE > config default > first.
export function activeProfile(explicit?: string, c = loadConfig()): string {
  const names = profileNames(c);
  const p = explicit ?? process.env.UNHARNESS_PROFILE ?? c.default ?? names[0];
  if (!names.includes(p)) throw new Error(`unknown profile "${p}" (have: ${names.join(', ')})`);
  return p;
}

export function dbFile(profile?: string, c = loadConfig()): string {
  const p = activeProfile(profile, c);
  const dir = c.profiles?.[p] ? expand(c.profiles[p].home) : home();
  return path.join(dir, 'db.sqlite');
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

// Main checkout of a linked git worktree (e.g. ~/.codex/worktrees/81b2/demo-repo -> ~/Code/demo-repo), else null.
// Only works while the worktree still exists; a deleted one can't be traced back.
// ponytail: git returns a realpath, so a route through a symlinked dir won't match the main checkout.
const mainCache = new Map<string, string | null>();
function mainCheckout(root: string): string | null {
  if (!mainCache.has(root)) {
    let main: string | null = null;
    try {
      const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (path.basename(common) === '.git' && path.dirname(common) !== root) main = path.dirname(common);
    } catch { /* not a repo / gone */ }
    mainCache.set(root, main);
  }
  return mainCache.get(root)!;
}

// Which profile a session working in `cwd` belongs to; null = don't collect. A worktree also matches the marker
// and routes of its main checkout.
export function routeFor(cwd: string | null, c = loadConfig()): string | null {
  if (!c.profiles) return IMPLICIT;
  const root = cwd ? repoInfo(cwd).root : null;
  const main = root ? mainCheckout(root) : null;
  for (const dir of [root, main]) {
    const marker = dir && path.join(dir, '.unharness.json');
    // turbopackIgnore: a dynamic path would make the dashboard build trace (and ship) the whole repo
    if (marker && existsSync(/*turbopackIgnore: true*/ marker)) {
      try {
        const p = JSON.parse(readFileSync(/*turbopackIgnore: true*/ marker, 'utf8')).profile;
        if (p === null || (typeof p === 'string' && c.profiles[p])) return p;
      } catch { /* malformed marker: fall through to routes */ }
    }
  }
  const dirs = [cwd && path.resolve(cwd), main].filter((d): d is string => !!d);
  const hit = (c.routes ?? []).filter((r) => dirs.some((d) => under(d, expand(r.path)))).sort((a, b) => expand(b.path).length - expand(a.path).length)[0];
  if (hit && c.profiles[hit.profile]) return hit.profile;
  return c.default === undefined ? Object.keys(c.profiles)[0] : c.default;
}
