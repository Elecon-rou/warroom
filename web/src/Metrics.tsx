import { useState } from 'react';
import { Activity, ChartNoAxesCombined, Table2 } from 'lucide-react';
import { Series, colors, short, clock, label } from './types';
type MetricsProps = {
  series: Series[];
  start: number;
  end: number;
  view: 'graph' | 'table';
  onViewChange: (view: 'graph' | 'table') => void;
};

export function Metrics({ series, start, end, view, onViewChange }: MetricsProps) {
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [hover, setHover] = useState<number | null>(null);
  const active = series.filter((_, i) => !hidden.has(i));
  const points = active.flatMap((s) => s.values.map((v) => Number(v[1]))).filter(Number.isFinite);
  const min = points.reduce((a, b) => Math.min(a, b), 0);
  const max = points.reduce((a, b) => Math.max(a, b), 1) * 1.12;
  const W = 1100;
  const H = 294;
  const L = 62;
  const R = 24;
  const T = 22;
  const B = 36;
  const x = (t: number) => L + ((t - start) / (end - start)) * (W - L - R);
  const y = (v: number) => H - B - ((v - min) / (max - min)) * (H - T - B);
  const allValues = series
    .flatMap((s) => s.values.map((v) => Number(v[1])))
    .filter(Number.isFinite);
  const latest = series.map((s) => Number(s.values.at(-1)?.[1])).filter(Number.isFinite);
  const hoverTime = hover === null ? null : start + hover * (end - start);
  const nearest = (s: Series) =>
    s.values.reduce<[number, string] | null>(
      (a, b) =>
        !a || Math.abs(b[0] - (hoverTime || 0)) < Math.abs(a[0] - (hoverTime || 0)) ? b : a,
      null,
    );
  return (
    <>
      <div className="result-toolbar">
        <div className="result-title">
          <Activity size={16} /> <strong>Query results</strong>
          <span className="count">{series.length} series</span>
        </div>
        <div className="segmented">
          <button
            className={view === 'graph' ? 'selected' : ''}
            onClick={() => onViewChange('graph')}
          >
            <ChartNoAxesCombined size={14} />
            Graph
          </button>
          <button
            className={view === 'table' ? 'selected' : ''}
            onClick={() => onViewChange('table')}
          >
            <Table2 size={14} />
            Table
          </button>
        </div>
      </div>
      <div className="metrics-summary">
        <div>
          <span>Series returned</span>
          <strong>
            {series.length}
            <small> time series</small>
          </strong>
        </div>
        <div>
          <span>Latest total</span>
          <strong>
            {short(latest.reduce((a, b) => a + b, 0))}
            <small> across series</small>
          </strong>
        </div>
        <div>
          <span>Peak value</span>
          <strong>
            {short(allValues.reduce((a, b) => Math.max(a, b), -Infinity))}
            <small> in range</small>
          </strong>
        </div>
        <div>
          <span>Data points</span>
          <strong>
            {short(series.reduce((a, s) => a + s.values.length, 0))}
            <small> samples</small>
          </strong>
        </div>
      </div>
      {view === 'graph' ? (
        <>
          <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
            <svg
              role="img"
              aria-label="Metrics time series chart"
              viewBox={`0 0 ${W} ${H}`}
              onMouseMove={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                setHover(
                  Math.max(
                    0,
                    Math.min(1, (((e.clientX - box.left) / box.width) * W - L) / (W - L - R)),
                  ),
                );
              }}
            >
              {Array.from({ length: 5 }, (_, i) => {
                const v = min + ((max - min) * i) / 4;
                return (
                  <g key={i}>
                    <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="gridline" />
                    <text x={L - 14} y={y(v) + 4} textAnchor="end">
                      {short(v)}
                    </text>
                  </g>
                );
              })}
              {Array.from({ length: 7 }, (_, i) => {
                const t = start + ((end - start) * i) / 6;
                return (
                  <g key={i}>
                    <line x1={x(t)} x2={x(t)} y1={T} y2={H - B} className="gridline vertical" />
                    <text x={x(t)} y={H - 9} textAnchor="middle">
                      {clock(t)}
                    </text>
                  </g>
                );
              })}
              {series.map((s, i) => {
                if (hidden.has(i)) return null;
                let segments: string[] = [];
                let current = '';
                for (const [t, v] of s.values) {
                  const n = Number(v);
                  if (!Number.isFinite(n)) {
                    if (current) segments.push(current);
                    current = '';
                    continue;
                  }
                  current += `${current ? ' L' : 'M'}${x(t).toFixed(2)},${y(n).toFixed(2)}`;
                }
                if (current) segments.push(current);
                return (
                  <g key={i}>
                    {segments.map((d, j) => (
                      <path
                        key={j}
                        d={d}
                        fill="none"
                        stroke={colors[i % colors.length]}
                        strokeWidth="1.7"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </g>
                );
              })}
              {hoverTime !== null && (
                <g>
                  <line
                    x1={x(hoverTime)}
                    x2={x(hoverTime)}
                    y1={T}
                    y2={H - B}
                    stroke="#819a9c"
                    strokeDasharray="4 4"
                  />
                  {series.map((s, i) => {
                    const v = nearest(s);
                    return v && !hidden.has(i) && Number.isFinite(Number(v[1])) ? (
                      <circle
                        key={i}
                        cx={x(v[0])}
                        cy={y(Number(v[1]))}
                        r="3.5"
                        fill={colors[i % colors.length]}
                        stroke="#0d171c"
                        strokeWidth="2"
                      />
                    ) : null;
                  })}
                </g>
              )}
            </svg>
            {hoverTime !== null && (
              <div
                className="chart-tooltip"
                style={{ left: `${Math.min(70, Math.max(8, (hover || 0) * 85))}%` }}
              >
                <strong>{new Date(hoverTime * 1000).toLocaleString()}</strong>
                {series.slice(0, 8).map((s, i) => {
                  const v = nearest(s);
                  return !hidden.has(i) && v ? (
                    <div key={i}>
                      <i style={{ background: colors[i % colors.length] }} />
                      <span>{Object.values(s.metric).join(' · ') || 'value'}</span>
                      <b>{short(Number(v[1]))}</b>
                    </div>
                  ) : null;
                })}
              </div>
            )}
          </div>
          <div className="legend">
            {series.map((s, i) => (
              <button
                key={i}
                className={hidden.has(i) ? 'muted-series' : ''}
                title={label(s)}
                onClick={() =>
                  setHidden((old) => {
                    const n = new Set(old);
                    n.has(i) ? n.delete(i) : n.add(i);
                    return n;
                  })
                }
              >
                <i style={{ background: colors[i % colors.length] }} />
                <span>{label(s)}</span>
                <b>{short(Number(s.values.at(-1)?.[1]))}</b>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Series / labels</th>
                <th>Samples</th>
                <th>Min</th>
                <th>Max</th>
                <th>Mean</th>
                <th>Last</th>
              </tr>
            </thead>
            <tbody>
              {series.map((s, i) => {
                const vals = s.values.map((v) => Number(v[1])).filter(Number.isFinite);
                return (
                  <tr key={i}>
                    <td className="mono">
                      <i className="series-dot" style={{ background: colors[i % colors.length] }} />
                      {label(s)}
                    </td>
                    <td>{s.values.length}</td>
                    <td>{short(vals.reduce((a, b) => Math.min(a, b), Infinity))}</td>
                    <td>{short(vals.reduce((a, b) => Math.max(a, b), -Infinity))}</td>
                    <td>{short(vals.reduce((a, b) => a + b, 0) / vals.length)}</td>
                    <td>{short(Number(s.values.at(-1)?.[1]))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
