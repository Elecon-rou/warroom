import { DataSourceScope, selectedSourceId, useDataSources } from './dataSources';
import { useMemo } from 'react';
import { MetricsConstructor } from './MetricsConstructor';
import { TracesConstructor } from './TracesConstructor';
import { LogsConstructor } from './LogsConstructor';
import {
  builderForPanel,
  buildQuery,
  builderQueryText,
  emptyBuilder,
  type QueryBuilder,
} from './queryBuilders';
import { ranges, type QueryPanel } from './state';

type QueryConstructorProps = {
  panel: QueryPanel;
  services: string[];
  onChange: (patch: Partial<QueryPanel>) => void;
};
export function QueryConstructor({ panel, services, onChange }: QueryConstructorProps) {
  const { range, customStart, customEnd } = panel;
  const sources = useDataSources();
  const sourceId = selectedSourceId(sources, panel.kind, panel.sourceId);
  const time = useMemo(() => {
    const end = range === 'custom' ? Date.parse(customEnd) / 1000 : Math.floor(Date.now() / 1000);
    const start =
      range === 'custom'
        ? Date.parse(customStart) / 1000
        : end - Number(ranges.find((item) => item[0] === range)?.[2] || 3600);
    return { start, end };
  }, [range, customStart, customEnd]);
  const builder = builderForPanel(panel);
  function update(builder: QueryBuilder) {
    onChange({ builder, text: builderQueryText(builder, panel.text) });
  }
  if (!builder)
    return (
      <div className="constructor-unavailable">
        <p>This query cannot be represented in the constructor. The manual query has been kept.</p>
        <div>
          <button className="subtle-button" onClick={() => onChange({ inputMode: 'manual' })}>
            Edit manually
          </button>
          <button className="subtle-button" onClick={() => update(emptyBuilder(panel.kind))}>
            Reset constructor
          </button>
        </div>
      </div>
    );
  const result = buildQuery(builder);
  const queryText = builderQueryText(builder, panel.text);
  return (
    <DataSourceScope.Provider value={sourceId}>
      <div className="query-constructor">
        {builder.kind === 'metrics' ? (
          <MetricsConstructor value={builder} start={time.start} end={time.end} onChange={update} />
        ) : builder.kind === 'logs' ? (
          <LogsConstructor value={builder} start={time.start} end={time.end} onChange={update} />
        ) : (
          <TracesConstructor value={builder} services={services} onChange={update} />
        )}
        {result.error && (
          <p className="builder-validation" role="status">
            {result.error}
          </p>
        )}
        <div className="builder-preview">
          <div>
            <span>{result.error ? 'Last valid query' : 'Query'}</span>
            <button
              className="text-button"
              disabled={!queryText}
              onClick={() => onChange({ inputMode: 'manual', text: queryText, builder })}
            >
              Edit manually
            </button>
          </div>
          <code>{queryText || '—'}</code>
        </div>
      </div>
    </DataSourceScope.Provider>
  );
}
