import test from 'node:test';
import assert from 'node:assert/strict';
import { newDashboard, newWidget, parseDashboard } from './dashboard.ts';
import { defaults, locationHash, readLocation } from './state.ts';
import { transferPreviewResults } from './dashboardResults.ts';
import {
  allVariableValues,
  parseDashboardVariables,
  variableSelection,
  interpolateVariables,
  resolveDashboardWidget,
} from './dashboardVariables.ts';

const variables = [
  {
    name: 'namespace',
    label: 'Environment',
    type: 'custom',
    options: ['prod', 'dev.test', 'quote"slash\\'],
    current: ['prod'],
    multi: true,
    includeAll: true,
  },
  {
    name: 'pod',
    type: 'query',
    source: 'metrics',
    sourceId: 'primary',
    query: 'label_values(up{namespace=~"$namespace"}, pod)',
    current: ['api-1'],
  },
];
const window = { start: 1700000000, end: 1700003600 };
const context = { kind: 'metrics', window };

test('dashboard variables persist through JSON and share URLs without affecting other dashboards', () => {
  const dashboard = {
    ...newDashboard(),
    variables,
    widgets: [{ ...newWidget(), query: 'up{namespace=~"$namespace",pod="$pod"}' }],
  };
  const parsed = parseDashboard(JSON.parse(JSON.stringify(dashboard)));
  assert.deepEqual(parsed.variables, variables);
  const restored = readLocation(locationHash('dashboards', { ...defaults(), dashboard: parsed }))
    .explorer.dashboard;
  assert.deepEqual(restored.variables, variables);
  assert.equal(newDashboard().variables, undefined);
});
test('variable definitions reject cycles, invalid dependencies, duplicates and oversized selections', () => {
  const invalid = [
    [...variables, variables[0]],
    [{ ...variables[0], name: '__from' }],
    [variables[1], variables[0]],
    [{ ...variables[1], query: 'label_values(up{pod="$pod"}, pod)' }],
    [{ ...variables[0], options: [] }],
    [{ ...variables[0], current: ['missing'] }],
    [{ ...variables[0], multi: false, current: ['prod', 'dev.test'] }],
    [{ ...variables[0], includeAll: false, current: [allVariableValues] }],
    Array.from({ length: 21 }, (_, i) => ({ ...variables[0], name: `v${i}` })),
  ];
  for (const value of invalid) assert.throws(() => parseDashboardVariables(value));
});
test('metrics interpolation escapes literal strings and regex alternatives rather than injecting query syntax', () => {
  assert.equal(
    interpolateVariables(
      'up{namespace=~"$namespace",pod="${pod}"}',
      variables,
      { namespace: ['dev.test'], pod: ['quote"slash\\'] },
      context,
    ),
    'up{namespace=~"dev\\\\.test",pod="quote\\"slash\\\\"}',
  );
  assert.equal(
    interpolateVariables(
      'up{namespace=~"$namespace"}',
      variables,
      { namespace: ['prod', 'dev.test'] },
      context,
    ),
    'up{namespace=~"(prod|dev\\\\.test)"}',
  );
  assert.equal(
    interpolateVariables(
      'up{namespace=~"$namespace"}',
      variables,
      { namespace: [allVariableValues] },
      context,
    ),
    'up{namespace=~".*"}',
  );
  assert.throws(
    () =>
      interpolateVariables(
        'up{namespace="$namespace"}',
        variables,
        { namespace: ['prod'] },
        context,
      ),
    /regex matcher/,
  );
  assert.throws(
    () => interpolateVariables('up{namespace="$missing"}', variables, {}, context),
    /Unknown dashboard variable/,
  );
  assert.throws(
    () => interpolateVariables('up{pod="$pod"}', variables, { pod: [] }, context),
    /Select a value/,
  );
});
test('formatters, labels, time built-ins and replacement backreferences remain distinct', () => {
  assert.equal(
    interpolateVariables(
      '${namespace:csv}',
      variables,
      { namespace: ['prod', 'dev.test'] },
      context,
    ),
    'prod,dev.test',
  );
  assert.equal(
    interpolateVariables(
      '${namespace:json}',
      variables,
      { namespace: ['prod', 'dev.test'] },
      context,
    ),
    '["prod","dev.test"]',
  );
  assert.equal(
    interpolateVariables(
      'CPU — $namespace',
      variables,
      { namespace: ['prod', 'dev.test'] },
      { window, title: true },
    ),
    'CPU — prod, dev.test',
  );
  assert.equal(
    interpolateVariables(
      '$__range $__interval $__from $__to $__rate_interval',
      variables,
      {},
      context,
    ),
    '3600s 15s 1700000000000 1700003600000 60s',
  );
  assert.equal(
    interpolateVariables('label_replace(up,"version","$1","image",".*:(.*)")', [], {}, context),
    'label_replace(up,"version","$1","image",".*:(.*)")',
  );
  assert.throws(
    () => interpolateVariables('${pod:exec}', variables, { pod: ['api'] }, context),
    /Unsupported variable format/,
  );
});
test('LogsQL values stay quoted and Jaeger parameters and JSON tags are encoded as data', () => {
  const one = [{ name: 'service', type: 'textbox', current: ['api & "edge" + /'] }];
  const values = { service: ['api & "edge" + /'] };
  assert.equal(
    interpolateVariables('_msg:"$service"', one, values, { kind: 'logs', window }),
    '_msg:"api & \\"edge\\" + /"',
  );
  const input = new URLSearchParams({
    service: '$service',
    tags: JSON.stringify({ owner: '${service}' }),
  }).toString();
  const output = new URLSearchParams(
    interpolateVariables(input, one, values, { kind: 'traces', window }),
  );
  assert.equal(output.get('service'), values.service[0]);
  assert.deepEqual(JSON.parse(output.get('tags')), { owner: values.service[0] });
  assert.throws(
    () =>
      interpolateVariables(
        input,
        variables,
        { namespace: [allVariableValues] },
        { kind: 'traces', window },
      ),
    /Unknown dashboard variable/,
  );
});
test('query options reconcile stale child selections and preview data cannot cross selections', () => {
  assert.deepEqual(variableSelection(variables[1], ['api-2']), ['api-2']);
  assert.deepEqual(variableSelection({ ...variables[0], current: [allVariableValues] }, ['prod']), [
    allVariableValues,
  ]);
  const widget = {
    ...newWidget(),
    query: 'up{namespace=~"$namespace"}',
    title: 'CPU — $namespace',
  };
  const before = { ...newDashboard(), variables, widgets: [widget] };
  const after = {
    ...before,
    variables: [{ ...variables[0], current: ['dev.test'] }, variables[1]],
  };
  const cached = { response: { data: [] } };
  assert.deepEqual(transferPreviewResults(before, after, { [widget.id]: cached }).missing, [
    widget.id,
  ]);
  const resolved = resolveDashboardWidget(widget, before, { namespace: ['prod'] }, window);
  assert.equal(resolved.title, 'CPU — prod');
  assert.equal(resolved.query, 'up{namespace=~"prod"}');
  assert.equal(widget.query, 'up{namespace=~"$namespace"}');
});

test('double dollar escapes literal dollar names without recursively expanding selected values', () => {
  assert.equal(interpolateVariables('"$$HOME"', [], {}, { kind: 'logs', window }), '"$HOME"');
  assert.equal(
    interpolateVariables('$pod', variables, { pod: ['$namespace'] }, { window, title: true }),
    '$namespace',
  );
});
