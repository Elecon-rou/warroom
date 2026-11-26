import { formatDashboardValue } from './dashboardLayout';
import { DashboardTimeSeries } from './DashboardTimeSeries';
import { useState } from 'react';
import { Logs } from './Logs';
import { colors, short, type ResponseData } from './types';
import { reduceValues, widgetRows, type DashboardWidget } from './dashboard';
import { DashboardForceGraph, type ForceData } from './DashboardForceGraph';

export type WidgetResult = {
  pending?: boolean;
  error?: string;
  response?: ResponseData;
  graph?: ForceData;
  updated?: number;
};
export function DashboardWidgetView({
  widget: w,
  result,
}: {
  widget: DashboardWidget;
  result?: WidgetResult;
}) {
  const [logView, setLogView] = useState({
    filter: '',
    wrap: true,
    sort: 'query' as 'query' | 'newest' | 'oldest',
  });
  if (result?.pending)
    return (
      <p className="dashboard-empty" role="status">
        Loading…
      </p>
    );
  if (result?.error) return <p className="inline-error">{result.error}</p>;
  if (w.type === 'force-graph')
    return result?.graph?.nodes.length ? (
      <DashboardForceGraph data={result.graph} />
    ) : (
      <p className="dashboard-empty">
        {result?.graph ? 'No service dependencies' : 'Run to load data'}
      </p>
    );
  if (!result?.response)
    return (
      <p className="dashboard-empty">{w.query.trim() ? 'Run to load data' : 'Query required'}</p>
    );
  if (w.type === 'time-series')
    return <DashboardTimeSeries widget={w} response={result.response} />;
  if (w.type === 'logs')
    return (
      <Logs
        rows={Array.isArray(result.response.data) ? result.response.data : []}
        {...logView}
        onViewChange={(patch) => setLogView((old) => ({ ...old, ...patch }))}
      />
    );
  const all = widgetRows(w, result.response),
    rows = all.slice(0, 200),
    valid = all.filter((r) => r.value !== null);
  const value = reduceValues(
    valid.map((r) => r.value!),
    w.reducer,
  );
  const color = (n: number) =>
    n >= w.critical ? '#fb7185' : n >= w.warning ? '#e8b86d' : '#2dd4bf';
  const suffix = w.unit ? ` ${w.unit}` : '';
  const truncation =
    all.length > 200 ? (
      <p className="dashboard-note">
        Showing 200 of {all.length} rows. Summary uses all returned rows.
      </p>
    ) : null;
  if (w.type === 'table') {
    const fields = [...new Set(rows.flatMap((r) => Object.keys(r.fields)))].slice(0, 20);
    return rows.length ? (
      <>
        <div className="dashboard-table">
          <table>
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f}>{f}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {fields.map((f) => (
                    <td key={f}>
                      {typeof r.fields[f] === 'object'
                        ? JSON.stringify(r.fields[f])
                        : String(r.fields[f] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {truncation}
      </>
    ) : (
      <p className="dashboard-empty">No data</p>
    );
  }
  if (!valid.length)
    return (
      <p className="dashboard-empty">
        {all.length ? 'No numeric values. Select a value field.' : 'No data'}
      </p>
    );
  const formatted = formatDashboardValue(value ?? NaN, w.unit);
  if (w.type === 'number')
    return (
      <div
        className="dashboard-number"
        style={{ color: value === null ? undefined : color(value) }}
      >
        {formatted.value}
        <small>{formatted.unit}</small>
        <span>
          {w.reducer} · {all.length} {w.source === 'metrics' ? 'series' : 'rows'}
        </span>
      </div>
    );
  if (w.type === 'gauge') {
    const progress = Math.max(0, Math.min(1, ((value ?? w.min) - w.min) / (w.max - w.min)));
    return (
      <div className="dashboard-gauge">
        <svg
          viewBox="0 0 240 150"
          role="img"
          aria-label={`${value === null ? 'No value' : short(value)}${suffix}, bounds ${w.min} to ${w.max}`}
        >
          <path
            d="M 30 120 A 90 90 0 0 1 210 120"
            fill="none"
            stroke="#23353d"
            strokeWidth="16"
            pathLength="100"
          />
          <path
            d="M 30 120 A 90 90 0 0 1 210 120"
            fill="none"
            stroke={color(value!)}
            strokeWidth="16"
            pathLength="100"
            strokeDasharray={`${progress * 100} 100`}
          />
          <text x="120" y="105" textAnchor="middle" fill="#dfeded" fontSize="27">
            {short(value!)}
            {suffix}
          </text>
          <text x="22" y="145" fill="#82969e" fontSize="12">
            {short(w.min)}
          </text>
          <text x="218" y="145" textAnchor="end" fill="#82969e" fontSize="12">
            {short(w.max)}
          </text>
        </svg>
        <small>
          {w.reducer} · {all.length} returned {w.source === 'metrics' ? 'series' : 'rows'}
        </small>
      </div>
    );
  }
  if (w.type === 'blinkenlights')
    return (
      <>
        <div className="dashboard-lights">
          {rows.map((r, i) => (
            <div
              key={i}
              title={`${r.label}: ${r.value === null ? 'No data' : short(r.value) + suffix}`}
            >
              <i style={{ background: r.value === null ? '#52616c' : color(r.value) }} />
              <span>{r.label}</span>
              <strong>{r.value === null ? '—' : short(r.value) + suffix}</strong>
            </div>
          ))}
        </div>
        <p className="dashboard-note">
          Teal &lt; {w.warning}; amber ≥ {w.warning}; red ≥ {w.critical}.
        </p>
        {truncation}
      </>
    );
  if (w.type === 'bars') {
    const max = Math.max(1, ...rows.map((r) => Math.abs(r.value ?? 0)));
    return (
      <>
        <div className="dashboard-bars">
          {rows.map((r, i) => (
            <div key={i} title={r.label}>
              <span>{r.label}</span>
              <div>
                <i
                  style={{
                    width: `${(Math.abs(r.value ?? 0) / max) * 100}%`,
                    background: colors[i % colors.length],
                  }}
                />
              </div>
              <strong>{r.value === null ? '—' : short(r.value) + suffix}</strong>
            </div>
          ))}
        </div>
        {truncation}
      </>
    );
  }
  // A pie represents proportions. Signed and zero-only data have no valid slices.
  const negative = rows.some((r) => (r.value ?? 0) < 0),
    positive = rows.filter((r) => (r.value ?? 0) > 0),
    total = positive.reduce((s, r) => s + r.value!, 0);
  if (negative || !total)
    return (
      <p className="dashboard-empty">Pie requires non-negative values and a positive total.</p>
    );
  let angle = -Math.PI / 2;
  return (
    <>
      <div className="dashboard-pie">
        <svg viewBox="0 0 220 220" role="img" aria-label="Value distribution">
          {positive.map((r, i) => {
            const start = angle;
            angle += (r.value! / total) * Math.PI * 2;
            const x1 = 110 + 90 * Math.cos(start),
              y1 = 110 + 90 * Math.sin(start),
              x2 = 110 + 90 * Math.cos(angle),
              y2 = 110 + 90 * Math.sin(angle);
            return positive.length === 1 ? (
              <circle key={i} cx="110" cy="110" r="90" fill={colors[i % colors.length]} />
            ) : (
              <path
                key={i}
                d={`M110 110 L${x1} ${y1} A90 90 0 ${angle - start > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`}
                fill={colors[i % colors.length]}
              >
                <title>
                  {r.label}: {short(r.value!)}
                  {suffix}
                </title>
              </path>
            );
          })}
        </svg>
        <div>
          {positive.map((r, i) => (
            <div key={i} title={r.label}>
              <i style={{ background: colors[i % colors.length] }} />
              <span>{r.label}</span>
              <strong>
                {short(r.value!)}
                {suffix}
              </strong>
            </div>
          ))}
        </div>
      </div>
      {truncation}
    </>
  );
}
