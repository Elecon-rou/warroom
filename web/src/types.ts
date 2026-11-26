export type Kind = 'metrics' | 'logs' | 'traces';
export type Source = { id: string; kind: Kind; name: string; url: string };
export type Series = { metric: Record<string, string>; values: [number, string][] };
export type LogRow = Record<string, unknown>;
export type Span = {
  spanID: string;
  traceID: string;
  operationName: string;
  processID: string;
  startTime: number;
  duration: number;
  references?: { refType: string; spanID: string }[];
  tags?: { key: string; value: unknown }[];
  logs?: unknown[];
};
export type Trace = {
  traceID?: string;
  spans: Span[];
  processes: Record<string, { serviceName: string; tags?: { key: string; value: unknown }[] }>;
};
export type ResponseData = {
  data: any;
  elapsedMs: number;
  demo: boolean;
  step: number;
  start: number;
  end: number;
};
export const colors = [
  '#2dd4bf',
  '#7995ff',
  '#e8b86d',
  '#ee7f9d',
  '#8bcfa1',
  '#be98ef',
  '#70bfdc',
  '#e09165',
];
export const short = (n: number) =>
  !Number.isFinite(n)
    ? '—'
    : Math.abs(n) >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : Math.abs(n) >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
export const clock = (n: number) =>
  new Date(n * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
export const label = (s: Series) =>
  Object.entries(s.metric)
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ') || 'value';
export const traceInfo = (t: Trace) => {
  const start = Math.min(...t.spans.map((s) => s.startTime));
  const end = Math.max(...t.spans.map((s) => s.startTime + s.duration));
  const root =
    t.spans.find((s) => !s.references?.some((r) => r.refType === 'CHILD_OF')) || t.spans[0];
  return {
    start,
    end,
    duration: end - start,
    root,
    id: t.traceID || t.spans[0]?.traceID || '',
    services: new Set(Object.values(t.processes || {}).map((p) => p.serviceName)).size,
  };
};
export const duration = (us: number) =>
  us >= 1e6 ? `${(us / 1e6).toFixed(2)} s` : `${(us / 1000).toFixed(2)} ms`;
