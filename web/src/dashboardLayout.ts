import type { DashboardWidget } from './dashboard.ts';
export const isCompactWidget = (type: DashboardWidget['type']) =>
  type === 'number' || type === 'gauge';
/** Even track counts let chart pairs stay readable. Fill each row without changing order. */
export function dashboardLayout(widgets: DashboardWidget[], width: number) {
  const capacity = Math.max(1, Math.min(6, Math.floor((width + 14) / 234)));
  const columns = capacity >= 6 ? 6 : capacity >= 4 ? 4 : capacity >= 2 ? 2 : 1;
  const spans: Record<string, number> = {};
  let row: DashboardWidget[] = [],
    used = 0,
    compact: boolean | undefined;
  const flush = () => {
    if (!row.length) return;
    let extra = columns - used,
      index = 0;
    while (extra-- > 0) {
      spans[row[index % row.length].id]++;
      index++;
    }
    row = [];
    used = 0;
  };
  for (const w of widgets) {
    const small = isCompactWidget(w.type);
    if (compact !== undefined && small !== compact) flush();
    compact = small;
    const base = small ? 1 : columns >= 4 ? 2 : 1;
    const desired =
      w.width === 3
        ? columns
        : w.width === 2
          ? small
            ? Math.ceil((columns * 2) / 3)
            : columns === 6
              ? 4
              : base
          : base;
    const span = Math.min(columns, desired);
    if (used + span > columns) flush();
    row.push(w);
    spans[w.id] = span;
    used += span;
    if (used === columns) flush();
  }
  flush();
  return { columns, spans };
}
export function formatDashboardValue(n: number, unit: string): { value: string; unit: string } {
  if (!Number.isFinite(n)) return { value: '—', unit };
  const print = (v: number) =>
    v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 10 ? 2 : 1 });
  if (['bytes', 'B'].includes(unit)) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let value = n,
      index = 0;
    while (Math.abs(value) >= 1024 && index < units.length - 1) {
      value /= 1024;
      index++;
    }
    return { value: print(value), unit: units[index] };
  }
  if (['s', 'seconds'].includes(unit) && Math.abs(n) >= 60) {
    const scale =
      Math.abs(n) >= 86400 ? [86400, 'd'] : Math.abs(n) >= 3600 ? [3600, 'h'] : [60, 'min'];
    return { value: print(n / Number(scale[0])), unit: String(scale[1]) };
  }
  if (['bps', 'b/s', 'bits/s'].includes(unit)) {
    const units = ['b/s', 'Kb/s', 'Mb/s', 'Gb/s', 'Tb/s'];
    let value = n,
      index = 0;
    while (Math.abs(value) >= 1000 && index < units.length - 1) {
      value /= 1000;
      index++;
    }
    return { value: print(value), unit: units[index] };
  }
  let value = n,
    suffix = '';
  for (const [threshold, name] of [
    [1e12, 'T'],
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
  ] as const) {
    if (Math.abs(n) >= threshold) {
      value = n / threshold;
      suffix = name;
      break;
    }
  }
  return { value: print(value) + suffix, unit };
}
