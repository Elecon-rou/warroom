import { splitLogPipes } from './logsqlSyntax.ts';
export const logFilterOperators = [
  'phrase',
  'exact',
  'not',
  'regex',
  'not_regex',
  'prefix',
  'substring',
  'exists',
  'empty',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains_any',
  'contains_all',
] as const;
export type FilterOperator = (typeof logFilterOperators)[number];
export type LogFilterRule = {
  id: string;
  type: 'rule';
  field: string;
  operator: FilterOperator;
  value: string;
};
export type LogFilterExpression = { id: string; type: 'expression'; expression: string };
export type LogFilterGroup = {
  id: string;
  type: 'group';
  join: 'AND' | 'OR';
  negated: boolean;
  conditions: LogFilterNode[];
};
export type LogFilterNode = LogFilterRule | LogFilterGroup | LogFilterExpression;
export type StreamMatcher = {
  id: string;
  label: string;
  operator: '=' | '!=' | '=~' | '!~';
  value: string;
};
export type LogSource = { streams: StreamMatcher[]; filters: LogFilterGroup };
export type FilterResult = { query: string; error?: string };
const fail = (error: string): FilterResult => ({ query: '', error });
const quote = JSON.stringify;
export function emptyFilterGroup(id = 'root'): LogFilterGroup {
  return { id, type: 'group', join: 'AND', negated: false, conditions: [] };
}
export function emptyLogSource(): LogSource {
  return { streams: [], filters: emptyFilterGroup() };
}
export function newFilterRule(): LogFilterRule {
  return { id: crypto.randomUUID(), type: 'rule', field: '_msg', operator: 'phrase', value: '' };
}
export function buildLogFilter(node: LogFilterNode, depth = 0): FilterResult {
  if (depth > 4) return fail('Filter groups are limited to four levels.');
  if (node.type === 'group') {
    if (!node.conditions.length)
      return depth === 0 && !node.negated
        ? { query: '*' }
        : fail('Add a condition to the filter group.');
    const expressions: string[] = [];
    for (const condition of node.conditions) {
      const result = buildLogFilter(condition, depth + 1);
      if (result.error) return result;
      expressions.push(result.query.includes('#') ? `(\n${result.query}\n)` : `(${result.query})`);
    }
    const query = expressions.join(` ${node.join} `);
    return { query: node.negated ? `NOT (${query})` : query };
  }
  if (node.type === 'expression') {
    const parts = splitLogPipes(node.expression);
    return parts?.length === 1 && parts[0]
      ? { query: parts[0] }
      : fail('Enter one balanced LogsQL filter expression.');
  }
  if (!node.field.trim() || node.field.length > 1000) return fail('Choose a filter field.');
  const field = quote(node.field);
  const value = quote(node.value);
  if (node.operator === 'exists') return { query: `${field}:*` };
  if (node.operator === 'empty') return { query: `${field}:=""` };
  if (!node.value) return fail('Enter a filter value.');
  switch (node.operator) {
    case 'phrase':
      return { query: `${field}:${value}` };
    case 'exact':
      return { query: `${field}:=${value}` };
    case 'not':
      return { query: `NOT ${field}:=${value}` };
    case 'regex':
      return { query: `${field}:~${value}` };
    case 'not_regex':
      return { query: `NOT ${field}:~${value}` };
    case 'prefix':
      return { query: `${field}:${value}*` };
    case 'substring':
      return { query: `${field}:~${quote(node.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}` };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[a-zA-Zµ]+)?$/.test(node.value))
        return fail('Enter a numeric value, optionally with a duration or size unit.');
      const operator = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[node.operator];
      return { query: `${field}:${operator}${node.value}` };
    }
    case 'in':
    case 'contains_any':
    case 'contains_all': {
      const values = node.value
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
      if (!values.length) return fail('Enter at least one value.');
      return {
        query: `${field}:${node.operator}(${values.map((value) => quote(value)).join(', ')})`,
      };
    }
  }
}
export function buildLogSource(source: LogSource): FilterResult {
  const matchers: string[] = [];
  for (const matcher of source.streams) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(matcher.label))
      return fail('Choose a valid stream label.');
    if (!['=', '!=', '=~', '!~'].includes(matcher.operator)) return fail('Invalid stream matcher.');
    matchers.push(`${matcher.label}${matcher.operator}${quote(matcher.value)}`);
  }
  const filter = buildLogFilter(source.filters);
  if (filter.error) return filter;
  if (!matchers.length) return filter;
  return {
    query: `_stream:{${matchers.join(',')}}${filter.query !== '*' ? ` AND (${filter.query})` : ''}`,
  };
}

