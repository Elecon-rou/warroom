import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyBuilder,
  newOperation,
  buildMetrics,
  buildTraces,
  parseMetrics,
  parseTraces,
  panelQuery,
  buildQuery,
  normalizeBuilder,
} from './queryBuilders.ts';
import { defaultPanel, locationHash, readLocation } from './state.ts';

test('metrics builder composes escaped selectors, rate, grouping and histogram quantiles', () => {
  const builder = {
    ...emptyBuilder('metrics'),
    metric: 'http_request_duration_seconds_bucket',
    filters: [{ label: 'job', operator: '=~', value: 'api"\\worker\n.*' }],
    operations: [
      newOperation('rate'),
      { ...newOperation('sum'), labels: 'le, service' },
      newOperation('histogram_quantile'),
    ],
  };
  const result = buildMetrics(builder);
  assert.equal(
    result.query,
    'histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket{job=~"api\\"\\\\worker\\n.*"}[5m])))',
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(parseMetrics(result.query), builder);
});

test('builder operations round-trip and reject invalid range ordering or parameters', () => {
  const builder = {
    ...emptyBuilder('metrics'),
    metric: 'requests_total',
    operations: [
      newOperation('increase'),
      { ...newOperation('topk'), parameter: '3', grouping: 'without', labels: 'replica' },
      newOperation('*'),
    ],
  };
  assert.deepEqual(parseMetrics(buildMetrics(builder).query), builder);
  assert.match(
    buildMetrics({ ...builder, operations: [newOperation('sum'), newOperation('rate')] }).error,
    /first/,
  );
  assert.match(
    buildMetrics({
      ...builder,
      operations: [{ ...newOperation('rate'), parameter: '5m]) + evil' }],
    }).error,
    /range window/,
  );
  assert.match(
    buildMetrics({ ...builder, operations: [{ ...newOperation('sum'), labels: 'job) (evil' }] })
      .error,
    /Grouping/,
  );
  assert.match(
    buildMetrics({
      ...builder,
      operations: [{ ...newOperation('histogram_quantile'), parameter: '2' }],
    }).error,
    /Quantile/,
  );
  assert.match(
    buildMetrics({ ...builder, operations: [{ ...newOperation('topk'), parameter: '0' }] }).error,
    /positive integer/,
  );
});

test('manual conversion preserves supported queries and refuses expressions it cannot represent', () => {
  for (const query of [
    'node_uname_info',
    'sum(ClickHouseMetrics_Query)',
    'sum(rate(requests_total{job="api"}[5m])) by (job)',
    'abs(sum by (job) (requests_total))',
  ]) {
    assert.ok(parseMetrics(query), query);
    assert.ok(buildMetrics(parseMetrics(query)).query);
  }
  for (const query of [
    'up + down',
    'sum(up) / sum(down)',
    'up offset 5m',
    'label_replace(up,"a","b","c","d")',
    '{job="api"}',
    'up[5m]',
  ])
    assert.equal(parseMetrics(query), null, query);
  const panel = { ...defaultPanel(), text: 'up + down', inputMode: 'constructor' };
  assert.match(panelQuery(panel).error, /cannot be represented/);
  assert.equal(panel.text, 'up + down');
});

test('traces builder safely encodes service, operation, tags and duration bounds', () => {
  const builder = {
    ...emptyBuilder('traces'),
    service: 'api & payments',
    operation: 'GET /v1?q=x',
    tags: [
      { key: 'error', value: 'true' },
      { key: 'http.url', value: 'a"b + café' },
    ],
    minDuration: '100ms',
    maxDuration: '1m30s',
  };
  const result = buildTraces(builder);
  const params = new URLSearchParams(result.query);
  assert.equal(params.get('service'), builder.service);
  assert.equal(params.get('operation'), builder.operation);
  assert.deepEqual(JSON.parse(params.get('tags')), { error: 'true', 'http.url': 'a"b + café' });
  assert.deepEqual(parseTraces(result.query), builder);
  assert.match(buildTraces({ ...builder, minDuration: '2m' }).error, /exceeds/);
  assert.match(buildTraces({ ...builder, minDuration: '100' }).error, /durations/);
  assert.match(
    buildTraces({
      ...builder,
      tags: [
        { key: 'a', value: '1' },
        { key: 'a', value: '2' },
      ],
    }).error,
    /unique/,
  );
  assert.equal(parseTraces('service=api&extra=1'), null);
  assert.equal(parseTraces('service=api&service=other'), null);
  assert.equal(parseTraces('service=api&tags=[]'), null);
});

test('incomplete constructors survive shared URLs and malformed builder state is rejected', () => {
  const metrics = {
    ...emptyBuilder('metrics'),
    metric: 'node_cpu_seconds_total',
    filters: [{ label: '', operator: '!=', value: '' }],
  };
  const traces = { ...emptyBuilder('traces'), service: 'api', tags: [{ key: '', value: '500' }] };
  const state = {
    version: 2,
    panels: [
      { ...defaultPanel('a'), inputMode: 'constructor', builder: metrics },
      { ...defaultPanel('b', 'traces'), inputMode: 'constructor', builder: traces },
    ],
  };
  assert.deepEqual(readLocation(locationHash('explore', state)).explorer, state);
  assert.equal(
    normalizeBuilder({ ...metrics, filters: Array(33).fill(metrics.filters[0]) }),
    undefined,
  );
  assert.equal(normalizeBuilder({ ...metrics, operations: [{ name: 'evil' }] }), undefined);
  assert.equal(panelQuery(state.panels[0]).query, '');
  assert.equal(
    panelQuery({
      ...defaultPanel(),
      inputMode: 'constructor',
      builder: { ...emptyBuilder('metrics'), metric: 'up' },
    }).query,
    'up',
  );
});

test('constructed query length stays within the editor and share-link limit', () => {
  const builder = {
    ...emptyBuilder('metrics'),
    metric: 'up',
    filters: Array.from({ length: 20 }, (_, index) => ({
      label: `label_${index}`,
      operator: '=',
      value: 'x'.repeat(1000),
    })),
  };
  assert.match(buildQuery(builder).error, /16000/);
  assert.equal(buildQuery(builder).query, '');
});
