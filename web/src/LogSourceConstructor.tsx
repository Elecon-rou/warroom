import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  buildLogSource,
  emptyFilterGroup,
  parseLogSource,
  type LogSource,
  type StreamMatcher,
} from './logFilters';
import type { LogsBuilder } from './logsBuilder';
import { LogFilterConstructor } from './LogFilterConstructor';
import { useSuggestions } from './useSuggestions';

type LogSourceConstructorProps = {
  value: LogsBuilder;
  fields: string[];
  start: number;
  end: number;
  onChange: (value: LogsBuilder) => void;
};
export function LogSourceConstructor({
  value,
  fields,
  start,
  end,
  onChange,
}: LogSourceConstructorProps) {
  const mode = value.sourceMode || 'builder';
  const source = value.source || parseLogSource(value.filter);
  const streamFields = useSuggestions(
    `/api/logs/metadata?${new URLSearchParams({ type: 'stream_fields', start: String(start), end: String(end), query: '*' })}`,
  );
  const streamsQuery = buildLogSource({ ...source, filters: emptyFilterGroup() }).query || '*';
  function update(source: LogSource) {
    const result = buildLogSource(source);
    onChange({
      ...value,
      sourceMode: 'builder',
      source,
      filter: result.error ? value.filter : result.query,
    });
  }
  return (
    <div className="log-source-constructor">
      <label className="builder-field">
        Source input
        <select
          aria-label="Source input"
          value={mode}
          onChange={(event) =>
            onChange({
              ...value,
              source,
              sourceMode: event.target.value as 'builder' | 'expression',
            })
          }
        >
          <option value="builder">Builder</option>
          <option value="expression">LogsQL expression</option>
        </select>
      </label>
      {mode === 'expression' ? (
        <label className="builder-field">
          LogsQL filter
          <textarea
            aria-label="Log source filter"
            value={value.filter}
            maxLength={16000}
            spellCheck={false}
            onChange={(event) =>
              onChange({ ...value, filter: event.target.value, source: undefined })
            }
          />
        </label>
      ) : (
        <>
          <div className="builder-section-heading">
            <span>Stream labels</span>
            <button
              className="subtle-button"
              aria-label="Add stream matcher"
              disabled={source.streams.length >= 32}
              onClick={() =>
                update({
                  ...source,
                  streams: [
                    ...source.streams,
                    { id: crypto.randomUUID(), label: '', operator: '=', value: '' },
                  ],
                })
              }
            >
              <Plus size={12} />
              Label
            </button>
          </div>
          {source.streams.map((matcher, index) => (
            <StreamFilter
              key={matcher.id}
              value={matcher}
              index={index}
              labels={streamFields.data}
              query="*"
              start={start}
              end={end}
              onChange={(matcher) =>
                update({
                  ...source,
                  streams: source.streams.map((current, i) => (i === index ? matcher : current)),
                })
              }
              onRemove={() =>
                update({ ...source, streams: source.streams.filter((_, i) => i !== index) })
              }
            />
          ))}
          {streamFields.error && <p className="builder-warning">{streamFields.error}</p>}
          <div className="builder-section-heading">
            <span>Log filters</span>
          </div>
          <LogFilterConstructor
            value={source.filters}
            fields={fields}
            query={streamsQuery}
            start={start}
            end={end}
            onChange={(filters) => update({ ...source, filters })}
          />
        </>
      )}
    </div>
  );
}
type StreamFilterProps = {
  value: StreamMatcher;
  index: number;
  labels: string[];
  query: string;
  start: number;
  end: number;
  onChange: (value: StreamMatcher) => void;
  onRemove: () => void;
};
function StreamFilter({
  value,
  index,
  labels,
  query,
  start,
  end,
  onChange,
  onRemove,
}: StreamFilterProps) {
  const id = useId();
  const suggestions = useSuggestions(
    value.label
      ? `/api/logs/metadata?${new URLSearchParams({ type: 'stream_values', field: value.label, query, start: String(start), end: String(end) })}`
      : null,
  );
  return (
    <div className="log-stream-matcher">
      <div className="builder-filter-row">
        <label className="builder-field builder-grow">
          Stream label
          <input
            aria-label={`Stream ${index + 1} label`}
            list={`${id}-labels`}
            value={value.label}
            maxLength={1000}
            onChange={(event) => onChange({ ...value, label: event.target.value })}
          />
          <datalist id={`${id}-labels`}>
            {labels.map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
        </label>
        <label className="builder-field builder-operator">
          Operator
          <select
            aria-label={`Stream ${index + 1} operator`}
            value={value.operator}
            onChange={(event) =>
              onChange({ ...value, operator: event.target.value as StreamMatcher['operator'] })
            }
          >
            {['=', '!=', '=~', '!~'].map((operator) => (
              <option key={operator}>{operator}</option>
            ))}
          </select>
        </label>
        <button
          className="icon-button builder-remove"
          aria-label={`Remove stream ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </button>
      </div>
      <label className="builder-field">
        Value
        <input
          aria-label={`Stream ${index + 1} value`}
          list={`${id}-values`}
          value={value.value}
          maxLength={4000}
          onChange={(event) => onChange({ ...value, value: event.target.value })}
        />
        <datalist id={`${id}-values`}>
          {suggestions.data.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </label>
      {suggestions.error && <p className="builder-warning">{suggestions.error}</p>}
    </div>
  );
}
