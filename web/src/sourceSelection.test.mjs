import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceName, graphSourceOptions, selectedGraphSource } from './sourceSelection.ts';

const sources = [
  { id: 'east', name: 'Production East', kind: 'metrics', url: 'https://east.example.com' },
  { id: 'west', name: 'Development West', kind: 'metrics', url: 'https://west.example.com' },
  { id: 'events', name: 'Application events', kind: 'logs', url: 'https://events.example.com' },
  { id: 'requests', name: 'Request archive', kind: 'traces', url: 'https://requests.example.com' },
];

test('names identify actual instances even when they share a query adapter', () => {
  assert.equal(sourceName(sources, 'metrics', 'east'), 'Production East');
  assert.equal(sourceName(sources, 'metrics', 'west'), 'Development West');
  assert.equal(sourceName(sources, 'logs', 'events'), 'Application events');
  assert.equal(sourceName(sources, 'metrics', 'removed'), 'removed (unavailable)');
  assert.equal(sourceName([], 'traces'), 'No data source selected');
});

test('graph choices use configured names and route individual and combined selections by ID', () => {
  const options = graphSourceOptions(sources);
  assert.deepEqual(
    options.map((option) => option.label),
    [
      'Production East',
      'Development West',
      'Request archive',
      'Production East + Request archive',
      'Development West + Request archive',
    ],
  );
  for (const option of options) {
    assert.equal(selectedGraphSource(sources, option.selection)?.value, option.value);
  }
  const pair = options.find((option) => option.value === 'west+requests');
  assert.deepEqual(pair.selection, {
    source: 'combined',
    metricsSourceId: 'west',
    tracesSourceId: 'requests',
  });
});

test('legacy graph settings resolve instances but removed and incompatible IDs never switch silently', () => {
  assert.equal(selectedGraphSource(sources, { source: 'combined' })?.value, 'east+requests');
  assert.equal(selectedGraphSource(sources.slice(0, 2), { source: 'combined' })?.value, 'east');
  assert.equal(
    selectedGraphSource(sources, { source: 'metrics', metricsSourceId: 'removed' }),
    undefined,
  );
  assert.equal(
    selectedGraphSource(sources, { source: 'metrics', metricsSourceId: 'requests' }),
    undefined,
  );
  assert.equal(
    selectedGraphSource(sources, { source: 'combined', tracesSourceId: 'east' }),
    undefined,
  );
  assert.equal(selectedGraphSource([], { source: 'combined' }), undefined);
});
