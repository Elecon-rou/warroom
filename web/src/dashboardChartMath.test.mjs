import test from 'node:test';
import assert from 'node:assert/strict';
import { chartSegments, chartDomain, nearestSample } from './dashboardChartMath.ts';
test('line charts retain sample times and split on missing data', () => {
  assert.deepEqual(
    chartSegments([
      [1, '0'],
      [2, '1'],
      [3, 'NaN'],
      [4, '2'],
      [5, 'Infinity'],
    ]),
    [
      [
        [1, 0],
        [2, 1],
      ],
      [[4, 2]],
    ],
  );
});
test('percentage fixed bounds remain 0 to 100 while auto bounds include signed values', () => {
  const series = [
    {
      metric: {},
      values: [
        [1, '-2'],
        [2, '3'],
      ],
    },
  ];
  assert.deepEqual(chartDomain(series, [0, 100]), [0, 100]);
  const [min, max] = chartDomain(series);
  assert.ok(min < -2 && max > 3);
  assert.deepEqual(chartDomain([]), [0, 1]);
});
test('shared tooltip does not invent values across a telemetry gap', () => {
  const samples = [
    [10, '2'],
    [20, 'NaN'],
    [30, '3'],
  ];
  assert.deepEqual(nearestSample(samples, 11, 3), [10, 2]);
  assert.equal(nearestSample(samples, 20, 3), null);
  assert.equal(nearestSample([], 20, 3), null);
});
