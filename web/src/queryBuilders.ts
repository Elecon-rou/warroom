import {
  buildLogs,
  emptyLogsBuilder,
  normalizeLogsBuilder,
  parseLogs,
  type LogsBuilder,
} from './logsBuilder.ts';
export type LabelFilter = { label: string; operator: '=' | '!=' | '=~' | '!~'; value: string };
export type MetricOperation = {
  name: string;
  parameter: string;
  grouping: 'by' | 'without';
  labels: string;
};
export type MetricsBuilder = {
  kind: 'metrics';
  metric: string;
  filters: LabelFilter[];
  operations: MetricOperation[];
};
export type TracesBuilder = {
  kind: 'traces';
  service: string;
  operation: string;
  tags: { key: string; value: string }[];
  minDuration: string;
  maxDuration: string;
};
export type QueryBuilder = MetricsBuilder | TracesBuilder | LogsBuilder;
export type BuiltQuery = { query: string; error?: string };

export const rangeFunctions = [
  'rate',
  'irate',
  'increase',
  'delta',
  'avg_over_time',
  'min_over_time',
  'max_over_time',
  'sum_over_time',
  'count_over_time',
];
export const aggregations = ['sum', 'avg', 'min', 'max', 'count', 'stddev', 'stdvar', 'group'];
export const instantFunctions = ['abs', 'ceil', 'floor', 'round', 'sqrt', 'ln', 'log2', 'log10'];
export const parameterFunctions = ['topk', 'bottomk', 'histogram_quantile'];
export const scalarOperations = ['+', '-', '*', '/'];
export const operationNames = [
  ...rangeFunctions,
  ...aggregations,
  ...instantFunctions,
  ...parameterFunctions,
  ...scalarOperations,
];
const metricName = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const labelName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const number = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const duration = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d|w|y))+$/;
const failure = (error: string): BuiltQuery => ({ query: '', error });

export function emptyBuilder(kind: 'metrics'): MetricsBuilder;
export function emptyBuilder(kind: 'traces'): TracesBuilder;
export function emptyBuilder(kind: 'logs'): LogsBuilder;
export function emptyBuilder(kind: 'metrics' | 'traces' | 'logs'): QueryBuilder;
export function emptyBuilder(kind: 'metrics' | 'traces' | 'logs'): QueryBuilder {
  if (kind === 'logs') return emptyLogsBuilder();
  return kind === 'metrics'
    ? { kind, metric: '', filters: [], operations: [] }
    : { kind, service: '', operation: '', tags: [], minDuration: '', maxDuration: '' };
}
export function newOperation(name: string): MetricOperation {
  return {
    name,
    parameter: rangeFunctions.includes(name)
      ? '5m'
      : name === 'histogram_quantile'
        ? '0.95'
        : parameterFunctions.includes(name)
          ? '5'
          : '100',
    grouping: 'by',
    labels: '',
  };
}

export function buildMetrics(builder: MetricsBuilder): BuiltQuery {
  if (!metricName.test(builder.metric)) return failure('Select a metric.');
  const filters: string[] = [];
  for (const filter of builder.filters) {
    if (!labelName.test(filter.label)) return failure('Each filter needs a valid label name.');
    if (!['=', '!=', '=~', '!~'].includes(filter.operator))
      return failure('Invalid label operator.');
    filters.push(`${filter.label}${filter.operator}${JSON.stringify(filter.value)}`);
  }
  let query = builder.metric + (filters.length ? `{${filters.join(',')}}` : '');
  for (const [index, operation] of builder.operations.entries()) {
    const { name, parameter, grouping } = operation;
    const labels = operation.labels
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean);
    if (!operationNames.includes(name)) return failure('Unsupported operation.');
    if (rangeFunctions.includes(name)) {
      if (index !== 0)
        return failure('Place a range function first, before aggregations or other operations.');
      if (!duration.test(parameter) || !/[1-9]/.test(parameter))
        return failure('Enter a positive range window, such as 5m.');
      query = `${name}(${query}[${parameter}])`;
    } else if (aggregations.includes(name) || name === 'topk' || name === 'bottomk') {
      if (labels.some((label) => !labelName.test(label)))
        return failure('Grouping labels must be valid comma-separated names.');
      if (!['by', 'without'].includes(grouping)) return failure('Invalid grouping mode.');
      const group = labels.length ? ` ${grouping} (${labels.join(', ')})` : '';
      if (name === 'topk' || name === 'bottomk') {
        if (!/^\d+$/.test(parameter) || Number(parameter) < 1)
          return failure('Top/bottom count must be a positive integer.');
        query = `${name}${group} (${parameter}, ${query})`;
      } else query = `${name}${group} (${query})`;
    } else if (name === 'histogram_quantile') {
      if (!number.test(parameter) || Number(parameter) < 0 || Number(parameter) > 1)
        return failure('Quantile must be between 0 and 1.');
      query = `${name}(${parameter}, ${query})`;
    } else if (scalarOperations.includes(name)) {
      if (!number.test(parameter) || !Number.isFinite(Number(parameter)))
        return failure('Enter a finite scalar number.');
      query = `(${query}) ${name} ${parameter}`;
    } else query = `${name}(${query})`;
  }
  return { query };
}

