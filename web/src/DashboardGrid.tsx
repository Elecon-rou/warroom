import { useDataSources, sourceName } from './dataSources';
import { ArrowDown, ArrowUp, Copy, Settings2, Trash2 } from 'lucide-react';
import { DashboardWidgetView, type WidgetResult } from './DashboardWidgetView';
import { dashboardLayout } from './dashboardLayout';
import { useElementSize } from './useElementSize';
import { maxDashboardWidgets, type DashboardWidget } from './dashboard';

type Controls = {
  selectedId?: string;
  onMove: (id: string, delta: number) => void;
  onDuplicate: (widget: DashboardWidget) => void;
  onEdit: (widget: DashboardWidget) => void;
  onRemove: (id: string) => void;
};
export function DashboardGrid({
  widgets,
  results,
  controls,
}: {
  widgets: DashboardWidget[];
  results: Record<string, WidgetResult>;
  controls?: Controls;
}) {
  const sources = useDataSources();
  const { ref, width } = useElementSize();
  const layout = dashboardLayout(widgets, width);
  return (
    <div
      ref={ref}
      className="dashboard-grid"
      style={{ gridTemplateColumns: `repeat(${layout.columns},minmax(0,1fr))` }}
    >
      {widgets.map((w, index) => (
        <section
          key={w.id}
          className={`dashboard-widget${controls?.selectedId === w.id ? ' selected' : ''}`}
          data-widget-type={w.type}
          style={{ gridColumn: `span ${layout.spans[w.id]}` }}
        >
          <header>
            <div className="dashboard-widget-heading">
              <h2 title={w.title}>{w.title}</h2>
              <small>
                {w.type} · {sourceName(sources, w.source, w.sourceId)}
                {results[w.id]?.updated
                  ? ` · ${new Date(results[w.id].updated!).toLocaleTimeString()}`
                  : ''}
              </small>
            </div>
            {controls && (
              <div className="inline-tools">
                <button
                  aria-label={`Move ${w.title} up`}
                  disabled={!index}
                  onClick={() => controls.onMove(w.id, -1)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  aria-label={`Move ${w.title} down`}
                  disabled={index === widgets.length - 1}
                  onClick={() => controls.onMove(w.id, 1)}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  aria-label={`Duplicate ${w.title}`}
                  disabled={widgets.length >= maxDashboardWidgets}
                  onClick={() => controls.onDuplicate(w)}
                >
                  <Copy size={13} />
                </button>
                <button aria-label={`Edit ${w.title}`} onClick={() => controls.onEdit(w)}>
                  <Settings2 size={14} />
                </button>
                <button
                  className="dashboard-delete"
                  aria-label={`Delete ${w.title}`}
                  onClick={() => controls.onRemove(w.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </header>
          <div className="dashboard-widget-body">
            <DashboardWidgetView widget={w} result={results[w.id]} />
          </div>
        </section>
      ))}
    </div>
  );
}
