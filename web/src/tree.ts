export type TreePoint = { x: number; y: number };
export type TreeLayout = { positions: Record<string, TreePoint>; width: number; height: number };
/** Condense cycles, rank callers before dependencies, then order siblings by parents. */
export function treeLayout(ids: string[], edges: { source: string; target: string }[]): TreeLayout {
  const nodes = [...new Set(ids)].sort();
  const known = new Set(nodes);
  const out = new Map(nodes.map((id) => [id, [] as string[]]));
  for (const edge of edges)
    if (known.has(edge.source) && known.has(edge.target) && edge.source !== edge.target)
      out.get(edge.source)!.push(edge.target);
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const components: string[][] = [];
  let next = 0;
  function visit(id: string) {
    indices.set(id, next);
    low.set(id, next++);
    stack.push(id);
    active.add(id);
    for (const child of out.get(id)!) {
      if (!indices.has(child)) {
        visit(child);
        low.set(id, Math.min(low.get(id)!, low.get(child)!));
      } else if (active.has(child)) low.set(id, Math.min(low.get(id)!, indices.get(child)!));
    }
    if (low.get(id) === indices.get(id)) {
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        active.delete(member);
        group.push(member);
      } while (member !== id);
      components.push(group.sort());
    }
  }
  nodes.forEach((id) => {
    if (!indices.has(id)) visit(id);
  });
  const component = new Map<string, number>();
  components.forEach((group, index) => group.forEach((id) => component.set(id, index)));
  const links = components.map(() => new Set<number>());
  const indegree = components.map(() => 0);
  const rank = components.map(() => 0);
  for (const edge of edges) {
    const a = component.get(edge.source);
    const b = component.get(edge.target);
    if (a !== undefined && b !== undefined && a !== b && !links[a].has(b)) {
      links[a].add(b);
      indegree[b]++;
    }
  }
  const queue = components.map((_, i) => i).filter((i) => !indegree[i]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const child of links[current]) {
      rank[child] = Math.max(rank[child], rank[current] + 1);
      if (--indegree[child] === 0) queue.push(child);
    }
  }
  const maxRank = Math.max(0, ...rank);
  const layers = Array.from({ length: maxRank + 1 }, () => [] as string[]);
  nodes.forEach((id) => layers[rank[component.get(id)!]].push(id));
  const parents = new Map(nodes.map((id) => [id, [] as string[]]));
  for (const edge of edges)
    if (known.has(edge.source) && known.has(edge.target))
      parents.get(edge.target)!.push(edge.source);
  for (let pass = 0; pass < 4; pass++) {
    const order = new Map<string, number>();
    layers.forEach((layer) =>
      layer.forEach((id, index) => order.set(id, (index + 0.5) / layer.length)),
    );
    for (let level = 1; level < layers.length; level++) {
      const center = (id: string) => {
        const upstream = parents.get(id)!.filter((p) => rank[component.get(p)!] < level);
        return upstream.length
          ? upstream.reduce((sum, p) => sum + (order.get(p) || 0), 0) / upstream.length
          : order.get(id) || 0;
      };
      layers[level].sort((a, b) => center(a) - center(b) || a.localeCompare(b));
    }
  }
  const width = Math.max(1100, 240 + maxRank * 290);
  const height = Math.max(640, Math.max(0, ...layers.map((layer) => layer.length)) * 155 + 100);
  const positions: Record<string, TreePoint> = {};
  layers.forEach((layer, level) =>
    layer.forEach(
      (id, index) =>
        (positions[id] = {
          x: maxRank ? 120 + (level * (width - 240)) / maxRank : width / 2,
          y: 70 + ((index + 0.5) * (height - 140)) / layer.length,
        }),
    ),
  );
  return { positions, width, height };
}
