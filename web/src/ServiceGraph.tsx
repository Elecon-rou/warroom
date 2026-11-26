import { useDataSources, selectedSourceId } from './dataSources';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Clock3,
  Copy,
  Focus,
  GitBranch,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Table2,
  X,
} from 'lucide-react';
import { short } from './types';
import { treeLayout } from './tree';
import { ranges, localDateTime, inputDateTime, type GraphSettings } from './state';
export type GraphNode = { id: string; kind: string };
export type GraphEdge = {
  source: string;
  target: string;
  calls?: number;
  rps?: number;
  errorRatio?: number;
  meanMs?: number;
  p95Ms?: number;
  traceCalls?: number;
  sampleCalls?: number;
  sampleErrors?: number;
  sampleMeanMs?: number;
  origins: string[];
};
type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
  sampledTraces: number;
  start: number;
  end: number;
};
type Point = { x: number; y: number };
function edgeLabel(edge: GraphEdge, metric: GraphSettings['metric']): string {
  if (metric === 'rps')
    return edge.rps !== undefined
      ? `${short(edge.rps)} req/s`
      : edge.traceCalls !== undefined
        ? `${short(edge.traceCalls)} calls`
        : `${edge.sampleCalls || 0} sampled`;
  if (metric === 'errors')
    return edge.errorRatio !== undefined ? `${(edge.errorRatio * 100).toFixed(1)}% errors` : '—';
  if (metric === 'latency')
    return edge.p95Ms !== undefined
      ? `p95 ${short(edge.p95Ms)} ms`
      : edge.meanMs !== undefined
        ? `avg ${short(edge.meanMs)} ms`
        : edge.sampleMeanMs !== undefined
          ? `sample avg ${short(edge.sampleMeanMs)} ms`
          : '—';
  return edge.calls !== undefined
    ? `${short(edge.calls)} calls`
    : edge.traceCalls !== undefined
      ? `${short(edge.traceCalls)} calls`
      : `${edge.sampleCalls || 0} sampled`;
}
type ServiceGraphViewProps = {
  settings: GraphSettings;
  onChange: (settings: GraphSettings) => void;
  onExplore: (service: string) => void;
};

