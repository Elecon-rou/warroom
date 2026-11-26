import {
  emptyFilterGroup,
  buildLogFilter,
  buildLogSource,
  validFilterGroup,
  validLogSource,
  type LogFilterGroup,
  type LogSource,
} from './logFilters.ts';
import { splitLogPipes } from './logsqlSyntax.ts';
export { splitLogPipes } from './logsqlSyntax.ts';
import {
  nativePipeDescriptions,
  nativePipeNames,
  noArgumentPipes,
  type NativePipeName,
} from './nativeLogsQL.ts';
export type LogStageType =
  | 'filter'
  | 'unpack_json'
  | 'unpack_logfmt'
  | 'fields'
  | 'delete'
  | 'rename'
  | 'replace'
  | 'sort'
  | 'limit'
  | 'offset'
  | 'stats'
  | 'uniq'
  | 'raw'
  | 'native';
export type LogFilterOperator = 'phrase' | 'exact' | 'not' | 'regex' | 'not_regex' | 'exists';
export type LogAggregation = 'count' | 'count_uniq' | 'sum' | 'avg' | 'min' | 'max';
type StageIdentity = { id: string; enabled: boolean };
export type LogStage = StageIdentity &
  (
    | {
        type: 'filter';
        field: string;
        operator: LogFilterOperator;
        value: string;
        mode?: 'fields' | 'expression' | 'builder';
        filterTree?: LogFilterGroup;
        expression?: string;
      }
    | { type: 'unpack_json' | 'unpack_logfmt'; field: string }
    | { type: 'fields' | 'delete' | 'uniq'; fields: string }
    | { type: 'rename'; field: string; target: string }
    | { type: 'replace'; field: string; find: string; replacement: string }
    | { type: 'sort'; fields: string; direction: 'asc' | 'desc' }
    | { type: 'limit' | 'offset'; count: string }
    | { type: 'stats'; aggregation: LogAggregation; field: string; groupBy: string; alias: string }
    | { type: 'raw'; expression: string }
    | { type: 'native'; name: NativePipeName; arguments: string }
  );
export type LogsBuilder = {
  kind: 'logs';
  filter: string;
  source?: LogSource;
  sourceMode?: 'builder' | 'expression';
  stages: LogStage[];
  selectedStageId?: string | null;
};
export type LogBuildResult = { query: string; error?: string };
export const logStagePalette: {
  type: LogStageType;
  label: string;
  group: string;
  description: string;
  nativeName?: NativePipeName;
}[] = [
  {
    type: 'filter',
    label: 'filter',
    group: 'Filter',
    description: 'Match fields, phrases or patterns',
  },
  {
    type: 'unpack_json',
    label: 'unpack_json',
    group: 'Parse',
    description: 'Extract fields from a JSON message',
  },
  {
    type: 'unpack_logfmt',
    label: 'unpack_logfmt',
    group: 'Parse',
    description: 'Extract key=value fields',
  },
  { type: 'fields', label: 'fields', group: 'Shape', description: 'Select output fields' },
  {
    type: 'delete',
    label: 'delete',
    group: 'Shape',
    description: 'Remove fields from query results',
  },
  { type: 'rename', label: 'rename', group: 'Transform', description: 'Rename an output field' },
  { type: 'replace', label: 'replace', group: 'Transform', description: 'Replace text in a field' },
  { type: 'sort', label: 'sort', group: 'Order', description: 'Order rows by fields' },
  { type: 'limit', label: 'limit', group: 'Slice', description: 'Keep the first N rows' },
  { type: 'offset', label: 'offset', group: 'Slice', description: 'Skip the first N rows' },
  {
    type: 'stats',
    label: 'stats',
    group: 'Summarize',
    description: 'Count or aggregate by fields',
  },
  {
    type: 'uniq',
    label: 'uniq',
    group: 'Summarize',
    description: 'Return distinct field combinations',
  },
  {
    type: 'raw',
    label: 'LogsQL',
    group: 'Advanced',
    description: 'Enter a native LogsQL pipe',
  },
];
const structuredPipes = new Set(logStagePalette.map((pipe) => pipe.type));
logStagePalette.push(
  ...nativePipeNames
    .filter((name) => !structuredPipes.has(name as LogStageType))
    .map((name) => ({
      type: 'native' as const,
      nativeName: name,
      label: name,
      group: 'Native pipes',
      description: nativePipeDescriptions[name],
    })),
);
export function logStageLabel(stage: LogStage): string {
  return stage.type === 'native' ? stage.name : stage.type === 'raw' ? 'LogsQL' : stage.type;
}

