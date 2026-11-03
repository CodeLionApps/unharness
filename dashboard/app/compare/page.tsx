import { compare, distinct, MIN_GROUP, type CompareBy, type Summary } from '../../../src/queries.ts';
import { parseDuration } from '../../../src/util.ts';
import { Strip } from '../charts.tsx';
import { db, Empty, num, param, pct, usd, type SP } from '../lib.tsx';

export const dynamic = 'force-dynamic';

const BY: CompareBy[] = ['harness', 'setup', 'tag', 'model'];
const SINCE = ['7d', '30d', '90d', 'all'];

const METRICS: { label: string; get: (s: Summary) => string; hint?: string }[] = [
  { label: 'Green checks at end', get: (s) => pct(s.pct_green_at_end), hint: 'among runs that ran checks; higher is better' },
  { label: 'Runs without checks', get: (s) => pct(s.pct_no_checks) },
  { label: 'Median red before green', get: (s) => num(s.median_red_before_green) },
  { label: 'Tool error rate', get: (s) => pct(s.tool_error_rate, 1) },
  { label: 'Re-reads / run', get: (s) => num(s.rereads_per_run) },
  { label: 'Compactions / run', get: (s) => num(s.compactions_per_run, 2) },
  { label: 'Cost / run (p25 · median · p75)', get: (s) => `${usd(s.cost_per_run.p25)} · ${usd(s.cost_per_run.median)} · ${usd(s.cost_per_run.p75)}` },
  { label: 'Tokens / run (p25 · median · p75)', get: (s) => `${num(s.tokens_per_run.p25)} · ${num(s.tokens_per_run.median)} · ${num(s.tokens_per_run.p75)}` },
  { label: 'Cache hit rate', get: (s) => pct(s.cache_hit_rate, 1) },
  { label: 'Total cost', get: (s) => usd(s.cost) + (s.cost_missing_runs ? '*' : '') },
];

export default async function Compare({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  if (!distinct(await db()).harnesses.length) return <><h1>Compare</h1><Empty /></>;
  const by = (BY.includes(param(sp, 'by') as CompareBy) ? param(sp, 'by') : 'harness') as CompareBy;
  const since = SINCE.includes(param(sp, 'since') ?? '') ? param(sp, 'since')! : '30d';
  const groups = compare(await db(), by, since === 'all' ? {} : { since: Date.now() - parseDuration(since) });
  const label = (k: string) => (by === 'setup' && k !== 'unknown' ? k.slice(0, 10) : k);
  const href = (b: string, s: string) => `/compare?by=${b}&since=${s}`;
  const low = groups.filter((g) => g.lowSample);

  const dists: { title: string; key: keyof (typeof groups)[number]['dist']; fmt: (v: number) => string }[] = [
    { title: 'Cost per run', key: 'cost', fmt: usd },
    { title: 'Tokens per run', key: 'tokens', fmt: (v) => num(v, 0) },
    { title: 'Tool error rate per run', key: 'tool_error_rate', fmt: (v) => pct(v) },
    { title: 'Re-reads per run', key: 'rereads', fmt: (v) => num(v, 0) },
    { title: 'Red check runs before first green', key: 'red_before_green', fmt: (v) => num(v, 0) },
  ];

  return (
    <>
      <div className="head">
        <div>
          <h1>Compare</h1>
          <div className="sub">Top-level runs grouped by {by}{by === 'tag' || by === 'model' ? ' (a run can belong to several groups)' : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <nav className="seg" aria-label="Group by">
            {BY.map((b) => <a key={b} href={href(b, since)} aria-current={b === by ? 'page' : undefined}>{b}</a>)}
          </nav>
          <nav className="seg" aria-label="Period">
            {SINCE.map((s) => <a key={s} href={href(by, s)} aria-current={s === since ? 'page' : undefined}>{s}</a>)}
          </nav>
        </div>
      </div>
      {!groups.length ? <div className="card empty">No runs in this window{by === 'tag' ? ' carry a tag (unharness tag <run> exp:name)' : ''}.</div> : (
        <>
          {low.length > 0 && (
            <div className="warn" role="note">
              ⚠ {low.length === groups.length ? 'All groups have' : `${low.map((g) => label(g.key)).join(', ')} ${low.length === 1 ? 'has' : 'have'}`} fewer than {MIN_GROUP} runs: differences may be noise.
            </div>
          )}
          <div className="card tablewrap">
            <h2>Quality metrics</h2>
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  {groups.map((g) => <th key={g.key} className="r" title={g.key}>{label(g.key)}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Runs (n)</td>
                  {groups.map((g) => <td key={g.key} className="r">{g.lowSample ? <span className="up" title={`below ${MIN_GROUP} runs`}>⚠ {g.n}</span> : g.n}</td>)}
                </tr>
                {METRICS.map((m) => (
                  <tr key={m.label}>
                    <td title={m.hint}>{m.label}</td>
                    {groups.map((g) => <td key={g.key} className="r">{m.get(g.summary)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Distributions</h2>
          <p className="note">One dot per run; shaded box = p25–p75, vertical tick = median. ⚠ marks groups below {MIN_GROUP} runs.</p>
          <div className="grid g2">
            {dists.map((d) => (
              <div className="card" key={d.key}>
                <h3>{d.title}</h3>
                <Strip label={`${d.title} by ${by}`} fmt={d.fmt}
                  rows={groups.map((g) => ({ label: `${label(g.key)} (${g.dist[d.key].length})`, values: g.dist[d.key], warn: g.lowSample }))} />
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
