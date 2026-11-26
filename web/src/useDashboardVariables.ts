import { useEffect, useRef, useState } from 'react';
import { selectedSourceId, useDataSources } from './dataSources';
import type { Dashboard } from './dashboard';
import { interpolateVariables, variableSelection, type VariableValues } from './dashboardVariables';

type Resolution = {
  key: string;
  values: VariableValues;
  options: Record<string, string[]>;
  errors: Record<string, string>;
  truncated: Record<string, boolean>;
};
const cache = new Map<
  string,
  { expires: number; owner: string; values: string[]; truncated: boolean }
>();
/** Resolve in declaration order so chained option queries see selected parents. */
export function useDashboardVariables(
  dashboard: Dashboard,
  onResolved?: (values: VariableValues) => void,
) {
  const sources = useDataSources();
  const [revision, refresh] = useState(0);
  const key = JSON.stringify([
    dashboard.id,
    dashboard.range,
    dashboard.variables || [],
    sources,
    revision,
  ]);
  const [state, setState] = useState<Resolution>({
    key: '',
    values: {},
    options: {},
    errors: {},
    truncated: {},
  });
  const refreshed = useRef(0);
  const callback = useRef(onResolved);
  callback.current = onResolved;
  useEffect(() => {
    if (refreshed.current !== revision) {
      for (const [key, value] of cache) if (value.owner === dashboard.id) cache.delete(key);
      refreshed.current = revision;
    }
    const controller = new AbortController();
    const next: Resolution = { key, values: {}, options: {}, errors: {}, truncated: {} };
    const variables = dashboard.variables || [];
    const end = Math.floor(Date.now() / 1000),
      window = { start: end - dashboard.range, end };
    void (async () => {
      for (const variable of variables) {
        if (controller.signal.aborted) return;
        try {
          let options = variable.options || [];
          if (variable.type === 'query') {
            const kind = variable.source!;
            const sourceId = selectedSourceId(sources, kind, variable.sourceId);
            if (!sourceId) throw new Error('Select a configured data source.');
            const query = interpolateVariables(variable.query || '', variables, next.values, {
              kind,
              window,
              optionQuery: true,
            });
            const cacheKey = JSON.stringify([
              dashboard.id,
              sourceId,
              sources.find((source) => source.id === sourceId)?.url,
              kind,
              query,
              dashboard.range,
            ]);
            const saved = cache.get(cacheKey);
            if (saved && saved.expires > Date.now()) {
              options = saved.values;
              next.truncated[variable.name] = saved.truncated;
            } else {
              const response = await fetch('/api/dashboards/variables/options', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({ kind, sourceId, query, ...window }),
              });
              const body = await response.json();
              if (!response.ok) throw new Error(body.error || 'Could not load variable options.');
              if (
                !Array.isArray(body.data) ||
                body.data.some((value: unknown) => typeof value !== 'string')
              )
                throw new Error('Invalid variable options response.');
              options = [...new Set<string>(body.data)]
                .filter((value) => value.length <= 1024 && value !== '$__all')
                .slice(0, 200);
              next.truncated[variable.name] = !!body.truncated || body.data.length > 200;
              if (cache.size >= 200) cache.delete(cache.keys().next().value!);
              cache.set(cacheKey, {
                owner: dashboard.id,
                values: options,
                truncated: next.truncated[variable.name],
                expires: Date.now() + 30000,
              });
            }
          }
          next.options[variable.name] = options;
          next.values[variable.name] = variableSelection(variable, options);
        } catch (error) {
          if (controller.signal.aborted) return;
          next.errors[variable.name] = (error as Error).message;
          next.values[variable.name] = [];
          next.options[variable.name] = [];
        }
      }
      if (!controller.signal.aborted) {
        setState(next);
        if (!Object.keys(next.errors).length) callback.current?.(next.values);
      }
    })();
    return () => controller.abort();
  }, [key]);
  return { ...state, pending: state.key !== key, refresh: () => refresh((value) => value + 1) };
}
