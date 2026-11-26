import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  allVariableValues,
  type DashboardVariable,
  type VariableValues,
} from './dashboardVariables';

type Props = {
  variables: DashboardVariable[];
  values: VariableValues;
  options: Record<string, string[]>;
  errors: Record<string, string>;
  truncated: Record<string, boolean>;
  pending: boolean;
  onSelect: (name: string, values: string[]) => void;
  onRefresh: () => void;
};
function TextVariable({
  variable,
  value,
  onSelect,
}: {
  variable: DashboardVariable;
  value: string;
  onSelect: Props['onSelect'];
}) {
  const [text, setText] = useState(value);
  return (
    <input
      key={value}
      aria-label={variable.label || variable.name}
      value={text}
      maxLength={1024}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text !== value) onSelect(variable.name, [text]);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}
export function DashboardVariables(props: Props) {
  if (!props.variables.length) return null;
  return (
    <div className="dashboard-variables" aria-label="Dashboard variables">
      {props.variables.map((variable) => {
        const selected = props.pending
          ? variable.current || []
          : props.values[variable.name] || variable.current || [];
        const options = props.options[variable.name] || variable.options || [];
        const label = variable.label || variable.name;
        return (
          <div className="dashboard-variable" key={variable.name}>
            <span>{label}</span>
            {variable.type === 'textbox' ? (
              <TextVariable
                key={`${variable.name}-${selected[0]}`}
                variable={variable}
                value={selected[0] || ''}
                onSelect={props.onSelect}
              />
            ) : variable.multi ? (
              <details className="variable-multi">
                <summary>
                  {selected.includes(allVariableValues)
                    ? 'All'
                    : selected.length
                      ? selected.join(', ')
                      : props.pending
                        ? 'Loading…'
                        : 'No values'}
                </summary>
                <div className="variable-options">
                  {variable.includeAll && (
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.includes(allVariableValues)}
                        disabled={props.pending}
                        onChange={(event) =>
                          props.onSelect(
                            variable.name,
                            event.target.checked ? [allVariableValues] : options.slice(0, 1),
                          )
                        }
                      />
                      All
                    </label>
                  )}
                  {options.map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={selected.includes(value)}
                        disabled={
                          props.pending || (!selected.includes(value) && selected.length >= 20)
                        }
                        onChange={(event) => {
                          const before = selected.filter((item) => item !== allVariableValues);
                          const next = event.target.checked
                            ? [...before, value]
                            : before.filter((item) => item !== value);
                          if (next.length) props.onSelect(variable.name, next);
                        }}
                      />
                      {value || '(empty)'}
                    </label>
                  ))}
                </div>
              </details>
            ) : (
              <select
                aria-label={label}
                value={selected[0] ?? ''}
                disabled={props.pending || !!props.errors[variable.name]}
                onChange={(event) => props.onSelect(variable.name, [event.target.value])}
              >
                {!selected.length && (
                  <option value="" disabled>
                    {props.pending ? 'Loading…' : 'No values'}
                  </option>
                )}
                {variable.includeAll && <option value={allVariableValues}>All</option>}
                {options.map((value) => (
                  <option key={value} value={value}>
                    {value || '(empty)'}
                  </option>
                ))}
              </select>
            )}
            {props.errors[variable.name] && (
              <small className="inline-error">{props.errors[variable.name]}</small>
            )}
            {props.truncated[variable.name] && <small>First 200 values</small>}
          </div>
        );
      })}
      {props.variables.some((variable) => variable.type === 'query') && (
        <button
          className="subtle-button"
          aria-label="Refresh variable options"
          disabled={props.pending}
          onClick={props.onRefresh}
        >
          <RefreshCw size={14} />
        </button>
      )}
    </div>
  );
}
