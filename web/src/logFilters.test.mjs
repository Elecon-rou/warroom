import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLogFilter,
  buildLogSource,
  emptyFilterGroup,
  emptyLogSource,
  newFilterRule,
  parseLogFilter,
  parseLogSource,
  validFilterGroup,
  validLogSource,
} from './logFilters.ts';
import { buildLogs, normalizeLogsBuilder } from './logsBuilder.ts';
import { nativePipeNames, nativePipeDescriptions } from './nativeLogsQL.ts';
import { defaultPanel, locationHash, patchPanel, readLocation } from './state.ts';
import { builderQueryText } from './queryBuilders.ts';
const rule = (id, field, operator, value) => ({ id, type: 'rule', field, operator, value });

test('source constructor combines escaped stream selectors with grouped log conditions', () => {
  const source = {
    streams: [{ id: 's', label: 'namespace', operator: '=~', value: 'prod|stage' }],
    filters: {
      ...emptyFilterGroup(),
      conditions: [
        rule('r1', 'level', 'in', 'warn\nerror'),
        {
          ...emptyFilterGroup('g'),
          join: 'OR',
          negated: true,
          conditions: [
            rule('r2', '_msg', 'phrase', 'health"check'),
            rule('r3', 'status', 'gte', '500'),
          ],
        },
      ],
    },
  };
  const built = buildLogSource(source);
  assert.equal(built.error, undefined);
  assert.match(built.query, /^_stream:\{namespace=~"prod\|stage"\} AND/);
  assert.match(built.query, /"level":in\("warn", "error"\)/);
  assert.match(built.query, /NOT \(.* OR .*"status":>=500/s);
  assert.ok(validLogSource(source));
  const builder = { kind: 'logs', filter: '*', sourceMode: 'builder', source, stages: [] };
  assert.equal(buildLogs(builder).query, built.query);
});

test('filter operators preserve native value escaping and comparison syntax', () => {
  assert.equal(
    buildLogFilter(rule('a', 'service', 'exact', 'a" | limit 1')).query,
    '"service":="a\\" | limit 1"',
  );
  assert.equal(
    buildLogFilter(rule('a', '_msg', 'substring', 'a.b*')).query,
    '"_msg":~"a\\\\.b\\\\*"',
  );
  assert.equal(buildLogFilter(rule('a', 'latency', 'gt', '100ms')).query, '"latency":>100ms');
  assert.match(buildLogFilter(rule('a', 'latency', 'gt', '100) | limit 1')).error, /numeric/);
  assert.equal(buildLogFilter(rule('a', '_msg', 'empty', '')).query, '"_msg":=""');
  assert.equal(buildLogFilter(rule('a', '_msg', 'exists', '')).query, '"_msg":*');
  assert.match(
    buildLogFilter({ ...emptyFilterGroup(), conditions: [emptyFilterGroup('empty')] }).error,
    /condition/,
  );
});

test('native filters are imported into source forms without changing OR precedence', () => {
  assert.equal(parseLogFilter('level:="error"').conditions[0].operator, 'exact');
  assert.equal(parseLogFilter('level:in("warn", "error")').conditions[0].operator, 'in');
  assert.equal(parseLogFilter('level:=""').conditions[0].operator, 'empty');
  assert.equal(parseLogFilter('error').conditions[0].field, '_msg');
  const source = parseLogSource('_stream:{namespace="prod"} AND level:="error"');
  assert.equal(source.streams[0].label, 'namespace');
  assert.equal(source.filters.conditions[0].field, 'level');
  const complex = '_stream:{namespace="prod"} OR level:="error"';
  const fallback = parseLogSource(complex);
  assert.equal(fallback.streams.length, 0);
  assert.equal(fallback.filters.conditions[0].type, 'expression');
  assert.ok(buildLogSource(fallback).query.includes(complex));
});

test('source and nested filter drafts persist across input changes and shared URLs', () => {
  const source = {
    ...emptyLogSource(),
    streams: [{ id: 's', label: '', operator: '=', value: '' }],
  };
  const tree = {
    ...emptyFilterGroup(),
    conditions: [
      { ...emptyFilterGroup('g'), conditions: [{ ...newFilterRule(), id: 'r', value: '' }] },
    ],
  };
  const builder = {
    kind: 'logs',
    filter: 'level:error',
    sourceMode: 'builder',
    source,
    stages: [
      {
        id: 'f',
        enabled: true,
        type: 'filter',
        field: '_msg',
        operator: 'phrase',
        value: '',
        mode: 'builder',
        filterTree: tree,
      },
    ],
    selectedStageId: 'f',
  };
  const text = builderQueryText(builder, 'level:error');
  assert.equal(text, 'level:error');
  let panel = { ...defaultPanel('a', 'logs'), text, inputMode: 'constructor', builder };
  for (const inputMode of ['llm', 'manual', 'constructor']) {
    panel = patchPanel(panel, { inputMode });
    panel = readLocation(locationHash('explore', { version: 2, panels: [panel] })).explorer
      .panels[0];
    assert.deepEqual(panel.builder, builder);
    assert.equal(panel.text, 'level:error');
  }
  assert.ok(normalizeLogsBuilder(builder));
  assert.equal(
    validFilterGroup({ ...tree, conditions: [...tree.conditions, tree.conditions[0]] }),
    false,
  );
  assert.equal(
    validLogSource({ ...source, streams: [...source.streams, source.streams[0]] }),
    false,
  );
});

test('each native pipe has its own useful description', () => {
  assert.equal(Object.keys(nativePipeDescriptions).length, nativePipeNames.length);
  for (const name of nativePipeNames) {
    assert.ok(nativePipeDescriptions[name].length > 15, name);
    assert.notEqual(nativePipeDescriptions[name], 'Native LogsQL arguments');
  }
});

test('a native clause ending in a comment keeps its closing group delimiter outside the comment', () => {
  const group = parseLogFilter('level:error # keep this native clause');
  const result = buildLogFilter(group);
  assert.ok(result.query.endsWith('\n)'));
  assert.ok(result.query.includes('level:error # keep this native clause\n'));
});
