import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newDashboard,
  newWidget,
  parseDashboard,
  widgetRows,
  reduceValues,
  compatibleSources,
} from './dashboard.ts';
import { defaults, locationHash, readLocation } from './state.ts';

test('all widget/source combinations enforce compatibility', () => {
  for (const type of [
    'blinkenlights',
    'bars',
    'time-series',
    'force-graph',
    'gauge',
    'logs',
    'pie',
    'table',
    'number',
  ])
    for (const source of ['metrics', 'logs', 'traces']) {
      const d = { ...newDashboard(), widgets: [{ ...newWidget(), type, source }] };
      if (compatibleSources(type).includes(source))
        assert.equal(parseDashboard(d).widgets[0].source, source);
      else assert.throws(() => parseDashboard(d), /Incompatible/);
    }
});
test('dashboard JSON survives URLs without losing explorer state', () => {
  const state = {
    ...defaults(),
    dashboard: {
      ...newDashboard(),
      title: 'CPU + disk / α',
      widgets: [{ ...newWidget(), query: 'sum(up)' }],
    },
  };
  const roundtrip = readLocation(locationHash('dashboards', state));
  assert.equal(roundtrip.page, 'dashboards');
  assert.deepEqual(roundtrip.explorer, state);
});
test('invalid imports are rejected instead of silently replacing data', () => {
  const w = newWidget(),
    d = { ...newDashboard(), widgets: [w] };
  for (const patch of [
    { widgets: [w, w] },
    { widgets: [{ ...w, max: 0 }] },
    { widgets: [{ ...w, warning: 99, critical: 10 }] },
    { widgets: [{ ...w, min: NaN }] },
    { range: Infinity },
    { refresh: 1 },
    { widgets: Array.from({ length: 65 }, newWidget) },
  ])
    assert.throws(() => parseDashboard({ ...d, ...patch }));
  assert.equal(parseDashboard({ ...d, password: 'not part of schema' }).password, undefined);
});
test('reducers retain no-data and reject nonfinite samples', () => {
  assert.equal(reduceValues([], 'sum'), null);
  assert.equal(reduceValues([NaN, Infinity], 'last'), null);
  assert.equal(reduceValues([1, 2, 3], 'mean'), 2);
  assert.equal(reduceValues([1, 2, 3], 'sum'), 6);
  assert.equal(reduceValues([1, 2, 3], 'count'), 3);
});
test('metrics adapter reduces samples per series and includes numeric table value', () => {
  const w = { ...newWidget(), reducer: 'mean', labelField: 'instance' };
  const rows = widgetRows(w, {
    data: {
      data: {
        result: [
          {
            metric: { __name__: 'cpu', instance: 'node-a' },
            values: [
              [1, '2'],
              [2, '4'],
              [3, 'NaN'],
            ],
          },
        ],
      },
    },
  });
  assert.equal(rows[0].label, 'node-a');
  assert.equal(rows[0].value, 3);
  assert.equal(rows[0].fields.value, 3);
});
test('logs adapter preserves missing values, zero and native stats output fields', () => {
  const w = { ...newWidget(), source: 'logs', valueField: 'errors', labelField: 'service' };
  const response = {
    data: [
      { service: 'api', errors: '0' },
      { service: 'db', errors: '' },
      { service: 'worker', errors: '7' },
      { service: 'no-field' },
    ],
  };
  assert.deepEqual(
    widgetRows(w, response).map((r) => r.value),
    [0, null, 7, null],
  );
  assert.deepEqual(
    widgetRows({ ...w, reducer: 'count', valueField: '' }, response).map((r) => r.value),
    [1, 1, 1, 1],
  );
});
test('trace adapter uses full trace duration in milliseconds', () => {
  const rows = widgetRows(
    { ...newWidget(), source: 'traces' },
    {
      data: {
        data: [
          {
            spans: [
              { traceID: 'a', startTime: 1000, duration: 4000 },
              { traceID: 'a', startTime: 2000, duration: 5000 },
            ],
            processes: { p: { serviceName: 'api' } },
          },
        ],
      },
    },
  );
  assert.equal(rows[0].value, 6);
  assert.equal(rows[0].fields.traceID, 'a');
});

test('time-series display options persist in shared dashboards and reject malformed styles', () => {
  const widget = {
    ...newWidget(),
    type: 'time-series',
    chartStyle: 'bars',
    axisMode: 'fixed',
    unit: '%',
    width: 3,
  };
  const state = { ...defaults(), dashboard: { ...newDashboard(), widgets: [widget] } };
  assert.deepEqual(readLocation(locationHash('dashboards', state)).explorer, state);
  assert.throws(() =>
    parseDashboard({ ...state.dashboard, widgets: [{ ...widget, chartStyle: 'pie' }] }),
  );
  assert.throws(() =>
    parseDashboard({ ...state.dashboard, widgets: [{ ...widget, source: 'logs' }] }),
  );
});

test('dashboard imports accept 48 and 64 panels and reject a 65th panel', () => {
  for (const count of [48, 64]) {
    const dashboard = { ...newDashboard(), widgets: Array.from({ length: count }, newWidget) };
    assert.equal(parseDashboard(dashboard).widgets.length, count);
    const state = { ...defaults(), dashboard };
    assert.equal(
      readLocation(locationHash('dashboards', state)).explorer.dashboard.widgets.length,
      count,
    );
  }
  assert.throws(() =>
    parseDashboard({ ...newDashboard(), widgets: Array.from({ length: 65 }, newWidget) }),
  );
});
