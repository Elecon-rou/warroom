import test from 'node:test';
import assert from 'node:assert/strict';
import { treeLayout } from './tree.ts';
test('callers precede downstream dependencies and siblings are separated', () => {
  const tree = treeLayout(
    ['gateway', 'api', 'worker', 'db'],
    [
      { source: 'gateway', target: 'api' },
      { source: 'gateway', target: 'worker' },
      { source: 'api', target: 'db' },
      { source: 'worker', target: 'db' },
    ],
  );
  const p = tree.positions;
  assert.ok(p.gateway.x < p.api.x && p.api.x < p.db.x);
  assert.equal(p.api.x, p.worker.x);
  assert.notEqual(p.api.y, p.worker.y);
  assert.equal(Object.keys(p).length, 4);
});
test('cycles and disconnected services are retained with finite positions', () => {
  const tree = treeLayout(
    ['a', 'b', 'c', 'isolated'],
    [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
      { source: 'b', target: 'c' },
    ],
  );
  assert.equal(tree.positions.a.x, tree.positions.b.x);
  assert.ok(tree.positions.c.x > tree.positions.b.x);
  assert.ok(tree.positions.isolated);
  for (const p of Object.values(tree.positions))
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});
test('layout is deterministic and grows to accommodate large levels', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `service-${i}`),
    edges = ids.slice(1).map((target) => ({ source: ids[0], target }));
  const a = treeLayout(ids, edges),
    b = treeLayout([...ids].reverse(), edges);
  assert.deepEqual(a, b);
  assert.ok(a.height > 640);
  assert.equal(new Set(Object.values(a.positions).map((p) => `${p.x},${p.y}`)).size, 30);
});