function durationSeconds(value: string): number | null {
  if (!/^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(value)) return null;
  const units: Record<string, number> = {
    ns: 1e-9,
    us: 1e-6,
    µs: 1e-6,
    ms: 0.001,
    s: 1,
    m: 60,
    h: 3600,
  };
  return [...value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)].reduce(
    (total, match) => total + Number(match[1]) * units[match[2]],
    0,
  );
}
export function buildTraces(builder: TracesBuilder): BuiltQuery {
  if (!builder.service.trim()) return failure('Select a service.');
  const min = builder.minDuration ? durationSeconds(builder.minDuration) : null;
  const max = builder.maxDuration ? durationSeconds(builder.maxDuration) : null;
  if ((builder.minDuration && min === null) || (builder.maxDuration && max === null))
    return failure('Use durations such as 100ms or 1.5s.');
  if (min !== null && max !== null && min > max)
    return failure('Minimum duration exceeds maximum duration.');
  const tags: Record<string, string> = Object.create(null);
  for (const tag of builder.tags) {
    if (!tag.key.trim()) return failure('Each tag needs a key.');
    if (Object.hasOwn(tags, tag.key)) return failure('Tag keys must be unique.');
    tags[tag.key] = tag.value;
  }
  const params = new URLSearchParams({ service: builder.service });
  if (builder.operation) params.set('operation', builder.operation);
  if (builder.tags.length) params.set('tags', JSON.stringify(tags));
  if (builder.minDuration) params.set('minDuration', builder.minDuration);
  if (builder.maxDuration) params.set('maxDuration', builder.maxDuration);
  return { query: params.toString() };
}
export function buildQuery(builder: QueryBuilder): BuiltQuery {
  const result =
    builder.kind === 'metrics'
      ? buildMetrics(builder)
      : builder.kind === 'logs'
        ? buildLogs(builder)
        : buildTraces(builder);
  return result.query.length > 16000
    ? failure('Query exceeds 16000 characters. Reduce filters or operations.')
    : result;
}

// Keep the last executable query while retaining an unfinished constructor draft.
export function builderQueryText(builder: QueryBuilder, previous: string): string {
  const result = buildQuery(builder);
  if (!result.error) return result.query;
  if (previous) return previous;
  return builder.kind === 'logs' ? buildLogs({ ...builder, stages: [] }).query : '';
}

