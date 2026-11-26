import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { Metrics } from './Metrics';
import { Logs } from './Logs';
import { Traces } from './Traces';
import type { InvestigationWidget } from './investigation';

type ChatWidgetViewProps = { widget: InvestigationWidget };

export function ChatWidgetView({ widget }: ChatWidgetViewProps) {
  const [response, setResponse] = useState(widget.response);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<'graph' | 'table'>('graph');
  const [filter, setFilter] = useState('');
  const [wrap, setWrap] = useState(true);
  const [sort, setSort] = useState<'query' | 'newest' | 'oldest'>('newest');
  const abortController = useRef<AbortController | null>(null);
  useEffect(() => () => abortController.current?.abort(), []);
  async function load(traceId?: string) {
    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;
    setPending(true);
    setError('');
    try {
      const r = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: widget.kind,
          sourceId: widget.sourceId,
          query: widget.query,
          start: widget.start,
          end: widget.end,
          limit: widget.limit,
          traceId,
        }),
        signal: controller.signal,
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Widget query failed.');
      setResponse(body);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      if (abortController.current === controller) setPending(false);
    }
  }
  const series = response?.data?.data?.result || [];
  const logs = Array.isArray(response?.data) ? response.data : [];
  const traces = Array.isArray(response?.data?.data) ? response.data.data : [];
  const count =
    widget.kind === 'metrics'
      ? series.length
      : widget.kind === 'logs'
        ? logs.length
        : traces.length;
  function download() {
    if (!response) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `investigate-${widget.kind}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="chat-widget" aria-label={`${widget.kind} widget: ${widget.title}`}>
      <div className="chat-widget-heading">
        <strong>{widget.title}</strong>
        <span className="count">{widget.kind}</span>
        <span className="chat-widget-time">
          {new Date(widget.start * 1000).toLocaleString()} —{' '}
          {new Date(widget.end * 1000).toLocaleTimeString()}
        </span>
        <button
          className="icon-button"
          aria-label={`Reload ${widget.title}`}
          disabled={pending}
          onClick={() => void load()}
        >
          {pending ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
        <button
          className="icon-button"
          aria-label={`Export ${widget.title}`}
          disabled={!response}
          onClick={download}
        >
          <Download size={14} />
        </button>
      </div>
      <details className="widget-query">
        <summary>Query</summary>
        <code>{widget.query}</code>
      </details>
      {error && <p className="inline-error">{error}</p>}
      {!response ? (
        <div className="result-message">
          <button className="subtle-button" onClick={() => void load()} disabled={pending}>
            Load saved widget data
          </button>
        </div>
      ) : count === 0 ? (
        <div className="result-message">No results</div>
      ) : widget.kind === 'metrics' ? (
        <Metrics
          series={series}
          start={widget.start}
          end={widget.end}
          view={view}
          onViewChange={setView}
        />
      ) : widget.kind === 'logs' ? (
        <Logs
          rows={logs}
          filter={filter}
          wrap={wrap}
          sort={sort}
          onViewChange={(patch) => {
            if (patch.filter !== undefined) setFilter(patch.filter);
            if (patch.wrap !== undefined) setWrap(patch.wrap);
            if (patch.sort !== undefined) setSort(patch.sort);
          }}
        />
      ) : (
        <Traces
          traces={traces}
          filter={filter}
          onFilterChange={setFilter}
          onTrace={(id) => void load(id)}
        />
      )}
      {widget.truncated && (
        <p className="graph-warning">
          Widget limited to{' '}
          {widget.kind === 'metrics'
            ? '40 metric series'
            : widget.kind === 'logs'
              ? '100 log entries'
              : '20 traces'}
          .
        </p>
      )}
    </section>
  );
}
