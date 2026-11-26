import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreInvestigationChatID, newInvestigationChatID } from './investigationChat.ts';
test('reload retains a chat budget identity; explicit reset rotates it', () => {
  const map = new Map();
  const storage = {
    getItem: (key) => map.get(key) || null,
    setItem: (key, value) => map.set(key, value),
  };
  const first = restoreInvestigationChatID(storage);
  assert.equal(restoreInvestigationChatID(storage), first);
  const reset = newInvestigationChatID(storage);
  assert.notEqual(reset, first);
  assert.equal(restoreInvestigationChatID(storage), reset);
});
