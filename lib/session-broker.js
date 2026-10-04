// Host-owned attachment capabilities. A binding owns observers, never a DSH agent.
import { createHash, randomUUID } from 'node:crypto';
import { PROTOCOL, exact, fault, plain } from './protocol.js';
import { createRuntimeAdapter, READ_ENDPOINTS, WRITE_ENDPOINTS } from './runtime-adapter.js';
import { connectSsh, validateSsh } from './ssh-carrier.js';
import { machineIdentity } from './authority.js';

export const BROKER_LIMITS = Object.freeze({ attachments: 16, idleMs: 5 * 60 * 1000 });
// Process identity, not attachment identity: reconnects in this host process agree.
const LOCAL_RUNTIME_ID = randomUUID(), LOCAL_INSTANCE_ID = randomUUID();
const LOCAL_AUTHORITY = createHash('sha256').update('local:' + LOCAL_RUNTIME_ID + ':' + LOCAL_INSTANCE_ID).digest('hex').slice(0, 20);
const READS = new Set(READ_ENDPOINTS), ENDPOINTS = new Set([...READ_ENDPOINTS, ...WRITE_ENDPOINTS]);
const METHODS = new Set(['call', 'open', 'next', 'close', 'event-result']);
const BINDING_KEYS = ['id', 'target', 'authority', 'runtimeId', 'instanceId'];
const LOST = new Set(['TRANSPORT_LOST', 'SSH_FAILED', 'SSH_DISCONNECTED', 'PROTOCOL_ERROR']);
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
const cancelled = signal => { if (signal?.aborted) throw fault('CANCELLED'); };

// Do not trust an injected transport to honor cancellation. Observe late results so
// a connection finishing after detach/disposal is still closed by its owner.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => { signal.removeEventListener('abort', abort); callback(value); };
    const abort = () => finish(reject, typeof signal.reason?.code === 'string' ? signal.reason : fault('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort();
  });
}

function checkHello(value) {
  if (!plain(value) || value.protocol !== PROTOCOL || !text(value.runtimeId) || !text(value.instanceId) ||
      !Array.isArray(value.capabilities) || value.capabilities.length > 128) throw fault('INCOMPATIBLE_PROTOCOL');
  const seen = new Set();
  for (const item of value.capabilities) {
    if (!plain(item) || !text(item.endpoint, 128) || typeof item.stream !== 'boolean' ||
        !Array.isArray(item.parameters) || item.parameters.length > 128 || item.parameters.some(p => !text(p)) ||
        seen.has(item.endpoint)) throw fault('INCOMPATIBLE_PROTOCOL');
    seen.add(item.endpoint);
  }
  // Neither the transport nor the caller may mutate the identity/capabilities we pin.
  try { return structuredClone(value); } catch { throw fault('INCOMPATIBLE_PROTOCOL'); }
}

function checkOperation(method, params, hello) {
  if (!METHODS.has(method)) throw fault('UNSUPPORTED_OPERATION');
  if (method === 'call' || method === 'open') {
    exact(params, method === 'call' ? ['endpoint', 'values', 'confirmDefaultChange'] : ['endpoint', 'values']);
    if (method === 'call' && params.endpoint === 'session/selectModel') {
      if (params.confirmDefaultChange !== true) throw fault('DEFAULT_CHANGE_CONFIRMATION_REQUIRED');
    } else if (params.confirmDefaultChange !== undefined) throw fault('INVALID_REQUEST');
    if (!text(params.endpoint, 128) || !Array.isArray(params.values)) throw fault('INVALID_REQUEST');
    if (method === 'open' && params.endpoint === '$events') {
      if (params.values.length) throw fault('INVALID_REQUEST');
      return;
    }
    const descriptor = hello.capabilities.find(item => item.endpoint === params.endpoint);
    if (!ENDPOINTS.has(params.endpoint) || !descriptor || descriptor.stream !== (method === 'open') ||
        params.values.length > descriptor.parameters.length) throw fault('UNSUPPORTED_OPERATION');
  } else if (method === 'event-result') {
    exact(params, ['clientId', 'eventId', 'outcome']);
    if (!text(params.clientId) || !text(params.eventId) || !plain(params.outcome)) throw fault('INVALID_REQUEST');
  } else {
    exact(params, method === 'next' ? ['streamId', 'waitMs'] : ['streamId']);
    if (!text(params.streamId) || (method === 'next' && params.waitMs !== undefined &&
        (!Number.isInteger(params.waitMs) || params.waitMs < 1 || params.waitMs > 25000))) throw fault('INVALID_REQUEST');
  }
}

