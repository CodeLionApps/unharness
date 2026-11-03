import { notFound } from 'next/navigation';
import { runDetail, type SubagentNode } from '../../../../src/queries.ts';
import { Timeline } from '../../charts.tsx';
import { db, dt, dur, num, pct, runHref, usd } from '../../lib.tsx';

export const dynamic = 'force-dynamic';

const FILES_TOP = 25;

function Tree({ nodes, root }: { nodes: SubagentNode[]; root?: boolean }) {
  return (
    <ul className={`tree${root ? ' root' : ''}`}>
      {nodes.map((s, i) => (
        <li key={i}>
          <strong>{s.agent_type}</strong>{' '}
          {s.status !== 'ok' && <span className="tag removed">{s.status}</span>}
          {s.run ? (
            <>
              <a href={runHref(s.run.id)} className="mono">{s.run.id}</a>
              <span className="sub"> · {usd(s.run.cost_total)} · {num(s.run.total.tokens)} tok · {s.run.total.tool_calls} tool calls · {s.run.models.join(', ')}</span>
            </>
          ) : <span className="sub"> · child log not found</span>}
          {s.children.length > 0 && <Tree nodes={s.children} />}
        </li>
      ))}
    </ul>
  );
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let d: ReturnType<typeof runDetail>;
  try {
    d = runDetail(await db(), decodeURIComponent(id));
  } catch {
    notFound();
  }
  const { run: r } = d;
  const reqSeqOfTool = new Map(d.toolCalls.map((t) => [t.seq, t.request_seq]));
  const hit = r.input + r.cache_read + r.cache_write ? r.cache_read / (r.input + r.cache_read + r.cache_write) : null;
  const parts = [
    { k: 'Input (uncached)', v: r.input, c: 's1' },
    { k: 'Cache read', v: r.cache_read, c: 's2' },
    { k: 'Cache write', v: r.cache_write, c: 's3' },
    { k: 'Output', v: r.output, c: 's4' },
  ];

  return (
    <>
      <div className="head">
        <div>
          <h1>{r.harness} run · {r.repo ?? 'unknown repo'}</h1>
          <div className="sub mono">{r.id}</div>
        </div>
        <a href="/runs">← all runs</a>
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>Run</h2>
          <dl className="meta">
            <dt>Harness</dt><dd>{r.harness} {r.harness_version}</dd>
            <dt>Repo · branch</dt><dd>{r.repo ?? '–'} · {r.branch ?? '–'}</dd>
            <dt>Models</dt><dd>{r.models.join(', ') || '–'}</dd>
            <dt>Started → ended</dt><dd>{dt(r.started_at)} → {dt(r.ended_at)}</dd>
            <dt>Active · model · tools</dt><dd>{dur(r.active_ms)} · {dur(r.model_ms)} · {dur(r.tool_ms)}</dd>
            {r.parent_run_id && <><dt>Parent run</dt><dd><a className="mono" href={runHref(r.parent_run_id)}>{r.parent_run_id}</a></dd></>}
            {r.resumed_from_run_id && <><dt>Resumed from</dt><dd><a className="mono" href={runHref(r.resumed_from_run_id)}>{r.resumed_from_run_id}</a></dd></>}
            <dt>Setup</dt><dd className="mono">{r.setup_fingerprint_id ? <a href="/setup">{r.setup_fingerprint_id}</a> : '–'}</dd>
            <dt>Tags</dt><dd>{r.tags.length ? r.tags.map((t) => <span key={t} className="tag">{t}</span>) : '–'}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Cost &amp; tokens</h2>
          <div className="kpis" style={{ marginBottom: 8 }}>
            <div className="kpi"><div className="label">Cost incl. subagents</div><div className="value">{usd(r.cost_total)}{r.cost_missing && <span className="missing" title="Some requests used a model without a known price">*</span>}</div><div className="delta">own {usd(r.cost)}</div></div>
            <div className="kpi"><div className="label">Tokens (own)</div><div className="value">{num(r.tokens)}</div><div className="delta">{r.requests} requests</div></div>
            <div className="kpi"><div className="label">Cache hit rate</div><div className="value">{pct(hit, 1)}</div><div className="delta">reasoning {num(r.reasoning)}</div></div>
          </div>
          <div className="stackbar" role="img" aria-label="Token mix">
            {parts.map((p) => <span key={p.k} className={p.c} style={{ flexGrow: p.v }} title={`${p.k}: ${num(p.v)}`} />)}
          </div>
          <div className="legend">{parts.map((p) => <span key={p.k}><i className={p.c} />{p.k} {num(p.v)} ({pct(r.tokens ? p.v / r.tokens : null)})</span>)}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Context per request</h2>
        <p className="note">Context = input + cache read + cache write per request. Dashed lines: compactions. Dots: checks (green passed, red failed, grey unknown exit code) at the request that ran them.</p>
        {d.requests.length ? (
          <Timeline label="Context size per request" fmt={(v) => num(v, 0)}
            points={d.requests.map((q) => ({ x: q.seq, y: q.context, title: `#${q.seq} ${q.model}: context ${num(q.context)}, output ${num(q.output)}, ${usd(q.cost_usd)}` }))}
            markers={d.compactions.map((c) => ({ x: c.at_request_seq, title: `Compaction (${c.trigger}) at #${c.at_request_seq}: ${num(c.tokens_before)} → ${num(c.tokens_after)}` }))}
            dots={d.checks.map((c) => ({ x: reqSeqOfTool.get(c.seq_in_run) ?? 0, ok: c.passed == null ? null : !!c.passed, title: `${c.check_class} (${c.runner}): ${c.passed == null ? 'unknown' : c.passed ? 'passed' : `failed, exit ${c.exit_code}`}` }))} />
        ) : <p className="sub">No model requests recorded.</p>}
      </div>

      <div className="grid g2">
        <div className="card tablewrap">
          <h2>Tools</h2>
          {!d.tools.length ? <p className="sub">No tool calls.</p> : (
            <table>
              <thead><tr><th>Tool</th><th>Kind</th><th className="r">Calls</th><th className="r">Errors</th><th className="r">Denied</th><th className="r">Avg time</th><th className="r">Result tok</th></tr></thead>
              <tbody>{d.tools.map((t) => (
                <tr key={t.tool_name}>
                  <td className="mono">{t.tool_name}</td><td>{t.tool_kind}</td><td className="r">{t.calls}</td>
                  <td className={`r${t.errors ? ' up' : ''}`}>{t.errors || ''}</td><td className="r">{t.denied || ''}</td>
                  <td className="r">{dur(t.avg_ms)}</td><td className="r">{num(t.result_tokens)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        <div className="card tablewrap">
          <h2>Checks</h2>
          {!d.checks.length ? <p className="sub">No checks detected.</p> : (
            <table>
              <thead><tr><th></th><th>Class</th><th>Runner</th><th className="r">Exit</th><th className="r">Request</th><th className="r">Time</th></tr></thead>
              <tbody>{d.checks.map((c) => (
                <tr key={c.seq}>
                  <td><span className={`dot ${c.passed == null ? 'none' : c.passed ? 'green' : 'red'}`} aria-label={c.passed == null ? 'unknown' : c.passed ? 'passed' : 'failed'} /></td>
                  <td className="mono">{c.check_class}</td><td>{c.runner}</td><td className="r">{c.exit_code ?? '?'}</td>
                  <td className="r">#{reqSeqOfTool.get(c.seq_in_run) ?? '?'}</td><td className="r">{dur(c.duration_ms)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Subagents</h2>
          {d.subagents.length ? <Tree nodes={d.subagents} root /> : <p className="sub">No subagents spawned.</p>}
        </div>
        <div className="card tablewrap">
          <h2>Skills</h2>
          {!d.skills.length ? <p className="sub">No skills invoked.</p> : (
            <table>
              <thead><tr><th>Skill</th><th>Source</th><th className="r">Calls</th><th className="r">Tokens loaded</th></tr></thead>
              <tbody>{d.skills.map((s) => <tr key={s.skill_name + s.source}><td>{s.skill_name}</td><td>{s.source}</td><td className="r">{s.calls}</td><td className="r">{num(s.tokens_loaded)}</td></tr>)}</tbody>
            </table>
          )}
          <h2 style={{ marginTop: 16 }}>Compactions</h2>
          {!d.compactions.length ? <p className="sub">None.</p> : (
            <table>
              <thead><tr><th className="r">At request</th><th>Trigger</th><th className="r">Before</th><th className="r">After</th></tr></thead>
              <tbody>{d.compactions.map((c) => <tr key={c.seq}><td className="r">#{c.at_request_seq}</td><td>{c.trigger}</td><td className="r">{num(c.tokens_before)}</td><td className="r">{num(c.tokens_after)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 16 }}>
        <div className="card tablewrap">
          <h2>Files <span className="sub">({r.files_read} read · {r.files_edited} edited · {r.rereads} re-reads)</span></h2>
          {!d.files.length ? <p className="sub">No file access recorded.</p> : (
            <>
              <table>
                <thead><tr><th>Path</th><th>Op</th><th className="r">Count</th></tr></thead>
                <tbody>{d.files.slice(0, FILES_TOP).map((f) => <tr key={f.op + f.path}><td className="mono wrap">{f.path}</td><td>{f.op}</td><td className="r">{f.count}</td></tr>)}</tbody>
              </table>
              {d.files.length > FILES_TOP && <p className="note">+ {d.files.length - FILES_TOP} more</p>}
            </>
          )}
        </div>
        <div className="card tablewrap">
          <h2>Setup fingerprint <span className="sub mono">{r.setup_fingerprint_id ?? ''}</span></h2>
          {!d.fingerprint.length ? <p className="sub">No fingerprint recorded.</p> : (
            <details className="fold">
              <summary>{d.fingerprint.length} component{d.fingerprint.length === 1 ? '' : 's'}</summary>
              <table>
                <thead><tr><th>Kind</th><th>Name</th><th>Hash</th></tr></thead>
                <tbody>{d.fingerprint.map((c) => <tr key={c.kind + c.name}><td>{c.kind}</td><td>{c.name}</td><td className="mono sub">{String(c.hash).slice(0, 10)}</td></tr>)}</tbody>
              </table>
            </details>
          )}
        </div>
      </div>
    </>
  );
}
