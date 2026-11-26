import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentBytes,
  validateJSONReference,
  readDashboardAttachment,
} from './dashboardReferenceFiles.ts';
test('JSON attachments accept Grafana/Warroom references and reject malformed or scalar content', () => {
  for (const text of ['{"panels":[{"type":"timeseries"}]}', '[]', '{"version":1,"widgets":[]}'])
    assert.doesNotThrow(() => validateJSONReference(text));
  for (const text of ['{', 'null', '"hi"', '42']) assert.throws(() => validateJSONReference(text));
  assert.throws(
    () => validateJSONReference(JSON.stringify({ data: 'x'.repeat(256 * 1024) })),
    /256 KiB/,
  );
});
test('attachment byte limits count UTF-8 JSON and decoded image bytes', () => {
  assert.equal(attachmentBytes({ mediaType: 'application/json', data: 'é' }), 2);
  assert.equal(attachmentBytes({ mediaType: 'image/png', data: 'YQ==' }), 1);
  assert.equal(attachmentBytes({ mediaType: 'image/png', data: 'YWI=' }), 2);
});
test('file reader accepts valid JSON without uploading and rejects unsupported images or oversize files', async () => {
  const file = new File(['{"panels":[]}'], 'reference.json', { type: 'application/json' });
  assert.deepEqual(await readDashboardAttachment(file), {
    name: 'reference.json',
    mediaType: 'application/json',
    data: '{"panels":[]}',
  });
  await assert.rejects(
    () => readDashboardAttachment(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })),
    /PNG/,
  );
  await assert.rejects(
    () => readDashboardAttachment(new File(['x'.repeat(256 * 1024 + 1)], 'x.json')),
    /256 KiB/,
  );
  await assert.rejects(
    () => readDashboardAttachment(new File([new Uint8Array([255, 254])], 'bad.json')),
    /encoded data/,
  );
});
