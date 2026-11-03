import { cookies } from 'next/headers';
import { openDb, type DB } from '../../src/db.ts';
import { activeProfile, dbFile, profileNames } from '../../src/profiles.ts';

// Profile picked in the nav (cookie), else the one the server was started with (-p / UNHARNESS_PROFILE / default).
export const PROFILE_COOKIE = 'unharness_profile';
export async function currentProfile(): Promise<string> {
  const raw = (await cookies()).get(PROFILE_COOKIE)?.value;
  const picked = raw && decodeURIComponent(raw);
  return activeProfile(picked && profileNames().includes(picked) ? picked : undefined);
}

// One read handle per profile per server process.
const handles = new Map<string, DB>();
export async function db(): Promise<DB> {
  const p = await currentProfile();
  return handles.get(p) ?? handles.set(p, openDb(dbFile(p))).get(p)!;
}

// Why the profile's database can't be opened (e.g. it was created by a newer Unharness), or null. The layout shows
// it in place of the page: Next hides a server error's message in production, which would leave a blank error.
export async function dbError(): Promise<string | null> {
  try { await db(); return null; } catch (e) { return (e as Error).message; }
}

export type SP = Promise<Record<string, string | string[] | undefined>>;
export const param = (sp: Awaited<SP>, k: string) => {
  const v = sp[k];
  return (Array.isArray(v) ? v[0] : v) || undefined;
};

export const usd = (v: number | null | undefined) =>
  v == null ? '–' : v === 0 ? '$0' : v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;

export const num = (v: number | null | undefined, digits = 1) => {
  if (v == null) return '–';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(digits)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(digits)}k`;
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(digits);
};

export const pct = (v: number | null | undefined, digits = 0) => (v == null ? '–' : `${(v * 100).toFixed(digits)}%`);

export const dur = (ms: number | null | undefined) => {
  if (ms == null) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export const dt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';
// bare YYYY-MM-DD is a local calendar day, not UTC midnight
export const day = (iso: string) => new Date(/^\d{4}-\d\d-\d\d$/.test(iso) ? `${iso}T00:00` : iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

// Relative change vs previous; null when there is no baseline.
export const delta = (cur: number | null, prev: number | null) => (cur == null || !prev ? null : (cur - prev) / prev);

export const runHref = (id: string) => `/runs/${encodeURIComponent(id)}`;

export const Empty = () => (
  <div className="card empty">
    <h2>No runs yet</h2>
    <p>Import your agent sessions with <code>unharness sync</code>, then reload.</p>
  </div>
);
