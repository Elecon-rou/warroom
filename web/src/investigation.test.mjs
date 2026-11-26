import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationContext } from './investigation.ts';

test('incomplete investigation conclusions are not treated as verified follow-up context', () => {
  const messages = [
    { id: '1', role: 'user', content: 'Find the incident cause' },
    {
      id: '2',
      role: 'assistant',
      content: 'The cause is definitely a deployment',
      incomplete: true,
      warning: 'Output limited',
      context: '{"measured_errors":7}',
    },
    { id: '3', role: 'user', content: 'Which checks remain?' },
  ];
  const context = buildConversationContext(messages);
  assert.ok(!JSON.stringify(context).includes('definitely a deployment'));
  assert.ok(JSON.stringify(context).includes('incomplete'));
  assert.ok(JSON.stringify(context).includes('measured_errors'));
});
