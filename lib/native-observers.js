// Forward resident control/events through the existing native Host BFF. There
// is no client contribution and no replacement Gateway or remote UI bundle.
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { fault } from './protocol.js';

function queue(signal, limit = 2048) {
  const items = []; let wake, failure, done = false;
  const end = () => { done = true; wake?.(); };
  signal.addEventListener('abort', end, { once: true });
  return {
    push(value) { if (done) return; if (items.length >= limit) { failure = fault('OBSERVER_OVERFLOW'); end(); } else { items.push(value); wake?.(); } },
    fail(error) { failure = error; end(); },
    async *[Symbol.asyncIterator]() {
      try {
        while (!done && !signal.aborted) { if (items.length) yield items.shift(); else await new Promise(resolve => { wake = resolve; }); }
        if (failure) throw failure;
      } finally { end(); signal.removeEventListener('abort', end); }
    },
  };
}

export function createNativeObservers(ctx, { bindings, transport }) {
  const lifetime = new AbortController(), targets = new Map(), listeners = new Set(), projections = new Map();
  const pending = new Map();
  const identity = binding => JSON.stringify([binding.target, binding.authority, binding.runtimeId, binding.instanceId]);
  const bindingFor = (source, id) => [...bindings.values()].find(b => identity(b) === identity(source) && b.remoteSessionId === id);
  const broadcast = frame => { for (const listener of listeners) listener.push(frame); };
  function projection(binding, key, value, seq) {
    const current = projections.get(binding.sessionId) ?? { asOfSeq: seq, values: {} };
    projections.set(binding.sessionId, { asOfSeq: Math.max(current.asOfSeq, seq), values: { ...current.values, [key]: value } });
    broadcast({ type: 'projection', sessionId: binding.sessionId, key, value, seq });
  }
  async function events(binding, ready, signal) {
    let clientId;
    for await (const frame of transport.stream(binding, '$events', [], signal)) {
      if (frame.type === 'ready') { clientId = frame.clientId; ready(); continue; }
      if (frame.type === 'cancel') { pending.get(identity(binding) + '/' + clientId + '/' + frame.eventId)?.abort(); continue; }
      if (frame.type === 'emit') {
        if (!['api-session/added', 'api-session/status', 'api-session/activity', 'api-session/error', 'api-session/removed'].includes(frame.event)) continue;
        const remoteId = frame.event === 'api-session/added' ? frame.args[0]?.sessionId : frame.args[0];
        const owner = bindingFor(binding, remoteId); if (!owner) continue;
        const args = frame.event === 'api-session/added'
          ? [{ ...frame.args[0], sessionId: owner.sessionId, cwd: owner.cwd }]
          : [owner.sessionId, ...frame.args.slice(1)];
        ctx.emit(frame.event, ...args); continue;
      }
      if (frame.type !== 'waterfall' || !clientId) continue;
      const owner = bindingFor(binding, frame.agentId);
      if (!owner || !['approval/request', 'user-questions/request'].includes(frame.event)) {
        // This observation must not hold another session's pending waterfall.
        await transport.eventResult(binding, { clientId, eventId: frame.eventId, outcome: { kind: 'next' } });
        continue;
      }
      const key = identity(binding) + '/' + clientId + '/' + frame.eventId;
      if (pending.has(key)) continue;
      const controller = new AbortController(); pending.set(key, controller);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      const agent = { id: owner.sessionId }, scope = createScope(ctx, agent); agent.ctx = scope.ctx;
      const request = { ...frame.request, agent, signal: controller.signal };
      // Only answerer waterfall dispatch: never ask the local ApprovalService to
      // own this action or write audit records. The real owner is remote DSH.
      const task = (async () => {
        const delegated = Symbol('delegate');
        try {
          const value = await ctx.waterfall(scopeTarget(agent, agent), frame.event, request, () => Promise.resolve(delegated));
          if (!controller.signal.aborted && !lifetime.signal.aborted) await transport.eventResult(owner, {
            clientId, eventId: frame.eventId, outcome: value === delegated ? { kind: 'next' } : { kind: 'result', value },
          });
        } catch (error) {
          if (!controller.signal.aborted && !lifetime.signal.aborted) await transport.eventResult(owner, {
            clientId, eventId: frame.eventId, outcome: { kind: 'rejected', error: { name: 'RemoteAnswerFailed', message: 'Native answerer could not complete the request.', ...(error?.code === 'ASK_TIMED_OUT' ? { code: 'ASK_TIMED_OUT' } : {}) } },
          }).catch(() => {});
        } finally { pending.delete(key); signal.removeEventListener('abort', abort); await scope.dispose(); }
      })();
      task.catch(() => {});
    }
  }
  async function control(binding, signal) {
    for await (const frame of transport.stream(binding, 'session/control', [], signal)) {
      if (frame.type === 'baseline') {
        for (const [remoteId, block] of Object.entries(frame.value.projections)) {
          const owner = bindingFor(binding, remoteId); if (!owner) continue;
          for (const [key, value] of Object.entries(block.values)) projection(owner, key, value, block.asOfSeq);
        }
      } else if (frame.type === 'projection') {
        const owner = bindingFor(binding, frame.sessionId);
        if (owner) projection(owner, frame.key, frame.value, frame.seq);
      }
    }
  }
  function ensure(binding) {
    const key = identity(binding);
    if (targets.has(key)) return targets.get(key).ready;
    if (lifetime.signal.aborted) return Promise.reject(fault('PROXY_UNAVAILABLE'));
    const report = error => {
      if (!lifetime.signal.aborted) for (const owner of bindings.values()) if (identity(owner) === key) ctx.emit('api-session/error', owner.sessionId, 'Remote observation lost; reconnect required (' + (error.code || 'TRANSPORT_LOST') + ').');
    };
    let resolve, reject;
    const controller = new AbortController(), abort = () => controller.abort();
    lifetime.signal.addEventListener('abort', abort, { once: true });
    const ready = new Promise((yes, no) => { resolve = yes; reject = no; }); ready.catch(() => {});
    const entry = { jobs: [], ready, controller }; targets.set(key, entry);
    let failed = false;
    const ended = error => {
      if (failed) return; failed = true;
      reject(error); controller.abort();
      if (targets.get(key) === entry) targets.delete(key);
      lifetime.signal.removeEventListener('abort', abort); report(error);
    };
    entry.jobs = [events(binding, resolve, controller.signal), control(binding, controller.signal)].map(job => job.then(() => ended(fault('REMOTE_OBSERVER_ENDED')), ended));
    return ready;
  }
  return {
    ensure,
    async *control(localFactory, signal) {
      const controller = new AbortController(), stop = () => controller.abort();
      signal.addEventListener('abort', stop, { once: true }); lifetime.signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted || lifetime.signal.aborted) stop();
      const channel = queue(controller.signal); listeners.add(channel);
      const iterator = localFactory(controller.signal)[Symbol.asyncIterator]();
      try {
        const first = await iterator.next();
        if (first.done || first.value.type !== 'baseline') throw fault('INCOMPATIBLE_DSH');
        const native = Object.fromEntries(Object.entries(first.value.value.projections).filter(([id]) => !bindings.has(id)));
        yield { type: 'baseline', value: { projections: { ...native, ...Object.fromEntries(projections) } } };
        const pump = (async () => { for (let item = await iterator.next(); !item.done && !controller.signal.aborted; item = await iterator.next()) if (!bindings.has(item.value.sessionId)) channel.push(item.value); })().catch(error => channel.fail(error));
        pump.catch(() => {});
        yield* channel;
      } finally {
        stop(); listeners.delete(channel); signal.removeEventListener('abort', stop); lifetime.signal.removeEventListener('abort', stop);
        await Promise.resolve(iterator.return?.()).catch(() => {});
      }
    },
    async dispose() {
      lifetime.abort(); for (const controller of pending.values()) controller.abort();
      await Promise.allSettled([...targets.values()].flatMap(value => value.jobs)); targets.clear();
    },
  };
}
