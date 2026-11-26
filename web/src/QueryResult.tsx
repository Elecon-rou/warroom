import { ArrowDownToLine, LoaderCircle, Maximize2, RefreshCw } from 'lucide-react';
import type { Kind, Series, Trace } from './types';
import type { QueryOutput } from './explorer';
import type { QueryPanel as QueryInput } from './state';
import { Metrics } from './Metrics';
import { Logs } from './Logs';
import { Traces } from './Traces';

type QueryResultProps = {
  kind: Kind;
  name: string;
  row: QueryInput;
  onChange: (patch: Partial<QueryInput>) => void;
  output: QueryOutput;
  expanded: boolean;
  onExpand: () => void;
  onRetry: () => void;
  onTrace: (id: string) => void;
};

export function QueryResult({
  kind,
  name,
  row,
  onChange,
  output,
  expanded,
  onExpand,
  onRetry,
  onTrace,
}: QueryResultProps) {
  const result = output.response;
  const series: Series[] = result?.data?.data?.result || [];
  const logs = Array.isArray(result?.data) ? result.data : [];
  const traces: Trace[] = Array.isArray(result?.data?.data) ? result.data.data : [];
  const count =
    kind === 'metrics'
      ? series.length
      : kind === 'logs'
        ? logs.length
        : traces.filter((t) => t.spans?.length).length;
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `warroom-${kind}-${name}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="query-result-group" aria-label={`Query ${name} results`}>
      <div className="query-result-heading">
        <span className="query-letter">{name}</span>
        <code title={output.text}>{output.text}</code>
        <span>
          {output.pending ? 'Running…' : output.error ? 'Failed' : `${result?.elapsedMs} ms`}
        </span>
      </div>
      <section
        className={`results-panel ${output.pending ? 'loading' : ''}`}
        aria-busy={output.pending}
      >
        <div className="result-utility">
          <button
            className="icon-button"
            aria-label={`Export query ${name} results`}
            onClick={download}
            disabled={!result}
          >
            <ArrowDownToLine size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={expanded ? 'Exit expanded view' : 'Expand results'}
            onClick={onExpand}
          >
            <Maximize2 size={15} />
          </button>
        </div>
        {output.error ? (
          <div className="error-state">
            <div>
              <h3>Query {name} failed</h3>
              <p>{output.error}</p>
              <button className="subtle-button" onClick={onRetry}>
                <RefreshCw size={14} />
                Retry
              </button>
            </div>
          </div>
        ) : !result ? (
          <div className="result-message">
            <LoaderCircle className="spin" size={16} />
            <span>Loading…</span>
          </div>
        ) : count === 0 ? (
          <div className="result-message">No results</div>
        ) : kind === 'metrics' ? (
          <Metrics
            series={series}
            start={result.start}
            end={result.end}
            view={row.view || 'graph'}
            onViewChange={(view) => onChange({ view })}
          />
        ) : kind === 'logs' ? (
          <Logs
            rows={logs}
            filter={row.filter || ''}
            wrap={row.wrap !== false}
            sort={row.sort || 'newest'}
            onViewChange={onChange}
          />
        ) : (
          <Traces
            traces={traces}
            onTrace={onTrace}
            filter={row.filter || ''}
            onFilterChange={(filter) => onChange({ filter })}
          />
        )}
      </section>
      {result?.data?.warnings?.length > 0 && (
        <div className="notice">{result?.data.warnings.join(' · ')}</div>
      )}
      {result?.data?.isPartial && <div className="notice">Partial response.</div>}
    </section>
  );
}
