import { useElementSize } from './useElementSize';
import { formatDashboardValue } from './dashboardLayout';
import { useId, useMemo, useState } from 'react';
import { colors, type ResponseData, type Series } from './types';
import type { DashboardWidget } from './dashboard';
import { chartDomain, chartSegments, nearestSample } from './dashboardChartMath.ts';
/** Preserve range samples, timestamps and missing values; no scalar reducer. */
export function DashboardTimeSeries({
  widget: w,
  response: r,
}: {
  widget: DashboardWidget;
  response: ResponseData;
}) {
  const { ref, width } = useElementSize(700);
  const W = Math.max(260, width),
    H = Math.max(220, Math.min(310, W * 0.4)),
    L = 64,
    R = 18,
    T = 16,
    B = 35,
    PW = W - L - R,
    PH = H - T - B;
  const clip = useId();
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<{ time: number; fraction: number } | null>(null);
  const all: Series[] = r.data?.data?.result || [],
    series = all.slice(0, 40),
    active = series.map((s, i) => ({ s, i })).filter(({ i }) => !hidden.has(i));
  const [min, max] = useMemo(
    () =>
      chartDomain(
        active.map(({ s }) => s),
        w.axisMode === 'fixed' ? [w.min, w.max] : undefined,
      ),
    [r, hidden, w.axisMode, w.min, w.max],
  );
  const x = (t: number) => L + ((t - r.start) / (r.end - r.start)) * PW,
    y = (v: number) => T + ((max - v) / (max - min)) * PH;
  const format = (n: number) => {
    const result = formatDashboardValue(n, w.unit);
    return result.value + (result.unit === '%' ? '%' : result.unit ? ' ' + result.unit : '');
  };
  const name = (s: Series, i: number) =>
    (w.labelField
      ? s.metric[w.labelField]
      : Object.entries(s.metric)
          .filter(([k]) => k !== '__name__')
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')) ||
    s.metric.__name__ ||
    `Series ${i + 1}`;
  const times = active
    .flatMap(({ s }) => s.values.map(([t]) => t))
    .filter((t) => Number.isFinite(t) && t >= r.start && t <= r.end)
    .sort((a, b) => a - b);
  let spacing = r.step || (r.end - r.start) / 240;
  for (let i = 1; i < times.length; i++)
    if (times[i] > times[i - 1]) spacing = Math.min(spacing, times[i] - times[i - 1]);
  const group = Math.max(0.5, Math.min(32, (spacing / (r.end - r.start)) * PW * 0.8)),
    bar = group / Math.max(1, active.length),
    zero = y(Math.max(min, Math.min(max, 0)));
  if (!series.some((s) => s.values.some(([, v]) => v.trim() !== '' && Number.isFinite(Number(v)))))
    return <p className="dashboard-empty">No data</p>;
  return (
    <div className="dashboard-timeseries" ref={ref}>
      <div className="dashboard-timeseries-plot" onPointerLeave={() => setCursor(null)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${w.title}, ${w.chartStyle === 'bars' ? 'bar' : 'line'} time series`}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect(),
              px = ((e.clientX - rect.left) / rect.width) * W,
              fraction = Math.max(0, Math.min(1, (px - L) / PW));
            setCursor({ time: r.start + fraction * (r.end - r.start), fraction });
          }}
        >
          <defs>
            <clipPath id={clip}>
              <rect x={L} y={T} width={PW} height={PH} />
            </clipPath>
          </defs>
          {Array.from({ length: 6 }, (_, i) => {
            const n = min + ((max - min) * i) / 5;
            return (
              <g key={i}>
                <line x1={L} x2={W - R} y1={y(n)} y2={y(n)} stroke="#25353d" />
                <text x={L - 10} y={y(n) + 4} fill="#8ca2ad" fontSize="11" textAnchor="end">
                  {format(n)}
                </text>
              </g>
            );
          })}
          {Array.from({ length: 7 }, (_, i) => {
            const t = r.start + ((r.end - r.start) * i) / 6;
            return (
              <g key={i}>
                <line x1={x(t)} x2={x(t)} y1={T} y2={H - B} stroke="#1d2d35" />
                <text
                  x={x(t)}
                  y={H - 10}
                  fill="#8ca2ad"
                  fontSize="11"
                  textAnchor={i === 0 ? 'start' : i === 6 ? 'end' : 'middle'}
                >
                  {new Date(t * 1000).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })}
                </text>
              </g>
            );
          })}
          <g clipPath={`url(#${clip})`}>
            {active.map(({ s, i }, position) =>
              w.chartStyle === 'bars' ? (
                <g key={i}>
                  {s.values.map(([t, v], j) => {
                    const n = Number(v);
                    if (
                      !Number.isFinite(t) ||
                      !Number.isFinite(n) ||
                      v.trim() === '' ||
                      t < r.start ||
                      t > r.end
                    )
                      return null;
                    return (
                      <rect
                        key={j}
                        x={x(t) - group / 2 + position * bar}
                        y={Math.min(y(n), zero)}
                        width={bar}
                        height={Math.max(0.5, Math.abs(zero - y(n)))}
                        fill={colors[i % colors.length]}
                        fillOpacity=".35"
                        stroke={colors[i % colors.length]}
                        strokeWidth=".7"
                      />
                    );
                  })}
                </g>
              ) : (
                <g key={i}>
                  {chartSegments(s.values, Math.max(spacing * 2.5, 1)).map((points, j) => (
                    <polyline
                      key={j}
                      points={points.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')}
                      fill="none"
                      stroke={colors[i % colors.length]}
                      strokeWidth="1.7"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </g>
              ),
            )}
            {cursor && (
              <>
                <line
                  x1={x(cursor.time)}
                  x2={x(cursor.time)}
                  y1={T}
                  y2={H - B}
                  stroke="#83939c"
                  strokeDasharray="4 4"
                />
                {active.map(({ s, i }) => {
                  const p = nearestSample(s.values, cursor.time, Math.max(spacing * 2.5, 1));
                  return p ? (
                    <circle
                      key={i}
                      cx={x(p[0])}
                      cy={y(p[1])}
                      r="3"
                      fill={colors[i % colors.length]}
                    />
                  ) : null;
                })}
              </>
            )}
          </g>
        </svg>
        {cursor && (
          <div className={`dashboard-chart-tooltip ${cursor.fraction > 0.6 ? 'left' : 'right'}`}>
            <strong>{new Date(cursor.time * 1000).toLocaleString()}</strong>
            {active.map(({ s, i }) => {
              const p = nearestSample(s.values, cursor.time, Math.max(spacing * 2.5, 1));
              return (
                <div key={i}>
                  <i style={{ background: colors[i % colors.length] }} />
                  <span>{name(s, i)}</span>
                  <b>{p ? format(p[1]) : '—'}</b>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="dashboard-chart-legend" aria-label="Time series legend">
        {series.map((s, i) => (
          <button
            key={i}
            aria-pressed={!hidden.has(i)}
            title={name(s, i)}
            className={hidden.has(i) ? 'muted' : ''}
            onClick={() =>
              setHidden((old) => {
                const next = new Set(old);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                return next;
              })
            }
          >
            <i style={{ background: colors[i % colors.length] }} />
            {name(s, i)}
          </button>
        ))}
      </div>
      {all.length > 40 && (
        <p className="dashboard-note">
          Showing 40 of {all.length} series. Narrow or aggregate the query to display fewer series.
        </p>
      )}
      {w.axisMode === 'fixed' && (
        <p className="dashboard-note">
          Axis: {format(w.min)}–{format(w.max)}. Values outside these bounds are clipped.
        </p>
      )}
    </div>
  );
}
