// Plugin-owned, browser-independent protocol. DSH domain payloads remain opaque.
// Pull-based streams bound buffering and make detaching observers distinct from canceling agents.
import { randomUUID } from 'node:crypto';

export const PROTOCOL = 'dsh-remote-sessions/1';
export const LIMITS = Object.freeze({ frame: 8 * 1024 * 1024, pending: 128, streams: 32, batch: 128 });
export function fault(code, message = code) { return Object.assign(new Error(message), { code }); }
export function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
export function exact(value, keys) { if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw fault('INVALID_REQUEST'); }
export function wireError(error) {
  // Infrastructure errors never reflect argv, paths, environment or private request bodies.
  return { code: typeof error?.code === 'string' && /^[A-Z_]{2,64}$/.test(error.code) ? error.code : 'BACKEND_ERROR', message: 'The runtime operation failed. Inspect the runtime diagnostics.' };
}

export class RpcPeer {
  constructor(stream, { handle, maxFrame = LIMITS.frame, maxPending = LIMITS.pending } = {}) {
    this.stream = stream; this.handle = handle; this.maxFrame = maxFrame; this.maxPending = maxPending;
    this.pending = new Map(); this.active = new Map(); this.buffer = Buffer.alloc(0); this.closed = false;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    stream.on('data', chunk => { try { this.consume(chunk); } catch { this.close(fault('PROTOCOL_ERROR')); } });
    stream.on('error', () => this.close(fault('TRANSPORT_LOST')));
    stream.on('end', () => this.close(fault('TRANSPORT_LOST')));
    stream.on('close', () => this.close(fault('TRANSPORT_LOST')));
  }
  send(value) {
    if (this.closed) throw fault('TRANSPORT_LOST');
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > this.maxFrame) throw fault('FRAME_TOO_LARGE');
    if (this.stream.writableLength > this.maxFrame * 2) throw fault('BACKPRESSURE');
    const header = Buffer.allocUnsafe(4); header.writeUInt32BE(body.length);
    this.stream.write(Buffer.concat([header, body]));
  }
  request(method, params, { signal, timeoutMs = 60000 } = {}) {
    if (this.closed) return Promise.reject(fault('TRANSPORT_LOST'));
    if (signal?.aborted) return Promise.reject(fault('CANCELLED'));
    if (this.pending.size >= this.maxPending) return Promise.reject(fault('BUSY'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => { try { this.send({ type: 'cancel', id }); } catch {} finish(fault('CANCELLED')); };
      this.pending.set(id, { finish });
      signal?.addEventListener('abort', abort, { once: true });
      if (timeoutMs > 0) timer = setTimeout(() => { try { this.send({ type: 'cancel', id }); } catch {} finish(fault('TIMEOUT')); }, timeoutMs);
      try { this.send({ type: 'request', id, method, params }); } catch (error) { finish(error); }
      if (signal?.aborted) abort();
    });
  }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (!length || length > this.maxFrame) throw fault('FRAME_TOO_LARGE');
      if (this.buffer.length < length + 4) break;
      const value = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
      this.buffer = this.buffer.subarray(length + 4);
      this.dispatch(value);
    }
    if (this.buffer.length > this.maxFrame + 4) throw fault('FRAME_TOO_LARGE');
  }
  dispatch(message) {
    if (!plain(message) || typeof message.id !== 'string' || message.id.length > 128) throw fault('PROTOCOL_ERROR');
    if (message.type === 'response') {
      exact(message, ['type', 'id', 'ok', 'value', 'error']);
      if (typeof message.ok !== 'boolean') throw fault('PROTOCOL_ERROR');
      const pending = this.pending.get(message.id);
      if (!pending) return; // A late reply to an explicitly canceled request.
      pending.finish(message.ok ? null : fault(typeof message.error?.code === 'string' ? message.error.code : 'BACKEND_ERROR'), message.value);
      return;
    }
    if (message.type === 'cancel') {
      exact(message, ['type', 'id']); this.active.get(message.id)?.abort(); return;
    }
    exact(message, ['type', 'id', 'method', 'params']);
    if (message.type !== 'request' || typeof message.method !== 'string' || message.method.length > 128 || !this.handle || this.active.has(message.id)) throw fault('PROTOCOL_ERROR');
    if (this.active.size >= this.maxPending) { this.send({ type: 'response', id: message.id, ok: false, error: wireError(fault('BUSY')) }); return; }
    const controller = new AbortController(); this.active.set(message.id, controller);
    Promise.resolve().then(() => this.handle(message.method, message.params, controller.signal)).then(
      value => { if (!this.closed) this.send({ type: 'response', id: message.id, ok: true, value }); },
      error => { if (!this.closed) this.send({ type: 'response', id: message.id, ok: false, error: wireError(error) }); }
    ).catch(() => this.close(fault('PROTOCOL_ERROR'))).finally(() => this.active.delete(message.id));
  }
  close(reason = fault('TRANSPORT_LOST')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) pending.finish(reason);
    for (const controller of this.active.values()) controller.abort();
    this.active.clear(); this.buffer = Buffer.alloc(0);
    this.stream.destroy(); this.resolveDone(reason);
  }
}