// Deliberately parse only the subset the visual editor can reproduce without losing semantics.
export function parseMetrics(text: string, depth = 0): MetricsBuilder | null {
  const query = text.trim();
  if (!query) return emptyBuilder('metrics');
  if (depth > 12) return null;
  const selector = query.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?$/s);
  if (selector) {
    const filters: LabelFilter[] = [];
    let rest = selector[2]?.trim() || '';
    while (rest) {
      const match = rest.match(
        /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*")\s*(,|$)/s,
      );
      if (!match) return null;
      try {
        filters.push({
          label: match[1],
          operator: match[2] as LabelFilter['operator'],
          value: JSON.parse(match[3]),
        });
      } catch {
        return null;
      }
      rest = rest.slice(match[0].length).trim();
    }
    return { kind: 'metrics', metric: selector[1], filters, operations: [] };
  }
  const scalar = query.match(/^\((.*)\)\s*([+*/-])\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/is);
  if (scalar) {
    const inner = parseMetrics(scalar[1], depth + 1);
    if (!inner) return null;
    inner.operations.push({ ...newOperation(scalar[2]), parameter: scalar[3] });
    return inner;
  }
  const match = query.match(
    /^([a-z_]+)\s*(?:(by|without)\s*\(([^()]*)\)\s*)?\((.*?)\)\s*(?:(by|without)\s*\(([^()]*)\))?$/s,
  );
  if (!match || !operationNames.includes(match[1]) || (match[2] && match[5])) return null;
  const name = match[1];
  const operation = {
    ...newOperation(name),
    grouping: (match[2] || match[5] || 'by') as 'by' | 'without',
    labels: match[3] || match[6] || '',
  };
  if ((match[2] || match[5]) && ![...aggregations, 'topk', 'bottomk'].includes(name)) return null;
  let body = match[4].trim();
  if (rangeFunctions.includes(name)) {
    const range = body.match(/^(.*)\[([^\[\]]+)\]$/s);
    if (!range) return null;
    body = range[1];
    operation.parameter = range[2];
  } else if (parameterFunctions.includes(name)) {
    const parameter = body.match(/^([^,]+),\s*(.*)$/s);
    if (!parameter) return null;
    operation.parameter = parameter[1].trim();
    body = parameter[2];
  }
  const inner = parseMetrics(body, depth + 1);
  if (!inner) return null;
  inner.operations.push(operation);
  return buildMetrics(inner).error ? null : inner;
}
export function parseTraces(text: string): TracesBuilder | null {
  if (!text.trim()) return emptyBuilder('traces');
  const params = new URLSearchParams(text);
  if (
    [...params.keys()].some(
      (key) =>
        !['service', 'operation', 'tags', 'minDuration', 'maxDuration'].includes(key) ||
        params.getAll(key).length > 1,
    )
  )
    return null;
  try {
    const tags = JSON.parse(params.get('tags') || '{}');
    if (
      !tags ||
      Array.isArray(tags) ||
      typeof tags !== 'object' ||
      Object.values(tags).some((value) => typeof value !== 'string')
    )
      return null;
    const builder: TracesBuilder = {
      kind: 'traces',
      service: params.get('service') || '',
      operation: params.get('operation') || '',
      tags: Object.entries(tags).map(([key, value]) => ({ key, value: value as string })),
      minDuration: params.get('minDuration') || '',
      maxDuration: params.get('maxDuration') || '',
    };
    return buildTraces(builder).error ? null : builder;
  } catch {
    return null;
  }
}
export function builderForPanel(panel: {
  kind: string;
  text: string;
  builder?: QueryBuilder;
}): QueryBuilder | null {
  if (panel.builder?.kind === panel.kind) return panel.builder;
  return panel.kind === 'metrics'
    ? parseMetrics(panel.text)
    : panel.kind === 'traces'
      ? parseTraces(panel.text)
      : panel.kind === 'logs'
        ? parseLogs(panel.text)
        : null;
}
export function panelQuery(panel: {
  kind: string;
  inputMode: string;
  text: string;
  builder?: QueryBuilder;
}): BuiltQuery {
  if (panel.inputMode !== 'constructor') return { query: panel.text };
  const builder = builderForPanel(panel);
  return builder
    ? buildQuery(builder)
    : failure(
        'This query cannot be represented in the constructor. Use Manual or reset the constructor.',
      );
}

// URL input stays bounded; individual fields are validated again when compiling a query.
export function normalizeBuilder(value: unknown): QueryBuilder | undefined {
  const logs = normalizeLogsBuilder(value);
  if (logs) return logs;
  const v = value as QueryBuilder | undefined;
  const string = (s: unknown, limit = 1000): s is string =>
    typeof s === 'string' && s.length <= limit;
  if (
    v?.kind === 'metrics' &&
    string(v.metric) &&
    Array.isArray(v.filters) &&
    v.filters.length <= 32 &&
    v.filters.every(
      (f) =>
        f && string(f.label) && string(f.value) && ['=', '!=', '=~', '!~'].includes(f.operator),
    ) &&
    Array.isArray(v.operations) &&
    v.operations.length <= 12 &&
    v.operations.every(
      (op) =>
        op &&
        operationNames.includes(op.name) &&
        string(op.parameter) &&
        ['by', 'without'].includes(op.grouping) &&
        string(op.labels),
    )
  )
    return v;
  if (
    v?.kind === 'traces' &&
    [v.service, v.operation, v.minDuration, v.maxDuration].every((s) => string(s)) &&
    Array.isArray(v.tags) &&
    v.tags.length <= 32 &&
    v.tags.every((tag) => tag && string(tag.key) && string(tag.value))
  )
    return v;
  return undefined;
}
