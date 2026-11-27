import { newWidget } from './dashboard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readDashboardGeneration,
  generationTime,
  mergeWidgetEvent,
} from './dashboardGeneration.ts';
const encoder = new TextEncoder();
function stream(parts) {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(encoder.encode(p));
        c.close();
      },
    }),
    { headers: { 'Content-Type': 'application/x-ndjson' } },
  );
}
test('generation progress arrives before the final dashboard, even with split JSON records', async () => {
  let controller;
  const response = new Response(
    new ReadableStream({
      start(c) {
        controller = c;
      },
    }),
    { headers: { 'Content-Type': 'application/x-ndjson' } },
  );
  const events = [];
  const result = readDashboardGeneration(response, (e) => events.push(e));
  controller.enqueue(
    encoder.encode('{"type":"progress","phase":"filter","message":"Checking","elapsedMs":1}\n'),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  controller.enqueue(encoder.encode('{"type":"result","status":200,"da'));
  controller.enqueue(encoder.encode('ta":{"verdict":"PASS","dashboard":{"title":"CPU"}}}\n'));
  controller.close();
  assert.equal((await result).data.dashboard.title, 'CPU');
});
test('missing final result and malformed records never leave a successful generation', async () => {
  await assert.rejects(
    () =>
      readDashboardGeneration(
        stream(['{"type":"progress","phase":"planning","message":"Waiting","elapsedMs":10}\n']),
        () => {},
      ),
    /before a result/,
  );
  await assert.rejects(() => readDashboardGeneration(stream(['{oops}\n']), () => {}));
});
test('streamed semantic rejection and legacy HTTP errors retain their status', async () => {
  const rejected = await readDashboardGeneration(
    stream(['{"type":"result","status":422,"data":{"verdict":"FAIL","error":"Out of scope"}}\n']),
    () => {},
  );
  assert.equal(rejected.status, 422);
  const legacy = await readDashboardGeneration(
    new Response('{"error":"Invalid file"}', {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }),
    () => {},
  );
  assert.equal(legacy.status, 400);
  assert.equal(generationTime(181000), '3m 1s');
});

test('complete widget events are delivered before the final response and revisions replace old drafts', async () => {
  const { newWidget } = await import('./dashboard.ts');
  const { mergeWidgetEvent } = await import('./dashboardGeneration.ts');
  const widget = { ...newWidget(), query: 'up' };
  let streamController;
  const response = new Response(
    new ReadableStream({
      start(c) {
        streamController = c;
      },
    }),
    { headers: { 'Content-Type': 'application/x-ndjson' } },
  );
  const events = [];
  const result = readDashboardGeneration(
    response,
    () => {},
    (event) => events.push(event),
  );
  const event = { type: 'widget', revision: 1, index: 0, elapsedMs: 10, widget };
  streamController.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  streamController.enqueue(
    encoder.encode('{"type":"result","status":200,"data":{"verdict":"PASS"}}\n'),
  );
  streamController.close();
  await result;
  let state = mergeWidgetEvent({ revision: 0, widgets: {} }, event);
  state = mergeWidgetEvent(state, { ...event, index: 1, widget: { ...widget, id: 'second' } });
  assert.equal(Object.keys(state.widgets).length, 2);
  state = mergeWidgetEvent(state, { ...event, revision: 2 });
  assert.equal(Object.keys(state.widgets).length, 1);
  assert.equal(mergeWidgetEvent(state, event), state);
});

test('generation streams all 64 panels and rejects an out-of-range 65th event', async () => {
  const events = Array.from({ length: 64 }, (_, index) => ({
    type: 'widget',
    revision: 1,
    index,
    widget: { ...newWidget(), query: 'up' },
    elapsedMs: index,
  }));
  const received = [];
  const response = stream([
    ...events.map((event) => JSON.stringify(event) + '\n'),
    JSON.stringify({ type: 'result', status: 200, data: {} }) + '\n',
  ]);
  await readDashboardGeneration(
    response,
    () => {},
    (event) => received.push(event.index),
  );
  assert.deepEqual(
    received,
    Array.from({ length: 64 }, (_, index) => index),
  );
  await assert.rejects(
    () =>
      readDashboardGeneration(
        stream([JSON.stringify({ ...events[0], index: 64 }) + '\n']),
        () => {},
      ),
    /Invalid dashboard generation response/,
  );
});

test('streamed variable definitions follow widgets and explicit removal', async () => {
  const variables = [{ name: 'env', type: 'custom', options: ['dev'], current: ['dev'] }];
  const event = {
    type: 'widget',
    revision: 1,
    index: 0,
    elapsedMs: 0,
    widget: { ...newWidget(), query: 'up{env="$env"}' },
    variables,
  };
  const received = [];
  await readDashboardGeneration(
    stream([
      JSON.stringify(event) + '\n',
      JSON.stringify({ type: 'result', status: 200, data: {} }) + '\n',
    ]),
    () => {},
    (value) => received.push(value),
  );
  assert.equal(received[0].variables[0].name, 'env');
  let state = mergeWidgetEvent({ revision: 0, widgets: {} }, received[0]);
  state = mergeWidgetEvent(state, { ...event, index: 1, variables: undefined });
  assert.equal(state.variables[0].current[0], 'dev');
  state = mergeWidgetEvent(state, { ...event, revision: 2, variables: [] });
  assert.deepEqual(state.variables, []);
  await assert.rejects(
    () =>
      readDashboardGeneration(
        stream([
          JSON.stringify({ ...event, variables: [{ name: 'bad name', type: 'custom' }] }) + '\n',
        ]),
        () => {},
      ),
    /variable/i,
  );
});
