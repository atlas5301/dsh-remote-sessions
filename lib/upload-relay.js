// Per-transport bounded upload relay into DSH's native fileUploads service.
// Never stores local paths or buffers an entire file. Receipts remain remote-owned.
import { randomUUID } from 'node:crypto';
import { exact, fault } from './protocol.js';
export const UPLOAD_CHUNK_BYTES = 192 * 1024;

export function createUploadRelay(service, { idleMs = 120000 } = {}) {
  const entries = new Map(); let closed = false;
  function touch(id, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { abort(entry, fault('UPLOAD_EXPIRED')); entries.delete(id); }, idleMs);
    entry.timer.unref?.();
  }
  function get(id) { const entry = entries.get(id); if (!entry) throw fault('UNKNOWN_UPLOAD'); return entry; }
  function abort(entry, error = fault('UPLOAD_ABORTED')) {
    clearTimeout(entry.timer);
    entry.failure = error; entry.controller.abort(error);
    entry.active?.reject(error); entry.active = null;
    entry.pending?.reject(error); entry.pending = null; entry.wake?.();
  }
  return {
    async handle(method, params, signal) {
      if (closed || !service?.uploadStream) throw fault('UPLOAD_UNAVAILABLE');
      signal?.throwIfAborted();
      if (method === 'upload-start') {
        exact(params, ['sessionId', 'name']);
        if (typeof params.sessionId !== 'string' || !params.sessionId || params.sessionId.length > 256 || (params.name !== undefined && (typeof params.name !== 'string' || params.name.length > 4096))) throw fault('INVALID_REQUEST');
        if (entries.size >= 4) throw fault('UPLOAD_LIMIT');
        const id = randomUUID(), entry = { controller: new AbortController(), index: 0, ended: false, pending: null, wake: null, failure: null, busy: false };
        entries.set(id, entry); touch(id, entry);
        const data = { async *[Symbol.asyncIterator]() {
          while (true) {
            if (entry.failure) throw entry.failure;
            if (entry.pending) {
              const part = entry.pending; entry.pending = null; entry.active = part;
              try { yield part.bytes; if (entry.failure) throw entry.failure; part.resolve(); }
              catch (error) { part.reject(error); throw error; }
              finally { entry.active = null; part.reject(entry.failure ?? fault('UPLOAD_STORAGE_CLOSED')); }
              continue;
            }
            if (entry.ended) return;
            await new Promise(resolve => { entry.wake = resolve; }); entry.wake = null;
          }
        } };
        entry.result = Promise.resolve().then(() => service.uploadStream({ sessionId: params.sessionId, data, signal: entry.controller.signal, ...(params.name === undefined ? {} : { name: params.name }) }))
          .then(value => ({ ok: true, value }), error => { abort(entry, error); return { ok: false, error }; });
        return { uploadId: id };
      }
      exact(params, method === 'upload-chunk' ? ['uploadId', 'index', 'data'] : ['uploadId']);
      const entry = get(params.uploadId);
      if (method === 'upload-abort') { abort(entry); entries.delete(params.uploadId); return { aborted: true }; }
      if (entry.failure) throw entry.failure;
      if (entry.busy || entry.ended) throw fault('UPLOAD_BUSY');
      entry.busy = true; touch(params.uploadId, entry);
      const onAbort = () => abort(entry, signal.reason ?? fault('UPLOAD_ABORTED'));
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (method === 'upload-chunk') {
          if (!Number.isSafeInteger(params.index) || params.index !== entry.index || typeof params.data !== 'string' || params.data.length > UPLOAD_CHUNK_BYTES * 4 / 3) throw fault('INVALID_UPLOAD_CHUNK');
          const bytes = Buffer.from(params.data, 'base64');
          if (!bytes.length || bytes.toString('base64') !== params.data) throw fault('INVALID_UPLOAD_CHUNK');
          await new Promise((resolve, reject) => { entry.pending = { bytes, resolve, reject }; entry.wake?.(); });
          entry.index++; return { index: entry.index };
        }
        if (method === 'upload-finish') {
          entry.ended = true; entry.wake?.();
          const result = await entry.result; clearTimeout(entry.timer); entries.delete(params.uploadId);
          if (!result.ok) throw result.error;
          return result.value;
        }
        throw fault('UNSUPPORTED_OPERATION');
      } finally { entry.busy = false; signal?.removeEventListener('abort', onAbort); }
    },
    dispose() { closed = true; for (const entry of entries.values()) abort(entry); entries.clear(); },
  };
}

export async function forwardUpload(requestRpc, { sessionId, data, name, signal }) {
  const { uploadId } = await requestRpc('upload-start', { sessionId, ...(name === undefined ? {} : { name }) }, signal);
  let index = 0;
  try {
    for await (const chunk of data) {
      signal?.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) throw fault('INVALID_UPLOAD_CHUNK');
      for (let offset = 0; offset < chunk.byteLength; offset += UPLOAD_CHUNK_BYTES) {
        const result = await requestRpc('upload-chunk', { uploadId, index, data: Buffer.from(chunk.subarray(offset, offset + UPLOAD_CHUNK_BYTES)).toString('base64') }, signal);
        if (result.index !== ++index) throw fault('INVALID_UPLOAD_REPLY');
      }
    }
    return await requestRpc('upload-finish', { uploadId }, signal);
  } catch (error) { await requestRpc('upload-abort', { uploadId }).catch(() => {}); throw error; }
}
