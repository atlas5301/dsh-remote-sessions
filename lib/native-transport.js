import { connectSsh } from './ssh-carrier.js';
import { machineIdentity } from './authority.js';
import { fault } from './protocol.js';
import { forwardUpload } from './upload-relay.js';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';

// Backend-owned links. No prompt replay, no local fallback. The only process
// this module can start is the strict SSH byte relay; automatic remote setup,
// when configured, runs before a connect retry and never executes agents.
function setupEligible(machine) {
  // Only normalized machines with an explicit node path may auto-provision; a
  // raw fixture transport without remoteNode is never touched.
  return machine.autoSetup !== false && typeof machine.remoteNode === 'string' && machine.remoteNode.startsWith('/');
}
export function createNativeTransport(registry, { connect = connectSsh, setup, adopt } = {}) {
  const links = new Map(), lifetime = new AbortController();
  function machine(target) {
    const value = registry.machines.find(item => item.name === target);
    if (!value || value.disabled || value.migrationRequired) throw fault('REMOTE_MACHINE_UNAVAILABLE');
    return value;
  }
  async function link(binding) {
    lifetime.signal.throwIfAborted();
    const config = machine(binding.target), authority = machineIdentity(config);
    if (binding.authority && binding.authority !== authority) throw fault('AUTHORITY_CHANGED');
    let opening = links.get(binding.target);
    if (!opening) {
      opening = (async () => {
        try {
          return await connect(config, { signal: lifetime.signal });
        } catch (error) {
          // A resident that is merely not running is distinct from an
          // unreachable host: ask the setup facade (probe + provision/start)
          // before failing. It never stops or replaces a running resident.
          if (!setup || !setupEligible(config)) throw error;
          let setupFailure;
          try { await setup.ensure(config, lifetime.signal, {}); }
          catch (attempt) { setupFailure = attempt; }
          try {
            return await connect(config, { signal: lifetime.signal });
          } catch (retry) {
            throw fault('REMOTE_SETUP_FAILED',
              `Remote runtime unavailable after automatic setup (${retry.code || 'TRANSPORT_LOST'}${setupFailure ? '; setup: ' + (setupFailure.code || 'SETUP_FAILED') : ''}).`);
          }
        }
      })().then(connection => {
        connection.peer.done.finally(() => { if (links.get(binding.target) === opening) links.delete(binding.target); }).catch(() => {});
        return { ...connection, authority };
      }).catch(error => { if (links.get(binding.target) === opening) links.delete(binding.target); throw error; });
      links.set(binding.target, opening);
    }
    const value = await opening;
    if (authority !== value.authority || machineIdentity(machine(binding.target)) !== authority) throw fault('AUTHORITY_CHANGED');
    if (binding.runtimeId && binding.runtimeId !== value.hello.runtimeId) throw fault('RUNTIME_CHANGED');
    if (binding.instanceId && binding.instanceId !== value.hello.instanceId) {
      // A resident restart changes the instance id while the session store
      // PERSISTS. The adopt hook verifies the bound session survived and
      // rebinds durably; without it (or when the session is gone) the
      // binding fails closed exactly as before.
      const adopted = binding.remoteSessionId && typeof adopt === 'function' ? await adopt(binding, value) : null;
      if (!adopted) throw fault('INSTANCE_CHANGED');
    }
    return value;
  }
  async function call(binding, endpoint, values, signal) {
    signal?.throwIfAborted();
    const connection = await link(binding);
    signal?.throwIfAborted();
    let result;
    try {
      result = await connection.peer.request('call', { endpoint, values,
        ...(endpoint === 'session/selectModel' ? { confirmDefaultChange: true } : {}),
      }, { signal });
    } catch (error) {
      if (['session/create', 'session/prompt', 'session/cancel', 'session/rename', 'session/selectModel', 'session/updateQueue', 'session/fork', 'commands/execute'].includes(endpoint)) throw fault('UNKNOWN_MUTATION_OUTCOME');
      throw error;
    }
    if (!result.ok) throw new RemoteError(result.error.code, result.error.message, result.error.details ?? {});
    return result.value;
  }
  return {
    async identify(target) { const connection = await link({ target }); return { target, authority: connection.authority, runtimeId: connection.hello.runtimeId, instanceId: connection.hello.instanceId }; },
    call,
    async *stream(binding, endpoint, values, signal) {
      const connection = await link(binding);
      const { streamId } = await connection.peer.request('open', { endpoint, values }, { signal });
      try {
        while (!signal?.aborted && !lifetime.signal.aborted) {
          const batch = await connection.peer.request('next', { streamId, waitMs: 25000 }, { signal });
          yield* batch.items;
          if (batch.done) return;
        }
      } finally { await connection.peer.request('close', { streamId }, { timeoutMs: 2000 }).catch(() => {}); }
    },
    async eventResult(binding, params) { const connection = await link(binding); return connection.peer.request('event-result', params); },
    async upload(binding, request) {
      const connection = await link(binding);
      return forwardUpload((method, params, signal) => connection.peer.request(method, params, { signal }), request);
    },
    async dispose() {
      lifetime.abort(); const existing = [...links.values()]; links.clear();
      for (const pending of existing) { try { (await pending).close(); } catch {} }
    },
  };
}
