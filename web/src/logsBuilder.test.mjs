import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLogs,
  emptyLogsBuilder,
  logStageQuery,
  moveLogStage,
  newLogStage,
  normalizeLogsBuilder,
  parseLogs,
  splitLogPipes,
} from './logsBuilder.ts';
import {
  buildQuery,
  builderForPanel,
  builderQueryText,
  normalizeBuilder,
  panelQuery,
} from './queryBuilders.ts';
import { defaultPanel, locationHash, patchPanel, readLocation } from './state.ts';

const stage = (type, patch = {}) => ({ ...newLogStage(type, `id-${type}`), ...patch });
test('LogsQL pipeline compiles native stages in order and escapes literals', () => {
  const builder = {
    ...emptyLogsBuilder(),
    stages: [
      stage('filter', { field: 'level', operator: 'exact', value: 'error"|\\\n' }),
      stage('unpack_json'),
      stage('rename', { field: 'http.status', target: 'status' }),
      stage('replace', { find: 'password="a"', replacement: '[redacted]' }),
      stage('sort'),
      stage('fields'),
      stage('limit', { count: '20' }),
    ],
  };
  assert.equal(
    buildLogs(builder).query,
    '*\n| filter "level":="error\\"|\\\\\\n"\n| unpack_json from "_msg"\n| rename "http.status" as "status"\n| replace ("password=\\"a\\"", "[redacted]") at "_msg"\n| sort by ("_time") desc\n| fields "_time", "_msg"\n| limit 20',
  );
  assert.equal(buildQuery(builder).error, undefined);
  assert.equal(buildLogs(builder, 1).query.split('\n| ').length, 2);
});

test('pipeline boundaries respect strings, regex alternatives and nested subqueries', () => {
  const query = '`error|warn` | filter _msg:~"foo|bar" | union (_time:1h | fields _msg) | limit 20';
  assert.deepEqual(splitLogPipes(query), [
    '`error|warn`',
    'filter _msg:~"foo|bar"',
    'union (_time:1h | fields _msg)',
    'limit 20',
  ]);
  for (const input of ['foo | filter (x', 'foo | filter "x', 'foo | filter [x)', 'foo | filter {x'])
    assert.equal(splitLogPipes(input), null, input);
  assert.match(buildLogs({ kind: 'logs', filter: '* | limit 1', stages: [] }).error, /single/);
  assert.match(
    logStageQuery(stage('raw', { expression: 'limit 1 | offset 1' })).error,
    /one balanced/,
  );
});

test('manual pipelines preserve richer native pipes through custom stages', () => {
  const original =
    '_stream:{app="api"} error | unpack_json from _msg | filter status:>=500 | stats by (app) count() as errors | sort by (errors desc) | limit 10';
  const builder = parseLogs(original);
  assert.ok(builder);
  assert.equal(builder.stages[0].type, 'unpack_json');
  assert.equal(builder.stages[1].type, 'filter');
  assert.equal(builder.stages[1].mode, 'expression');
  assert.match(buildLogs(builder).query, /filter status:>=500/);
  assert.match(buildLogs(builder).query, /stats by \(app\) count\(\) as errors/);
  assert.equal(builder.stages.at(-1).type, 'limit');
  assert.equal(parseLogs('* | limit 1 |'), null);
  assert.deepEqual(parseLogs(''), emptyLogsBuilder());
});

test('reordering, disabling and preview prefixes maintain the actual pipeline semantics', () => {
  const stages = [stage('filter', { value: 'error' }), stage('sort'), stage('limit')];
  assert.deepEqual(
    moveLogStage(stages, 'id-limit', 'id-filter').map((stage) => stage.type),
    ['limit', 'filter', 'sort'],
  );
  assert.deepEqual(
    moveLogStage(stages, 'id-filter', null).map((stage) => stage.type),
    ['sort', 'limit', 'filter'],
  );
  assert.equal(moveLogStage(stages, 'unknown', null), stages);
  const builder = {
    kind: 'logs',
    filter: '*',
    stages: [stage('filter', { value: '', enabled: false }), stage('sort'), stage('limit')],
  };
  assert.equal(buildLogs(builder, 1).query, '*');
  assert.equal(buildLogs(builder, 2).query, '*\n| sort by ("_time") desc');
  assert.equal(buildLogs(builder).error, undefined);
  assert.match(
    buildLogs({ ...builder, stages: [{ ...builder.stages[0], enabled: true }] }).error,
    /Stage 1/,
  );
});

test('stage validation blocks malformed fields and parameters while supporting summaries', () => {
  assert.match(
    logStageQuery(stage('rename', { field: 'x | limit 1', target: 'y' })).error,
    /fields/,
  );
  assert.match(logStageQuery(stage('limit', { count: '0' })).error, /whole number/);
  assert.match(logStageQuery(stage('limit', { count: 'NaN' })).error, /whole number/);
  assert.equal(
    logStageQuery(stage('stats', { groupBy: 'app, level' })).query,
    'stats by ("app", "level") count() as "logs_total"',
  );
  assert.match(logStageQuery(stage('stats', { aggregation: 'sum' })).error, /aggregation/);
  assert.equal(
    logStageQuery(stage('delete', { fields: 'secret, token' })).query,
    'delete "secret", "token"',
  );
  assert.equal(logStageQuery(stage('uniq', { fields: 'app' })).query, 'uniq by ("app")');
  assert.equal(logStageQuery(stage('filter', { operator: 'exists' })).query, 'filter "_msg":*');
});

