import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaults,
  defaultPanel,
  patchPanel,
  decodeState,
  readLocation,
  locationHash,
  localDateTime,
  inputDateTime,
} from './state.ts';

test('mixed-source independent panels round-trip through a share link', () => {
  const state = {
    version: 2,
    panels: [
      {
        ...defaultPanel('metrics-a'),
        text: 'sum(rate(requests{job="api"}[5m]))',
        prompt: 'Show CPU usage + café',
        inputMode: 'llm',
        view: 'table',
        range: '15m',
        refresh: 10,
      },
      {
        ...defaultPanel('logs-b', 'logs'),
        text: '_msg:"שלום + café & %?#"\n| fields _msg',
        filter: 'warn + café',
        sort: 'oldest',
        wrap: false,
        range: 'custom',
        customStart: '2026-10-26T08:00:00.000Z',
        customEnd: '2026-10-26T09:00:00.000Z',
        limit: 250,
      },
      {
        ...defaultPanel('traces-c', 'traces'),
        text: 'service=api&tags={"env":"prod"}',
        enabled: false,
        range: '24h',
        inputMode: 'llm',
      },
    ],
  };
  const parsed = readLocation(locationHash('explore', state));
  assert.equal(parsed.page, 'explore');
  assert.deepEqual(parsed.explorer, state);
  assert.equal(parsed.explorer.panels[0].refresh, 10);
  assert.equal(parsed.explorer.panels[1].refresh, 0);
  assert.equal(parsed.explorer.panels[2].kind, 'traces');
});

test('page routes retain all panel configuration on reload and back/forward', () => {
  const state = {
    version: 2,
    panels: [
      { ...defaultPanel('a', 'traces'), text: 'service=api', inputMode: 'constructor' },
      { ...defaultPanel('b', 'logs'), text: 'error' },
    ],
  };
  for (const page of ['history', 'sources', 'explore']) {
    const parsed = readLocation(locationHash(page, state));
    assert.equal(parsed.page, page);
    assert.deepEqual(parsed.explorer, state);
  }
});

test('old shared URLs migrate to separate panels without losing queries', () => {
  const old = {
    version: 1,
    kind: 'metrics',
    inputMode: 'manual',
    range: '15m',
    refresh: 30,
    limit: 20,
    step: '60',
    queries: {
      metrics: [
        { id: 'a', text: 'up', enabled: true },
        { id: 'b', text: 'down', enabled: false },
      ],
      logs: [{ id: 'c', text: 'error', enabled: true }],
      traces: [{ id: 'd', text: '', enabled: true }],
    },
  };
  const state = decodeState(JSON.stringify(old));
  assert.equal(state.version, 2);
  assert.equal(state.panels.length, 3);
  assert.deepEqual(
    state.panels.map((p) => p.kind),
    ['metrics', 'metrics', 'logs'],
  );
  assert.deepEqual(
    state.panels.map((p) => p.text),
    ['up', 'down', 'error'],
  );
  assert.equal(state.panels[1].enabled, false);
  assert.ok(state.panels.every((p) => p.range === '15m' && p.refresh === 30));
});

test('malformed URL state and duplicate IDs are handled safely', () => {
  for (const value of [null, 'garbage', 'null', '[]', '{"version":3}', '{"version":2,"panels":[]}'])
    assert.deepEqual(decodeState(value), defaults());
  const state = decodeState(
    JSON.stringify({
      version: 2,
      panels: [
        null,
        {
          id: 'same',
          text: 'up',
          kind: 'bad',
          range: 'invalid',
          refresh: -1,
          step: '0',
          limit: 100000,
        },
        { id: 'same', text: 'error', kind: 'logs' },
      ],
    }),
  );
  assert.equal(state.panels.length, 2);
  assert.notEqual(state.panels[0].id, state.panels[1].id);
  assert.equal(state.panels[0].kind, 'metrics');
  assert.equal(state.panels[0].range, '1h');
  assert.equal(state.panels[0].limit, 100);
  assert.equal(state.panels[1].kind, 'logs');
  assert.equal(readLocation('#unknown?state=bad').page, 'explore');
});

test('custom time range preserves UTC instants across viewer timezones', () => {
  const original = process.env.TZ;
  try {
    for (const timezone of ['Asia/Nicosia', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = timezone;
      const instant = '2026-10-26T08:00:00.000Z';
      assert.equal(inputDateTime(localDateTime(instant)), instant);
    }
  } finally {
    process.env.TZ = original;
  }
});

test('service graph route and visualization settings survive sharing', () => {
  const state = defaults();
  state.serviceGraph = {
    range: '15m',
    customStart: '',
    customEnd: '',
    refresh: 30,
    source: 'combined',
    search: 'api',
    view: 'table',
    metric: 'latency',
  };
  const parsed = readLocation(locationHash('service-graph', state));
  assert.equal(parsed.page, 'service-graph');
  assert.deepEqual(parsed.explorer.serviceGraph, state.serviceGraph);
});

test('Investigate route retains the selected time range without putting chat text into the URL', () => {
  const state = defaults();
  state.investigate = {
    range: 'custom',
    customStart: '2026-10-26T08:00:00.000Z',
    customEnd: '2026-10-26T09:00:00.000Z',
  };
  const parsed = readLocation(locationHash('investigate', state));
  assert.equal(parsed.page, 'investigate');
  assert.deepEqual(parsed.explorer.investigate, state.investigate);
});

test('input switches and LLM prompt edits retain the shared query and constructor fields', () => {
  const builder = { kind: 'metrics', metric: 'up', filters: [], operations: [] };
  let panel = { ...defaultPanel(), text: 'up', builder };
  for (const inputMode of ['constructor', 'manual', 'llm', 'constructor', 'llm', 'manual']) {
    panel = patchPanel(panel, { inputMode });
    assert.equal(panel.text, 'up');
    assert.deepEqual(panel.builder, builder);
    panel = patchPanel(panel, { prompt: 'Show running services' });
    assert.equal(panel.text, 'up');
    assert.deepEqual(
      readLocation(locationHash('explore', { version: 2, panels: [panel] })).explorer.panels[0],
      panel,
    );
  }
  panel = patchPanel(panel, { text: 'sum(up)' });
  assert.equal(panel.text, 'sum(up)');
  assert.equal(panel.builder, undefined);
  panel = patchPanel({ ...panel, builder }, { kind: 'traces', text: '' });
  assert.equal(panel.builder, undefined);
  assert.equal(panel.text, '');
});

test('logs constructor respects native pipeline sort order and preserves the choice in the URL', () => {
  const panel = patchPanel(
    { ...defaultPanel('logs-a', 'logs'), text: '* | sort by (duration desc)' },
    { inputMode: 'constructor' },
  );
  assert.equal(panel.sort, 'query');
  assert.equal(
    readLocation(locationHash('explore', { version: 2, panels: [panel] })).explorer.panels[0].sort,
    'query',
  );
  assert.equal(patchPanel(panel, { sort: 'oldest' }).sort, 'oldest');
});

test('source instance IDs survive sharing independently of kind', () => {
  const state = {
    ...defaults(),
    panels: [
      { ...defaultPanel('east'), sourceId: 'metrics-east' },
      { ...defaultPanel('west'), sourceId: 'metrics-west' },
    ],
  };
  const restored = readLocation(locationHash('explore', state));
  assert.deepEqual(
    restored.explorer.panels.map((p) => p.sourceId),
    ['metrics-east', 'metrics-west'],
  );
});
