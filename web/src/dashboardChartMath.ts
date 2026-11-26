import type { Series } from './types.ts';
const valid = ([t, v]: [number, string]) =>
  Number.isFinite(t) && v.trim() !== '' && Number.isFinite(Number(v));
export function chartSegments(values: [number, string][], maxGap = Infinity): [number, number][][] {
  const result: [number, number][][] = [];
  let segment: [number, number][] = [];
  for (const pair of values) {
    if (valid(pair)) {
      if (segment.length && pair[0] - segment[segment.length - 1][0] > maxGap) {
        result.push(segment);
        segment = [];
      }
      segment.push([pair[0], Number(pair[1])]);
    } else if (segment.length) {
      result.push(segment);
      segment = [];
    }
  }
  if (segment.length) result.push(segment);
  return result;
}
export function chartDomain(series: Series[], fixed?: [number, number]): [number, number] {
  if (fixed && fixed.every(Number.isFinite) && fixed[0] < fixed[1]) return fixed;
  let min = 0,
    max = 0;
  for (const s of series)
    for (const pair of s.values)
      if (valid(pair)) {
        min = Math.min(min, Number(pair[1]));
        max = Math.max(max, Number(pair[1]));
      }
  if (min === max) return [min, max + 1];
  const padding = (max - min) * 0.08;
  return [min < 0 ? min - padding : 0, max > 0 ? max + padding : 0];
}
export function nearestSample(
  values: [number, string][],
  time: number,
  maxDistance: number,
): [number, number] | null {
  let best: [number, number] | null = null,
    distance = maxDistance;
  for (const pair of values) {
    const delta = Math.abs(pair[0] - time);
    if (valid(pair) && delta <= distance) {
      best = [pair[0], Number(pair[1])];
      distance = delta;
    }
  }
  return best;
}
