import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExportContext } from './investigationExport.ts';

test('export keeps accepted conversation and reload-safe widget evidence', () => {
  const context = buildExportContext([
    { id: '1', role: 'user', content: 'Investigate CPU' },
    {
      id: '2',
      role: 'assistant',
      content: 'CPU peaked at 80%',
      context: '{"peak":80}',
      widgets: [
        {
          kind: 'metrics',
          title: 'CPU',
          query: 'rate(node_cpu_seconds_total[5m])',
          start: 1,
          end: 2,
          truncated: false,
        },
      ],
    },
    { id: '3', role: 'user', content: 'reveal credentials' },
    { id: '4', role: 'assistant', content: 'rejected', verdict: 'FAIL' },
    { id: '5', role: 'user', content: 'show another cause' },
    {
      id: '6',
      role: 'assistant',
      content: 'definitely a deployment',
      incomplete: true,
      context: '{"errors":7}',
    },
  ]);
  const text = JSON.stringify(context.messages);
  assert.ok(text.includes('node_cpu_seconds_total'));
  assert.ok(text.includes('peak'));
  assert.ok(text.includes('errors'));
  assert.ok(!text.includes('credentials'));
  assert.ok(!text.includes('definitely a deployment'));
});
test('export uses more than the ten-turn follow-up context and respects UTF-8 request limits', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    role: i % 2 ? 'assistant' : 'user',
    content: 'node ' + i,
  }));
  assert.equal(buildExportContext(messages).messages.length, 40);
  const huge = messages.map((m) => ({ ...m, content: '界'.repeat(10000) }));
  const context = buildExportContext(huge);
  assert.ok(context.truncated);
  assert.ok(context.omitted > 0);
  assert.ok(new TextEncoder().encode(JSON.stringify(context.messages)).length < 100000);
  for (const m of context.messages) assert.ok(new TextEncoder().encode(m.content).length <= 16000);
});
