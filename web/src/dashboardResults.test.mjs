import test from 'node:test';
import assert from 'node:assert/strict';
import { newDashboard, newWidget } from './dashboard.ts';
import { transferPreviewResults } from './dashboardResults.ts';
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
