import { useId } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
  aggregations,
  instantFunctions,
  newOperation,
  parameterFunctions,
  rangeFunctions,
  scalarOperations,
  type LabelFilter,
  type MetricOperation,
  type MetricsBuilder,
} from './queryBuilders';
import { useSuggestions } from './useSuggestions';

type MetricsConstructorProps = {
  value: MetricsBuilder;
  start: number;
  end: number;
  onChange: (value: MetricsBuilder) => void;
};
export function MetricsConstructor({ value, start, end, onChange }: MetricsConstructorProps) {
  const id = useId();
  const metadataParams = new URLSearchParams({ start: String(start), end: String(end) });
  const metadataUrl = (type: string, extra: Record<string, string> = {}) =>
    `/api/metrics/metadata?${new URLSearchParams({ ...Object.fromEntries(metadataParams), type, ...extra })}`;
  const metrics = useSuggestions(metadataUrl('metrics', { search: value.metric.slice(0, 200) }));
  const validMetric = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(value.metric);
  const labels = useSuggestions(
    validMetric ? metadataUrl('labels', { metric: value.metric }) : null,
  );
  function updateFilter(index: number, patch: Partial<LabelFilter>) {
    onChange({
      ...value,
      filters: value.filters.map((filter, current) =>
        current === index ? { ...filter, ...patch } : filter,
      ),
    });
  }
  function updateOperation(index: number, patch: Partial<MetricOperation>) {
    onChange({
      ...value,
      operations: value.operations.map((operation, current) =>
        current === index ? { ...operation, ...patch } : operation,
      ),
    });
  }
  function moveOperation(index: number, direction: number) {
    const operations = [...value.operations];
    [operations[index], operations[index + direction]] = [
      operations[index + direction],
      operations[index],
    ];
    onChange({ ...value, operations });
  }
  return (
    <div className="metrics-constructor">
      <label className="builder-field builder-metric">
        Metric
        <input
          aria-label="Metric"
          list={`${id}-metrics`}
          value={value.metric}
          maxLength={1000}
          autoComplete="off"
          onChange={(event) => onChange({ ...value, metric: event.target.value })}
        />
        <datalist id={`${id}-metrics`}>
          {metrics.data.map((metric) => (
            <option key={metric} value={metric} />
          ))}
        </datalist>
      </label>
      {(metrics.pending || labels.pending) && (
        <span className="builder-metadata-status" role="status">
          Loading suggestions…
        </span>
      )}
      {metrics.truncated && (
        <span className="builder-metadata-status">Type to narrow metric suggestions.</span>
      )}
      {(metrics.error || labels.error) && (
        <p className="builder-warning" role="status">
          {metrics.error || labels.error} You can enter names manually.
        </p>
      )}
      <div className="builder-section-heading">
        <span>Label filters</span>
        <button
          className="subtle-button"
          disabled={value.filters.length >= 32}
          onClick={() =>
            onChange({
              ...value,
              filters: [...value.filters, { label: '', operator: '=', value: '' }],
            })
          }
        >
          <Plus size={13} />
          Add filter
        </button>
      </div>
      <datalist id={`${id}-labels`}>
        {labels.data
          .filter((label) => label !== '__name__')
          .map((label) => (
            <option key={label} value={label} />
          ))}
      </datalist>
      {value.filters.map((filter, index) => (
        <MetricFilter
          key={index}
          filter={filter}
          index={index}
          metric={value.metric}
          labelsId={`${id}-labels`}
          start={start}
          end={end}
          onChange={(patch) => updateFilter(index, patch)}
          onRemove={() =>
            onChange({ ...value, filters: value.filters.filter((_, current) => current !== index) })
          }
        />
      ))}
      <div className="builder-section-heading">
        <span>Operations</span>
        <select
          className="builder-add-operation"
          aria-label="Add operation"
          value=""
          disabled={value.operations.length >= 12}
          onChange={(event) => {
            const operation = newOperation(event.target.value);
            // Range functions operate on the raw selector, before any aggregation.
            const operations = rangeFunctions.includes(operation.name)
              ? [operation, ...value.operations]
              : [...value.operations, operation];
            onChange({ ...value, operations });
          }}
        >
          <option value="" disabled>
            Add operation
          </option>
          <optgroup label="Range functions">
            {rangeFunctions.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </optgroup>
          <optgroup label="Aggregations">
            {aggregations.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </optgroup>
          <optgroup label="Functions">
            {[...instantFunctions, ...parameterFunctions].map((name) => (
              <option key={name}>{name}</option>
            ))}
          </optgroup>
          <optgroup label="Scalar arithmetic">
            {scalarOperations.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <div className="builder-operations">
        {value.operations.map((operation, index) => (
          <div className="builder-operation" key={index}>
            <div className="builder-operation-heading">
              <span className="builder-operation-order">{index + 1}</span>
              <code>{operation.name}</code>
              <div className="builder-row-actions">
                <button
                  className="icon-button"
                  aria-label={`Move operation ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => moveOperation(index, -1)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Move operation ${index + 1} down`}
                  disabled={index === value.operations.length - 1}
                  onClick={() => moveOperation(index, 1)}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Remove operation ${index + 1}`}
                  onClick={() =>
                    onChange({
                      ...value,
                      operations: value.operations.filter((_, current) => current !== index),
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            {(rangeFunctions.includes(operation.name) ||
              parameterFunctions.includes(operation.name) ||
              scalarOperations.includes(operation.name)) && (
              <label className="builder-field">
                {rangeFunctions.includes(operation.name)
                  ? 'Range window'
                  : operation.name === 'histogram_quantile'
                    ? 'Quantile'
                    : scalarOperations.includes(operation.name)
                      ? 'Scalar'
                      : 'Count'}
                <input
                  aria-label={`Operation ${index + 1} parameter`}
                  value={operation.parameter}
                  maxLength={100}
                  onChange={(event) => updateOperation(index, { parameter: event.target.value })}
                />
              </label>
            )}
            {[...aggregations, 'topk', 'bottomk'].includes(operation.name) && (
              <div className="builder-grouping">
                <label className="builder-field">
                  Grouping
                  <select
                    aria-label={`Operation ${index + 1} grouping`}
                    value={operation.grouping}
                    onChange={(event) =>
                      updateOperation(index, { grouping: event.target.value as 'by' | 'without' })
                    }
                  >
                    <option value="by">By</option>
                    <option value="without">Without</option>
                  </select>
                </label>
                <label className="builder-field builder-grow">
                  Labels
                  <input
                    aria-label={`Operation ${index + 1} labels`}
                    list={`${id}-labels`}
                    value={operation.labels}
                    maxLength={1000}
                    onChange={(event) => updateOperation(index, { labels: event.target.value })}
                  />
                  <span className="builder-field-hint">Comma-separated</span>
                </label>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type MetricFilterProps = {
  filter: LabelFilter;
  index: number;
  metric: string;
  labelsId: string;
  start: number;
  end: number;
  onChange: (patch: Partial<LabelFilter>) => void;
  onRemove: () => void;
};
function MetricFilter({
  filter,
  index,
  metric,
  labelsId,
  start,
  end,
  onChange,
  onRemove,
}: MetricFilterProps) {
  const id = useId();
  const valid =
    /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(filter.label);
  const values = useSuggestions(
    valid
      ? `/api/metrics/metadata?${new URLSearchParams({ type: 'values', metric, label: filter.label, start: String(start), end: String(end) })}`
      : null,
  );
  return (
    <div className="builder-filter-group">
      <div className="builder-filter-row">
        <label className="builder-field builder-grow">
          Label
          <input
            aria-label={`Filter ${index + 1} label`}
            list={labelsId}
            value={filter.label}
            maxLength={1000}
            onChange={(event) => onChange({ label: event.target.value, value: '' })}
          />
        </label>
        <label className="builder-field builder-operator">
          Operator
          <select
            aria-label={`Filter ${index + 1} operator`}
            value={filter.operator}
            onChange={(event) =>
              onChange({ operator: event.target.value as LabelFilter['operator'] })
            }
          >
            {['=', '!=', '=~', '!~'].map((operator) => (
              <option key={operator}>{operator}</option>
            ))}
          </select>
        </label>
        <label className="builder-field builder-grow">
          Value
          <input
            aria-label={`Filter ${index + 1} value`}
            list={`${id}-values`}
            value={filter.value}
            maxLength={1000}
            onChange={(event) => onChange({ value: event.target.value })}
          />
          <datalist id={`${id}-values`}>
            {values.data.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <button
          className="icon-button builder-remove"
          aria-label={`Remove filter ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {values.error && (
        <p className="builder-warning" role="status">
          {values.error}
        </p>
      )}
    </div>
  );
}
