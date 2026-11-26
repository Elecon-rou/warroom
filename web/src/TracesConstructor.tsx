import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { TracesBuilder } from './queryBuilders';
import { useSuggestions } from './useSuggestions';

type TracesConstructorProps = {
  value: TracesBuilder;
  services: string[];
  onChange: (value: TracesBuilder) => void;
};
export function TracesConstructor({ value, services, onChange }: TracesConstructorProps) {
  const id = useId();
  const serviceNames = useSuggestions('/api/services');
  const operations = useSuggestions(
    value.service ? `/api/operations?${new URLSearchParams({ service: value.service })}` : null,
  );
  return (
    <div className="traces-constructor">
      <div className="builder-fields">
        <label className="builder-field builder-grow">
          Service
          <input
            aria-label="Trace service"
            list={`${id}-services`}
            value={value.service}
            maxLength={1000}
            onChange={(event) => onChange({ ...value, service: event.target.value, operation: '' })}
          />
          <datalist id={`${id}-services`}>
            {[...new Set([...services, ...serviceNames.data])].map((service) => (
              <option key={service} value={service} />
            ))}
          </datalist>
        </label>
        <label className="builder-field builder-grow">
          Operation
          <input
            aria-label="Trace operation"
            list={`${id}-operations`}
            disabled={!value.service}
            value={value.operation}
            maxLength={1000}
            onChange={(event) => onChange({ ...value, operation: event.target.value })}
          />
          <datalist id={`${id}-operations`}>
            {operations.data.map((operation) => (
              <option key={operation} value={operation} />
            ))}
          </datalist>
        </label>
      </div>
      {(serviceNames.pending || operations.pending) && (
        <span className="builder-metadata-status" role="status">
          Loading suggestions…
        </span>
      )}
      {(serviceNames.error || operations.error) && (
        <p className="builder-warning" role="status">
          {serviceNames.error || operations.error} You can enter names manually.
        </p>
      )}
      <div className="builder-section-heading">
        <span>Tags</span>
        <button
          className="subtle-button"
          disabled={value.tags.length >= 32}
          onClick={() => onChange({ ...value, tags: [...value.tags, { key: '', value: '' }] })}
        >
          <Plus size={13} />
          Add tag
        </button>
      </div>
      {value.tags.map((tag, index) => (
        <div className="builder-filter-row" key={index}>
          <label className="builder-field builder-grow">
            Key
            <input
              aria-label={`Tag ${index + 1} key`}
              value={tag.key}
              maxLength={1000}
              onChange={(event) =>
                onChange({
                  ...value,
                  tags: value.tags.map((current, i) =>
                    i === index ? { ...current, key: event.target.value } : current,
                  ),
                })
              }
            />
          </label>
          <span className="builder-equals">=</span>
          <label className="builder-field builder-grow">
            Value
            <input
              aria-label={`Tag ${index + 1} value`}
              value={tag.value}
              maxLength={1000}
              onChange={(event) =>
                onChange({
                  ...value,
                  tags: value.tags.map((current, i) =>
                    i === index ? { ...current, value: event.target.value } : current,
                  ),
                })
              }
            />
          </label>
          <button
            className="icon-button builder-remove"
            aria-label={`Remove tag ${index + 1}`}
            onClick={() => onChange({ ...value, tags: value.tags.filter((_, i) => i !== index) })}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="builder-fields builder-durations">
        <label className="builder-field">
          Min duration
          <input
            aria-label="Minimum trace duration"
            value={value.minDuration}
            maxLength={100}
            onChange={(event) => onChange({ ...value, minDuration: event.target.value })}
          />
        </label>
        <label className="builder-field">
          Max duration
          <input
            aria-label="Maximum trace duration"
            value={value.maxDuration}
            maxLength={100}
            onChange={(event) => onChange({ ...value, maxDuration: event.target.value })}
          />
        </label>
      </div>
    </div>
  );
}
