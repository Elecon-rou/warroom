import { useMemo, useState } from 'react';
import { ChevronRight, ListFilter, Search, AlignLeft, WrapText } from 'lucide-react';
import { LogRow } from './types';
type LogsProps = {
  rows: LogRow[];
  filter: string;
  wrap: boolean;
  sort: 'query' | 'newest' | 'oldest';
  onViewChange: (patch: {
    filter?: string;
    wrap?: boolean;
    sort?: 'query' | 'newest' | 'oldest';
  }) => void;
};

export function Logs({ rows, filter, wrap, sort, onViewChange }: LogsProps) {
  const search = filter;
  const direction = sort;
  const [open, setOpen] = useState<Set<number>>(new Set());
  const filtered = useMemo(
    () =>
      rows
        .filter((r) => JSON.stringify(r).toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) =>
          direction === 'query'
            ? 0
            : (Date.parse(String(b._time)) - Date.parse(String(a._time))) *
              (direction === 'newest' ? 1 : -1),
        ),
    [rows, search, direction],
  );
  return (
    <>
      <div className="result-toolbar">
        <div className="result-title">
          <AlignLeft size={16} />
          <strong>Log stream</strong>
          <span className="count">{filtered.length} entries</span>
        </div>
        <div className="inline-tools">
          <div className="search-input">
            <Search size={14} />
            <input
              aria-label="Filter log results"
              placeholder="Filter results…"
              value={search}
              onChange={(e) => onViewChange({ filter: e.target.value })}
            />
          </div>
          <button
            title="Toggle line wrapping"
            className={wrap ? 'icon-button active' : 'icon-button'}
            onClick={() => onViewChange({ wrap: !wrap })}
          >
            <WrapText size={16} />
          </button>
          <select
            aria-label="Log sort order"
            value={direction}
            onChange={(e) =>
              onViewChange({ sort: e.target.value as 'query' | 'newest' | 'oldest' })
            }
          >
            <option value="query">Query order</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
      </div>
      <div className="log-head">
        <span>TIME</span>
        <span>MESSAGE / FIELDS</span>
      </div>
      <div className="log-list">
        {filtered.map((r, i) => {
          const level = String(r.level || r.severity || '').toLowerCase();
          return (
            <div className={`log-entry ${level}`} key={i}>
              <button
                className="log-row"
                onClick={() =>
                  setOpen((old) => {
                    const n = new Set(old);
                    n.has(i) ? n.delete(i) : n.add(i);
                    return n;
                  })
                }
                aria-expanded={open.has(i)}
              >
                <ChevronRight size={13} className={open.has(i) ? 'rotate' : ''} />
                <time>
                  {r._time
                    ? new Date(String(r._time)).toLocaleTimeString([], { hour12: false })
                    : '—'}
                </time>
                <span className={`level ${level}`}>{level || 'log'}</span>
                <span className={wrap ? 'log-message wrap' : 'log-message'}>
                  {String(r._msg ?? r.message ?? JSON.stringify(r))}
                </span>
              </button>
              {open.has(i) && (
                <div className="field-grid">
                  {Object.entries(r).map(([k, v]) => (
                    <div key={k}>
                      <span>{k}</span>
                      <code>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {!filtered.length && (
          <div className="empty small">
            <ListFilter />
            <h3>No matching entries</h3>
            <p>Try a different result filter.</p>
          </div>
        )}
      </div>
    </>
  );
}
