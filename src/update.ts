// Version and the once-a-day update notice. The registry check here and the pricing table refresh (pricing.ts) are
// Unharness's only network calls; neither sends anything about your sessions.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { home } from './util.ts';

const REGISTRY = 'https://registry.npmjs.org/@codelionapps%2funharness/latest';
const DAY = 8.64e7;

// package.json sits one level above both src/ and dist/
export const version = (): string => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// a > b for x.y.z versions; a prerelease (x.y.z-tag) is older than its release. Malformed input is never newer.
// ponytail: prereleases of the same x.y.z compare equal; compare their tags if we ever publish several.
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string) => [...v.split('-')[0].split('.').map(Number), v.includes('-') ? 0 : 1];
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// The notice line when a newer version is published, else undefined. Checks the registry at most once per 24h
// (cached in <home>/update-check.json, failures too, so offline use never waits twice a day), with a 1.5 s timeout.
// Skipped in a source checkout, without a terminal, in CI, and with UNHARNESS_NO_UPDATE_CHECK=1. Never throws.
export async function updateNotice(): Promise<string | undefined> {
  if (!import.meta.url.includes('/node_modules/') || !process.stderr.isTTY || process.env.CI || process.env.UNHARNESS_NO_UPDATE_CHECK === '1') return;
  try {
    const f = path.join(home(), 'update-check.json');
    let c: { checkedAt: number; latest?: string } | null = null;
    try { c = JSON.parse(readFileSync(f, 'utf8')); } catch {}
    if (!c || !(Date.now() - c.checkedAt < DAY)) {
      let latest = c?.latest;
      try {
        const r = await fetch(REGISTRY, { signal: AbortSignal.timeout(1500) });
        if (r.ok) latest = (await r.json()).version ?? latest;
      } catch {}
      c = { checkedAt: Date.now(), latest };
      mkdirSync(home(), { recursive: true });
      writeFileSync(f, JSON.stringify(c) + '\n');
    }
    const have = version();
    if (typeof c.latest === 'string' && isNewer(c.latest, have)) return `Unharness ${c.latest} is available (you have ${have}): npm i -g @codelionapps/unharness`;
  } catch {}
}
