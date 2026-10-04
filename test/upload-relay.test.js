import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadRelay, forwardUpload, UPLOAD_CHUNK_BYTES } from '../lib/upload-relay.js';

function fixture(options) {
  const saved = [];
  const service = { async uploadStream({ data, signal, sessionId, name }) {
    const chunks = [];
    for await (const chunk of data) { signal.throwIfAborted(); chunks.push(Buffer.from(chunk)); }
    const result = { sessionId, name, bytes: Buffer.concat(chunks) }; saved.push(result);
    return { receiptId: 'owned-by-' + sessionId, file: { name, bytes: result.bytes.length } };
  } };
  return { saved, relay: createUploadRelay(service, options) };
}

test('upload relay transfers bounded chunks byte-for-byte with a remote-owned receipt', async () => {
  const { relay, saved } = fixture(), sizes = [], input = Buffer.alloc(UPLOAD_CHUNK_BYTES * 3 + 19, 0xa3);
  const result = await forwardUpload((method, params, signal) => {
    if (method === 'upload-chunk') sizes.push(Buffer.from(params.data, 'base64').length);
    return relay.handle(method, params, signal);
  }, { sessionId: 'remote-session', name: 'data.bin', data: (async function* () { yield input; })() });
  assert.equal(result.receiptId, 'owned-by-remote-session'); assert.deepEqual(sizes, [UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, 19]);
  assert.deepEqual(saved[0].bytes, input); relay.dispose();
});

test('upload relay rejects malformed ordering, noncanonical encoding and a fifth active upload', async () => {
  const { relay } = fixture();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await relay.handle('upload-start', { sessionId: 's' })).uploadId);
  await assert.rejects(relay.handle('upload-start', { sessionId: 's' }), { code: 'UPLOAD_LIMIT' });
  for (const params of [{ index: 1, data: 'YQ==' }, { index: 0, data: 'YQ' }, { index: 0, data: '' }]) {
    await assert.rejects(relay.handle('upload-chunk', { uploadId: ids[0], ...params }), { code: 'INVALID_UPLOAD_CHUNK' });
  }
  relay.dispose();
  await assert.rejects(relay.handle('upload-finish', { uploadId: ids[0] }), { code: 'UPLOAD_UNAVAILABLE' });
});

test('transport disposal interrupts pending upload without finishing staged file', async () => {
  const { relay, saved } = fixture();
  const { uploadId } = await relay.handle('upload-start', { sessionId: 's' });
  await relay.handle('upload-chunk', { uploadId, index: 0, data: 'YQ==' });
  relay.dispose(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.length, 0);
});

test('abandoned uploads expire even while the observation carrier remains alive', async () => {
  const { relay, saved } = fixture({ idleMs: 10 });
  const { uploadId } = await relay.handle('upload-start', { sessionId: 's' });
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(relay.handle('upload-finish', { uploadId }), { code: 'UNKNOWN_UPLOAD' });
  assert.equal(saved.length, 0); relay.dispose();
});

test('storage failure after consuming a chunk rejects its admission instead of hanging', async () => {
  const relay = createUploadRelay({ async uploadStream({ data }) { for await (const chunk of data) { assert.ok(chunk.length); throw new Error('disk full'); } } });
  const { uploadId } = await relay.handle('upload-start', { sessionId: 's' });
  await assert.rejects(relay.handle('upload-chunk', { uploadId, index: 0, data: 'YQ==' }), error => error.message === 'disk full' || error.code === 'UPLOAD_STORAGE_CLOSED');
  relay.dispose();
});

test('upstream source error aborts its remote upload, never commits partial bytes', async () => {
  const { relay, saved } = fixture();
  await assert.rejects(forwardUpload((method, params, signal) => relay.handle(method, params, signal), {
    sessionId: 's', data: (async function* () { yield Buffer.from('prefix'); throw new Error('source failed'); })(),
  }), /source failed/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(saved.length, 0); relay.dispose();
});
