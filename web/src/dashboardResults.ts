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
  if (previous.range === next.range)
    for (const w of next.widgets) {
      const before = old.get(w.id),
        result = cache[w.id];
      if (before && result && !result.pending && widgetRequestKey(before) === widgetRequestKey(w))
        results[w.id] = result;
    }
  return { results, missing: next.widgets.filter((w) => !results[w.id]).map((w) => w.id) };
}
