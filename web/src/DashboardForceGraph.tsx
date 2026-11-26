import { useEffect, useRef, useState } from 'react';

type Node = { id: string; x: number; y: number; vx: number; vy: number };
export type ForceData = {
  nodes: { id: string }[];
  edges: { source: string; target: string; calls?: number; rps?: number; origins?: string[] }[];
  warnings?: string[];
};
// Independent spring/charge simulation; positions are local, never saved in dashboard JSON.
export function DashboardForceGraph({ data }: { data: ForceData }) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<string | null>(null);
  const nodes = useRef<Node[]>([]);
  const [frame, setFrame] = useState<Node[]>([]);
  const [zoom, setZoom] = useState(1);
  const edges = data.edges.filter(
    (e) =>
      data.nodes.slice(0, 80).some((n) => n.id === e.source) &&
      data.nodes.slice(0, 80).some((n) => n.id === e.target),
  );
  useEffect(() => {
    nodes.current = data.nodes.slice(0, 80).map((n, i, all) => ({
      ...n,
      x: 300 + 180 * Math.cos((i / all.length) * Math.PI * 2),
      y: 170 + 120 * Math.sin((i / all.length) * Math.PI * 2),
      vx: 0,
      vy: 0,
    }));
    let raf = 0;
    let tick = 0;
    function step() {
      const all = nodes.current;
      for (const n of all) {
        n.vx += (300 - n.x) * 0.001;
        n.vy += (170 - n.y) * 0.001;
      }
      for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i],
            b = all[j];
          const dx = a.x - b.x || 0.01,
            dy = a.y - b.y || 0.01;
          const d = Math.max(20, Math.hypot(dx, dy));
          const f = 400 / (d * d);
          a.vx += (dx / d) * f;
          a.vy += (dy / d) * f;
          b.vx -= (dx / d) * f;
          b.vy -= (dy / d) * f;
        }
      const map = new Map(all.map((n) => [n.id, n]));
      for (const e of data.edges) {
        const a = map.get(e.source),
          b = map.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x,
          dy = b.y - a.y,
          d = Math.max(1, Math.hypot(dx, dy)),
          f = (d - 125) * 0.005;
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
      for (const n of all) {
        n.vx *= 0.85;
        n.vy *= 0.85;
        if (n.id !== drag.current) {
          n.x = Math.max(35, Math.min(565, n.x + n.vx));
          n.y = Math.max(30, Math.min(310, n.y + n.vy));
        }
      }
      setFrame(all.map((n) => ({ ...n })));
      if (++tick < 1800) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [data]);
  const map = new Map(frame.map((n) => [n.id, n]));
  function move(event: React.PointerEvent<SVGSVGElement>) {
    if (!drag.current || !svg.current) return;
    const matrix = svg.current.getScreenCTM();
    if (!matrix) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const n = nodes.current.find((n) => n.id === drag.current);
    if (n) {
      n.x = (p.x - 300) / zoom + 300;
      n.y = (p.y - 170) / zoom + 170;
      setFrame(nodes.current.map((n) => ({ ...n })));
    }
  }
  return (
    <div className="dashboard-force">
      <div className="inline-tools">
        <button aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.2))}>
          −
        </button>
        <button aria-label="Reset graph zoom" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, z + 0.2))}>
          +
        </button>
      </div>
      <svg
        ref={svg}
        viewBox="0 0 600 340"
        role="img"
        aria-label="Service dependency force graph"
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <g transform={`translate(300 170) scale(${zoom}) translate(-300 -170)`}>
          {edges.map((e, i) => {
            const a = map.get(e.source),
              b = map.get(e.target);
            return a && b ? (
              <g key={i}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#406e73" strokeWidth="1.5" />
                <circle
                  cx={a.x + (b.x - a.x) * 0.7}
                  cy={a.y + (b.y - a.y) * 0.7}
                  r="3"
                  fill="#2dd4bf"
                />
                <title>
                  {e.source} → {e.target}
                  {e.calls != null ? ` · ${e.calls} calls` : ''}
                </title>
              </g>
            ) : null;
          })}
          {frame.map((n) => (
            <g
              key={n.id}
              onPointerDown={(e) => {
                drag.current = n.id;
                svg.current?.setPointerCapture(e.pointerId);
              }}
              className="force-node"
            >
              <circle cx={n.x} cy={n.y} r="10" fill="#173a3b" stroke="#2dd4bf" />
              <text x={n.x} y={n.y + 25} textAnchor="middle" fill="#c1d3d9" fontSize="10">
                {n.id.length > 26 ? n.id.slice(0, 24) + '…' : n.id}
              </text>
              <title>{n.id}</title>
            </g>
          ))}
        </g>
      </svg>
      {data.nodes.length > 80 && <small>Showing 80 of {data.nodes.length} services.</small>}
      {data.warnings?.map((w, i) => (
        <p key={i} className="dashboard-note">
          {w}
        </p>
      ))}
    </div>
  );
}
