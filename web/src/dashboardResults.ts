import type { Dashboard, DashboardWidget } from './dashboard.ts';
import type { WidgetResult } from './DashboardWidgetView.tsx';
export const widgetRequestKey = (widget: DashboardWidget) =>
  JSON.stringify([widget.type === 'force-graph', widget.source, widget.sourceId, widget.query]);
/** Reuse preview data only if the query and selected range still describe it. */
export function transferPreviewResults(
  previous: Dashboard,
  next: Dashboard,
  cache: Record<string, WidgetResult>,
) {
  const old = new Map(previous.widgets.map((w) => [w.id, w]));
  const results: Record<string, WidgetResult> = {};
  const variablesMatch =
    JSON.stringify(previous.variables || []) === JSON.stringify(next.variables || []);
  const unresolved = previous.variables?.some(
    (variable) => variable.type === 'query' && !variable.current?.length,
  );
  if (previous.range === next.range && variablesMatch && !unresolved)
    for (const w of next.widgets) {
      const before = old.get(w.id),
        result = cache[w.id];
      if (before && result && !result.pending && widgetRequestKey(before) === widgetRequestKey(w))
        results[w.id] = result;
    }
  return { results, missing: next.widgets.filter((w) => !results[w.id]).map((w) => w.id) };
}

export const hasWidgetData = (result?: WidgetResult) =>
  result?.response !== undefined || result?.graph !== undefined;

/** Keep the displayed snapshot mounted while its replacement is being loaded. */
export function beginWidgetRefresh(previous?: WidgetResult): WidgetResult {
  return { ...previous, pending: true };
}
export function finishWidgetRefresh(
  previous: WidgetResult | undefined,
  next: WidgetResult,
): WidgetResult {
  if (next.error && hasWidgetData(previous))
    return { ...previous, pending: false, error: next.error };
  return next;
}
/** Stage a complete refresh before publishing any result. Cancelled batches never commit. */
export async function preloadDashboardResults(
  widgets: DashboardWidget[],
  signal: AbortSignal,
  load: (widget: DashboardWidget) => Promise<WidgetResult>,
): Promise<Record<string, WidgetResult> | null> {
  const queue = [...widgets];
  const staged: Record<string, WidgetResult> = {};
  async function worker() {
    while (queue.length && !signal.aborted) {
      const widget = queue.shift()!;
      try {
        const result = await load(widget);
        if (!signal.aborted) staged[widget.id] = result;
      } catch (error) {
        if (!signal.aborted)
          staged[widget.id] = { error: error instanceof Error ? error.message : 'Query failed.' };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  return signal.aborted ? null : staged;
}
/** Loading/error metadata must not redraw a chart that still displays the same data. */
export function sameWidgetContents(before?: WidgetResult, after?: WidgetResult) {
  return (
    before?.response === after?.response &&
    before?.graph === after?.graph &&
    (hasWidgetData(before) ||
      (before?.pending === after?.pending && before?.error === after?.error))
  );
}