export const logAggregations: LogAggregation[] = [
  'count',
  'count_uniq',
  'sum',
  'avg',
  'min',
  'max',
];
export function emptyLogsBuilder(): LogsBuilder {
  return { kind: 'logs', filter: '*', stages: [] };
}
export function newLogStage(type: LogStageType, id: string = crypto.randomUUID()): LogStage {
  const base = { id, enabled: true };
  switch (type) {
    case 'filter':
      return { ...base, type, field: '_msg', operator: 'phrase', value: '' };
    case 'unpack_json':
    case 'unpack_logfmt':
      return { ...base, type, field: '_msg' };
    case 'fields':
    case 'delete':
    case 'uniq':
      return { ...base, type, fields: type === 'fields' ? '_time, _msg' : '' };
    case 'rename':
      return { ...base, type, field: '', target: '' };
    case 'replace':
      return { ...base, type, field: '_msg', find: '', replacement: '' };
    case 'sort':
      return { ...base, type, fields: '_time', direction: 'desc' };
    case 'limit':
    case 'offset':
      return { ...base, type, count: type === 'limit' ? '100' : '0' };
    case 'stats':
      return { ...base, type, aggregation: 'count', field: '', groupBy: '', alias: 'logs_total' };
    case 'raw':
      return { ...base, type, expression: '' };
    case 'native':
      return { ...base, type, name: 'field_names', arguments: '' };
  }
}

const fieldPattern = /^[a-zA-Z0-9_@][a-zA-Z0-9_./:@-]*$/;
const fieldCode = (field: string) => (fieldPattern.test(field) ? JSON.stringify(field) : null);
const fieldList = (value: string): string[] | null => {
  const names = value.split(',').map((name) => name.trim());
  return names.length && names.every((name) => fieldPattern.test(name))
    ? names.map((name) => JSON.stringify(name))
    : null;
};
const invalid = (error: string): LogBuildResult => ({ query: '', error });
export function logStageQuery(stage: LogStage): LogBuildResult {
  switch (stage.type) {
    case 'filter': {
      if (stage.mode === 'builder') {
        if (!stage.filterTree?.conditions.length) return invalid('Add a filter condition.');
        const result = buildLogFilter(stage.filterTree);
        return result.error ? result : { query: `filter ${result.query}` };
      }
      if (stage.mode === 'expression') {
        const parts = splitLogPipes(stage.expression || '');
        return parts?.length === 1 && parts[0]
          ? { query: `filter ${parts[0]}` }
          : invalid('Enter one balanced native LogsQL filter expression.');
      }
      const field = fieldCode(stage.field);
      if (!field) return invalid('Enter a valid field name.');
      if (stage.operator === 'exists') return { query: `filter ${field}:*` };
      if (!stage.value) return invalid('Enter a filter value.');
      const value = JSON.stringify(stage.value);
      switch (stage.operator) {
        case 'phrase':
          return { query: `filter ${field}:${value}` };
        case 'exact':
          return { query: `filter ${field}:=${value}` };
        case 'not':
          return { query: `filter NOT ${field}:=${value}` };
        case 'regex':
          return { query: `filter ${field}:~${value}` };
        case 'not_regex':
          return { query: `filter NOT ${field}:~${value}` };
        default:
          return invalid('Invalid filter operator.');
      }
    }
    case 'unpack_json':
    case 'unpack_logfmt': {
      const field = fieldCode(stage.field);
      return field ? { query: `${stage.type} from ${field}` } : invalid('Enter a source field.');
    }
    case 'fields':
    case 'delete':
    case 'uniq':
    case 'sort': {
      const fields = fieldList(stage.fields);
      if (!fields) return invalid('Enter comma-separated field names.');
      if (stage.type === 'sort')
        return ['asc', 'desc'].includes(stage.direction)
          ? { query: `sort by (${fields.join(', ')})${stage.direction === 'desc' ? ' desc' : ''}` }
          : invalid('Invalid sort direction.');
      return {
        query:
          stage.type === 'uniq'
            ? `uniq by (${fields.join(', ')})`
            : `${stage.type} ${fields.join(', ')}`,
      };
    }
    case 'rename': {
      const field = fieldCode(stage.field),
        target = fieldCode(stage.target);
      return field && target
        ? { query: `rename ${field} as ${target}` }
        : invalid('Enter source and target fields.');
    }
    case 'replace': {
      const field = fieldCode(stage.field);
      return field && stage.find
        ? {
            query: `replace (${JSON.stringify(stage.find)}, ${JSON.stringify(stage.replacement)}) at ${field}`,
          }
        : invalid('Enter a field and text to replace.');
    }
    case 'limit':
    case 'offset': {
      const count = Number(stage.count);
      return /^\d+$/.test(stage.count) &&
        Number.isSafeInteger(count) &&
        count >= (stage.type === 'limit' ? 1 : 0) &&
        count <= 1000000
        ? { query: `${stage.type} ${stage.count}` }
        : invalid(
            'Enter a whole number between ' +
              (stage.type === 'limit' ? '1' : '0') +
              ' and 1000000.',
          );
    }
    case 'stats': {
      if (!logAggregations.includes(stage.aggregation)) return invalid('Invalid aggregation.');
      const field = stage.field ? fieldCode(stage.field) : '';
      const alias = fieldCode(stage.alias);
      const groups = stage.groupBy.trim() ? fieldList(stage.groupBy) : [];
      if (!alias || !groups || (stage.aggregation !== 'count' && !field))
        return invalid('Enter valid aggregation, output and grouping fields.');
      return {
        query: `stats${groups.length ? ` by (${groups.join(', ')})` : ''} ${stage.aggregation}(${stage.aggregation === 'count' ? '' : field}) as ${alias}`,
      };
    }
    case 'native': {
      if (!nativePipeNames.includes(stage.name)) return invalid('Unknown LogsQL pipe.');
      if (!stage.arguments.trim() && !noArgumentPipes.includes(stage.name))
        return invalid(`Enter native ${stage.name} arguments.`);
      const expression = `${stage.name}${stage.arguments.trim() ? ` ${stage.arguments.trim()}` : ''}`;
      const parts = splitLogPipes(expression);
      return parts?.length === 1 && parts[0]
        ? { query: parts[0] }
        : invalid('Pipe arguments must be balanced and cannot contain another top-level pipe.');
    }
    case 'raw': {
      const parts = splitLogPipes(stage.expression);
      return parts?.length === 1 && parts[0]
        ? { query: parts[0] }
        : invalid('Enter one balanced pipe expression, without a leading |.');
    }
  }
}
export function buildLogs(builder: LogsBuilder, through = builder.stages.length): LogBuildResult {
  const sourceResult =
    builder.sourceMode === 'builder' && builder.source
      ? buildLogSource(builder.source)
      : { query: builder.filter.trim() || '*' };
  if (sourceResult.error) return sourceResult;
  const source = sourceResult.query;
  const parts = splitLogPipes(source);
  if (!parts || parts.length !== 1)
    return invalid('Source must be a single balanced filter. Add pipes as stages.');
  const pipes: string[] = [parts[0]];
  for (const [index, stage] of builder.stages.slice(0, through).entries()) {
    if (!stage.enabled) continue;
    const result = logStageQuery(stage);
    if (result.error) return invalid(`Stage ${index + 1}: ${result.error}`);
    pipes.push(result.query);
  }
  const query = pipes.join('\n| ');
  return query.length <= 16000
    ? { query }
    : invalid('Query exceeds 16000 characters. Reduce stages or filter text.');
}

