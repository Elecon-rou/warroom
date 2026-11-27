import test from 'node:test';
import assert from 'node:assert/strict';
import { newDashboard, newWidget } from './dashboard.ts';
import {
  beginWidgetRefresh,
  finishWidgetRefresh,
  sameWidgetContents,
  preloadDashboardResults,
  transferPreviewResults,
} from './dashboardResults.ts';
test('applying a draft reuses completed results across layout edits but never across query or range edits', () => {
  const widget = { ...newWidget(), query: 'up' },
    before = { ...newDashboard(), widgets: [widget] };
  const cached = { response: { data: [], start: 1, end: 2 } };
  const edited = { ...before, widgets: [{ ...widget, title: 'Renamed', width: 3 }] };
  assert.equal(
    transferPreviewResults(before, edited, { [widget.id]: cached }).results[widget.id],
    cached,
  );
  assert.deepEqual(
    transferPreviewResults(
      before,
      { ...edited, widgets: [{ ...widget, query: 'sum(up)' }] },
      { [widget.id]: cached },
    ).missing,
    [widget.id],
  );
  assert.deepEqual(
    transferPreviewResults(before, { ...edited, range: 900 }, { [widget.id]: cached }).missing,
    [widget.id],
  );
  assert.deepEqual(
    transferPreviewResults(before, edited, { [widget.id]: { pending: true } }).missing,
    [widget.id],
  );
});

test('changing source instance invalidates preview results', () => {
  const widget = { ...newWidget(), sourceId: 'east', query: 'up' };
  const before = { ...newDashboard(), widgets: [widget] };
  const after = { ...before, widgets: [{ ...widget, sourceId: 'west' }] };
  assert.deepEqual(
    transferPreviewResults(before, after, { [widget.id]: { response: { data: [] } } }).missing,
    [widget.id],
  );
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('a dashboard refresh preloads every panel before publishing and bounds concurrency', async () => {
  const widgets = Array.from({ length: 5 }, (_, i) => ({ ...newWidget(), id: String(i) }));
  const reads = widgets.map(() => deferred());
  const started = [];
  let committed = false;
  const batch = preloadDashboardResults(widgets, new AbortController().signal, async (widget) => {
    started.push(widget.id);
    return reads[Number(widget.id)].promise;
  }).then((results) => {
    committed = true;
    return results;
  });
  assert.deepEqual(started, ['0', '1', '2']);
  reads[1].resolve({ updated: 2 });
  await new Promise(setImmediate);
  assert.equal(committed, false);
  assert.deepEqual(started, ['0', '1', '2', '3']);
  reads[0].resolve({ updated: 1 });
  reads[2].resolve({ updated: 3 });
  reads[3].resolve({ updated: 4 });
  await new Promise(setImmediate);
  assert.equal(committed, false);
  reads[4].resolve({ updated: 5 });
  const result = await batch;
  assert.deepEqual(
    widgets.map((widget) => result[widget.id].updated),
    [1, 2, 3, 4, 5],
  );
});

test('cancelled and superseded refresh batches never publish partial or late results', async () => {
  const controller = new AbortController();
  const read = deferred();
  const batch = preloadDashboardResults(
    [
      { ...newWidget(), id: 'first' },
      { ...newWidget(), id: 'second' },
    ],
    controller.signal,
    () => read.promise,
  );
  controller.abort();
  read.resolve({ updated: 999 });
  assert.equal(await batch, null);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    await preloadDashboardResults([newWidget()], aborted.signal, () => {
      assert.fail('cancelled query was started');
    }),
    null,
  );
});

test('refresh preserves mounted contents and last successful data on errors', async () => {
  const old = { response: { data: [] }, updated: 10 };
  const pending = beginWidgetRefresh(old);
  assert.equal(pending.response, old.response);
  assert.equal(sameWidgetContents(old, pending), true);
  assert.equal(sameWidgetContents(undefined, beginWidgetRefresh()), false);
  const next = { response: { data: [1] }, updated: 20 };
  assert.equal(sameWidgetContents(pending, next), false);
  assert.equal(finishWidgetRefresh(pending, next), next);
  const widgets = [
    { ...newWidget(), id: 'failed' },
    { ...newWidget(), id: 'okay' },
  ];
  const result = await preloadDashboardResults(
    widgets,
    new AbortController().signal,
    async (widget) => {
      if (widget.id === 'failed') throw new Error('Datasource unavailable');
      return next;
    },
  );
  assert.equal(result.okay, next);
  const failed = finishWidgetRefresh(pending, result.failed);
  assert.equal(failed.response, old.response);
  assert.equal(failed.updated, 10);
  assert.equal(failed.error, 'Datasource unavailable');
  assert.equal(failed.pending, false);
  assert.equal(sameWidgetContents(old, failed), true);
  assert.deepEqual(finishWidgetRefresh(undefined, result.failed), {
    error: 'Datasource unavailable',
  });
  assert.deepEqual(
    await preloadDashboardResults([], new AbortController().signal, async () => next),
    {},
  );
});
