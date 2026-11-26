import { parseDashboard, type Dashboard } from './dashboard.ts';
import { builderQueryText, normalizeBuilder, type QueryBuilder } from './queryBuilders.ts';
import type { Kind } from './types';
export type Page =
  'dashboards' | 'explore' | 'history' | 'sources' | 'service-graph' | 'investigate';
export type InputMode = 'manual' | 'constructor' | 'llm';
export type QueryPanel = {
  id: string;
  kind: Kind;
  sourceId?: string;
  inputMode: InputMode;
  text: string;
  prompt: string;
  builder?: QueryBuilder;
  enabled: boolean;
  range: string;
  refresh: number;
  limit: number;
  step: string;
  customStart: string;
  customEnd: string;
  view: 'graph' | 'table';
  filter: string;
  wrap: boolean;
  sort: 'query' | 'newest' | 'oldest';
};
export type GraphSettings = {
  range: string;
  customStart: string;
  customEnd: string;
  refresh: number;
  source: 'combined' | 'metrics' | 'traces';
  metricsSourceId?: string;
  tracesSourceId?: string;
  search: string;
  view: 'graph' | 'table';
  metric: 'rps' | 'errors' | 'latency' | 'calls';
};
export function defaultGraphSettings(): GraphSettings {
  return {
    range: '1h',
    customStart: '',
    customEnd: '',
    refresh: 0,
    source: 'combined',
    search: '',
    view: 'graph',
    metric: 'rps',
  };
}
function normalizeGraph(value: any): GraphSettings {
  const d = defaultGraphSettings();
  return {
    ...d,
    range: [...ranges.map((r) => r[0]), 'custom'].includes(value?.range) ? value.range : d.range,
    customStart: isoDate(value?.customStart),
    customEnd: isoDate(value?.customEnd),
    refresh: [0, 15, 30, 60, 300].includes(value?.refresh) ? value.refresh : 0,
    source: ['combined', 'metrics', 'traces'].includes(value?.source) ? value.source : 'combined',
    ...(typeof value?.metricsSourceId === 'string'
      ? { metricsSourceId: value.metricsSourceId.slice(0, 100) }
      : {}),
    ...(typeof value?.tracesSourceId === 'string'
      ? { tracesSourceId: value.tracesSourceId.slice(0, 100) }
      : {}),
    search: typeof value?.search === 'string' ? value.search.slice(0, 500) : '',
    view: value?.view === 'table' ? 'table' : 'graph',
    metric: ['rps', 'errors', 'latency', 'calls'].includes(value?.metric) ? value.metric : 'rps',
  };
}
export type InvestigateSettings = { range: string; customStart: string; customEnd: string };
export function defaultInvestigateSettings(): InvestigateSettings {
  return { range: '1h', customStart: '', customEnd: '' };
}
export type ExplorerState = {
  version: 2;
  panels: QueryPanel[];
  dashboard?: Dashboard;
  serviceGraph?: GraphSettings;
  investigate?: InvestigateSettings;
};
export type LocationState = { page: Page; explorer: ExplorerState };
export const ranges = [
  ['5m', 'Last 5 minutes', 300],
  ['15m', 'Last 15 minutes', 900],
  ['30m', 'Last 30 minutes', 1800],
  ['1h', 'Last 1 hour', 3600],
  ['3h', 'Last 3 hours', 10800],
  ['6h', 'Last 6 hours', 21600],
  ['24h', 'Last 24 hours', 86400],
  ['7d', 'Last 7 days', 604800],
] as const;
const kinds: Kind[] = ['metrics', 'logs', 'traces'];
export function defaultPanel(id = 'panel-a', kind: Kind = 'metrics'): QueryPanel {
  return {
    id,
    kind,
    inputMode: 'manual',
    text: '',
    prompt: '',
    enabled: true,
    range: '1h',
    refresh: 0,
    limit: 100,
    step: 'auto',
    customStart: '',
    customEnd: '',
    view: 'graph',
    filter: '',
    wrap: true,
    sort: 'newest',
  };
}
// Input modes share one query. Only an explicit text change replaces it;
// a new prompt keeps the existing query until generation succeeds.
export function patchPanel(panel: QueryPanel, patch: Partial<QueryPanel>): QueryPanel {
  const next = { ...panel, ...patch };
  if (patch.inputMode && panel.inputMode === 'constructor' && panel.builder && !('text' in patch))
    next.text = builderQueryText(panel.builder, panel.text);
  // Pipeline sort stages own row order until the user chooses a viewer override.
  if (next.kind === 'logs' && next.inputMode === 'constructor' && (patch.inputMode || patch.kind))
    next.sort = 'query';
  if (patch.kind || ('text' in patch && patch.text !== panel.text && !('builder' in patch)))
    next.builder = undefined;
  return next;
}

