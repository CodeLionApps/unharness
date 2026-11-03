// Hand-written SVG charts. Server-rendered; hover info via <title> (native tooltip).
type Fmt = (v: number) => string;

// ~3 round ticks from 0 to >= max
function ticks(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(v);
  return out;
}

const W = 1100, PAD_L = 52, PAD_R = 12; // full-width charts; strip plots use SW (half-width cards)
const SW = 620;

function YGrid({ t, y, fmt, x1 = PAD_L, x2 = W - PAD_R }: { t: number[]; y: (v: number) => number; fmt: Fmt; x1?: number; x2?: number }) {
  return (
    <g className="axis">
      {t.map((v) => (
        <g key={v}>
          <line x1={x1} x2={x2} y1={y(v)} y2={y(v)} className={v === 0 ? 'baseline' : 'grid'} />
          <text x={x1 - 6} y={y(v) + 4} textAnchor="end">{fmt(v)}</text>
        </g>
      ))}
    </g>
  );
}

export function Bars({ data, fmt, label, height = 180 }: { data: { label: string; value: number; title: string }[]; fmt: Fmt; label: string; height?: number }) {
  const top = 10, bottom = height - 22;
  const t = ticks(Math.max(0, ...data.map((d) => d.value)));
  const max = t.at(-1)!;
  const y = (v: number) => bottom - (v / max) * (bottom - top);
  const slot = (W - PAD_L - PAD_R) / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(28, slot - 2));
  const every = Math.ceil(data.length / 12);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="chart" role="img" aria-label={label}>
      <title>{label}</title>
      <YGrid t={t} y={y} fmt={fmt} />
      {data.map((d, i) => {
        const x = PAD_L + i * slot + (slot - bw) / 2;
        const h = bottom - y(d.value), r = Math.min(4, bw / 2, h), tp = bottom - h;
        return (
          <g key={i}>
            <title>{d.title}</title>
            <rect x={PAD_L + i * slot} y={top} width={slot} height={bottom - top} className="hit" />
            {d.value > 0 && <path className="bar" d={`M${x},${bottom}V${tp + r}Q${x},${tp} ${x + r},${tp}H${x + bw - r}Q${x + bw},${tp} ${x + bw},${tp + r}V${bottom}Z`} />}
            {i % every === 0 && <text className="tick" x={PAD_L + i * slot + slot / 2} y={height - 6} textAnchor="middle">{d.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// Context growth per request: area + line, vertical markers (compactions), status dots on the line (checks).
export function Timeline({ points, markers, dots, label, fmt }: {
  points: { x: number; y: number; title: string }[];
  markers: { x: number; title: string }[];
  dots: { x: number; ok: boolean | null; title: string }[];
  label: string;
  fmt: Fmt;
}) {
  const height = 240, top = 14, bottom = height - 24;
  const t = ticks(Math.max(0, ...points.map((p) => p.y)));
  const maxY = t.at(-1)!;
  const maxX = Math.max(1, ...points.map((p) => p.x));
  const X = (v: number) => PAD_L + (v / maxX) * (W - PAD_L - PAD_R);
  const Y = (v: number) => bottom - (v / maxY) * (bottom - top);
  const yAt = new Map(points.map((p) => [p.x, p.y]));
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const area = points.length ? `${line}L${X(points.at(-1)!.x)},${bottom}L${X(points[0].x)},${bottom}Z` : '';
  const stack = new Map<number, number>();
  const step = Math.max(1, Math.ceil(maxX / 10));
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="chart" role="img" aria-label={label}>
      <title>{label}</title>
      <YGrid t={t} y={Y} fmt={fmt} />
      {Array.from({ length: Math.floor(maxX / step) + 1 }, (_, i) => i * step).map((s) => (
        <text key={s} className="tick" x={X(s)} y={height - 6} textAnchor="middle">{s}</text>
      ))}
      <path d={area} className="area" />
      <path d={line} className="line" />
      {markers.map((m, i) => (
        <g key={i} className="marker">
          <title>{m.title}</title>
          <line x1={X(m.x)} x2={X(m.x)} y1={top} y2={bottom} />
          <rect x={X(m.x) - 5} y={top} width={10} height={bottom - top} className="hit" />
          <text x={X(m.x) + 3} y={top + 8}>compaction</text>
        </g>
      ))}
      {points.map((p) => (
        <g key={p.x}>
          <title>{p.title}</title>
          <rect x={X(p.x) - 4} y={top} width={8} height={bottom - top} className="hit" />
        </g>
      ))}
      {dots.map((d, i) => {
        const k = stack.get(d.x) ?? 0;
        stack.set(d.x, k + 1);
        return (
          <circle key={i} cx={X(d.x)} cy={Y(yAt.get(d.x) ?? 0) - 10 - k * 9} r={4.5} className={`dot ${d.ok == null ? 'unk' : d.ok ? 'ok' : 'bad'}`}>
            <title>{d.title}</title>
          </circle>
        );
      })}
    </svg>
  );
}

// One strip per group on a shared x scale: jittered dots, p25–p75 box, median tick.
export function Strip({ rows, fmt, label }: { rows: { label: string; values: number[]; warn?: boolean }[]; fmt: Fmt; label: string }) {
  const rowH = 34, top = 6, padL = 130;
  const height = top + rows.length * rowH + 22;
  const t = ticks(Math.max(0, ...rows.flatMap((r) => r.values)));
  const max = t.at(-1)!;
  const X = (v: number) => padL + (v / max) * (SW - padL - PAD_R);
  const q = (s: number[], p: number) => { const pos = (s.length - 1) * p, lo = Math.floor(pos); return s[lo] + (s[Math.ceil(pos)] - s[lo]) * (pos - lo); };
  return (
    <svg viewBox={`0 0 ${SW} ${height}`} className="chart" role="img" aria-label={label}>
      <title>{label}</title>
      <g className="axis">
        {t.map((v) => (
          <g key={v}>
            <line x1={X(v)} x2={X(v)} y1={top} y2={height - 20} className={v === 0 ? 'baseline' : 'grid'} />
            <text x={X(v)} y={height - 6} textAnchor="middle">{fmt(v)}</text>
          </g>
        ))}
      </g>
      {rows.map((r, i) => {
        const cy = top + i * rowH + rowH / 2;
        const s = [...r.values].sort((a, b) => a - b);
        return (
          <g key={r.label}>
            <text x={padL - 8} y={cy + 4} textAnchor="end" className="rowlabel">{r.warn ? '⚠ ' : ''}{r.label.length > 18 ? r.label.slice(0, 17) + '…' : r.label}</text>
            {s.length > 0 && (
              <g>
                <title>{`${r.label}: n=${s.length}, p25 ${fmt(q(s, 0.25))}, median ${fmt(q(s, 0.5))}, p75 ${fmt(q(s, 0.75))}`}</title>
                <rect x={X(q(s, 0.25))} y={cy - 9} width={Math.max(1, X(q(s, 0.75)) - X(q(s, 0.25)))} height={18} rx={3} className="iqr" />
                <line x1={X(q(s, 0.5))} x2={X(q(s, 0.5))} y1={cy - 11} y2={cy + 11} className="median" />
              </g>
            )}
            {r.values.map((v, j) => (
              // deterministic jitter so the page is stable across renders
              <circle key={j} cx={X(v)} cy={cy + (((j * 7919) % 13) - 6) * 0.9} r={3} className="pt">
                <title>{fmt(v)}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}