test('pipeline drafts round-trip in shared URLs and survive all input mode switches', () => {
  const builder = { ...emptyLogsBuilder(), stages: [stage('filter'), stage('sort')] };
  let panel = { ...defaultPanel('logs-a', 'logs'), inputMode: 'constructor', text: '', builder };
  assert.deepEqual(normalizeBuilder(builder), builder);
  for (const inputMode of ['manual', 'llm', 'constructor']) {
    panel = patchPanel(panel, { inputMode });
    assert.deepEqual(
      readLocation(locationHash('explore', { version: 2, panels: [panel] })).explorer.panels[0],
      panel,
    );
  }
  assert.match(panelQuery(panel).error, /filter value/);
  assert.equal(
    builderForPanel({ ...defaultPanel('a', 'logs'), text: 'error | limit 20' }).kind,
    'logs',
  );
  assert.equal(
    normalizeLogsBuilder({ ...builder, stages: Array(25).fill(builder.stages[0]) }),
    undefined,
  );
  assert.equal(
    normalizeLogsBuilder({ ...builder, stages: [builder.stages[0], builder.stages[0]] }),
    undefined,
  );
  assert.equal(
    normalizeLogsBuilder({
      ...builder,
      stages: [{ ...builder.stages[0], operator: 'javascript' }],
    }),
    undefined,
  );
});

test('Kubernetes and dotted field names remain quoted as single LogsQL identifiers', () => {
  assert.equal(
    logStageQuery(
      stage('filter', {
        field: 'annotations.argocd.argoproj.io/tracking-id',
        operator: 'exact',
        value: 'app',
      }),
    ).query,
    'filter "annotations.argocd.argoproj.io/tracking-id":="app"',
  );
  assert.equal(
    logStageQuery(stage('fields', { fields: '@timestamp, kubernetes.namespace_name' })).query,
    'fields "@timestamp", "kubernetes.namespace_name"',
  );
});

test('unfinished delete stage keeps its query and selection through every input and reload', () => {
  const builder = {
    ...emptyLogsBuilder(),
    stages: [stage('delete')],
    selectedStageId: 'id-delete',
  };
  const text = builderQueryText(builder, 'level:error');
  assert.equal(text, 'level:error');
  assert.equal(builderQueryText(builder, ''), '*');
  let panel = { ...defaultPanel('logs-a', 'logs'), inputMode: 'constructor', text, builder };
  for (const inputMode of ['manual', 'llm', 'constructor']) {
    panel = patchPanel(panel, { inputMode });
    assert.equal(panel.text, 'level:error');
    assert.equal(panel.builder.selectedStageId, 'id-delete');
    assert.deepEqual(panel.builder.stages, builder.stages);
    panel = readLocation(locationHash('explore', { version: 2, panels: [panel] })).explorer
      .panels[0];
  }
  assert.equal(patchPanel(panel, { text: panel.text }).builder, panel.builder);
  const recovered = patchPanel(
    { ...panel, inputMode: 'constructor', text: '' },
    { inputMode: 'manual' },
  );
  assert.equal(recovered.text, '*');
  assert.deepEqual(recovered.builder, builder);
});

test('native filters and pipe arguments compile without translating LogsQL syntax', () => {
  const expression = 'level:in("error", "warn") AND NOT _msg:~"health|ping"';
  const filter = stage('filter', { mode: 'expression', expression });
  const math = stage('native', { name: 'math', arguments: '(errors / total) as error_ratio' });
  assert.equal(logStageQuery(filter).query, `filter ${expression}`);
  assert.equal(logStageQuery(math).query, 'math (errors / total) as error_ratio');
  assert.equal(
    logStageQuery(stage('native', { name: 'field_names', arguments: '' })).query,
    'field_names',
  );
  assert.match(logStageQuery(stage('native', { name: 'math', arguments: '' })).error, /arguments/);
  assert.match(
    logStageQuery(stage('native', { name: 'math', arguments: '(a) as b | limit 1' })).error,
    /top-level pipe/,
  );
  const parsed = parseLogs(`* | filter ${expression} | math (errors / total) as error_ratio`);
  assert.equal(parsed.stages[0].mode, 'expression');
  assert.equal(parsed.stages[1].name, 'math');
  assert.equal(
    buildLogs(parsed).query,
    `*\n| filter ${expression}\n| math (errors / total) as error_ratio`,
  );
  assert.equal(
    normalizeLogsBuilder({
      ...emptyLogsBuilder(),
      stages: [filter, math],
      selectedStageId: math.id,
    }).selectedStageId,
    math.id,
  );
});

test('native LogsQL comments do not turn pipe characters or brackets into stages', () => {
  const query = 'error # ignored | " (\n| filter _msg:~"a|b" # text }\n| limit 10;';
  const parts = splitLogPipes(query);
  assert.equal(parts.length, 3);
  assert.equal(parts[2], 'limit 10');
  assert.ok(parseLogs(query));
  assert.equal(buildLogs(parseLogs('* | limit 10;')).query, '*\n| limit 10');
});
