import type { Kind, ResponseData, Series, Trace } from './types.ts';

export const maxDashboardWidgets = 64;

export const widgetTypes = [
  'blinkenlights',
  'bars',
  'time-series',
  'force-graph',
  'gauge',
  'logs',
  'pie',
  'table',
  'number',
] as const;
export type WidgetType = (typeof widgetTypes)[number];
export const reducers = ['last', 'mean', 'min', 'max', 'sum', 'count'] as const;
export type Reducer = (typeof reducers)[number];
export type DashboardWidget = {
  id: string;
  title: string;
  type: WidgetType;
  chartStyle?: 'lines' | 'bars';
  axisMode?: 'auto' | 'fixed';
  source: Kind;
  sourceId?: string;
  query: string;
  width: number;
  reducer: Reducer;
  valueField: string;
  labelField: string;
  unit: string;
  min: number;
  max: number;
  warning: number;
  critical: number;
};
export type Dashboard = {
  version: 1;
  id: string;
  title: string;
  range: number;
  refresh: number;
  widgets: DashboardWidget[];
};
export const compatibleSources = (type: WidgetType): Kind[] =>
  type === 'time-series'
    ? ['metrics']
    : type === 'logs'
      ? ['logs']
      : type === 'force-graph'
        ? ['metrics', 'traces']
        : ['metrics', 'logs', 'traces'];
export function newWidget(): DashboardWidget {
  return {
    id: crypto.randomUUID(),
    title: 'Widget',
    type: 'number',
    chartStyle: 'lines',
    axisMode: 'auto',
    source: 'metrics',
    query: '',
    width: 1,
    reducer: 'last',
    valueField: '',
    labelField: '',
    unit: '',
    min: 0,
    max: 100,
    warning: 70,
    critical: 90,
  };
}
export function newDashboard(): Dashboard {
  return {
    version: 1,
    id: crypto.randomUUID(),
    title: 'Dashboard',
    range: 3600,
    refresh: 0,
    widgets: [],
  };
}
// JSON, URL state, browser storage and LLM output all use this same boundary.
export function parseDashboard(value: unknown): Dashboard {
  const d = value as Dashboard;
  if (
    !d ||
    d.version !== 1 ||
    typeof d.id !== 'string' ||
    !d.id.trim() ||
    d.id.length > 100 ||
    typeof d.title !== 'string' ||
    !d.title.trim() ||
    d.title.length > 160 ||
    !Number.isFinite(d.range) ||
    d.range < 60 ||
    d.range > 2678400 ||
    ![0, 15, 30, 60, 300].includes(d.refresh) ||
    !Array.isArray(d.widgets) ||
    d.widgets.length > maxDashboardWidgets
  )
    throw new Error('Invalid dashboard: version, id, title, time range, refresh or widgets.');
  const ids = new Set<string>();
  for (const w of d.widgets) {
    if (!w || typeof w.id !== 'string' || !w.id.trim() || w.id.length > 100 || ids.has(w.id))
      throw new Error('Widget IDs must be unique, non-empty strings.');
    ids.add(w.id);
    if (!widgetTypes.includes(w.type) || !compatibleSources(w.type).includes(w.source))
      throw new Error(`Incompatible widget/source: ${w.type}/${w.source}.`);
    if (
      (w.chartStyle !== undefined && !['lines', 'bars'].includes(w.chartStyle)) ||
      (w.axisMode !== undefined && !['auto', 'fixed'].includes(w.axisMode))
    )
      throw new Error('Invalid time-series style or axis mode.');
    if (
      typeof w.title !== 'string' ||
      !w.title.trim() ||
      w.title.length > 160 ||
      typeof w.query !== 'string' ||
      w.query.length > 16000 ||
      ![1, 2, 3].includes(w.width) ||
      !reducers.includes(w.reducer)
    )
      throw new Error(`Invalid widget configuration: ${w.id}.`);
    for (const field of ['valueField', 'labelField', 'unit'] as const)
      if (typeof w[field] !== 'string' || w[field].length > 200)
        throw new Error(`Invalid ${field}.`);
    if (
      ![w.min, w.max, w.warning, w.critical].every(Number.isFinite) ||
      w.min >= w.max ||
      w.warning > w.critical
    )
      throw new Error('Gauge bounds and ascending thresholds must be finite.');
  }
  // Strip unknown properties rather than letting imported state leak into requests.
  return {
    version: 1,
    id: d.id,
    title: d.title,
    range: d.range,
    refresh: d.refresh,
    widgets: d.widgets.map((w) => ({
      id: w.id,
      title: w.title,
      type: w.type,
      ...(w.chartStyle ? { chartStyle: w.chartStyle } : {}),
      ...(w.axisMode ? { axisMode: w.axisMode } : {}),
      source: w.source,
      ...(typeof w.sourceId === 'string' && w.sourceId
        ? { sourceId: w.sourceId.slice(0, 100) }
        : {}),
      query: w.query,
      width: w.width,
      reducer: w.reducer,
      valueField: w.valueField,
      labelField: w.labelField,
      unit: w.unit,
      min: w.min,
      max: w.max,
      warning: w.warning,
      critical: w.critical,
    })),
  };
}
export function reduceValues(values: number[], reducer: Reducer): number | null {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  if (reducer === 'count') return nums.length;
  if (reducer === 'last') return nums.at(-1)!;
  if (reducer === 'min') return Math.min(...nums);
  if (reducer === 'max') return Math.max(...nums);
  const sum = nums.reduce((a, b) => a + b, 0);
  return reducer === 'mean' ? sum / nums.length : sum;
}
export type Datum = { label: string; value: number | null; fields: Record<string, unknown> };
function numeric(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '')
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function widgetRows(w: DashboardWidget, response: ResponseData): Datum[] {
  if (w.source === 'metrics') {
    const series: Series[] = response.data?.data?.result || [];
    return series.map((s, index) => ({
      label:
        (w.labelField
          ? s.metric[w.labelField]
          : Object.entries(s.metric)
              .filter(([k]) => k !== '__name__')
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')) ||
        s.metric.__name__ ||
        `Series ${index + 1}`,
      value: reduceValues(
        s.values.map(([, v]) => Number(v)),
        w.reducer,
      ),
      fields: {
        ...s.metric,
        value: reduceValues(
          s.values.map(([, v]) => Number(v)),
          w.reducer,
        ),
      },
    }));
  }
  const rows: Record<string, unknown>[] =
    w.source === 'logs'
      ? Array.isArray(response.data)
        ? response.data
        : []
      : (response.data?.data || []).map((t: Trace) => {
          const spans = t.spans || [];
          const start = Math.min(...spans.map((s) => s.startTime));
          const end = Math.max(...spans.map((s) => s.startTime + s.duration));
          return {
            traceID: t.traceID || spans[0]?.traceID,
            service: Object.values(t.processes || {})
              .map((p) => p.serviceName)
              .join(', '),
            duration_ms: spans.length ? (end - start) / 1000 : null,
            spans: spans.length,
          };
        });
  return rows.map((row, i) => ({
    label: String(
      row[w.labelField || (w.source === 'traces' ? 'service' : '_time')] ?? `Row ${i + 1}`,
    ),
    value:
      w.reducer === 'count' && !w.valueField
        ? 1
        : numeric(row[w.valueField || (w.source === 'traces' ? 'duration_ms' : 'value')]),
    fields: row,
  }));
}
