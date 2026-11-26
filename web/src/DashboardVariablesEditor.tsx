import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useDataSources, selectedSourceId } from './dataSources';
import {
  maxDashboardVariables,
  parseDashboardVariables,
  type DashboardVariable,
} from './dashboardVariables';

export function DashboardVariablesEditor({
  variables,
  onDone,
  onCancel,
}: {
  variables: DashboardVariable[];
  onDone: (variables: DashboardVariable[]) => void;
  onCancel: () => void;
}) {
  const sources = useDataSources();
  const [draft, setDraft] = useState(variables);
  const [error, setError] = useState('');
  const patch = (index: number, changes: Partial<DashboardVariable>) =>
    setDraft((old) =>
      old.map((variable, i) => (i === index ? { ...variable, ...changes } : variable)),
    );
  function move(index: number, delta: number) {
    const next = [...draft],
      target = index + delta;
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
  }
  return (
    <section className="dashboard-editor" aria-label="Dashboard variable settings">
      <div className="dashboard-editor-heading dashboard-variables-heading">
        <h2>Variables</h2>
        <button className="subtle-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="subtle-button"
          onClick={() => {
            try {
              onDone(parseDashboardVariables(draft));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Done
        </button>
      </div>
      <p className="dashboard-note">
        Use $name or {'${name}'} in queries and titles. Put dependencies first. For metrics with
        multiple values or All, use {'label=~"$name"'}.
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {draft.map((variable, index) => (
        <section className="variable-definition" key={index}>
          <div className="dashboard-editor-heading">
            <strong>{variable.name || `Variable ${index + 1}`}</strong>
            <button
              className="icon-button"
              aria-label={`Move variable ${index + 1} up`}
              disabled={!index}
              onClick={() => move(index, -1)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              className="icon-button"
              aria-label={`Move variable ${index + 1} down`}
              disabled={index === draft.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown size={14} />
            </button>
            <button
              className="icon-button danger"
              aria-label={`Delete variable ${index + 1}`}
              onClick={() => setDraft(draft.filter((_, i) => i !== index))}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div className="dashboard-fields">
            <label>
              Name
              <input
                value={variable.name}
                maxLength={64}
                onChange={(event) => patch(index, { name: event.target.value })}
              />
            </label>
            <label>
              Label
              <input
                value={variable.label || ''}
                maxLength={120}
                onChange={(event) => patch(index, { label: event.target.value })}
              />
            </label>
            <label>
              Type
              <select
                value={variable.type}
                onChange={(event) => {
                  const type = event.target.value as DashboardVariable['type'];
                  patch(index, {
                    type,
                    current: [],
                    multi: false,
                    includeAll: false,
                    options: type === 'custom' ? ['value'] : undefined,
                    source: type === 'query' ? sources[0]?.kind : undefined,
                    sourceId: type === 'query' ? sources[0]?.id : undefined,
                    query: type === 'query' ? 'label_values(namespace)' : undefined,
                  });
                }}
              >
                <option value="custom">Custom list</option>
                <option value="textbox">Text box</option>
                <option value="query">Query</option>
              </select>
            </label>
            {variable.type === 'query' && (
              <label>
                Data source
                <select
                  value={
                    selectedSourceId(sources, variable.source || 'metrics', variable.sourceId) || ''
                  }
                  onChange={(event) => {
                    const source = sources.find((source) => source.id === event.target.value);
                    if (source)
                      patch(index, {
                        source: source.kind,
                        sourceId: source.id,
                        current: [],
                        query:
                          source.kind === 'metrics'
                            ? 'label_values(namespace)'
                            : source.kind === 'logs'
                              ? 'field_values(_stream)'
                              : 'services()',
                      });
                  }}
                >
                  <option value="" disabled>
                    Select data source
                  </option>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {variable.type === 'custom' && (
            <label className="variable-editor-field">
              Options (one per line)
              <textarea
                value={(variable.options || []).join('\n')}
                onChange={(event) =>
                  patch(index, { options: event.target.value.split('\n'), current: [] })
                }
              />
            </label>
          )}
          {variable.type === 'query' && (
            <label className="variable-editor-field">
              Option query
              <textarea
                value={variable.query || ''}
                maxLength={4000}
                onChange={(event) => patch(index, { query: event.target.value, current: [] })}
              />
              <small>
                {variable.source === 'logs'
                  ? 'field_values(field) or field_values(field, LogsQL filter)'
                  : variable.source === 'traces'
                    ? 'services() or operations("$service")'
                    : 'label_values(label), label_values(selector, label), or metrics()'}
              </small>
            </label>
          )}
          {variable.type === 'textbox' ? (
            <label className="variable-editor-field">
              Default value
              <input
                value={variable.current?.[0] || ''}
                maxLength={1024}
                onChange={(event) => patch(index, { current: [event.target.value] })}
              />
            </label>
          ) : (
            <div className="variable-flags">
              <label>
                <input
                  type="checkbox"
                  checked={!!variable.multi}
                  onChange={(event) => patch(index, { multi: event.target.checked, current: [] })}
                />
                Multiple values
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={!!variable.includeAll}
                  onChange={(event) =>
                    patch(index, { includeAll: event.target.checked, current: [] })
                  }
                />
                Include All
              </label>
            </div>
          )}
        </section>
      ))}
      <button
        className="subtle-button"
        disabled={draft.length >= maxDashboardVariables}
        onClick={() => {
          let number = 1;
          while (draft.some((variable) => variable.name === `variable${number}`)) number++;
          setDraft([
            ...draft,
            { name: `variable${number}`, type: 'custom', options: ['value'], current: ['value'] },
          ]);
        }}
      >
        <Plus size={14} />
        Add variable
      </button>
    </section>
  );
}
