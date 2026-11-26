import { useDataSources, selectedSourceId } from './dataSources';
import { compatibleSources, reducers, widgetTypes, type DashboardWidget } from './dashboard';
import { QueryConstructor } from './QueryConstructor';
import { useState } from 'react';
import { defaultPanel, patchPanel } from './state';
import { panelQuery } from './queryBuilders';
import type { QueryPanel } from './state';

export function DashboardEditor({
  widget: w,
  services,
  onChange,
  onDone,
  onCancel,
}: {
  widget: DashboardWidget;
  services: string[];
  onChange: (w: DashboardWidget) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const sources = useDataSources();
  const [panel, setPanel] = useState<QueryPanel>(() => ({
    ...defaultPanel(w.id, w.source),
    text: w.query,
    sourceId: w.sourceId,
    inputMode: 'manual',
  }));
  const [constructor, setConstructor] = useState(false);
  const patch = (next: Partial<DashboardWidget>) => onChange({ ...w, ...next });
  return (
    <section className="dashboard-editor" aria-label="Widget editor">
      <div className="dashboard-editor-heading">
        <h2>Widget</h2>
        <button className="subtle-button" onClick={onCancel}>
          Cancel
        </button>
        <button className="subtle-button" onClick={onDone}>
          Done
        </button>
      </div>
      <div className="dashboard-fields">
        <label>
          Title
          <input
            value={w.title}
            maxLength={160}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </label>
        <label>
          Type
          <select
            value={w.type}
            onChange={(e) => {
              const type = e.target.value as DashboardWidget['type'];
              const source = compatibleSources(type).includes(w.source)
                ? w.source
                : compatibleSources(type)[0];
              patch({
                type,
                source,
                sourceId:
                  source === w.source ? w.sourceId : sources.find((s) => s.kind === source)?.id,
                query: source === w.source ? w.query : '',
                ...(type === 'time-series' ? { width: 1 } : {}),
              });
              setConstructor(false);
            }}
          >
            {widgetTypes.map((t) => (
              <option key={t} value={t}>
                {t === 'pie'
                  ? 'Pie chart'
                  : t === 'time-series'
                    ? 'Time series'
                    : t === 'force-graph'
                      ? 'Force graph'
                      : t[0].toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select
            value={selectedSourceId(sources, w.source, w.sourceId) || ''}
            onChange={(e) => {
              const source = sources.find((s) => s.id === e.target.value);
              if (source) patch({ source: source.kind, sourceId: source.id, query: '' });
              setConstructor(false);
            }}
          >
            <option value="" disabled>
              Select source
            </option>
            {sources
              .filter((s) => compatibleSources(w.type).includes(s.kind))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Width
          <select value={w.width} onChange={(e) => patch({ width: Number(e.target.value) })}>
            <option value="1">Auto</option>
            <option value="2">Wide</option>
            <option value="3">Full</option>
          </select>
        </label>
      </div>
      {w.type === 'force-graph' ? (
        <p className="dashboard-note">
          Dependencies from{' '}
          {w.source === 'metrics' ? 'service-graph metrics' : 'sampled Jaeger traces'}. Uses the
          dashboard time range. Drag nodes to reposition.
        </p>
      ) : (
        <>
          <div className="dashboard-editor-heading">
            <label htmlFor="dashboard-query">
              Query ·{' '}
              {w.source === 'metrics'
                ? 'PromQL / MetricsQL'
                : w.source === 'logs'
                  ? 'LogsQL'
                  : 'Jaeger search parameters'}
            </label>
            <button
              className="subtle-button"
              onClick={() => {
                setPanel({
                  ...defaultPanel(w.id, w.source),
                  text: w.query,
                  inputMode: 'constructor',
                });
                setConstructor(!constructor);
              }}
            >
              {constructor ? 'Manual' : 'Constructor'}
            </button>
          </div>
          {constructor ? (
            <QueryConstructor
              panel={{ ...panel, kind: w.source, text: w.query, inputMode: 'constructor' }}
              services={services}
              onChange={(p) => {
                if (p.inputMode === 'manual') {
                  setConstructor(false);
                  return;
                }
                const next = patchPanel({ ...panel, kind: w.source, text: w.query }, p);
                setPanel(next);
                const compiled = panelQuery({ ...next, inputMode: 'constructor' });
                if (!compiled.error) patch({ query: compiled.query });
              }}
            />
          ) : (
            <textarea
              id="dashboard-query"
              className="dashboard-code"
              value={w.query}
              spellCheck={false}
              onChange={(e) => patch({ query: e.target.value })}
              maxLength={16000}
            />
          )}
          {w.type !== 'logs' && w.type !== 'time-series' && (
            <div className="dashboard-fields">
              <label>
                Reducer
                <select
                  value={w.reducer}
                  onChange={(e) => patch({ reducer: e.target.value as DashboardWidget['reducer'] })}
                >
                  {reducers.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
              <label>
                Label field
                <input
                  value={w.labelField}
                  onChange={(e) => patch({ labelField: e.target.value })}
                />
              </label>
              <label>
                Value field
                <input
                  value={w.valueField}
                  onChange={(e) => patch({ valueField: e.target.value })}
                />
              </label>
              <label>
                Unit
                <input value={w.unit} onChange={(e) => patch({ unit: e.target.value })} />
              </label>
            </div>
          )}
          {w.type !== 'logs' && w.type !== 'time-series' && (
            <p className="dashboard-note">
              Metrics: reduce samples per series; number and gauge also reduce across series. Logs:
              select a numeric value field (default: value). Traces: default duration_ms. Count with
              no value field counts returned rows.
            </p>
          )}
        </>
      )}
      {w.type === 'time-series' && (
        <div className="dashboard-fields">
          <label>
            Display
            <select
              value={w.chartStyle || 'lines'}
              onChange={(e) => patch({ chartStyle: e.target.value as 'lines' | 'bars' })}
            >
              <option value="lines">Lines</option>
              <option value="bars">Bars</option>
            </select>
          </label>
          <label>
            Y axis
            <select
              value={w.axisMode || 'auto'}
              onChange={(e) => patch({ axisMode: e.target.value as 'auto' | 'fixed' })}
            >
              <option value="auto">Auto</option>
              <option value="fixed">Fixed bounds</option>
            </select>
          </label>
          <label>
            Legend label
            <input value={w.labelField} onChange={(e) => patch({ labelField: e.target.value })} />
          </label>
          <label>
            Unit
            <input value={w.unit} onChange={(e) => patch({ unit: e.target.value })} />
          </label>
        </div>
      )}
      {(['gauge', 'number', 'blinkenlights'].includes(w.type) ||
        (w.type === 'time-series' && w.axisMode === 'fixed')) && (
        <div className="dashboard-fields">
          {(['min', 'max', 'warning', 'critical'] as const)
            .filter((f) => w.type !== 'time-series' || f === 'min' || f === 'max')
            .map((f) => (
              <label key={f}>
                {f === 'warning'
                  ? 'Amber ≥'
                  : f === 'critical'
                    ? 'Red ≥'
                    : f === 'min'
                      ? 'Minimum'
                      : 'Maximum'}
                <input
                  type="number"
                  value={w[f]}
                  onChange={(e) => patch({ [f]: e.target.valueAsNumber })}
                />
              </label>
            ))}
        </div>
      )}
    </section>
  );
}
