import { distinct, filterRuns, allRuns, type RunFilter } from '../../../src/queries.ts';
import { parseDuration } from '../../../src/util.ts';
import { db, dt, dur, Empty, num, param, runHref, usd, type SP } from '../lib.tsx';

export const dynamic = 'force-dynamic';

const SINCE = ['1d', '7d', '30d', '90d'];
const LIMIT = 500;

function Select({ name, label, options, value }: { name: string; label: string; options: string[]; value?: string }) {
  return (
    <label>
      {label}
      <select name={name} defaultValue={value ?? ''}>
        <option value="">all</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

export default async function Runs({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const d = distinct(await db());
  if (!d.harnesses.length) return <><h1>Runs</h1><Empty /></>;
  const since = param(sp, 'since');
  const f: RunFilter = {
    harness: param(sp, 'harness'), repo: param(sp, 'repo'), tag: param(sp, 'tag'),
    since: since && SINCE.includes(since) ? Date.now() - parseDuration(since) : undefined,
  };
  const all = filterRuns(allRuns(await db()), f);
  const rows = all.slice(0, LIMIT);

  return (
    <>
      <div className="head">
        <div>
          <h1>Runs</h1>
          <div className="sub">{all.length} top-level runs{all.length > LIMIT ? ` (showing newest ${LIMIT})` : ''} · cost includes subagents</div>
        </div>
        <form className="filters" method="get">
          <Select name="harness" label="Harness" options={d.harnesses} value={f.harness} />
          <Select name="repo" label="Repo" options={d.repos} value={f.repo} />
          <Select name="tag" label="Tag" options={d.tags} value={f.tag} />
          <Select name="since" label="Ended within" options={SINCE} value={since} />
          <button type="submit">Filter</button>
          <a href="/runs">Reset</a>
        </form>
      </div>
      <div className="card tablewrap">
        {!rows.length ? <div className="empty">No runs match these filters.</div> : (
          <table>
            <thead>
              <tr>
                <th>Ended</th><th>Harness</th><th>Repo · branch</th><th>Models</th>
                <th className="r">Cost</th><th className="r">Tokens</th><th className="r">Tools / err</th>
                <th>Checks</th><th className="r">Subagents</th><th className="r">Compactions</th><th className="r">Active</th><th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><a href={runHref(r.id)} title={r.id}>{dt(r.ended_at)}</a></td>
                  <td>{r.harness}</td>
                  <td>{r.repo ?? '–'}{r.branch ? <span className="sub"> · {r.branch}</span> : null}</td>
                  <td className="sub">{r.models.join(', ') || '–'}</td>
                  <td className="r">{usd(r.cost_total)}{r.cost_missing && <span className="missing" title="Some requests used a model without a known price">*</span>}</td>
                  <td className="r">{num(r.total.tokens)}</td>
                  <td className="r">{r.total.tool_calls} / <span className={r.total.tool_errors ? 'up' : undefined}>{r.total.tool_errors}</span></td>
                  <td><span className={`dot ${r.checks_state}`} title={`checks: ${r.checks_state}`} aria-label={`checks ${r.checks_state}`} /> <span className="sub">{r.checks || ''}</span></td>
                  <td className="r">{r.subagents || ''}</td>
                  <td className="r">{r.compactions || ''}</td>
                  <td className="r">{dur(r.active_ms)}</td>
                  <td>{r.tags.map((t) => <span key={t} className="tag">{t}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="note"><span className="dot green" /> all check classes green at end · <span className="dot red" /> some red at end · <span className="dot none" /> no checks run · <span className="missing">*</span> cost understated (unknown model price)</p>
    </>
  );
}
