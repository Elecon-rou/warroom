import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentBytes,
  isDashboardDocument,
  maxDocumentBytes,
  validateDocumentReference,
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

test('document uploads accept YAML, Markdown and text even without browser MIME metadata', async () => {
  for (const [name, type, data] of [
    [
      'grafana.JSON',
      'application/json',
      '{"apiVersion":"dashboard.grafana.app/v2","kind":"Dashboard","spec":{"title":"CPU","elements":{}}}',
    ],
    ['dashboard.yml', 'application/yaml', 'title: CPU\npanels:\n  - expr: rate(cpu[5m])'],
    ['dashboard.yaml', 'application/yaml', 'title: CPU'],
    ['spec.md', 'text/markdown', '# CPU dashboard\nShow CPU by node.'],
    ['spec.markdown', 'text/markdown', '# Disk usage'],
    ['notes.txt', 'text/plain', 'Show memory usage by node.'],
  ]) {
    const result = await readDashboardAttachment(new File([data], name));
    assert.deepEqual(result, { name, mediaType: type, data });
    assert.equal(isDashboardDocument(result), true);
    assert.equal(attachmentBytes(result), new TextEncoder().encode(data).length);
  }
  for (const type of ['text/yaml', 'application/x-yaml']) {
    const result = await readDashboardAttachment(new File(['title: CPU'], 'reference', { type }));
    assert.equal(result.mediaType, 'application/yaml');
  }
  assert.equal(isDashboardDocument({ mediaType: 'image/png' }), false);
});

test('document validation rejects binary, empty and oversized references', async () => {
  for (const name of ['x.md', 'x.yaml', 'x.txt']) {
    await assert.rejects(
      () => readDashboardAttachment(new File([new Uint8Array([255, 254])], name)),
      /encoded data/,
    );
    await assert.rejects(() => readDashboardAttachment(new File([' \n '], name)), /Empty/);
    await assert.rejects(
      () => readDashboardAttachment(new File(['hello\0world'], name)),
      /null bytes/,
    );
    await assert.rejects(
      () => readDashboardAttachment(new File(['x'.repeat(maxDocumentBytes + 1)], name)),
      /256 KiB/,
    );
  }
  assert.throws(() => validateDocumentReference('é'.repeat(maxDocumentBytes / 2 + 1)), /256 KiB/);
  await assert.rejects(
    () => readDashboardAttachment(new File(['%PDF'], 'reference.pdf', { type: 'application/pdf' })),
    /JSON, YAML/,
  );
});
