import type { Dashboard, DashboardWidget } from './dashboard.ts';
import type { Kind } from './types.ts';

export const allVariableValues = '$__all';
export const maxDashboardVariables = 20;
export type DashboardVariable = {
  name: string;
  label?: string;
  type: 'custom' | 'textbox' | 'query';
  source?: Kind;
  sourceId?: string;
  query?: string;
  options?: string[];
  current?: string[];
  multi?: boolean;
  includeAll?: boolean;
};
export type VariableValues = Record<string, string[]>;
const reference = /\$\$|\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::([a-z]+))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;
export function variableReferences(text: string) {
  return [...text.matchAll(reference)]
    .map((match) => match[1] || match[3])
    .filter((name): name is string => !!name);
}
export function parseDashboardVariables(raw: unknown): DashboardVariable[] {
  if (!Array.isArray(raw) || raw.length > maxDashboardVariables)
    throw new Error(`A dashboard supports at most ${maxDashboardVariables} variables.`);
  const seen = new Set<string>();
  return raw.map((v): DashboardVariable => {
    if (
      !v ||
      typeof v.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v.name) ||
      v.name.startsWith('__') ||
      seen.has(v.name) ||
      !['custom', 'textbox', 'query'].includes(v.type) ||
      (v.label !== undefined && (typeof v.label !== 'string' || v.label.length > 120)) ||
      (v.multi !== undefined && typeof v.multi !== 'boolean') ||
      (v.includeAll !== undefined && typeof v.includeAll !== 'boolean')
    )
      throw new Error(
        'Variable names must be unique identifiers; names starting with __ are reserved.',
      );
    const options = v.options ?? [],
      current = v.current ?? [];
    for (const [values, limit] of [
      [options, 200],
      [current, 20],
    ] as const)
      if (
        !Array.isArray(values) ||
        values.length > limit ||
        values.some((value) => typeof value !== 'string' || value.length > 1024) ||
        new Set(values).size !== values.length
      )
        throw new Error(`Invalid options or selection for variable ${v.name}.`);
    if (
      (!v.multi && current.length > 1) ||
      options.includes(allVariableValues) ||
      (current.includes(allVariableValues) && (!v.includeAll || current.length !== 1))
    )
      throw new Error(`Invalid All or multi-selection for variable ${v.name}.`);
    if (
      v.type === 'custom' &&
      (!options.length ||
        current.some((value: string) => value !== allVariableValues && !options.includes(value)))
    )
      throw new Error(`Variable ${v.name} needs options containing its selected values.`);
    if (v.type === 'textbox' && (v.multi || v.includeAll))
      throw new Error(`Text variable ${v.name} must have a single value.`);
    if (v.type === 'query') {
      if (
        !['metrics', 'logs', 'traces'].includes(v.source) ||
        typeof v.query !== 'string' ||
        !v.query.trim() ||
        v.query.length > 4000 ||
        (v.sourceId !== undefined && typeof v.sourceId !== 'string')
      )
        throw new Error(`Variable ${v.name} needs a data source and option query.`);
      for (const dependency of variableReferences(v.query))
        if (!dependency.startsWith('__') && !seen.has(dependency))
          throw new Error(`Variable ${v.name} must follow its dependency ${dependency}.`);
    }
    seen.add(v.name);
    return {
      name: v.name,
      type: v.type,
      ...(v.label ? { label: v.label } : {}),
      ...(v.type === 'custom' ? { options } : {}),
      ...(v.type === 'query'
        ? { source: v.source, ...(v.sourceId ? { sourceId: v.sourceId } : {}), query: v.query }
        : {}),
      ...(current.length ? { current } : {}),
      ...(v.multi ? { multi: true } : {}),
      ...(v.includeAll ? { includeAll: true } : {}),
    };
  });
}
export function variableSelection(variable: DashboardVariable, options: string[]): string[] {
  if (variable.type === 'textbox') return [variable.current?.[0] ?? ''];
  if (variable.includeAll && variable.current?.includes(allVariableValues))
    return [allVariableValues];
  const selected = (variable.current || []).filter((value) => options.includes(value));
  return selected.length ? (variable.multi ? selected : selected.slice(0, 1)) : options.slice(0, 1);
}
export function defaultVariableValues(variables: DashboardVariable[] = []): VariableValues {
  return Object.fromEntries(
    variables.map((v) => [
      v.name,
      v.current?.length ? v.current : variableSelection(v, v.options || []),
    ]),
  );
}
export type VariableWindow = { start: number; end: number };
type Interpolation = {
  kind?: Kind;
  window: VariableWindow;
  title?: boolean;
  optionQuery?: boolean;
};
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapedString = (value: string) => JSON.stringify(value).slice(1, -1);
function inString(text: string) {
  let quoted = false,
    escaped = false;
  for (const character of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
  }
  return quoted;
}
export function interpolateVariables(
  text: string,
  variables: DashboardVariable[],
  values: VariableValues,
  context: Interpolation,
): string {
  const duration = Math.max(1, Math.round(context.window.end - context.window.start));
  const interval = Math.max(1, Math.ceil(duration / 240));
  const builtins: Record<string, string> = {
    __from: String(Math.round(context.window.start * 1000)),
    __to: String(Math.round(context.window.end * 1000)),
    __range: `${duration}s`,
    __range_s: String(duration),
    __range_ms: String(duration * 1000),
    __interval: `${interval}s`,
    __interval_ms: String(interval * 1000),
    __rate_interval: `${Math.max(60, interval * 4)}s`,
  };
  const lookup = new Map(variables.map((v) => [v.name, v]));
  function interpolate(input: string, plain = false): string {
    return input.replace(
      reference,
      (token, braced: string, format: string, short: string, offset: number) => {
        if (token === '$$') return '$';
        const name = braced || short;
        if (builtins[name] !== undefined) return builtins[name];
        const variable = lookup.get(name);
        if (!variable) throw new Error(`Unknown dashboard variable: ${name}.`);
        const selected = values[name];
        if (!selected?.length) throw new Error(`Select a value for variable ${name}.`);
        const all = selected[0] === allVariableValues;
        if (context.title) return all ? 'All' : selected.join(', ');
        if (format && !['regex', 'raw', 'csv', 'json'].includes(format))
          throw new Error(`Unsupported variable format: ${format}.`);
        if (plain && !format) {
          if (all || selected.length !== 1)
            throw new Error(`Trace variable ${name} requires one value.`);
          return selected[0];
        }
        const prefix = input.slice(0, offset);
        const quoted = inString(prefix);
        const regexContext = /(?:=~|!~|:~)\s*"(?:[^"\\]|\\.)*$/.test(prefix);
        if (
          !format &&
          context.kind === 'metrics' &&
          (variable.multi || variable.includeAll) &&
          !regexContext &&
          !plain
        )
          throw new Error(`Use a regex matcher (=~) for multi-value or All variable ${name}.`);
        const regex =
          format === 'regex' ||
          (!format && (regexContext || variable.multi || variable.includeAll));
        let result: string;
        if (format === 'json')
          return JSON.stringify(selected.length === 1 ? selected[0] : selected);
        if (format === 'raw' || format === 'csv') return all ? '.*' : selected.join(',');
        if (regex) {
          const parts = selected.map(escapeRegex);
          result = all ? '.*' : parts.length === 1 ? parts[0] : `(${parts.join('|')})`;
        } else {
          if (all) throw new Error(`All requires a regex matcher for variable ${name}.`);
          result = selected.join(',');
        }
        return quoted && !plain ? escapedString(result) : result;
      },
    );
  }
  if (context.kind === 'traces' && !context.title && !context.optionQuery) {
    const params = new URLSearchParams(text);
    for (const [name, value] of [...params]) {
      if (name === 'tags') {
        const tags = JSON.parse(value);
        if (!tags || Array.isArray(tags) || typeof tags !== 'object')
          throw new Error('Trace tags must be an object.');
        params.set(
          name,
          JSON.stringify(
            Object.fromEntries(
              Object.entries(tags).map(([key, value]) => {
                if (typeof value !== 'string') throw new Error('Trace tags must contain strings.');
                return [key, interpolate(value, true)];
              }),
            ),
          ),
        );
      } else params.set(name, interpolate(value, true));
    }
    return params.toString();
  }
  return interpolate(text);
}
export function resolveDashboardWidget(
  widget: DashboardWidget,
  dashboard: Dashboard,
  values: VariableValues,
  window: VariableWindow,
): DashboardWidget {
  const variables = dashboard.variables || [];
  const query =
    widget.type === 'force-graph'
      ? ''
      : interpolateVariables(widget.query, variables, values, { kind: widget.source, window });
  if (query.length > 16000)
    throw new Error(`Interpolated query exceeds 16000 characters: ${widget.title}.`);
  return {
    ...widget,
    query,
    title: interpolateVariables(widget.title, variables, values, { window, title: true }),
  };
}