function readFields(text: string): string | null {
  const fields = text.split(',').map((value) => {
    try {
      return value.trim().startsWith('"') ? JSON.parse(value.trim()) : value.trim();
    } catch {
      return null;
    }
  });
  return fields.every((field) => typeof field === 'string' && fieldPattern.test(field))
    ? fields.join(', ')
    : null;
}
export function parseLogs(query: string): LogsBuilder | null {
  if (!query.trim()) return emptyLogsBuilder();
  const parts = splitLogPipes(query);
  if (!parts || parts.some((part) => !part) || parts.length > 25) return null;
  const stages = parts.slice(1).map((expression, index): LogStage => {
    const id = `stage-${index + 1}`;
    const base = { id, enabled: true };
    const count = expression.match(/^(limit|offset)\s+(\d+)$/);
    if (count) return { ...base, type: count[1] as 'limit' | 'offset', count: count[2] };
    const fields = expression.match(/^(fields|delete)\s+(.+)$/s);
    if (fields && readFields(fields[2]))
      return { ...base, type: fields[1] as 'fields' | 'delete', fields: readFields(fields[2])! };
    const sort = expression.match(/^sort\s+by\s*\(([^()]*)\)\s*(asc|desc)?$/);
    if (sort && readFields(sort[1]))
      return {
        ...base,
        type: 'sort',
        fields: readFields(sort[1])!,
        direction: sort[2] === 'desc' ? 'desc' : 'asc',
      };
    const unpack = expression.match(/^(unpack_json|unpack_logfmt)(?:\s+from\s+(.+))?$/s);
    if (unpack) {
      const field = readFields(unpack[2] || '_msg');
      if (field && !field.includes(','))
        return { ...base, type: unpack[1] as 'unpack_json' | 'unpack_logfmt', field };
    }
    const filter = expression.match(/^filter\s+([\s\S]+)$/);
    if (filter)
      return {
        ...newLogStage('filter', id),
        type: 'filter',
        field: '_msg',
        operator: 'phrase',
        value: '',
        mode: 'expression',
        expression: filter[1],
      };
    const native = expression.match(/^([a-z_]+)(?:\s+([\s\S]*))?$/);
    if (native && nativePipeNames.includes(native[1] as NativePipeName))
      return {
        ...base,
        type: 'native',
        name: native[1] as NativePipeName,
        arguments: native[2] || '',
      };
    // Preserve richer manual expressions as editable custom stages instead of dropping them.
    return { ...base, type: 'raw', expression };
  });
  const builder: LogsBuilder = { kind: 'logs', filter: parts[0], stages };
  return buildLogs(builder).error ? null : builder;
}

