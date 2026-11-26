import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  emptyFilterGroup,
  newFilterRule,
  type LogFilterGroup,
  type LogFilterNode,
  type LogFilterRule,
} from './logFilters';
import { useSuggestions } from './useSuggestions';

type LogFilterConstructorProps = {
  value: LogFilterGroup;
  fields: string[];
  query: string;
  start: number;
  end: number;
  onChange: (value: LogFilterGroup) => void;
};
const operators = [
  ['phrase', 'Contains phrase'],
  ['exact', 'Equals :='],
  ['not', 'Does not equal !='],
  ['regex', 'Matches regex ~'],
  ['not_regex', 'Does not match !~'],
  ['prefix', 'Prefix *'],
  ['substring', 'Contains text'],
  ['exists', 'Is not empty *'],
  ['empty', 'Is empty'],
  ['gt', 'Greater than >'],
  ['gte', 'At least >='],
  ['lt', 'Less than <'],
  ['lte', 'At most <='],
  ['in', 'One of in()'],
  ['contains_any', 'Contains any'],
  ['contains_all', 'Contains all'],
];
function nodeCount(node: LogFilterNode): number {
  return node.type === 'group'
    ? 1 + node.conditions.reduce((count, child) => count + nodeCount(child), 0)
    : 1;
}
export function LogFilterConstructor(props: LogFilterConstructorProps) {
  return <FilterGroup {...props} root depth={0} path="" canAdd={nodeCount(props.value) < 64} />;
}
type FilterGroupProps = LogFilterConstructorProps & {
  root?: boolean;
  depth: number;
  path: string;
  canAdd: boolean;
  onRemove?: () => void;
};
function FilterGroup({
  value,
  onChange,
  root,
  depth,
  path,
  canAdd,
  onRemove,
  ...metadata
}: FilterGroupProps) {
  function change(index: number, node: LogFilterNode) {
    onChange({
      ...value,
      conditions: value.conditions.map((current, i) => (i === index ? node : current)),
    });
  }
  return (
    <div className={`log-filter-group ${root ? 'root' : ''}`}>
      <div className="log-filter-group-heading">
        <label>
          Match
          <select
            aria-label={`${path ? `Group ${path}` : 'Filter'} combination`}
            value={value.join}
            onChange={(event) => onChange({ ...value, join: event.target.value as 'AND' | 'OR' })}
          >
            <option value="AND">All (AND)</option>
            <option value="OR">Any (OR)</option>
          </select>
        </label>
        <label className="log-filter-negation">
          <input
            type="checkbox"
            aria-label={`${path ? `Group ${path}` : 'Filter'} negation`}
            checked={value.negated}
            onChange={(event) => onChange({ ...value, negated: event.target.checked })}
          />
          NOT
        </label>
        {onRemove && (
          <button className="icon-button" aria-label={`Remove group ${path}`} onClick={onRemove}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {value.conditions.map((condition, index) => {
        const name = path ? `${path}.${index + 1}` : String(index + 1);
        const remove = () =>
          onChange({ ...value, conditions: value.conditions.filter((_, i) => i !== index) });
        return condition.type === 'group' ? (
          <FilterGroup
            {...metadata}
            key={condition.id}
            value={condition}
            onChange={(group) => change(index, group)}
            onRemove={remove}
            path={name}
            depth={depth + 1}
            canAdd={canAdd}
          />
        ) : condition.type === 'expression' ? (
          <div className="log-native-condition" key={condition.id}>
            <label className="builder-field builder-grow">
              Native expression
              <textarea
                aria-label={`Condition ${name} expression`}
                value={condition.expression}
                maxLength={16000}
                onChange={(event) =>
                  change(index, { ...condition, expression: event.target.value })
                }
              />
            </label>
            <button
              className="icon-button"
              aria-label={`Remove condition ${name}`}
              onClick={remove}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ) : (
          <FilterRule
            {...metadata}
            key={condition.id}
            value={condition}
            name={name}
            onChange={(rule) => change(index, rule)}
            onRemove={remove}
          />
        );
      })}
      <div className="log-filter-add">
        <button
          className="subtle-button"
          disabled={!canAdd}
          aria-label={path ? `Add condition to group ${path}` : 'Add condition'}
          onClick={() => onChange({ ...value, conditions: [...value.conditions, newFilterRule()] })}
        >
          <Plus size={12} />
          Condition
        </button>
        {depth < 3 && (
          <button
            className="subtle-button"
            disabled={!canAdd}
            aria-label={path ? `Add group to group ${path}` : 'Add group'}
            onClick={() =>
              onChange({
                ...value,
                conditions: [...value.conditions, emptyFilterGroup(crypto.randomUUID())],
              })
            }
          >
            <Plus size={12} />
            Group
          </button>
        )}
      </div>
    </div>
  );
}
type FilterRuleProps = Omit<LogFilterConstructorProps, 'value' | 'onChange'> & {
  value: LogFilterRule;
  name: string;
  onChange: (value: LogFilterRule) => void;
  onRemove: () => void;
};
function FilterRule({
  value,
  name,
  fields,
  query,
  start,
  end,
  onChange,
  onRemove,
}: FilterRuleProps) {
  const id = useId();
  const needsValue = !['exists', 'empty'].includes(value.operator);
  const multiple = ['in', 'contains_any', 'contains_all'].includes(value.operator);
  const suggestions = useSuggestions(
    needsValue && value.field
      ? `/api/logs/metadata?${new URLSearchParams({ type: 'values', field: value.field, query, start: String(start), end: String(end) })}`
      : null,
  );
  return (
    <div className="log-filter-condition">
      <div className="log-filter-condition-fields">
        <label className="builder-field builder-grow">
          Field
          <input
            aria-label={`Condition ${name} field`}
            list={`${id}-fields`}
            value={value.field}
            maxLength={1000}
            onChange={(event) => onChange({ ...value, field: event.target.value })}
          />
          <datalist id={`${id}-fields`}>
            {fields.map((field) => (
              <option value={field} key={field} />
            ))}
          </datalist>
        </label>
        <label className="builder-field builder-grow">
          Operator
          <select
            aria-label={`Condition ${name} operator`}
            value={value.operator}
            onChange={(event) =>
              onChange({ ...value, operator: event.target.value as LogFilterRule['operator'] })
            }
          >
            {operators.map(([operator, label]) => (
              <option key={operator} value={operator}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-button builder-remove"
          aria-label={`Remove condition ${name}`}
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {needsValue && (
        <label className="builder-field">
          {multiple ? 'Values · one per line' : 'Value'}
          {multiple ? (
            <textarea
              aria-label={`Condition ${name} value`}
              maxLength={4000}
              value={value.value}
              onChange={(event) => onChange({ ...value, value: event.target.value })}
            />
          ) : (
            <input
              aria-label={`Condition ${name} value`}
              list={`${id}-values`}
              maxLength={4000}
              value={value.value}
              onChange={(event) => onChange({ ...value, value: event.target.value })}
            />
          )}
          <datalist id={`${id}-values`}>
            {suggestions.data.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
      )}
      {suggestions.error && <p className="builder-warning">{suggestions.error}</p>}
    </div>
  );
}
