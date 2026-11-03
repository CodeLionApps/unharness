import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './util.ts';
import type { SetupComponent, SetupFingerprint } from './types.ts';

// Shared building blocks for adapter fingerprints. Only names + hashes leave this module.

// Hash a file, or a directory recursively (sorted relative paths + contents). null if missing.
export function hashPath(p: string): string | null {
  if (!existsSync(p)) return null;
  const st = statSync(p);
  if (st.isFile()) return sha256(readFileSync(p));
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) parts.push(`${path.relative(p, full)}\0${sha256(readFileSync(full))}`);
    }
  };
  walk(p);
  return sha256(parts.join('\n'));
}

// One component per entry of a directory (e.g. each skill / agent / command), named by entry.
export function dirComponents(kind: string, dir: string, prefix = ''): SetupComponent[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .flatMap((e) => {
      const hash = hashPath(path.join(dir, e.name));
      return hash ? [{ kind, name: prefix + e.name.replace(/\.md$/, ''), hash }] : [];
    });
}

export function fileComponent(kind: string, name: string, file: string): SetupComponent[] {
  const hash = hashPath(file);
  return hash ? [{ kind, name, hash }] : [];
}

// Hash a JSON value after removing secret-ish keys (env, headers, tokens) at any depth.
const SECRET = /^(env|headers|token|apikey|api_key|authorization|password|secret|bearer_token(_env_var)?)$/i;
export function hashJson(v: unknown): string {
  const strip = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(strip)
      : x && typeof x === 'object'
        ? Object.fromEntries(Object.entries(x).filter(([k]) => !SECRET.test(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, strip(val)]))
        : x;
  return sha256(JSON.stringify(strip(v)));
}

export function valueComponent(kind: string, name: string, value: unknown): SetupComponent[] {
  return value == null ? [] : [{ kind, name, hash: hashJson(value) }];
}

export function makeFingerprint(components: SetupComponent[]): SetupFingerprint {
  const sorted = [...components].sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`));
  return { id: sha256(sorted.map((c) => `${c.kind}/${c.name}=${c.hash}`).join('\n')).slice(0, 16), components: sorted };
}