export function ServiceGraphView({ settings, onChange, onExplore }: ServiceGraphViewProps) {
  const sources = useDataSources();
  const [data, setData] = useState<GraphData | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [copied, setCopied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const runRef = useRef<() => void>(() => {});
  const busy = useRef(false);
  const svg = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{
    node?: string;
    x: number;
    y: number;
    point?: Point;
    camera: { x: number; y: number; zoom: number };
  } | null>(null);
  const dimensions = useRef({ width: 1100, height: 640 });
  busy.current = pending;
  function update(patch: Partial<GraphSettings>) {
    onChange({ ...settings, ...patch });
  }
  async function run() {
    controller.current?.abort();
    const abortController = new AbortController();
    controller.current = abortController;
    setPending(true);
    setError('');
    const end =
      settings.range === 'custom' ? Date.parse(settings.customEnd) / 1000 : Date.now() / 1000;
    const start =
      settings.range === 'custom'
        ? Date.parse(settings.customStart) / 1000
        : end - Number(ranges.find((r) => r[0] === settings.range)?.[2] || 3600);
    try {
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        throw new Error('Invalid time range.');
      const response = await fetch('/api/service-graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start,
          end,
          source: settings.source,
          metricsSourceId: selectedSourceId(sources, 'metrics', settings.metricsSourceId),
          tracesSourceId: selectedSourceId(sources, 'traces', settings.tracesSourceId),
        }),
        signal: abortController.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Service graph request failed.');
      if (controller.current !== abortController) return;
      setData(body);
      setSelected(null);
      setSelectedEdge(null);
      setCamera({ x: 0, y: 0, zoom: 1 });
    } catch (err) {
      if (controller.current === abortController && (err as Error).name !== 'AbortError')
        setError((err as Error).message);
    } finally {
      if (controller.current === abortController) setPending(false);
    }
  }
  runRef.current = () => void run();
  useEffect(() => {
    runRef.current();
    return () => controller.current?.abort();
  }, [sources.map((s) => s.id).join(',')]);
  useEffect(() => {
    if (!settings.refresh) return;
    const timer = window.setInterval(() => {
      if (!busy.current) runRef.current();
    }, settings.refresh * 1000);
    return () => clearInterval(timer);
  }, [settings.refresh]);
  useEffect(() => {
    if (data) {
      const tree = treeLayout(
        data.nodes.map((node) => node.id),
        data.edges,
      );
      dimensions.current = { width: tree.width, height: tree.height };
      setPositions(tree.positions);
    }
  }, [data]);
  function relayout() {
    if (data) {
      const tree = treeLayout(
        data.nodes.map((node) => node.id),
        data.edges,
      );
      dimensions.current = { width: tree.width, height: tree.height };
      setPositions(tree.positions);
      setCamera({ x: 0, y: 0, zoom: 1 });
    }
  }
  function releaseDrag() {
    drag.current = null;
  }
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setCamera((c) => ({
        ...c,
        zoom: Math.max(0.35, Math.min(3, c.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08))),
      }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [data, settings.view]);
  const filtered = useMemo(() => {
    const matched = new Set(
      (data?.nodes || [])
        .filter((n) => n.id.toLowerCase().includes(settings.search.toLowerCase()))
        .map((n) => n.id),
    );
    const edges = (data?.edges || []).filter((e) => matched.has(e.source) || matched.has(e.target));
    const ids = new Set(edges.flatMap((e) => [e.source, e.target]));
    matched.forEach((id) => ids.add(id));
    return { nodes: (data?.nodes || []).filter((n) => ids.has(n.id)), edges };
  }, [data, settings.search]);
  const connected = new Set(
    selected
      ? [
          selected,
          ...filtered.edges
            .filter((e) => e.source === selected || e.target === selected)
            .flatMap((e) => [e.source, e.target]),
        ]
      : filtered.nodes.map((n) => n.id),
  );
  const related = (data?.edges || []).filter((e) => e.source === selected || e.target === selected);
  function nodeRPS(id: string) {
    const incoming = (data?.edges || []).filter((e) => e.target === id && e.rps !== undefined);
    return incoming.length ? incoming.reduce((sum, e) => sum + (e.rps || 0), 0) : undefined;
  }
  function nodeError(id: string) {
    const incoming = (data?.edges || []).filter(
      (e) => e.target === id && e.calls !== undefined && e.errorRatio !== undefined,
    );
    const calls = incoming.reduce((n, e) => n + (e.calls || 0), 0);
    return calls
      ? incoming.reduce((n, e) => n + (e.calls || 0) * (e.errorRatio || 0), 0) / calls
      : undefined;
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copy the URL from the address bar.');
    }
  }
  const changeZoom = (factor: number) =>
    setCamera((c) => ({ ...c, zoom: Math.max(0.35, Math.min(3, c.zoom * factor)) }));
  return (
    <main className="explore graph-page">
      <div className="page-heading">
        <h1>
          Service graph<span className="heading-dot">.</span>
        </h1>
        <button className="subtle-button" onClick={copy}>
          <Copy size={14} />
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <div className="graph-controls">
        <div className="range-selector">
          <Clock3 size={14} />
          <select
            aria-label="Service graph time range"
            value={settings.range}
            onChange={(e) => update({ range: e.target.value })}
          >
            {ranges.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
            <option value="custom">Custom range</option>
          </select>
        </div>
        {(['metrics', 'traces'] as const)
          .filter((kind) => settings.source === 'combined' || settings.source === kind)
          .map((kind) => (
            <select
              key={kind}
              aria-label={`${kind} graph data source`}
              value={
                selectedSourceId(
                  sources,
                  kind,
                  kind === 'metrics' ? settings.metricsSourceId : settings.tracesSourceId,
                ) || ''
              }
              onChange={(e) =>
                update(
                  kind === 'metrics'
                    ? { metricsSourceId: e.target.value }
                    : { tracesSourceId: e.target.value },
                )
              }
            >
              <option value="" disabled>
                Select {kind} source
              </option>
              {sources
                .filter((s) => s.kind === kind)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          ))}
        <select
          aria-label="Service graph sources"
          value={settings.source}
          onChange={(e) => update({ source: e.target.value as GraphSettings['source'] })}
        >
          <option value="combined">Metrics + traces</option>
          <option value="metrics">Metrics</option>
          <option value="traces">Traces</option>
        </select>
        <select
          aria-label="Service graph refresh"
          value={settings.refresh}
          onChange={(e) => update({ refresh: Number(e.target.value) })}
        >
          <option value={0}>Refresh off</option>
          {[15, 30, 60, 300].map((n) => (
            <option key={n} value={n}>
              Every {n}s
            </option>
          ))}
        </select>
        <button className="run-button" onClick={() => void run()}>
          {pending ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Refresh
        </button>
      </div>
      {settings.range === 'custom' && (
        <div className="custom-range">
          <label>
            From
            <input
              aria-label="Graph range start"
              type="datetime-local"
              value={localDateTime(settings.customStart)}
              onChange={(e) => update({ customStart: inputDateTime(e.target.value) })}
            />
          </label>
          <label>
            To
            <input
              aria-label="Graph range end"
              type="datetime-local"
              value={localDateTime(settings.customEnd)}
              onChange={(e) => update({ customEnd: inputDateTime(e.target.value) })}
            />
          </label>
        </div>
      )}
      {error && <p className="inline-error">{error}</p>}
      <section className="graph-panel" aria-busy={pending}>
        <div className="graph-toolbar">
          <div className="search-input">
            <Search size={14} />
            <input
              aria-label="Search services"
              placeholder="Filter services"
              value={settings.search}
              onChange={(e) => update({ search: e.target.value })}
            />
          </div>
          <span className="graph-count">
            {filtered.nodes.length} services · {filtered.edges.length} connections
          </span>
          <select
            aria-label="Graph edge statistic"
            value={settings.metric}
            onChange={(e) => update({ metric: e.target.value as GraphSettings['metric'] })}
          >
            <option value="rps">Average request rate</option>
            <option value="errors">Error rate</option>
            <option value="latency">Latency</option>
            <option value="calls">Calls</option>
          </select>
          <div className="segmented">
            <button
              className={settings.view === 'graph' ? 'selected' : ''}
              onClick={() => update({ view: 'graph' })}
            >
              <GitBranch size={14} />
              Graph
            </button>
            <button
              className={settings.view === 'table' ? 'selected' : ''}
              onClick={() => update({ view: 'table' })}
            >
              <Table2 size={14} />
              Table
            </button>
          </div>
        </div>
        {data && filtered.nodes.length > 0 ? (
          settings.view === 'graph' ? (
            <div className="graph-canvas">
              <div className="graph-zoom">
                <button aria-label="Reset tree layout" onClick={relayout}>
                  <RotateCcw size={16} />
                </button>
                <button aria-label="Zoom in" onClick={() => changeZoom(1.2)}>
                  <Plus size={16} />
                </button>
                <button aria-label="Zoom out" onClick={() => changeZoom(1 / 1.2)}>
                  <Minus size={16} />
                </button>
                <button aria-label="Fit graph" onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}>
                  <Focus size={16} />
                </button>
              </div>
              <svg
                ref={svg}
                viewBox={`0 0 ${dimensions.current.width} ${dimensions.current.height}`}
                role="img"
                aria-label="Service dependency graph"
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  drag.current = { x: e.clientX, y: e.clientY, camera };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d || !svg.current) return;
                  const box = svg.current.getBoundingClientRect();
                  const dx = ((e.clientX - d.x) * dimensions.current.width) / box.width;
                  const dy = ((e.clientY - d.y) * dimensions.current.width) / box.width;
                  if (d.node && d.point) {
                    const point = {
                      x: d.point.x + dx / camera.zoom,
                      y: d.point.y + dy / camera.zoom,
                    };
                    setPositions((old) => ({ ...old, [d.node!]: point }));
                  } else setCamera({ ...d.camera, x: d.camera.x + dx, y: d.camera.y + dy });
                }}
                onPointerUp={releaseDrag}
                onPointerCancel={releaseDrag}
              >
                <defs>
                  <marker
                    id="graph-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="5"
                    markerHeight="5"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
                  </marker>
                </defs>
                <g
                  transform={`translate(${camera.x + (dimensions.current.width / 2) * (1 - camera.zoom)} ${camera.y + (dimensions.current.height / 2) * (1 - camera.zoom)}) scale(${camera.zoom})`}
                >
                  {filtered.edges.map((edge, index) => {
                    const a = positions[edge.source];
                    const b = positions[edge.target];
                    if (!a || !b) return null;
                    const forward = b.x > a.x + 50;
                    const side = edge.source.localeCompare(edge.target) < 0 ? 1 : -1;
                    const sx = a.x + (forward ? 32 : side * 32);
                    const sy = a.y;
                    const tx = b.x + (forward ? -38 : side * 38);
                    const ty = b.y;
                    const mx = forward ? (sx + tx) / 2 : a.x + side * 115;
                    const my = (sy + ty) / 2;
                    const path = `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
                    const color = (edge.errorRatio || 0) > 0.05 ? '#f28d94' : '#3e8f85';
                    return (
                      <g
                        key={index}
                        className="graph-edge"
                        opacity={
                          !selected || edge.source === selected || edge.target === selected
                            ? 1
                            : 0.15
                        }
                        role="button"
                        tabIndex={0}
                        aria-label={`${edge.source} to ${edge.target}`}
                        onClick={() => {
                          setSelectedEdge(edge);
                          setSelected(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setSelectedEdge(edge);
                            setSelected(null);
                          }
                        }}
                      >
                        <path
                          d={path}
                          fill="none"
                          stroke={color}
                          strokeWidth={Math.min(5, 1.4 + Math.log10(1 + (edge.rps || 0)))}
                          markerEnd="url(#graph-arrow)"
                        />
                        <path d={path} fill="none" stroke="transparent" strokeWidth="16" />
                        <text x={mx} y={my - 6} textAnchor="middle">
                          {edgeLabel(edge, settings.metric)}
                        </text>
                      </g>
                    );
                  })}
                  {filtered.nodes.map((node) => {
                    const p = positions[node.id];
                    if (!p) return null;
                    const error = nodeError(node.id);
                    const rps = nodeRPS(node.id);
                    return (
                      <g
                        key={node.id}
                        transform={`translate(${p.x} ${p.y})`}
                        className="graph-node"
                        opacity={connected.has(node.id) ? 1 : 0.25}
                        role="button"
                        tabIndex={0}
                        aria-label={`Service ${node.id}`}
                        onClick={() => {
                          setSelected(node.id === selected ? null : node.id);
                          setSelectedEdge(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            setSelected(node.id);
                            setSelectedEdge(null);
                          }
                        }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          drag.current = {
                            node: node.id,
                            x: e.clientX,
                            y: e.clientY,
                            point: p,
                            camera,
                          };
                          svg.current?.setPointerCapture(e.pointerId);
                        }}
                      >
                        <circle
                          r={selected === node.id ? 34 : 31}
                          fill="#10262c"
                          stroke={
                            selected === node.id
                              ? '#8ef0d5'
                              : (error || 0) > 0.05
                                ? '#e58a94'
                                : '#397e75'
                          }
                          strokeWidth="2"
                        />
                        {error !== undefined && error > 0 && (
                          <circle
                            r="31"
                            fill="none"
                            stroke="#ee8d96"
                            strokeWidth="4"
                            pathLength="100"
                            strokeDasharray={`${error * 100} 100`}
                            transform="rotate(-90)"
                          />
                        )}
                        <text y="5" textAnchor="middle" className="node-initial">
                          {node.kind === 'database' ? 'DB' : node.id.slice(0, 2).toUpperCase()}
                        </text>
                        <text y="51" textAnchor="middle" className="node-label">
                          {node.id.length > 28 ? node.id.slice(0, 27) + '…' : node.id}
                        </text>
                        <text y="67" textAnchor="middle" className="node-stat">
                          {rps !== undefined ? `${short(rps)} req/s` : node.kind}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </svg>
              <div className="graph-legend">
                <span>
                  <i />
                  Healthy / unknown
                </span>
                <span>
                  <i className="error" />
                  Error rate &gt; 5%
                </span>
                <span>Tree layout · drag nodes · drag background to pan · scroll to zoom</span>
              </div>
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Server</th>
                    <th>Avg req/s</th>
                    <th>Errors</th>
                    <th>Mean</th>
                    <th>P95</th>
                    <th>Trace samples</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.edges.map((edge, index) => (
                    <tr
                      key={index}
                      onClick={() => {
                        setSelectedEdge(edge);
                        setSelected(null);
                      }}
                    >
                      <td>{edge.source}</td>
                      <td>{edge.target}</td>
                      <td>{edge.rps !== undefined ? short(edge.rps) : '—'}</td>
                      <td>
                        {edge.errorRatio !== undefined
                          ? (edge.errorRatio * 100).toFixed(2) + '%'
                          : '—'}
                      </td>
                      <td>
                        {edge.meanMs !== undefined
                          ? short(edge.meanMs) + ' ms'
                          : edge.sampleMeanMs !== undefined
                            ? 'sample ' + short(edge.sampleMeanMs) + ' ms'
                            : '—'}
                      </td>
                      <td>{edge.p95Ms !== undefined ? short(edge.p95Ms) + ' ms' : '—'}</td>
                      <td>{edge.sampleCalls || '—'}</td>
                      <td>{edge.origins.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <div className="result-message">
            {pending ? 'Loading service graph…' : 'No service relationships in this range.'}
          </div>
        )}
      </section>
      {(selected || selectedEdge) && (
        <section className="graph-details">
          <div>
            <h2>{selected || `${selectedEdge?.source} → ${selectedEdge?.target}`}</h2>
            <button
              className="icon-button"
              aria-label="Close graph details"
              onClick={() => {
                setSelected(null);
                setSelectedEdge(null);
              }}
            >
              <X size={16} />
            </button>
          </div>
          {selected && (
            <button className="text-button" onClick={() => onExplore(selected)}>
              Explore traces
              <ArrowRight size={13} />
            </button>
          )}
          {(selectedEdge ? [selectedEdge] : related).map((edge, index) => (
            <div className="graph-detail-row" key={index}>
              <strong>
                {edge.source} → {edge.target}
              </strong>
              <span>{edgeLabel(edge, 'rps')}</span>
              <span>{edgeLabel(edge, 'errors')}</span>
              <span>{edgeLabel(edge, 'latency')}</span>
              <small>
                {edge.origins.join(' · ')}
                {edge.sampleCalls
                  ? ` · ${edge.sampleCalls} sampled calls · ${edge.sampleErrors || 0} sampled errors`
                  : ''}
              </small>
            </div>
          ))}
        </section>
      )}
      {data?.warnings.map((warning, index) => (
        <p className="graph-warning" key={index}>
          {warning}
        </p>
      ))}
    </main>
  );
}