export function normalizeLogsBuilder(value: unknown): LogsBuilder | undefined {
  const builder = value as LogsBuilder | undefined;
  const text = (value: unknown, max = 1000): value is string =>
    typeof value === 'string' && value.length <= max;
  if (
    builder?.kind !== 'logs' ||
    !text(builder.filter, 16000) ||
    !Array.isArray(builder.stages) ||
    builder.stages.length > 24
  )
    return undefined;
  if (builder.source !== undefined && !validLogSource(builder.source)) return undefined;
  if (builder.sourceMode !== undefined && !['builder', 'expression'].includes(builder.sourceMode))
    return undefined;
  const ids = new Set<string>();
  for (const stage of builder.stages) {
    if (
      !stage ||
      !text(stage.id, 80) ||
      !/^[-\w]+$/.test(stage.id) ||
      ids.has(stage.id) ||
      typeof stage.enabled !== 'boolean'
    )
      return undefined;
    ids.add(stage.id);
    switch (stage.type) {
      case 'filter':
        if (
          (stage.mode !== undefined && !['fields', 'expression', 'builder'].includes(stage.mode)) ||
          (stage.filterTree !== undefined && !validFilterGroup(stage.filterTree)) ||
          (stage.expression !== undefined && !text(stage.expression, 16000)) ||
          !text(stage.field) ||
          !text(stage.value, 4000) ||
          !['phrase', 'exact', 'not', 'regex', 'not_regex', 'exists'].includes(stage.operator)
        )
          return undefined;
        break;
      case 'unpack_json':
      case 'unpack_logfmt':
        if (!text(stage.field)) return undefined;
        break;
      case 'fields':
      case 'delete':
      case 'uniq':
        if (!text(stage.fields)) return undefined;
        break;
      case 'sort':
        if (!text(stage.fields) || !['asc', 'desc'].includes(stage.direction)) return undefined;
        break;
      case 'rename':
        if (!text(stage.field) || !text(stage.target)) return undefined;
        break;
      case 'replace':
        if (!text(stage.field) || !text(stage.find, 4000) || !text(stage.replacement, 4000))
          return undefined;
        break;
      case 'limit':
      case 'offset':
        if (!text(stage.count, 20)) return undefined;
        break;
      case 'stats':
        if (
          !logAggregations.includes(stage.aggregation) ||
          ![stage.field, stage.groupBy, stage.alias].every((value) => text(value))
        )
          return undefined;
        break;
      case 'native':
        if (!nativePipeNames.includes(stage.name) || !text(stage.arguments, 16000))
          return undefined;
        break;
      case 'raw':
        if (!text(stage.expression, 16000)) return undefined;
        break;
      default:
        return undefined;
    }
  }
  if (
    builder.selectedStageId !== undefined &&
    builder.selectedStageId !== null &&
    !ids.has(builder.selectedStageId)
  )
    return undefined;
  const needsMigration = builder.stages.some(
    (stage) =>
      stage.type === 'filter' &&
      stage.mode === 'expression' &&
      !stage.expression?.trim() &&
      !stage.filterTree,
  );
  if (needsMigration)
    return {
      ...builder,
      stages: builder.stages.map((stage) =>
        stage.type === 'filter' &&
        stage.mode === 'expression' &&
        !stage.expression?.trim() &&
        !stage.filterTree
          ? { ...stage, mode: 'builder', filterTree: emptyFilterGroup() }
          : stage,
      ),
    };
  return builder;
}

export function moveLogStage(stages: LogStage[], id: string, beforeId: string | null): LogStage[] {
  const stage = stages.find((stage) => stage.id === id);
  if (!stage || id === beforeId) return stages;
  const others = stages.filter((stage) => stage.id !== id);
  const target =
    beforeId === null ? others.length : others.findIndex((stage) => stage.id === beforeId);
  if (target < 0) return stages;
  return [...others.slice(0, target), stage, ...others.slice(target)];
}
