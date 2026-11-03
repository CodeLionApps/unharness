import { distinct, MIN_GROUP, setupHistory, type Summary } from '../../../src/queries.ts';
import { db, day, Empty, num, pct, usd } from '../lib.tsx';

export const dynamic = 'force-dynamic';

const METRICS: { label: string; get: (s: Summary) => number | null; fmt: (v: number | null) => string; better: 'up' | 'down' }[] = [
  { label: 'Median cost / run', get: (s) => s.cost_per_run.median, fmt: usd, better: 'down' },
  { label: 'Median tokens / run', get: (s) => s.tokens_per_run.median, fmt: (v) => num(v), better: 'down' },
  { label: 'Green checks at end', get: (s) => s.pct_green_at_end, fmt: (v) => pct(v), better: 'up' },
  { label: 'Tool error rate', get: (s) => s.tool_error_rate, fmt: (v) => pct(v, 1), better: 'down' },
  { label: 'Re-reads / run', get: (s) => s.rereads_per_run, fmt: (v) => num(v), better: 'down' },
  { label: 'Compactions / run', get: (s) => s.compactions_per_run, fmt: (v) => num(v, 2), better: 'down' },
  { label: 'Cache hit rate', get: (s) => s.cache_hit_rate, fmt: (v) => pct(v, 1), better: 'up' },
];

function Change({ before, after }: { before: number | null; after: number | null }) {
  if (before == null || after == null || before === after) return null;
  return <>{after > before ? '▲' : '▼'}</>;
}

export default async function Setup() {
  if (!distinct(await db()).harnesses.length) return <><h1>Setup history</h1><Empty /></>;
  const streams = setupHistory(await db());
  return (
    <>
      <div className="head">
        <div>
          <h1>Setup history</h1>
          <div className="sub">Setup fingerprint changes per harness · repo, with metrics of the runs after vs before each change</div>
        </div>
      </div>
      <p className="note">
        Fingerprints are computed when a session is imported. For sessions backfilled by a first <code>unharness sync</code>, the fingerprint reflects the setup at import time, not necessarily the one the run actually used.
        Install the session-end hook for exact fingerprints.
      </p>
      {!streams.length && <div className="card empty">No runs with a setup fingerprint yet.</div>}
      {streams.map((s) => (
        <section className="card" key={s.stream}>
          <h2>{s.stream} <span className="sub">· {s.changes.length} setup{s.changes.length === 1 ? '' : 's'}</span></h2>
          <ol className="timeline">
            {[...s.changes].reverse().map((c) => (
              <li key={c.fingerprint + c.from}>
                <h3>
                  <span className="mono">{c.fingerprint.slice(0, 10)}</span>{' '}
                  <span className="sub">{day(c.from)} – {day(c.to)} · {c.summary.runs} run{c.summary.runs === 1 ? '' : 's'}{c.before ? ` (before: ${c.before.runs})` : ''}</span>
                </h3>
                {!c.before ? <p className="note">First setup seen in this stream.</p> : (
                  <div className="change">
                    <div>
                      {c.changed.length ? c.changed.map((x) => <span key={x.component} className={`tag ${x.change}`} title={x.change}>{x.change === 'added' ? '+' : x.change === 'removed' ? '−' : '~'} {x.component}</span>)
                        : <span className="note">Same components, hashes identical (fingerprint id changed only).</span>}
                      {(c.summary.runs < MIN_GROUP || c.before.runs < MIN_GROUP) && <p className="note">⚠ fewer than {MIN_GROUP} runs on one side: treat differences as noise.</p>}
                    </div>
                    <div className="tablewrap">
                      <table>
                        <thead><tr><th>Metric</th><th className="r">Before</th><th className="r">After</th><th></th></tr></thead>
                        <tbody>
                          {METRICS.map((m) => {
                            const b = m.get(c.before!), a = m.get(c.summary);
                            const good = b != null && a != null && a !== b && (a > b) === (m.better === 'up');
                            return (
                              <tr key={m.label}>
                                <td>{m.label}</td><td className="r">{m.fmt(b)}</td><td className="r">{m.fmt(a)}</td>
                                <td className={b != null && a != null && a !== b ? (good ? 'down' : 'up') : undefined}><Change before={b} after={a} /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}
