import { distinct, overview } from '../../src/queries.ts';
import { Bars } from './charts.tsx';
import { db, delta, day, Empty, num, param, pct, usd, type SP } from './lib.tsx';

export const dynamic = 'force-dynamic';

const PERIODS = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 } as const;

function Kpi({ label, value, cur, prev, kind = 'neutral', pp }: {
  label: string; value: string; cur: number | null; prev: number | null; kind?: 'neutral' | 'lowerBetter' | 'higherBetter'; pp?: boolean;
}) {
  // pp: show absolute change in percentage points (for rates)
  const d = pp ? (cur != null && prev != null ? cur - prev : null) : delta(cur, prev);
  const cls = d == null || d === 0 || kind === 'neutral' ? 'neutral-up' : (d > 0) === (kind === 'higherBetter') ? 'down' : 'up';
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="delta">
        {d == null ? 'no previous data' : <><span className={cls}>{d >= 0 ? '▲' : '▼'} {pp ? `${(Math.abs(d) * 100).toFixed(1)} pp` : pct(Math.abs(d))}</span> vs previous</>}
      </div>
    </div>
  );
}

function Breakdown({ title, rows, total }: { title: string; rows: { key: string; runs: number; cost: number; tokens: number }[]; total: number }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="tablewrap"><table>
        <thead><tr><th>{title.replace('By ', '')}</th><th className="r">Runs</th><th className="r">Tokens</th><th className="r">Cost</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="share"><i style={{ width: `${total ? (r.cost / total) * 100 : 0}%` }} /><span title={r.key}>{r.key}</span></td>
              <td className="r">{r.runs}</td>
              <td className="r">{num(r.tokens)}</td>
              <td className="r">{usd(r.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}

export default async function Overview({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const p = (param(sp, 'period') ?? '7d') as keyof typeof PERIODS;
  const days = PERIODS[p] ?? 7;
  const r = overview(await db(), days);
  const { current: c, previous: v } = r;
  const hasAny = distinct(await db()).harnesses.length > 0;

  return (
    <>
      <div className="head">
        <div>
          <h1>Overview</h1>
          <div className="sub">Last {days === 1 ? '24 hours' : `${days} days`} vs the {days === 1 ? '24 hours' : `${days} days`} before · top-level runs, cost includes subagents · hypothetical API prices</div>
        </div>
        <nav className="seg" aria-label="Period">
          {Object.keys(PERIODS).map((k) => <a key={k} href={`/?period=${k}`} aria-current={k === p ? 'page' : undefined}>{k}</a>)}
        </nav>
      </div>
      {!hasAny ? <Empty /> : (
        <>
          <div className="kpis">
            <Kpi label="Cost (API prices)" value={usd(c.cost)} cur={c.cost} prev={v.runs ? v.cost : null} kind="lowerBetter" />
            <Kpi label="Tokens" value={num(c.tokens)} cur={c.tokens} prev={v.runs ? v.tokens : null} />
            <Kpi label="Runs" value={String(c.runs)} cur={c.runs} prev={v.runs || null} />
            <Kpi label="Cache hit rate" value={pct(c.cache_hit_rate, 1)} cur={c.cache_hit_rate} prev={v.cache_hit_rate} kind="higherBetter" pp />
            <Kpi label="Green checks at end" value={pct(c.pct_green_at_end)} cur={c.pct_green_at_end} prev={v.pct_green_at_end} kind="higherBetter" pp />
            <Kpi label="Tool error rate" value={pct(c.tool_error_rate, 1)} cur={c.tool_error_rate} prev={v.tool_error_rate} kind="lowerBetter" pp />
          </div>
          {c.cost_missing_runs > 0 && <p className="note"><span className="missing">*</span> {c.cost_missing_runs} run(s) used a model without a known price; their cost is understated.</p>}
          <div className="card">
            <h2>Cost per day</h2>
            <Bars label="Cost per day" fmt={usd}
              data={r.daily.map((d) => ({ label: day(d.day), value: d.cost, title: `${day(d.day)}: ${usd(d.cost)} · ${d.runs} runs · ${num(d.tokens)} tokens` }))} />
          </div>
          {c.runs === 0 ? <div className="card empty">No runs ended in this period.</div> : (
            <div className="grid g3">
              <Breakdown title="By harness" rows={r.byHarness} total={c.cost} />
              <Breakdown title="By model" rows={r.byModel} total={c.cost} />
              <Breakdown title="By repo" rows={r.byRepo} total={c.cost} />
            </div>
          )}
          <p className="note">By model: runs that used several models count under each of them. Token mix this period: {num(c.input)} input · {num(c.cache_read)} cache read · {num(c.cache_write)} cache write · {num(c.output)} output.</p>
        </>
      )}
    </>
  );
}