export function defaults(): ExplorerState {
  return { version: 2, panels: [defaultPanel()] };
}
function normalizePanel(row: any, index: number, ids: Set<string>): QueryPanel | null {
  if (!row || typeof row.text !== 'string' || row.text.length > 16000) return null;
  let id = typeof row.id === 'string' && /^[-\w]{1,80}$/.test(row.id) ? row.id : `panel-${index}`;
  let suffix = 0;
  while (ids.has(id)) id = `panel-${index}-${suffix++}`;
  ids.add(id);
  const builder = normalizeBuilder(row.builder);
  return {
    ...(builder && builder.kind === row.kind ? { builder } : {}),
    id,
    ...(typeof row.sourceId === 'string' && row.sourceId
      ? { sourceId: row.sourceId.slice(0, 100) }
      : {}),
    kind: kinds.includes(row.kind) ? row.kind : 'metrics',
    inputMode: ['manual', 'constructor', 'llm'].includes(row.inputMode) ? row.inputMode : 'manual',
    text: row.text,
    prompt: typeof row.prompt === 'string' ? row.prompt.slice(0, 8000) : '',
    enabled: row.enabled !== false,
    range: [...ranges.map((r) => r[0]), 'custom'].includes(row.range) ? row.range : '1h',
    refresh: [0, 5, 10, 30, 60, 300].includes(row.refresh) ? row.refresh : 0,
    limit: [20, 50, 100, 250, 500, 1000].includes(row.limit) ? row.limit : 100,
    step: ['auto', '15', '30', '60', '300'].includes(row.step) ? row.step : 'auto',
    customStart: isoDate(row.customStart),
    customEnd: isoDate(row.customEnd),
    view: row.view === 'table' ? 'table' : 'graph',
    filter: typeof row.filter === 'string' ? row.filter.slice(0, 16000) : '',
    wrap: row.wrap !== false,
    sort: row.sort === 'query' ? 'query' : row.sort === 'oldest' ? 'oldest' : 'newest',
  };
}
export function decodeState(value: string | null): ExplorerState {
  if (!value || value.length > 2000000) return defaults();
  try {
    const state = JSON.parse(value);
    let rows: any[] = [];
    if (state?.version === 2 && Array.isArray(state.panels)) rows = state.panels;
    else if (state?.version === 1) {
      const active = kinds.includes(state.kind) ? state.kind : 'metrics';
      for (const kind of [active, ...kinds.filter((k) => k !== active)]) {
        if (!Array.isArray(state.queries?.[kind])) continue;
        for (const query of state.queries[kind])
          if (query && (kind === active || query.text?.trim()))
            rows.push({ ...state, ...query, kind });
      }
    } else return defaults();
    const ids = new Set<string>();
    const panels = rows
      .slice(0, 26)
      .map((row, index) => normalizePanel(row, index, ids))
      .filter((row): row is QueryPanel => row !== null);
    const result: ExplorerState = panels.length ? { version: 2, panels } : defaults();
    if (state.serviceGraph) result.serviceGraph = normalizeGraph(state.serviceGraph);
    if (state.investigate) {
      const value = normalizeGraph(state.investigate);
      result.investigate = {
        range: value.range,
        customStart: value.customStart,
        customEnd: value.customEnd,
      };
    }
    if (state.dashboard) {
      try {
        result.dashboard = parseDashboard(state.dashboard);
      } catch {
        /* Preserve other page state when dashboard import is invalid. */
      }
    }
    return result;
  } catch {
    return defaults();
  }
}
export function readLocation(hash = window.location.hash): LocationState {
  const [route, search = ''] = hash.replace(/^#/, '').split('?');
  return {
    page:
      route === 'dashboards' ||
      route === 'history' ||
      route === 'sources' ||
      route === 'service-graph' ||
      route === 'investigate'
        ? route
        : 'explore',
    explorer: decodeState(new URLSearchParams(search).get('state')),
  };
}
export function locationHash(page: Page, explorer: ExplorerState): string {
  return `#${page}?${new URLSearchParams({ state: JSON.stringify(explorer) })}`;
}
function isoDate(value: unknown): string {
  return typeof value === 'string' && value.length < 40 && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : '';
}
export function localDateTime(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function inputDateTime(value: string): string {
  return value ? new Date(value).toISOString() : '';
}
