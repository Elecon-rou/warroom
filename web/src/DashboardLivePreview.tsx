import { useDataSources, selectedSourceId } from './dataSources';
import { widgetRequestKey as requestKey } from './dashboardResults';
import { useEffect, useRef, useState } from 'react';
import { DashboardGrid } from './DashboardGrid';
import type { Dashboard } from './dashboard';
import type { WidgetResult } from './DashboardWidgetView';

type Window = { start: number; end: number };
/** Query only complete validated widget events, with three concurrent reads and cancellation. */
export function DashboardLivePreview({
  draft,
  window,
  onResults,
}: {
  draft: Dashboard;
  window: Window;
  onResults: (results: Record<string, WidgetResult>) => void;
}) {
  const sources = useDataSources();
  const cache = useRef(new Map<string, WidgetResult>());
  const controllers = useRef(new Map<string, AbortController>());
  const current = useRef(draft.widgets);
  current.current = draft.widgets;
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  const running = useRef(0);
  const pumpRef = useRef<() => void>(() => {});
  function pump() {
    for (const w of current.current) {
      const key = requestKey(w);
      if (running.current >= 3) break;
      if (cache.current.has(key)) continue;
      const controller = new AbortController();
      controllers.current.set(key, controller);
      running.current++;
      cache.current.set(key, { pending: true });
      setRevision((v) => v + 1);
      void (async () => {
        try {
          const graph = w.type === 'force-graph';
          const res = await fetch(graph ? '/api/service-graph' : '/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify(
              graph
                ? {
                    source: w.source,
                    sourceId: selectedSourceId(sources, w.source, w.sourceId),
                    ...window,
                  }
                : {
                    kind: w.source,
                    sourceId: selectedSourceId(sources, w.source, w.sourceId),
                    query: w.query,
                    ...window,
                    step: 0,
                    limit: 100,
                  },
            ),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Query failed.');
          if (!controller.signal.aborted)
            cache.current.set(key, { [graph ? 'graph' : 'response']: data, updated: Date.now() });
        } catch (error) {
          if (!controller.signal.aborted)
            cache.current.set(key, { error: (error as Error).message });
        } finally {
          if (controllers.current.get(key) === controller) controllers.current.delete(key);
          running.current--;
          if (alive.current) {
            setRevision((v) => v + 1);
            pumpRef.current();
          }
        }
      })();
    }
  }
  pumpRef.current = pump;
  useEffect(() => {
    const wanted = new Set(draft.widgets.map(requestKey));
    controllers.current.forEach((controller, key) => {
      if (!wanted.has(key)) {
        controller.abort();
        cache.current.delete(key);
      }
    });
    pumpRef.current();
  }, [draft.widgets]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controllers.current.forEach((c) => c.abort());
      cache.current.clear();
    };
  }, []);
  const results = Object.fromEntries(
    draft.widgets.map((w) => [w.id, cache.current.get(requestKey(w)) || {}]),
  );
  useEffect(() => onResults(results), [revision, draft.widgets]);
  return <DashboardGrid widgets={draft.widgets} results={results} />;
}
