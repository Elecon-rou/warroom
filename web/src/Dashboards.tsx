import { useDataSources, selectedSourceId } from './dataSources';
import { transferPreviewResults } from './dashboardResults';
import { DashboardGrid } from './DashboardGrid';
import { DashboardLivePreview } from './DashboardLivePreview';
import {
  mergeWidgetEvent,
  type LiveWidgetState,
  readDashboardGeneration,
  generationTime,
  type DashboardProgress,
} from './dashboardGeneration';
import { DashboardAttachments } from './DashboardAttachments';
import type { DashboardAttachment } from './dashboardReferenceFiles';
import { useEffect, useRef, useState } from 'react';
import { Download, Link, Play, Plus, RefreshCw, Square } from 'lucide-react';
import { DashboardEditor } from './DashboardEditor';
import { type WidgetResult } from './DashboardWidgetView';
import {
  newDashboard,
  newWidget,
  parseDashboard,
  type Dashboard,
  type DashboardWidget,
} from './dashboard';

type Props = { value?: Dashboard; services: string[]; onChange: (value: Dashboard) => void };
export function Dashboards({ value, services, onChange }: Props) {
  const sources = useDataSources();
  const [fallback] = useState(newDashboard);
  const [deployed, setDeployed] = useState<Dashboard[]>([]);
  const [catalogErrors, setCatalogErrors] = useState<string[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const catalogRequest = useRef<AbortController | null>(null);
  const selectedDeployment = deployed.find((d) => d.id === value?.id);
  const dashboard = value || fallback;
  async function reloadDashboards() {
    catalogRequest.current?.abort();
    const request = new AbortController();
    catalogRequest.current = request;
    setCatalogLoading(true);
    try {
      const response = await fetch('/api/dashboards', {
        signal: request.signal,
        cache: 'no-store',
      });
      const catalog = await response.json();
      if (!response.ok) throw new Error(catalog.error || 'Cannot load deployed dashboards.');
      const dashboards = catalog.dashboards.map((d: unknown) => parseDashboard(d));
      if (catalogRequest.current === request) {
        setDeployed(dashboards);
        setCatalogErrors(catalog.errors || []);
      }
    } catch (e) {
      if (catalogRequest.current === request && (e as Error).name !== 'AbortError')
        setCatalogErrors([(e as Error).message]);
    } finally {
      if (catalogRequest.current === request) setCatalogLoading(false);
    }
  }
  useEffect(() => {
    void reloadDashboards();
    return () => catalogRequest.current?.abort();
  }, []);
  const [mode, setMode] = useState<'visual' | 'json' | 'llm'>('visual');
  const [json, setJSON] = useState('');
  const [editing, setEditing] = useState<DashboardWidget | null>(null);
  const [results, setResults] = useState<Record<string, WidgetResult>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [prompt, setPrompt] = useState('');
  const [attachmentReading, setAttachmentReading] = useState(false);
  const [attachments, setAttachments] = useState<DashboardAttachment[]>([]);
  const [generating, setGenerating] = useState(false);
  const [liveDraft, setLiveDraft] = useState<Dashboard | null>(null);
  const [generationWindow, setGenerationWindow] = useState({ start: 0, end: 0 });
  const previewResults = useRef<Record<string, WidgetResult>>({});
  const previewRevision = useRef<LiveWidgetState>({ revision: 0, widgets: {} });
  const [generationOutcome, setGenerationOutcome] = useState<
    'success' | 'error' | 'cancelled' | null
  >(null);
  const [generationEvents, setGenerationEvents] = useState<DashboardProgress[]>([]);
  const [generationElapsed, setGenerationElapsed] = useState(0);
  const generationStarted = useRef(0);
  const [audit, setAudit] = useState<{
    verdict?: string;
    discovery?: { tool: string; error?: string }[];
  }>({});
  const [running, setRunning] = useState(false);
  const active = useRef<AbortController | null>(null);
  const generation = useRef<AbortController | null>(null);
  const runRef = useRef<(ids?: string[]) => void>(() => {});
  const queryKeys = useRef<Record<string, string>>({});
  const runAfterApply = useRef<string[] | null>(null);
  const appliedResults = useRef<Record<string, WidgetResult> | null>(null);
  const signature = JSON.stringify(dashboard);
  useEffect(() => {
    if (!generating) return;
    const timer = window.setInterval(
      () => setGenerationElapsed(Date.now() - generationStarted.current),
      1000,
    );
    return () => clearInterval(timer);
  }, [generating]);
  useEffect(() => {
    onChange(dashboard);
  }, []);
  useEffect(() => {
    const keys = Object.fromEntries(
      dashboard.widgets.map((w) => [
        w.id,
        JSON.stringify([w.type === 'force-graph', w.source, w.sourceId, w.query, dashboard.range]),
      ]),
    );
    const previous = queryKeys.current,
      transferred = appliedResults.current;
    const same =
      Object.keys(previous).length === Object.keys(keys).length &&
      Object.entries(keys).every(([id, key]) => previous[id] === key);
    queryKeys.current = keys;
    if (same && !transferred) return;
    active.current?.abort();
    setRunning(false);
    setResults((old) =>
      Object.fromEntries(
        dashboard.widgets.flatMap((w) => {
          const result =
            transferred?.[w.id] || (previous[w.id] === keys[w.id] ? old[w.id] : undefined);
          return result && !result.pending ? [[w.id, result]] : [];
        }),
      ),
    );
    appliedResults.current = null;
    const ids = runAfterApply.current;
    runAfterApply.current = null;
    if (ids?.length) {
      const timer = window.setTimeout(() => runRef.current(ids), 0);
      return () => clearTimeout(timer);
    }
  }, [signature]);
  useEffect(
    () => () => {
      active.current?.abort();
      generation.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!dashboard.refresh || liveDraft || generating) return;
    const timer = window.setInterval(() => runRef.current(), dashboard.refresh * 1000);
    return () => clearInterval(timer);
  }, [dashboard.refresh, !!liveDraft, generating]);
  useEffect(() => {
    if (!editing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEditing(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [!!editing]);
  function transferDraft(next: Dashboard) {
    if (!liveDraft) return;
    const transferred = transferPreviewResults(liveDraft, next, previewResults.current);
    appliedResults.current = transferred.results;
    runAfterApply.current = transferred.missing;
  }
  function apply(next: Dashboard) {
    try {
      const valid = parseDashboard(next);
      setError('');
      setNotice('');
      onChange(valid);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function stop() {
    active.current?.abort();
    active.current = null;
    setRunning(false);
    setResults((old) =>
      Object.fromEntries(Object.entries(old).map(([id, r]) => [id, { ...r, pending: false }])),
    );
  }
  async function run(ids?: string[]) {
    if (running) return;
    try {
      parseDashboard(dashboard);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    setError('');
    const end = Math.floor(Date.now() / 1000),
      start = end - dashboard.range;
    const targets = ids ? dashboard.widgets.filter((w) => ids.includes(w.id)) : dashboard.widgets;
    setResults((old) => ({
      ...old,
      ...Object.fromEntries(targets.map((w) => [w.id, { pending: true }])),
    }));
    const queue = [...targets];
    // Bound concurrency; the server continues to enforce source and query limits.
    async function worker() {
      while (queue.length && !controller.signal.aborted) {
        const w = queue.shift()!;
        try {
          if (w.type !== 'force-graph' && !w.query.trim()) throw new Error('Query required.');
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
                    start,
                    end,
                  }
                : {
                    kind: w.source,
                    sourceId: selectedSourceId(sources, w.source, w.sourceId),
                    query: w.query,
                    start,
                    end,
                    limit: 100,
                    step: 0,
                  },
            ),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Query failed.');
          if (!controller.signal.aborted)
            setResults((old) => ({
              ...old,
              [w.id]: { [graph ? 'graph' : 'response']: data, updated: Date.now() },
            }));
        } catch (e) {
          if (!controller.signal.aborted)
            setResults((old) => ({ ...old, [w.id]: { error: (e as Error).message } }));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    if (active.current === controller) {
      active.current = null;
      setRunning(false);
    }
  }
  runRef.current = (ids) => {
    void run(ids);
  };
  function exportJSON() {
    try {
      const valid = parseDashboard(liveDraft || dashboard);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(valid, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dashboard.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function move(id: string, delta: number) {
    const list = [...dashboard.widgets],
      i = list.findIndex((w) => w.id === id),
      j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    apply({ ...dashboard, widgets: list });
  }
  async function generate() {
    generation.current?.abort();
    stop();
    const c = new AbortController();
    generation.current = c;
    setGenerating(true);
    setGenerationOutcome(null);
    setLiveDraft(null);
    setEditing(null);
    previewResults.current = {};
    previewRevision.current = { revision: 0, widgets: {} };
    generationStarted.current = Date.now();
    setGenerationElapsed(0);
    setGenerationEvents([
      {
        type: 'progress',
        phase: 'upload',
        message: 'Submitting prompt and attachments',
        elapsedMs: 0,
      },
    ]);
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      c.abort();
    }, 330000);
    setError('');
    setNotice('');
    setAudit({});
    const end = Math.floor(Date.now() / 1000);
    const start = end - dashboard.range;
    setGenerationWindow({ start, end });
    const draftId = dashboard.widgets.length ? dashboard.id : crypto.randomUUID();
    try {
      const res = await fetch('/api/dashboards/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        signal: c.signal,
        body: JSON.stringify({
          prompt,
          attachments,
          dashboard: dashboard.widgets.length ? dashboard : undefined,
          start: end - dashboard.range,
          end,
        }),
      });
      const { data, status } = await readDashboardGeneration(
        res,
        (event) => {
          if (generation.current === c && !c.signal.aborted)
            setGenerationEvents((old) => [...old, event].slice(-24));
        },
        (event) => {
          if (generation.current !== c || c.signal.aborted) return;
          const next = mergeWidgetEvent(previewRevision.current, event);
          if (next === previewRevision.current) return;
          previewRevision.current = next;
          setLiveDraft({
            version: 1,
            id: draftId,
            title: 'Generated dashboard',
            range: end - start,
            refresh: 0,
            widgets: Object.entries(next.widgets)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([, widget]) => widget),
          });
        },
      );
      if (c.signal.aborted) return;
      setAudit({ verdict: data.verdict, discovery: data.discovery });
      if (status >= 400) throw new Error(data.error || 'Dashboard generation failed.');
      const draft = parseDashboard(data.dashboard);
      setJSON(JSON.stringify(draft, null, 2));
      setLiveDraft(draft);
      setMode('llm');
      setNotice('Review the draft, then export JSON.');
      setGenerationOutcome('success');
    } catch (e) {
      setGenerationOutcome(c.signal.aborted && !timedOut ? 'cancelled' : 'error');
      if (timedOut)
        setError('Dashboard generation exceeded its time limit. Narrow the request or try again.');
      else if (!c.signal.aborted) setError((e as Error).message);
      else setNotice('Generation cancelled.');
    } finally {
      window.clearTimeout(timeout);
      if (generation.current === c) {
        setGenerating(false);
        generation.current = null;
      }
    }
  }
  return (
    <main className="explore dashboards">
      <div className="page-heading">
        <h1>
          Dashboards<span className="heading-dot">.</span>
        </h1>
        <div className="page-actions">
          <button
            className="subtle-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                setNotice('Link copied.');
              } catch {
                setError('Unable to copy link.');
              }
            }}
          >
            <Link size={14} />
            Copy link
          </button>
          <button className="subtle-button" onClick={exportJSON} disabled={generating}>
            <Download size={14} />
            Export JSON
          </button>
          <button
            className="run-button"
            disabled={!!liveDraft || !dashboard.widgets.length}
            onClick={() => (running ? stop() : void run())}
          >
            {running ? <Square size={13} /> : <Play size={13} />} {running ? 'Cancel' : 'Run'}
          </button>
        </div>
      </div>
      <div className={`dashboard-workspace${editing ? ' is-editing' : ''}`}>
        <div className="dashboard-canvas">
          <div className="dashboard-toolbar">
            <select
              aria-label="Deployed dashboards"
              value={deployed.some((d) => d.id === dashboard.id) ? dashboard.id : ''}
              onChange={(e) => {
                const next = deployed.find((d) => d.id === e.target.value);
                if (next) {
                  generation.current?.abort();
                  setLiveDraft(null);
                  apply(next);
                  setEditing(null);
                  setMode('visual');
                }
              }}
            >
              <option value="" disabled>
                Deployed dashboards
              </option>
              {deployed.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
            <button
              className="subtle-button"
              disabled={catalogLoading}
              onClick={() => void reloadDashboards()}
              aria-label="Reload deployed dashboards"
            >
              <RefreshCw size={14} />
            </button>
            {selectedDeployment && (
              <>
                <span className="dashboard-note">Editing draft · deployed file unchanged</span>
                <button
                  className="subtle-button"
                  onClick={() => {
                    generation.current?.abort();
                    setLiveDraft(null);
                    setEditing(null);
                    apply(selectedDeployment);
                    setMode('visual');
                  }}
                >
                  Reset to deployed
                </button>
              </>
            )}
            <button
              className="subtle-button"
              onClick={() => {
                generation.current?.abort();
                setLiveDraft(null);
                apply(newDashboard());
                setEditing(null);
                setMode('visual');
              }}
            >
              New
            </button>
            <button
              className="subtle-button"
              onClick={() =>
                apply({
                  ...dashboard,
                  widgets: dashboard.widgets.map((w) => ({
                    ...w,
                    width: ['logs', 'table', 'force-graph'].includes(w.type) ? 3 : 1,
                  })),
                })
              }
              disabled={!!liveDraft}
            >
              Auto layout
            </button>
            <input
              aria-label="Dashboard title"
              value={dashboard.title}
              maxLength={160}
              onChange={(e) => onChange({ ...dashboard, title: e.target.value })}
            />
            <select
              aria-label="Dashboard time range"
              value={dashboard.range}
              onChange={(e) => apply({ ...dashboard, range: Number(e.target.value) })}
            >
              {[
                [300, '5 minutes'],
                [900, '15 minutes'],
                [3600, '1 hour'],
                [21600, '6 hours'],
                [86400, '24 hours'],
                [604800, '7 days'],
                ...([300, 900, 3600, 21600, 86400, 604800].includes(dashboard.range)
                  ? []
                  : [[dashboard.range, `${dashboard.range} seconds`]]),
              ].map(([seconds, label]) => (
                <option key={seconds} value={seconds}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="Dashboard refresh"
              value={dashboard.refresh}
              onChange={(e) => apply({ ...dashboard, refresh: Number(e.target.value) })}
            >
              {[0, 15, 30, 60, 300].map((n) => (
                <option key={n} value={n}>
                  {n ? `${n}s` : 'Refresh off'}
                </option>
              ))}
            </select>
          </div>
          <div className="dashboard-modes" role="group" aria-label="Dashboard construction">
            {(['visual', 'json', 'llm'] as const).map((m) => (
              <button
                key={m}
                className={mode === m ? 'selected' : ''}
                onClick={() => {
                  if (m === 'json' && mode !== 'json' && (mode === 'visual' || !json.trim()))
                    setJSON(JSON.stringify(dashboard, null, 2));
                  setMode(m);
                  setError('');
                }}
              >
                {m === 'visual' ? 'Manual' : m.toUpperCase()}
              </button>
            ))}
          </div>
          {catalogErrors.map((message, index) => (
            <p className="inline-error" role="status" key={index}>
              {message}
            </p>
          ))}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="dashboard-note" role="status">
              {notice}
            </p>
          )}
          {mode === 'llm' && (
            <section className="dashboard-editor">
              <DashboardAttachments
                files={attachments}
                disabled={generating}
                onChange={(files) => {
                  setAttachments(files);
                  setAudit({});
                }}
                onError={setError}
                onBusyChange={setAttachmentReading}
              >
                <label htmlFor="dashboard-prompt">Dashboard prompt</label>
                <textarea
                  id="dashboard-prompt"
                  disabled={generating}
                  value={prompt}
                  maxLength={8000}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    setAudit({});
                  }}
                />
              </DashboardAttachments>
              <div className="dashboard-editor-heading">
                <span className="dashboard-note">
                  Infrastructure, business, and issue topics. Semantic filter runs before discovery.
                </span>
                <button
                  className="run-button"
                  disabled={
                    attachmentReading || (!generating && !prompt.trim() && !attachments.length)
                  }
                  onClick={() => (generating ? generation.current?.abort() : void generate())}
                >
                  {generating
                    ? 'Cancel'
                    : dashboard.widgets.length
                      ? 'Revise dashboard'
                      : 'Generate'}
                </button>
              </div>
            </section>
          )}
          {generationEvents.length > 0 && (
            <details className="dashboard-generation-status" open={generating ? undefined : false}>
              <summary>
                <span role="status" aria-live="polite">
                  {generating
                    ? generationEvents.at(-1)?.message
                    : generationOutcome === 'error'
                      ? 'Generation stopped'
                      : generationOutcome === 'cancelled'
                        ? 'Generation cancelled'
                        : 'Generation finished'}
                </span>
                <small>{generationTime(generationElapsed)}</small>
              </summary>
              <ol>
                {generationEvents.map((event, index) => (
                  <li key={index}>
                    <time>{generationTime(event.elapsedMs)}</time>
                    {event.message}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {audit.verdict && (
            <details className="dashboard-audit">
              <summary>
                Semantic filter: {audit.verdict} · {audit.discovery?.length || 0} discovery calls
              </summary>
              {audit.discovery?.map((call, i) => (
                <p key={i}>
                  {call.tool}
                  {call.error ? `: ${call.error}` : ''}
                </p>
              ))}
            </details>
          )}
          {mode === 'json' && (
            <section className="dashboard-editor">
              <label htmlFor="dashboard-json">Dashboard JSON</label>
              <textarea
                id="dashboard-json"
                className="dashboard-code dashboard-json"
                value={json}
                spellCheck={false}
                onChange={(e) => setJSON(e.target.value)}
              />
              <div className="dashboard-editor-heading">
                <label className="dashboard-import">
                  Import file
                  <input
                    type="file"
                    accept="application/json,.json"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 512000) {
                        setError('JSON file is too large.');
                        return;
                      }
                      setJSON(await file.text());
                    }}
                  />
                </label>
                <button
                  className="run-button"
                  onClick={() => {
                    try {
                      const next = parseDashboard(JSON.parse(json));
                      if (liveDraft?.id === next.id) transferDraft(next);
                      apply(next);
                      setLiveDraft(null);
                      setEditing(null);
                      setMode('visual');
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Apply JSON
                </button>
              </div>
            </section>
          )}
          {liveDraft && (
            <section className="dashboard-live-draft" aria-label="Generated dashboard preview">
              <div className="dashboard-draft-toolbar">
                <strong>
                  {generating ? 'Generating draft' : 'Generated draft'} · {liveDraft.widgets.length}{' '}
                  widgets
                </strong>
                <span className="dashboard-draft-note">
                  {generating
                    ? 'Widgets appear as they are completed.'
                    : 'Not applied to the current dashboard.'}
                </span>
                <button
                  className="subtle-button"
                  disabled={generating}
                  onClick={() => {
                    setJSON(JSON.stringify(liveDraft, null, 2));
                    setMode('json');
                  }}
                >
                  Review JSON
                </button>
                <button
                  className="run-button"
                  disabled={generating || !liveDraft.widgets.length}
                  onClick={() => {
                    try {
                      const next = parseDashboard(liveDraft);
                      transferDraft(next);
                      apply(next);
                      setLiveDraft(null);
                      setMode('visual');
                    } catch (error) {
                      setError((error as Error).message);
                    }
                  }}
                >
                  Apply dashboard
                </button>
                <button
                  className="subtle-button"
                  disabled={generating}
                  onClick={() => setLiveDraft(null)}
                >
                  Discard
                </button>
              </div>
              <DashboardLivePreview
                key={`${generationWindow.start}-${generationWindow.end}`}
                draft={liveDraft}
                window={generationWindow}
                onResults={(results) => {
                  previewResults.current = results;
                }}
              />
            </section>
          )}
          {!liveDraft && (
            <DashboardGrid
              widgets={dashboard.widgets}
              results={results}
              controls={{
                selectedId: editing?.id,
                onMove: move,
                onDuplicate: (w) =>
                  apply({
                    ...dashboard,
                    widgets: [
                      ...dashboard.widgets,
                      { ...w, id: crypto.randomUUID(), title: w.title + ' copy' },
                    ],
                  }),
                onEdit: (w) => {
                  setMode('visual');
                  setEditing({ ...w });
                },
                onRemove: (id) => {
                  apply({
                    ...dashboard,
                    widgets: dashboard.widgets.filter((w) => w.id !== id),
                  });
                  if (editing?.id === id) setEditing(null);
                },
              }}
            />
          )}
          {mode === 'visual' && !liveDraft && (
            <button
              className="subtle-button add-panel"
              disabled={dashboard.widgets.length >= 24 || !!editing}
              onClick={() =>
                setEditing({
                  ...newWidget(),
                  source: sources[0]?.kind || 'metrics',
                  sourceId: sources[0]?.id,
                })
              }
            >
              <Plus size={14} />
              Add widget
            </button>
          )}
        </div>
        {editing && (
          <aside className="dashboard-inspector" aria-label="Widget settings">
            <DashboardEditor
              key={`${editing.id}-${editing.source}-${editing.sourceId}`}
              widget={editing}
              services={services}
              onChange={setEditing}
              onCancel={() => setEditing(null)}
              onDone={() => {
                try {
                  const next = parseDashboard({
                    ...dashboard,
                    widgets: dashboard.widgets.some((w) => w.id === editing.id)
                      ? dashboard.widgets.map((w) => (w.id === editing.id ? editing : w))
                      : [...dashboard.widgets, editing],
                  });
                  apply(next);
                  setEditing(null);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
          </aside>
        )}
      </div>
    </main>
  );
}
