import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardLayout, formatDashboardValue } from './dashboardLayout.ts';
import { newWidget } from './dashboard.ts';
test('dashboard rows adapt to canvas width without gaps or over-wide spans', () => {
  const widgets = [
    { ...newWidget(), id: 'a', type: 'number' },
    { ...newWidget(), id: 'b', type: 'number' },
    { ...newWidget(), id: 'c', type: 'time-series', width: 2 },
    { ...newWidget(), id: 'd', type: 'time-series', width: 1 },
  ];
  for (const width of [320, 600, 1000, 1600]) {
    const layout = dashboardLayout(widgets, width);
    assert.ok(Object.values(layout.spans).every((span) => span >= 1 && span <= layout.columns));
    if (layout.columns > 1) {
      assert.equal(layout.spans.a + layout.spans.b, layout.columns);
      assert.equal(layout.spans.c + layout.spans.d, layout.columns);
    }
  }
});
test('compact quantities show useful units instead of huge overflowing values', () => {
  assert.deepEqual(formatDashboardValue(1024 ** 3 * 24, 'bytes'), { value: '24', unit: 'GiB' });
  assert.deepEqual(formatDashboardValue(86400 * 8, 's'), { value: '8', unit: 'd' });
  assert.deepEqual(formatDashboardValue(250000000, 'bps'), { value: '250', unit: 'Mb/s' });
  assert.equal(formatDashboardValue(1e12, 'requests').value, '1T');
});
