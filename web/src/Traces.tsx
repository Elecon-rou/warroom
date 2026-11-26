import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, GitBranch, Search } from 'lucide-react';
import { Trace, Span, traceInfo, duration, colors } from './types';
type TracesProps = {
  traces: Trace[];
  onTrace: (id: string) => void;
  filter: string;
  onFilterChange: (filter: string) => void;
};

export function Traces({ traces, onTrace, filter, onFilterChange }: TracesProps) {
  const [selected, setSelected] = useState<Trace | null>(null);
  const [span, setSpan] = useState<Span | null>(null);
  useEffect(() => {
    setSelected((current) =>
      current
        ? traces.find((t) => t.spans?.length && traceInfo(t).id === traceInfo(current).id) || null
        : null,
    );
    setSpan(null);
  }, [traces]);
  const valid = traces.filter((t) => t.spans?.length);
  const shown = valid.filter((t) => JSON.stringify(t).toLowerCase().includes(filter.toLowerCase()));
  if (selected) {
    const info = traceInfo(selected);
    const spans = [...selected.spans].sort((a, b) => a.startTime - b.startTime);
    const map = new Map(spans.map((s) => [s.spanID, s]));
    const depth = (s: Span) => {
      let d = 0;
      let seen = new Set([s.spanID]);
      let parent = s.references?.find((r) => r.refType === 'CHILD_OF')?.spanID;
      while (parent && map.has(parent) && !seen.has(parent) && d < 12) {
        seen.add(parent);
        d++;
        parent = map.get(parent)?.references?.find((r) => r.refType === 'CHILD_OF')?.spanID;
      }
      return d;
    };
    return (
      <>
        <div className="result-toolbar">
          <div className="result-title">
            <button
              className="icon-button"
              title="Back to traces"
              onClick={() => {
                setSelected(null);
                setSpan(null);
              }}
            >
              <ArrowLeft size={17} />
            </button>
            <strong>{info.root.operationName}</strong>
            <span className="count">{duration(info.duration)}</span>
          </div>
          <button className="text-button" onClick={() => onTrace(info.id)}>
            Fetch complete trace
          </button>
        </div>
        <div className="trace-meta">
          <code>{info.id}</code>
          <span>{spans.length} spans</span>
          <span>{info.services} services</span>
          <span>{new Date(info.start / 1000).toLocaleString()}</span>
        </div>
        <div className="waterfall-head">
          <span>Service & operation</span>
          <span>
            0 ms <b>{duration(info.duration / 2)}</b> {duration(info.duration)}
          </span>
        </div>
        <div className="waterfall">
          {spans.map((s, i) => (
            <button
              key={s.spanID}
              className={`waterfall-row ${span?.spanID === s.spanID ? 'picked' : ''}`}
              onClick={() => setSpan(span?.spanID === s.spanID ? null : s)}
            >
              <span className="span-name" style={{ paddingLeft: 16 + depth(s) * 16 }}>
                <i style={{ background: colors[i % colors.length] }} />
                <span>
                  <small>
                    {selected.processes?.[s.processID]?.serviceName || 'unknown service'}
                  </small>
                  {s.operationName}
                </span>
              </span>
              <span className="span-track">
                <i
                  style={{
                    left: `${((s.startTime - info.start) / Math.max(1, info.duration)) * 100}%`,
                    width: `${Math.max(0.4, (s.duration / Math.max(1, info.duration)) * 100)}%`,
                    background: colors[i % colors.length],
                  }}
                />
                <b>{duration(s.duration)}</b>
              </span>
            </button>
          ))}
        </div>
        {span && (
          <div className="span-details">
            <h3>
              {span.operationName}
              <span>{duration(span.duration)}</span>
            </h3>
            <div className="field-grid">
              <div>
                <span>spanID</span>
                <code>{span.spanID}</code>
              </div>
              {span.tags?.map((t) => (
                <div key={t.key}>
                  <span>{t.key}</span>
                  <code>{String(t.value)}</code>
                </div>
              ))}
            </div>
            {!!span.logs?.length && <pre>{JSON.stringify(span.logs, null, 2)}</pre>}
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <div className="result-toolbar">
        <div className="result-title">
          <GitBranch size={16} />
          <strong>Traces</strong>
          <span className="count">{shown.length} traces</span>
        </div>
        <div className="search-input">
          <Search size={14} />
          <input
            aria-label="Filter traces"
            placeholder="Filter results…"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
          />
        </div>
      </div>
      <div className="table-scroll">
        <table className="trace-table">
          <thead>
            <tr>
              <th>Service / operation</th>
              <th>Trace ID</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Spans</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((t, i) => {
              const info = traceInfo(t);
              return (
                <tr
                  key={info.id || i}
                  tabIndex={0}
                  role="button"
                  onClick={() => setSelected(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setSelected(t);
                  }}
                >
                  <td>
                    <div className="trace-service">
                      <i style={{ background: colors[i % colors.length] }} />
                      {t.processes?.[info.root.processID]?.serviceName || 'unknown'}
                    </div>
                    <strong>{info.root.operationName}</strong>
                  </td>
                  <td className="mono trace-id">{info.id.slice(0, 16)}…</td>
                  <td>{new Date(info.start / 1000).toLocaleTimeString()}</td>
                  <td>
                    <span className="duration-pill">{duration(info.duration)}</span>
                  </td>
                  <td>{t.spans.length}</td>
                  <td>
                    <ChevronRight size={15} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!shown.length && (
        <div className="empty small">
          <h3>No matching traces</h3>
          <p>Try a different filter.</p>
        </div>
      )}
    </>
  );
}