// Retains only a single pending next() per stream. A timed poll leaves that read in
// place, not a new concurrent read; connection loss aborts the observer only.
export class StreamShelf {
  constructor({ max = LIMITS.streams, idleMs = 120000 } = {}) { this.items = new Map(); this.max = max; this.idleMs = idleMs; this.disposed = false; }
  async open(factory, signal) {
    if (this.disposed) throw fault('TRANSPORT_LOST');
    if (this.items.size >= this.max) throw fault('BUSY');
    signal?.throwIfAborted();
    const id = randomUUID(), controller = new AbortController();
    const item = { controller, iterator: null, next: null, polling: false, timer: null };
    this.items.set(id, item);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let cancelOpening;
    const opening = Promise.resolve().then(() => factory(controller.signal)).then(async source => {
      const iterator = source[Symbol.asyncIterator]();
      if (this.disposed || this.items.get(id) !== item || controller.signal.aborted) {
        await iterator.return?.(); throw fault('CANCELLED');
      }
      return iterator;
    });
    const cancelled = new Promise((_, reject) => {
      cancelOpening = () => reject(fault('CANCELLED'));
      controller.signal.addEventListener('abort', cancelOpening, { once: true });
      if (controller.signal.aborted) cancelOpening();
    });
    try {
      item.iterator = await Promise.race([opening, cancelled]);
      if (controller.signal.aborted) throw fault('CANCELLED');
      this.touch(id, item); return id;
    } catch (error) { await this.close(id); throw error; }
    finally { signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancelOpening); }
  }
  touch(id, item) { clearTimeout(item.timer); item.timer = setTimeout(() => { this.close(id).catch(() => {}); }, this.idleMs); item.timer.unref?.(); }
  async next(id, { waitMs = 25000, signal } = {}) {
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 25000) throw fault('INVALID_REQUEST');
    const item = this.items.get(id);
    if (!item?.iterator) throw fault('STREAM_GONE');
    if (item.polling) throw fault('POLL_IN_PROGRESS');
    item.polling = true; clearTimeout(item.timer);
    let timer, abort;
    try {
      signal?.throwIfAborted();
      item.next ??= Promise.resolve().then(() => item.iterator.next());
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), Math.min(25000, Math.max(1, waitMs))); });
      const cancelled = new Promise((_, reject) => { abort = () => reject(fault('CANCELLED')); signal?.addEventListener('abort', abort, { once: true }); });
      const result = await Promise.race([item.next, timeout, cancelled]);
      if (result.timeout) return { done: false, items: [] };
      item.next = null;
      if (result.done) { await this.close(id); return { done: true, items: [] }; }
      return { done: false, items: [result.value] };
    } catch (error) { await this.close(id); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); item.polling = false; if (this.items.get(id) === item) this.touch(id, item); }
  }
  async close(id) {
    const item = this.items.get(id); if (!item) return;
    this.items.delete(id); clearTimeout(item.timer); item.controller.abort();
    item.next?.catch(() => {});
    await item.iterator?.return?.();
  }
  async dispose() { this.disposed = true; await Promise.allSettled([...this.items.keys()].map(id => this.close(id))); }
}
