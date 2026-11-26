import { selectedSourceId } from './dataSources';
import { QueryConstructor } from './QueryConstructor';
import { panelQuery } from './queryBuilders';
import { useEffect, useRef } from 'react';
import {
  ArrowRight,
  Braces,
  Clock3,
  LoaderCircle,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import type { Source } from './types';
import { Carousel } from './Carousel';
import { QueryResult } from './QueryResult';
import {
  sourceMetadata,
  inputModes,
  type Generation,
  type LLMConfig,
  type QueryOutput,
} from './explorer';
import { ranges, localDateTime, inputDateTime, type QueryPanel as QueryInput } from './state';

type ExplorePanelProps = {
  row: QueryInput;
  name: string;
  sources: Source[];
  services: string[];
  generation?: Generation;
  llmConfig: LLMConfig;
  onGenerate: () => void;
  output?: QueryOutput;
  removable: boolean;
  expanded: boolean;
  onChange: (patch: Partial<QueryInput>) => void;
  onRemove: () => void;
  onRun: () => void;
  onCancel: () => void;
  onExpand: () => void;
  onTrace: (id: string) => void;
};

export function ExplorePanel({
  row,
  name,
  sources,
  services,
  generation,
  llmConfig,
  onGenerate,
  output,
  removable,
  expanded,
  onChange,
  onRemove,
  onRun,
  onCancel,
  onExpand,
  onTrace,
}: ExplorePanelProps) {
  const { kind, inputMode, range, refresh, limit, step, customStart, customEnd } = row;
  const current = sourceMetadata[kind];
  const Icon = current.icon;
  const query = panelQuery(row);
  const pending = !!output?.pending || !!generation?.pending;
  // Refresh uses current callbacks without restarting the timer on every render.
  const callbacks = useRef({ onRun, pending });
  callbacks.current = { onRun, pending };
  useEffect(() => {
    if (!refresh || !row.enabled || (inputMode !== 'manual' && inputMode !== 'constructor')) return;
    const timer = window.setInterval(() => {
      if (!callbacks.current.pending) callbacks.current.onRun();
    }, refresh * 1000);
    return () => clearInterval(timer);
  }, [refresh, row.enabled, inputMode]);
  return (
    <section
      className={`explorer-panel ${row.enabled ? '' : 'panel-disabled'}`}
      aria-label={`Query ${name} panel`}
    >
      <div className="panel-heading">
        <h2>Query {name}</h2>
        <div className="query-row-actions">
          <label className="query-enabled">
            <input
              type="checkbox"
              aria-label={`Enable query ${name}`}
              checked={row.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
            />
            Enabled
          </label>
          <button
            className="icon-button delete-query"
            aria-label={`Remove query ${name}`}
            disabled={!removable}
            onClick={onRemove}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <div className="explore-selectors">
        <Carousel
          label="Query input"
          options={inputModes}
          value={inputMode}
          onChange={(mode) => onChange({ inputMode: mode, refresh: 0 })}
        />
        <Carousel
          label="Data source"
          options={sources.map((s) => ({
            value: s.id,
            label: s.name,
            detail: sourceMetadata[s.kind].name,
            icon: sourceMetadata[s.kind].icon,
          }))}
          value={selectedSourceId(sources, kind, row.sourceId) || ''}
          onChange={(id) => {
            const source = sources.find((s) => s.id === id);
            if (source) onChange({ sourceId: id, kind: source.kind, text: '', filter: '' });
          }}
        />
      </div>
      {!sources.length && <p className="inline-error">No data sources configured.</p>}
      <div className="query-panel">
        <div className="control-bar">
          <span className="query-control-label">
            <Icon size={15} />
            {current.language}
          </span>
          <div className="time-controls">
            <div className="range-selector">
              <Clock3 size={14} />
              <select
                aria-label={`Time range for query ${name}`}
                value={range}
                onChange={(e) => onChange({ range: e.target.value })}
              >
                {ranges.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
                <option value="custom">Custom range</option>
              </select>
            </div>
            <div className="refresh-selector">
              <RefreshCw size={14} />
              <select
                aria-label={`Refresh interval for query ${name}`}
                value={refresh}
                disabled={inputMode === 'llm'}
                onChange={(e) => onChange({ refresh: Number(e.target.value) })}
              >
                {[
                  [0, 'Refresh off'],
                  [5, 'Every 5s'],
                  [10, 'Every 10s'],
                  [30, 'Every 30s'],
                  [60, 'Every 1m'],
                  [300, 'Every 5m'],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="run-button"
              aria-label={pending ? `Cancel query ${name}` : `Run query ${name}`}
              disabled={
                !pending &&
                (!sources.some((s) => s.id === selectedSourceId(sources, kind, row.sourceId)) ||
                  !row.enabled ||
                  !(inputMode === 'llm' ? row.prompt.trim() : !query.error && query.query.trim()))
              }
              onClick={pending ? onCancel : onRun}
            >
              {pending ? <Square size={13} /> : <Play size={13} />}{' '}
              {pending ? 'Cancel' : inputMode === 'llm' ? 'Generate & run' : 'Run query'}
            </button>
          </div>
        </div>
        {range === 'custom' && (
          <div className="custom-range">
            <label>
              From
              <input
                type="datetime-local"
                aria-label={`Start time for query ${name}`}
                value={localDateTime(customStart)}
                onChange={(e) => onChange({ customStart: inputDateTime(e.target.value) })}
              />
            </label>
            <ArrowRight size={14} />
            <label>
              To
              <input
                type="datetime-local"
                aria-label={`End time for query ${name}`}
                value={localDateTime(customEnd)}
                onChange={(e) => onChange({ customEnd: inputDateTime(e.target.value) })}
              />
            </label>
          </div>
        )}
        {inputMode === 'llm' && (
          <div className="llm-input">
            <label htmlFor={`prompt-${row.id}`}>Prompt</label>
            <textarea
              id={`prompt-${row.id}`}
              maxLength={8000}
              aria-label={`Prompt for query ${name}`}
              value={row.prompt}
              onChange={(e) => onChange({ prompt: e.target.value })}
            />
            <div className="llm-actions">
              <span>
                {llmConfig.configured
                  ? `${llmConfig.provider || 'LLM'} · ${llmConfig.model}`
                  : 'LLM is not configured.'}
              </span>
              <div>
                {generation?.verdict && (
                  <span className={`verdict ${generation.verdict.toLowerCase()}`}>
                    {generation.verdict}
                  </span>
                )}
                <button
                  className="subtle-button"
                  disabled={!row.enabled || !row.prompt.trim() || !llmConfig.configured}
                  onClick={generation?.pending ? onCancel : onGenerate}
                >
                  {generation?.pending ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : (
                    <Sparkles size={13} />
                  )}{' '}
                  {generation?.pending ? 'Cancel' : 'Generate query'}
                </button>
              </div>
            </div>
            {!!generation?.discovery?.length && (
              <details className="discovery-log">
                <summary>MCP discovery · {generation.discovery.length} calls</summary>
                <ul>
                  {generation.discovery.map((call, index) => (
                    <li key={index}>
                      <code>{call.tool}</code>
                      <span>{call.elapsedMs} ms</span>
                      {call.error && <p>{call.error}</p>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {generation?.error && (
              <p className="inline-error" role="status">
                {generation.error}
              </p>
            )}
          </div>
        )}
        {inputMode === 'constructor' && (
          <QueryConstructor panel={row} services={services} onChange={onChange} />
        )}
        {inputMode === 'manual' ||
        (inputMode === 'llm' && row.text) ||
        inputMode === 'constructor' ? (
          <>
            {inputMode === 'llm' && (
              <div className="generated-query-heading">
                <span>Query</span>
                <button className="text-button" onClick={() => onChange({ inputMode: 'manual' })}>
                  Edit manually
                </button>
              </div>
            )}
            {inputMode !== 'constructor' && (
              <div className="editor-panel">
                <div className="code-editor">
                  <div className="line-numbers">
                    {row.text.split('\n').map((_, index) => (
                      <span key={index}>{index + 1}</span>
                    ))}
                  </div>
                  <textarea
                    readOnly={inputMode === 'llm'}
                    maxLength={16000}
                    spellCheck={false}
                    aria-label={`Query ${name} editor`}
                    value={row.text}
                    onChange={(e) => onChange({ text: e.target.value })}
                  />
                  <Braces size={16} className="code-watermark" />
                </div>
              </div>
            )}
            <div className="editor-footer">
              <div className="query-options">
                {kind === 'metrics' ? (
                  <label>
                    Resolution
                    <select
                      aria-label={`Resolution for query ${name}`}
                      value={step}
                      onChange={(e) => onChange({ step: e.target.value })}
                    >
                      {[
                        ['auto', 'Auto'],
                        ['15', '15 seconds'],
                        ['30', '30 seconds'],
                        ['60', '1 minute'],
                        ['300', '5 minutes'],
                      ].map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    Result limit
                    <select
                      aria-label={`Result limit for query ${name}`}
                      value={limit}
                      onChange={(e) => onChange({ limit: Number(e.target.value) })}
                    >
                      {[20, 50, 100, 250, 500, 1000].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                )}
                {kind === 'traces' && inputMode === 'manual' && services.length > 0 && (
                  <label>
                    Service
                    <select
                      aria-label={`Service for query ${name}`}
                      value={new URLSearchParams(row.text).get('service') || ''}
                      onChange={(e) => {
                        const params = new URLSearchParams(row.text);
                        params.set('service', e.target.value);
                        onChange({ text: params.toString() });
                      }}
                    >
                      <option value="" disabled>
                        Service
                      </option>
                      {services.map((service) => (
                        <option key={service}>{service}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <span className="keyboard-hint">
                <kbd>⌘ / Ctrl</kbd>
                <kbd>↵</kbd>Run all
              </span>
            </div>
          </>
        ) : null}
      </div>
      {row.enabled && (output?.pending || output?.error || output?.response) && (
        <QueryResult
          kind={kind}
          name={name}
          row={row}
          onChange={onChange}
          output={output}
          expanded={expanded}
          onExpand={onExpand}
          onRetry={onRun}
          onTrace={onTrace}
        />
      )}
    </section>
  );
}
