import { useId } from 'react';
import {
  logAggregations,
  logStageQuery,
  type LogFilterOperator,
  type LogStage,
} from './logsBuilder';
import {
  nativePipeNames,
  logsqlFilterReference,
  logsqlPipeReference,
  type NativePipeName,
} from './nativeLogsQL';
import { useSuggestions } from './useSuggestions';
import { LogFilterConstructor } from './LogFilterConstructor';
import { buildLogFilter, parseLogFilter } from './logFilters';

type LogStageEditorProps = {
  stage: LogStage;
  fields: string[];
  source: string;
  start: number;
  end: number;
  onChange: (stage: LogStage) => void;
};
export function LogStageEditor({
  stage,
  fields,
  source,
  start,
  end,
  onChange,
}: LogStageEditorProps) {
  const id = useId();
  const values = useSuggestions(
    stage.type === 'filter' &&
      stage.mode !== 'expression' &&
      stage.mode !== 'builder' &&
      stage.operator !== 'exists' &&
      stage.field
      ? `/api/logs/metadata?${new URLSearchParams({ type: 'values', field: stage.field, query: source, start: String(start), end: String(end) })}`
      : null,
  );
  function update(patch: Record<string, string>) {
    onChange({ ...stage, ...patch } as LogStage);
  }
  function field(label: string, key: string, value: string, suggested = true, maxLength = 1000) {
    return (
      <label className="builder-field builder-grow">
        {label}
        <input
          aria-label={`Stage ${label.toLowerCase()}`}
          value={value}
          maxLength={maxLength}
          list={suggested ? `${id}-fields` : undefined}
          onChange={(event) => update({ [key]: event.target.value })}
          autoComplete="off"
        />
      </label>
    );
  }
  return (
    <div className="pipe-stage-fields">
      {stage.type !== 'native' && stage.type !== 'filter' && stage.type !== 'raw' && (
        <button
          className="text-button pipe-native-edit"
          onClick={() => {
            const result = logStageQuery(stage);
            const args = result.error
              ? 'fields' in stage
                ? stage.fields
                : ''
              : result.query.slice(stage.type.length).trim();
            if (nativePipeNames.includes(stage.type as NativePipeName))
              onChange({
                id: stage.id,
                enabled: stage.enabled,
                type: 'native',
                name: stage.type as NativePipeName,
                arguments: args,
              });
          }}
        >
          Edit native arguments
        </button>
      )}
      <datalist id={`${id}-fields`}>
        {fields.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {stage.type === 'filter' && (
        <label className="builder-field">
          Filter input
          <select
            aria-label="Filter input"
            value={stage.mode || 'fields'}
            onChange={(event) =>
              onChange({
                ...stage,
                mode: event.target.value as 'fields' | 'expression' | 'builder',
                filterTree:
                  stage.filterTree ||
                  parseLogFilter(
                    stage.expression || logStageQuery(stage).query.replace(/^filter /, ''),
                  ),
                expression:
                  stage.mode === 'builder' && stage.filterTree
                    ? buildLogFilter(stage.filterTree).query || stage.expression || ''
                    : (stage.expression ?? logStageQuery(stage).query.replace(/^filter /, '')),
              })
            }
          >
            <option value="builder">Builder</option>
            <option value="expression">LogsQL expression</option>
            <option value="fields">Field filter</option>
          </select>
        </label>
      )}
      {stage.type === 'filter' && stage.mode === 'expression' && (
        <label className="builder-field">
          LogsQL filter
          <textarea
            aria-label="Stage filter expression"
            value={stage.expression || ''}
            maxLength={16000}
            spellCheck={false}
            onChange={(event) =>
              onChange({
                ...stage,
                expression: event.target.value,
                ...(stage.type === 'filter' ? { filterTree: undefined } : {}),
              })
            }
          />
          <a
            className="pipe-doc-link"
            href={logsqlFilterReference}
            target="_blank"
            rel="noreferrer"
          >
            Filter syntax
          </a>
        </label>
      )}
      {stage.type === 'filter' && stage.mode === 'builder' && (
        <LogFilterConstructor
          value={stage.filterTree || parseLogFilter(stage.expression || '')}
          fields={fields}
          query={source}
          start={start}
          end={end}
          onChange={(filterTree) => onChange({ ...stage, filterTree })}
        />
      )}
      {stage.type === 'filter' && stage.mode !== 'expression' && stage.mode !== 'builder' && (
        <>
          <div className="builder-fields">
            {field('Field', 'field', stage.field)}
            <label className="builder-field builder-grow">
              Match
              <select
                aria-label="Stage match"
                value={stage.operator}
                onChange={(event) => update({ operator: event.target.value as LogFilterOperator })}
              >
                <option value="phrase">:phrase</option>
                <option value="exact">:=value</option>
                <option value="not">:!=value</option>
                <option value="regex">:~regexp</option>
                <option value="not_regex">:!~regexp</option>
                <option value="exists">:*</option>
              </select>
            </label>
          </div>
          {stage.operator !== 'exists' && (
            <label className="builder-field">
              Value
              <input
                aria-label="Stage value"
                list={`${id}-values`}
                value={stage.value}
                maxLength={4000}
                onChange={(event) => update({ value: event.target.value })}
              />
              <datalist id={`${id}-values`}>
                {values.data.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </label>
          )}
          {values.error && <p className="builder-warning">{values.error}</p>}
        </>
      )}
      {(stage.type === 'unpack_json' || stage.type === 'unpack_logfmt') &&
        field('Source field', 'field', stage.field)}
      {(stage.type === 'fields' || stage.type === 'delete' || stage.type === 'uniq') && (
        <>
          {field('Fields', 'fields', stage.fields)}
          <span className="builder-field-hint">Comma-separated</span>
        </>
      )}
      {stage.type === 'rename' && (
        <div className="builder-fields">
          {field('Source field', 'field', stage.field)}
          {field('Target field', 'target', stage.target)}
        </div>
      )}
      {stage.type === 'replace' && (
        <>
          {field('Field', 'field', stage.field)}
          <div className="builder-fields">
            {field('Find', 'find', stage.find, false, 4000)}
            {field('Replacement', 'replacement', stage.replacement, false, 4000)}
          </div>
        </>
      )}
      {stage.type === 'sort' && (
        <div className="builder-fields">
          {field('Fields', 'fields', stage.fields)}
          <label className="builder-field">
            Direction
            <select
              aria-label="Stage direction"
              value={stage.direction}
              onChange={(event) => update({ direction: event.target.value })}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </label>
        </div>
      )}
      {(stage.type === 'limit' || stage.type === 'offset') &&
        field('Rows', 'count', stage.count, false, 20)}
      {stage.type === 'stats' && (
        <>
          <div className="builder-fields">
            <label className="builder-field builder-grow">
              Function
              <select
                aria-label="Stage function"
                value={stage.aggregation}
                onChange={(event) => update({ aggregation: event.target.value })}
              >
                {logAggregations.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            {stage.aggregation !== 'count' && field('Field', 'field', stage.field)}
            {field('Output field', 'alias', stage.alias)}
          </div>
          {field('Group by', 'groupBy', stage.groupBy)}
          <span className="builder-field-hint">Optional comma-separated fields</span>
        </>
      )}
      {stage.type === 'native' && (
        <label className="builder-field">
          {stage.name} arguments
          <textarea
            aria-label="Native pipe arguments"
            value={stage.arguments}
            maxLength={16000}
            spellCheck={false}
            onChange={(event) => update({ arguments: event.target.value })}
          />
          <a
            className="pipe-doc-link"
            href={`${logsqlPipeReference.replace('#pipes', '')}#${stage.name.replaceAll('_', '-')}-pipe`}
            target="_blank"
            rel="noreferrer"
          >
            {stage.name} syntax
          </a>
        </label>
      )}
      {stage.type === 'raw' && (
        <label className="builder-field">
          Pipe expression
          <textarea
            aria-label="Stage pipe expression"
            value={stage.expression}
            maxLength={16000}
            spellCheck={false}
            onChange={(event) => update({ expression: event.target.value })}
          />
        </label>
      )}
    </div>
  );
}