/**
 * attach({target: 'local' | machineName, expectedRuntimeId?, expectedInstanceId?}, signal)
 *   -> {binding: {id, target, authority, runtimeId, instanceId}, hello}
 * execute({binding, method: 'call'|'open'|'next'|'close'|'event-result', params}, signal)
 *   -> the unchanged protocol reply. Pass the entire binding back, not just its id.
 * detach({binding}) -> {detached:true}; reconcile() -> {evicted:number}; dispose().
 * Call reconcile after replacing/mutating registry.machines; every operation also
 * rechecks it. Errors have safe Error.code; remote admitted writes may fail with
 * UNKNOWN_MUTATION_OUTCOME and must NOT be automatically replayed.
 */
export function createSessionBroker(ctx, registry, {
  connect = connectSsh, localAdapterFactory = createRuntimeAdapter, now = Date.now,
} = {}) {
  const records = new Map();
  let disposed = false, disposal;
  function available() { if (disposed) throw fault('BROKER_DISPOSED'); }
  function machineFor(target) {
    if (!Array.isArray(registry?.machines)) throw fault('INVALID_REGISTRY');
    // A registry record can never turn the reserved local target into a remote.
    if (registry.machines.some(machine => machine?.name === 'local')) throw fault('RESERVED_TARGET');
    if (target === 'local') return null;
    const matches = registry.machines.filter(machine => machine?.name === target);
    if (!matches.length) throw fault('TARGET_NOT_FOUND');
    if (matches.length !== 1 || !plain(matches[0])) throw fault('INVALID_MACHINE');
    const machine = matches[0];
    if (machine.disabled || machine.migrationRequired) throw fault('MIGRATION_REQUIRED');
    if (machine.runtimeMode !== undefined && machine.runtimeMode !== 'remote-runtime') throw fault('UNSUPPORTED_RUNTIME');
    validateSsh(machine);
    return machine;
  }
  function authorityFor(target) {
    const machine = machineFor(target);
    return machine ? machineIdentity(machine) : LOCAL_AUTHORITY;
  }
  function release(record) {
    if (!record.cleanup) return record.cleaning ?? Promise.resolve();
    const cleanup = record.cleanup; record.cleanup = null;
    record.cleaning = Promise.resolve().then(cleanup).catch(() => {});
    return record.cleaning;
  }
  function evict(record, code = 'BINDING_GONE') {
    if (!record.closed) {
      record.closed = true; record.reason = code;
      records.delete(record.id); clearTimeout(record.timer);
      record.controller.abort(fault(code));
    }
    return release(record);
  }
  function current(record) {
    if (record.closed) throw fault(record.reason);
    let authority;
    try { authority = authorityFor(record.target); } catch { /* Fail closed on invalid/deleted records. */ }
    if (authority !== record.authority) {
      evict(record, 'AUTHORITY_CHANGED'); throw fault('AUTHORITY_CHANGED');
    }
    if (record.remote?.peer.closed) {
      evict(record, 'TRANSPORT_LOST'); throw fault('TRANSPORT_LOST');
    }
  }
  function expire(record) {
    if (record.closed || record.active || record.idleAt === null) return;
    if (now() - record.idleAt >= BROKER_LIMITS.idleMs) evict(record, 'BINDING_EXPIRED');
    else arm(record);
  }
  function arm(record) {
    clearTimeout(record.timer);
    if (record.closed || record.active || record.idleAt === null) return;
    const delay = Math.max(1, Math.min(BROKER_LIMITS.idleMs, BROKER_LIMITS.idleMs - (now() - record.idleAt)));
    record.timer = setTimeout(() => expire(record), delay); record.timer.unref?.();
  }
  function idle(record) { record.idleAt = now(); arm(record); }
  function lookup(binding) {
    exact(binding, BINDING_KEYS);
    if (BINDING_KEYS.some(key => !text(binding[key]))) throw fault('INVALID_REQUEST');
    const record = records.get(binding.id);
    if (!record?.binding) throw fault('BINDING_GONE');
    if (BINDING_KEYS.some(key => binding[key] !== record.binding[key])) throw fault('BINDING_MISMATCH');
    current(record); expire(record);
    if (record.closed) throw fault(record.reason);
    return record;
  }
  async function acquire(record, machine) {
    if (machine) {
      const remote = await connect(machine, { signal: record.controller.signal });
      // Install cleanup before any validation or authority/cancellation check.
      record.cleanup = () => remote?.close?.(); record.remote = remote;
      if (record.closed) { await release(record); throw fault(record.reason); }
      if (typeof remote?.close !== 'function' || typeof remote?.peer?.request !== 'function') throw fault('INCOMPATIBLE_PROTOCOL');
      const hello = checkHello(remote.hello);
      // Transport loss revokes only this SSH attachment, not the resident runtime.
      if (remote.peer.done?.then) Promise.resolve(remote.peer.done).then(
        () => evict(record, 'TRANSPORT_LOST'), () => evict(record, 'TRANSPORT_LOST'),
      ).catch(() => {});
      return hello;
    }
    const adapter = await localAdapterFactory(ctx, { runtimeId: LOCAL_RUNTIME_ID, instanceId: LOCAL_INSTANCE_ID });
    current(record);
    if (typeof adapter?.client !== 'function') throw fault('INCOMPATIBLE_DSH');
    const client = adapter.client();
    record.cleanup = () => client?.dispose?.(); record.client = client;
    if (typeof client?.handle !== 'function' || typeof client?.dispose !== 'function') throw fault('INCOMPATIBLE_DSH');
    const hello = checkHello(adapter.hello);
    if (hello.runtimeId !== LOCAL_RUNTIME_ID || hello.instanceId !== LOCAL_INSTANCE_ID) throw fault('RUNTIME_CHANGED');
    return hello;
  }
  async function attach(body, signal) {
    available(); exact(body, ['target', 'expectedRuntimeId', 'expectedInstanceId']);
    if (!text(body.target, 128) || ['expectedRuntimeId', 'expectedInstanceId'].some(key =>
      body[key] !== undefined && !text(body[key]))) throw fault('INVALID_REQUEST');
    cancelled(signal);
    const { target, expectedRuntimeId, expectedInstanceId } = body;
    // Reap expired/changed attachments before admission; pending handshakes count.
    reconcile();
    if (records.size >= BROKER_LIMITS.attachments) throw fault('BUSY');
    const configured = machineFor(target);
    let machine;
    try { machine = configured ? structuredClone(configured) : null; } catch { throw fault('INVALID_MACHINE'); }
    const record = { id: randomUUID(), target,
      authority: machine ? machineIdentity(machine) : LOCAL_AUTHORITY,
      controller: new AbortController(), active: 1, idleAt: null, closed: false };
    records.set(record.id, record);
    const abort = () => evict(record, 'CANCELLED');
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      current(record);
      record.hello = await abortable(acquire(record, machine), record.controller.signal);
      current(record); cancelled(signal);
      if ((expectedRuntimeId !== undefined && expectedRuntimeId !== record.hello.runtimeId) ||
          (expectedInstanceId !== undefined && expectedInstanceId !== record.hello.instanceId)) throw fault('RUNTIME_CHANGED');
      record.binding = Object.freeze({ id: record.id, target: record.target, authority: record.authority,
        runtimeId: record.hello.runtimeId, instanceId: record.hello.instanceId });
      record.active = 0; idle(record);
      return { binding: { ...record.binding }, hello: structuredClone(record.hello) };
    } catch (error) {
      await evict(record, error?.code ?? 'ATTACH_FAILED'); throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async function execute(body, signal) {
    available(); exact(body, ['binding', 'method', 'params']); cancelled(signal);
    const record = lookup(body.binding);
    checkOperation(body.method, body.params, record.hello);
    // Copy before any await: the caller cannot retarget a request already admitted.
    let params;
    try { params = structuredClone(body.params); } catch { throw fault('INVALID_REQUEST'); }
    const mutation = !!record.remote && (body.method === 'event-result' ||
      (body.method === 'call' && !READS.has(params.endpoint)));
    const operationSignal = signal ? AbortSignal.any([signal, record.controller.signal]) : record.controller.signal;
    record.active++; clearTimeout(record.timer);
    try {
      const reply = await abortable(record.remote
        ? record.remote.peer.request(body.method, params, { signal: operationSignal })
        : record.client.handle(body.method, params, operationSignal), operationSignal);
      current(record); cancelled(signal);
      return reply;
    } catch (error) {
      if (LOST.has(error?.code)) evict(record, error.code);
      if (mutation) throw fault('UNKNOWN_MUTATION_OUTCOME', 'The remote mutation may have run. Reattach and inspect runtime state; do not automatically replay it.');
      throw error;
    } finally {
      record.active--;
      if (!record.closed && !record.active) idle(record);
    }
  }
  async function detach(body) {
    available(); exact(body, ['binding']);
    // Require the complete pinned capability, even for observer disposal.
    const record = lookup(body.binding);
    await evict(record);
    return { detached: true };
  }
  function reconcile() {
    let evicted = 0;
    for (const record of [...records.values()]) {
      try { current(record); expire(record); } catch { /* current already revoked it. */ }
      if (record.closed) evicted++;
    }
    return { evicted };
  }
  function dispose() {
    if (!disposal) {
      disposed = true;
      disposal = Promise.allSettled([...records.values()].map(record => evict(record, 'BROKER_DISPOSED'))).then(() => undefined);
    }
    return disposal;
  }
  return Object.freeze({ attach, execute, detach, reconcile, dispose });
}
