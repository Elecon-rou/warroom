import { DataSourcesContext, selectedSourceId } from './dataSources';
import { useQueryHistory } from './useQueryHistory';
import { Dashboards } from './Dashboards';
import { panelQuery } from './queryBuilders';
import { useEffect, useRef, useState } from 'react';
import { Link, Play, Plus, Square } from 'lucide-react';
import type { Kind, Source } from './types';
import { ExplorePanel } from './ExplorePanel';
import { Sidebar } from './Sidebar';
import { HistoryPage } from './HistoryPage';
import { SourcesPage } from './SourcesPage';
import { ServiceGraphView } from './ServiceGraph';
import { InvestigateView } from './Investigate';
import {
  queryName,
  type HistoryEntry,
  type Generation,
  type LLMConfig,
  type QueryOutput,
} from './explorer';
import {
  locationHash,
  readLocation,
  ranges,
  defaultGraphSettings,
  defaultInvestigateSettings,
  type ExplorerState,
  defaultPanel,
  patchPanel,
  type Page,
  type QueryPanel as QueryInput,
} from './state';

export function App() {
  const [location, setLocation] = useState(readLocation);
  const { page, explorer } = location;
  const rows = explorer.panels;
  const [sources, setSources] = useState<Source[]>([]);
  const services: string[] = [];
  const [sourceError, setSourceError] = useState('');
  const [generations, setGenerations] = useState<Record<string, Generation>>({});
  const [llmConfig, setLLMConfig] = useState<LLMConfig>({ configured: false, model: '' });
  const {
    history,
    error: historyError,
    record: recordHistory,
    clear: clearHistory,
    refresh: refreshHistory,
  } = useQueryHistory();
  const [outputs, setOutputs] = useState<Record<string, QueryOutput>>({});
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState('');
  const controllers = useRef(new Map<string, AbortController>());
  const runRef = useRef<() => void>(() => {});
  const copyTimer = useRef<number | undefined>(undefined);
  const pending = rows.some((row) => outputs[row.id]?.pending || generations[row.id]?.pending);
  const runnable = rows.filter(
    (row) =>
      row.enabled &&
      (row.inputMode === 'llm'
        ? row.prompt.trim()
        : !panelQuery(row).error && panelQuery(row).query.trim()),
  );

  function update(patch: Partial<ExplorerState>) {
    setLocation((old) => ({ ...old, explorer: { ...old.explorer, ...patch } }));
  }
  function stop(id?: string) {
    const ids = id ? [id] : [...controllers.current.keys()];
    ids.forEach((key) => {
      controllers.current.get(key)?.abort();
      controllers.current.delete(key);
    });
    setGenerations((old) => {
      const next = { ...old };
      ids.forEach((key) => {
        if (next[key]) next[key] = { ...next[key], pending: false };
      });
      return next;
    });
    setOutputs((old) => {
      const next = { ...old };
      ids.forEach((key) => {
        if (next[key]) next[key] = { ...next[key], pending: false };
      });
      return next;
    });
  }
  function navigate(nextPage: Page, nextState = explorer) {
    stop();
    if (nextPage === 'history') refreshHistory();
    setExpanded(false);
    window.history.pushState(null, '', locationHash(nextPage, nextState));
    setLocation({ page: nextPage, explorer: nextState });
  }
  function setRow(id: string, patch: Partial<QueryInput>) {
    if (
      patch.enabled === false ||
      patch.sourceId ||
      patch.kind ||
      patch.inputMode ||
      'prompt' in patch
    ) {
      stop(id);
      setOutputs((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      });
      setGenerations((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      });
    }
    setLocation((old) => ({
      ...old,
      explorer: {
        ...old.explorer,
        panels: old.explorer.panels.map((row) => (row.id === id ? patchPanel(row, patch) : row)),
      },
    }));
  }
  function addQuery(kind: Kind = rows.at(-1)?.kind || 'metrics', text = '', sourceId?: string) {
    if (rows.length >= 26) return;
    const next = {
      ...explorer,
      panels: [
        ...rows,
        {
          ...defaultPanel(crypto.randomUUID(), kind),
          text,
          sourceId: sourceId || selectedSourceId(sources, kind),
        },
      ],
    };
    if (page === 'explore') update(next);
    else navigate('explore', next);
  }
  function removeQuery(id: string) {
    stop(id);
    update({ panels: rows.filter((row) => row.id !== id) });
    setOutputs((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
  }

  // A panel owns one request at a time; ignore results from a superseded request.
  async function runOne(row: QueryInput, traceId?: string) {
    const { kind, inputMode, range, limit, step, customStart, customEnd } = row;
    if (
      page !== 'explore' ||
      !row.enabled ||
      (!traceId &&
        !(inputMode === 'llm'
          ? row.prompt.trim()
          : !panelQuery(row).error && panelQuery(row).query.trim()))
    )
      return;
    controllers.current.get(row.id)?.abort();
    const abortController = new AbortController();
    controllers.current.set(row.id, abortController);
    setOutputs((old) => ({ ...old, [row.id]: { pending: true, text: row.text } }));
    const end = range === 'custom' ? new Date(customEnd).getTime() / 1000 : Date.now() / 1000;
    const start =
      range === 'custom'
        ? new Date(customStart).getTime() / 1000
        : end - Number(ranges.find((r) => r[0] === range)?.[2] || 3600);
    try {
      const sourceId = selectedSourceId(sources, kind, row.sourceId);
      if (!sourceId) throw new Error('Select a configured data source.');
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
        throw new Error('Invalid time range.');
      const queryText =
        inputMode === 'llm' && !traceId
          ? await construct(row, abortController, start, end)
          : panelQuery(row).query;
      if (controllers.current.get(row.id) !== abortController) return;
      setOutputs((old) => ({ ...old, [row.id]: { pending: true, text: queryText } }));
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          sourceId,
          query: queryText,
          start,
          end,
          step: step === 'auto' ? 0 : Number(step),
          limit,
          demo: false,
          traceId,
        }),
        signal: abortController.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
      if (controllers.current.get(row.id) !== abortController) return;
      setOutputs((old) => ({
        ...old,
        [row.id]: { response: body, pending: false, text: queryText },
      }));
      if (!traceId) recordHistory(kind, queryText, sourceId);
    } catch (error) {
      if (
        controllers.current.get(row.id) === abortController &&
        (error as Error).name !== 'AbortError'
      )
        setOutputs((old) => ({
          ...old,
          [row.id]: { pending: false, error: (error as Error).message, text: row.text },
        }));
    } finally {
      if (controllers.current.get(row.id) === abortController) controllers.current.delete(row.id);
    }
  }
  async function construct(
    row: QueryInput,
    abortController: AbortController,
    start: number,
    end: number,
  ) {
    setGenerations((old) => ({ ...old, [row.id]: { pending: true } }));
    try {
      const response = await fetch('/api/llm/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: row.kind,
          sourceId: selectedSourceId(sources, row.kind, row.sourceId),
          prompt: row.prompt,
          start,
          end,
        }),
        signal: abortController.signal,
      });
      const body = await response.json();
      if (controllers.current.get(row.id) !== abortController)
        throw new DOMException('Cancelled', 'AbortError');
      setGenerations((old) => ({
        ...old,
        [row.id]: {
          pending: false,
          verdict: body.verdict,
          discovery: body.discovery,
          error: response.ok ? undefined : body.error,
        },
      }));
      if (!response.ok) throw new Error(body.error || 'Query generation failed.');
      if (body.verdict !== 'PASS' || typeof body.query !== 'string' || !body.query.trim())
        throw new Error('Invalid query generation response.');
      setRow(row.id, { text: body.query });
      return body.query as string;
    } catch (error) {
      if (
        controllers.current.get(row.id) === abortController &&
        (error as Error).name !== 'AbortError'
      )
        setGenerations((old) => ({
          ...old,
          [row.id]: { ...old[row.id], pending: false, error: (error as Error).message },
        }));
      throw error;
    }
  }
  async function generateOnly(row: QueryInput) {
    if (!row.enabled || !row.prompt.trim()) return;
    controllers.current.get(row.id)?.abort();
    const abortController = new AbortController();
    controllers.current.set(row.id, abortController);
    const end =
      row.range === 'custom' ? new Date(row.customEnd).getTime() / 1000 : Date.now() / 1000;
    const start =
      row.range === 'custom'
        ? new Date(row.customStart).getTime() / 1000
        : end - Number(ranges.find((r) => r[0] === row.range)?.[2] || 3600);
    try {
      await construct(row, abortController, start, end);
    } catch {
    } finally {
      if (controllers.current.get(row.id) === abortController) controllers.current.delete(row.id);
    }
  }
  function runAll() {
    runnable.forEach((row) => void runOne(row));
  }
  runRef.current = runAll;
  async function copyLink() {
    const url = new URL(window.location.href);
    url.hash = locationHash('explore', explorer);
    try {
      await navigator.clipboard.writeText(url.href);
      setCopied(true);
      setShareError('');
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setShareError('Copy the URL from the address bar.');
    }
  }
  function restore(h: HistoryEntry) {
    addQuery(h.kind, h.query, h.sourceId);
  }
  useEffect(() => {
    window.history.replaceState(null, '', locationHash(page, explorer));
  }, [page, explorer]);
  useEffect(() => {
    const onLocation = () => {
      stop();
      setExpanded(false);
      setLocation(readLocation());
    };
    window.addEventListener('popstate', onLocation);
    window.addEventListener('hashchange', onLocation);
    return () => {
      window.removeEventListener('popstate', onLocation);
      window.removeEventListener('hashchange', onLocation);
    };
  }, []);
  useEffect(() => {
    const abortController = new AbortController();
    fetch('/api/sources', { signal: abortController.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Could not load data sources.');
        return r.json();
      })
      .then(setSources)
      .catch((e) => {
        if (e.name !== 'AbortError') setSourceError(e.message);
      });
    fetch('/api/llm/config', { signal: abortController.signal })
      .then((r) => r.json())
      .then(setLLMConfig)
      .catch(() => {});
    return () => {
      abortController.abort();
      controllers.current.forEach((c) => c.abort());
      window.clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        runRef.current();
      }
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <DataSourcesContext.Provider value={sources}>
      <div className="app-shell">
        <Sidebar
          page={page}
          explorer={explorer}
          historyCount={history.length}
          sourceCount={sources.length}
          onNavigate={navigate}
        />
        <div className="main-shell">
          {/* Keep the chat mounted so page navigation preserves its conversation. */}
          <div hidden={page !== 'investigate'}>
            <InvestigateView
              settings={explorer.investigate || defaultInvestigateSettings()}
              onChange={(investigate) => update({ investigate })}
              onDashboard={(dashboard) => navigate('dashboards', { ...explorer, dashboard })}
            />
          </div>
          {page === 'investigate' ? null : page === 'dashboards' ? (
            <Dashboards
              value={explorer.dashboard}
              services={services}
              onChange={(dashboard) => update({ dashboard })}
            />
          ) : page === 'service-graph' ? (
            <ServiceGraphView
              settings={explorer.serviceGraph || defaultGraphSettings()}
              onChange={(serviceGraph) => update({ serviceGraph })}
              onExplore={(service) =>
                addQuery('traces', new URLSearchParams({ service }).toString())
              }
            />
          ) : page === 'explore' ? (
            <main className={expanded ? 'explore expanded' : 'explore'}>
              <div className="page-heading">
                <h1>
                  Explore<span className="heading-dot">.</span>
                </h1>
                <div className="page-actions">
                  <button className="subtle-button" onClick={copyLink}>
                    <Link size={14} />
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                  <button
                    className="run-button"
                    disabled={!pending && !runnable.length}
                    onClick={() => (pending ? stop() : runAll())}
                  >
                    {pending ? <Square size={13} /> : <Play size={13} />}{' '}
                    {pending ? 'Cancel all' : 'Run all'}
                  </button>
                </div>
              </div>
              {shareError && <p className="inline-error">{shareError}</p>}
              <div className="explorer-panels">
                {rows.map((row, index) => (
                  <ExplorePanel
                    key={row.id}
                    row={row}
                    name={queryName(index)}
                    sources={sources}
                    services={services}
                    generation={generations[row.id]}
                    llmConfig={llmConfig}
                    onGenerate={() => void generateOnly(row)}
                    output={outputs[row.id]}
                    removable={rows.length > 1}
                    expanded={expanded}
                    onChange={(patch) => setRow(row.id, patch)}
                    onRemove={() => removeQuery(row.id)}
                    onRun={() => void runOne(row)}
                    onCancel={() => stop(row.id)}
                    onExpand={() => setExpanded(!expanded)}
                    onTrace={(id) => void runOne(row, id)}
                  />
                ))}
              </div>
              <button
                className="subtle-button add-panel"
                onClick={() => addQuery()}
                disabled={rows.length >= 26}
              >
                <Plus size={15} />
                Add query
              </button>
            </main>
          ) : page === 'history' ? (
            <HistoryPage
              entries={history}
              onRestore={restore}
              onClear={clearHistory}
              error={historyError}
            />
          ) : (
            <SourcesPage
              sources={sources}
              error={sourceError}
              onExplore={(source) => addQuery(source.kind, '', source.id)}
            />
          )}
        </div>
      </div>
    </DataSourcesContext.Provider>
  );
}