// Recognize simple native field filters. Preserve complex native expressions as clauses.
export function parseLogFilter(expression: string): LogFilterGroup {
  const group = emptyFilterGroup();
  const text = expression.trim();
  if (!text || text === '*') return group;
  const list = text.match(
    /^("(?:[^"\\]|\\.)*"|[\w.@/-]+):(in|contains_any|contains_all)\((.*)\)$/s,
  );
  if (list) {
    try {
      const values = JSON.parse(`[${list[3]}]`);
      if (
        Array.isArray(values) &&
        values.length &&
        values.every((value) => typeof value === 'string' && !value.includes('\n'))
      ) {
        group.conditions.push({
          id: 'condition-1',
          type: 'rule',
          field: list[1].startsWith('"') ? JSON.parse(list[1]) : list[1],
          operator: list[2] as FilterOperator,
          value: values.join('\n'),
        });
        return group;
      }
    } catch {
      /* Preserve subqueries and richer argument syntax as native expressions. */
    }
  }
  if (/^[a-zA-Z0-9_]+$/.test(text) && !['AND', 'OR', 'NOT'].includes(text.toUpperCase())) {
    group.conditions.push({
      id: 'condition-1',
      type: 'rule',
      field: '_msg',
      operator: 'phrase',
      value: text,
    });
    return group;
  }
  const match = text.match(
    /^("(?:[^"\\]|\\.)*"|[\w.@/-]+):(!=|!~|=|~)?("(?:[^"\\]|\\.)*"|[\w.-]+)$/s,
  );
  if (match) {
    try {
      const field = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
      const value = match[3].startsWith('"') ? JSON.parse(match[3]) : match[3];
      const operator = (
        { '=': 'exact', '!=': 'not', '~': 'regex', '!~': 'not_regex', '': 'phrase' } as const
      )[match[2] || ''];
      if (operator && value === '' && !['exact', 'phrase', 'not'].includes(operator))
        throw new Error('Keep native empty pattern semantics.');
      if (operator) {
        group.conditions.push({
          id: 'condition-1',
          type: 'rule',
          field,
          operator: value === '' ? (operator === 'not' ? 'exists' : 'empty') : operator,
          value,
        });
        return group;
      }
    } catch {
      /* Preserve the original expression below. */
    }
  }
  group.conditions.push({ id: 'condition-1', type: 'expression', expression: text });
  return group;
}
export function parseLogSource(expression: string): LogSource {
  const source = emptyLogSource();
  const match = expression
    .trim()
    .match(/^(?:_stream:)?\{((?:[^{}"]|"(?:[^"\\]|\\.)*")*)\}\s*(?:AND\s+)?([\s\S]*)$/);
  if (!match) return { streams: [], filters: parseLogFilter(expression) };
  if (/^OR\b/i.test(match[2].trim())) return { streams: [], filters: parseLogFilter(expression) };
  let rest = match[1].trim();
  while (rest) {
    const matcher = rest.match(
      /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*")\s*(,|$)/,
    );
    if (!matcher) return { streams: [], filters: parseLogFilter(expression) };
    try {
      source.streams.push({
        id: `stream-${source.streams.length}`,
        label: matcher[1],
        operator: matcher[2] as StreamMatcher['operator'],
        value: JSON.parse(matcher[3]),
      });
    } catch {
      return { streams: [], filters: parseLogFilter(expression) };
    }
    rest = rest.slice(matcher[0].length).trim();
  }
  source.filters = parseLogFilter(match[2]);
  return source;
}
export function validFilterGroup(value: unknown): value is LogFilterGroup {
  const ids = new Set<string>();
  let count = 0;
  const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
  function valid(value: unknown, depth: number): boolean {
    const node = value as LogFilterNode | undefined;
    if (
      !node ||
      ++count > 64 ||
      depth > 4 ||
      !text(node.id, 80) ||
      !/^[-\w]+$/.test(node.id) ||
      ids.has(node.id)
    )
      return false;
    ids.add(node.id);
    if (node.type === 'group')
      return (
        ['AND', 'OR'].includes(node.join) &&
        typeof node.negated === 'boolean' &&
        Array.isArray(node.conditions) &&
        node.conditions.every((condition) => valid(condition, depth + 1))
      );
    if (node.type === 'expression') return text(node.expression, 16000);
    return (
      node.type === 'rule' &&
      text(node.field, 1000) &&
      logFilterOperators.includes(node.operator) &&
      text(node.value, 4000)
    );
  }
  return (value as LogFilterGroup)?.type === 'group' && valid(value, 0);
}
export function validLogSource(value: unknown): value is LogSource {
  const source = value as LogSource | undefined;
  const ids = new Set<string>();
  return (
    !!source &&
    validFilterGroup(source.filters) &&
    Array.isArray(source.streams) &&
    source.streams.length <= 32 &&
    source.streams.every((matcher) => {
      if (
        !matcher ||
        typeof matcher.id !== 'string' ||
        !/^[-\w]{1,80}$/.test(matcher.id) ||
        ids.has(matcher.id)
      )
        return false;
      ids.add(matcher.id);
      return (
        typeof matcher.label === 'string' &&
        matcher.label.length <= 1000 &&
        ['=', '!=', '=~', '!~'].includes(matcher.operator) &&
        typeof matcher.value === 'string' &&
        matcher.value.length <= 4000
      );
    })
  );
}
