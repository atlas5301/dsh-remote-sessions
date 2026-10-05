// Backend-only overlay. The native DSH session Remote descriptors and frontend
// remain unchanged. Like dsh-remote's fileReferences overlay, only the owning
// service instance is wrapped; ordinary local calls retain their original receiver.
import { randomUUID } from 'node:crypto';
import { fault } from './protocol.js';
import { UPLOAD_CHUNK_BYTES } from './upload-relay.js';
import { createNativeObservers } from './native-observers.js';

const COMMANDS = ['prompt', 'cancel', 'rename', 'selectModel', 'updateQueue', 'attachment', 'projections'];
const READS = ['page', 'follow'];

/**
 * Production native-service overlay, installed by native-host after storage readiness.
 * bindings: durable get/has/values/set store of pinned local/remote session identities.
 * resolveWorkspace(cwd): explicit remote target binding or null for ordinary local.
 * transport.call(binding, endpoint, values, signal): native domain result, not envelope.
 * transport.stream(binding, endpoint, values, signal): native frames.
 */
export function installNativeSessionProxy(ctx, { bindings, resolveWorkspace, transport }) {
  const service = ctx.sessionController;
  const observers = createNativeObservers(ctx, { bindings, transport });
  const identity = binding => JSON.stringify([binding.target, binding.authority, binding.runtimeId, binding.instanceId]);
  const originals = new Map(), wrappers = new Map(), creations = new Map(), shells = new Map(), restoreAgents = [], teardown = [];
  let disposed = false;
  const installed = (owner, name, fn) => Object.getOwnPropertyDescriptor(owner, name)?.value === fn;
  const restore = () => {
    disposed = true;
    for (const { detach } of shells.values()) detach(); shells.clear();
    for (const revert of restoreAgents.reverse()) { const result = revert(); if (result?.then) { teardown.push(result); result.catch(() => {}); } } restoreAgents.length = 0;
    for (const [name, wrapper] of wrappers) if (installed(service, name, wrapper)) service[name] = originals.get(name);
  };
  try {
  for (const name of ['create', 'list', 'resolveAgent', ...COMMANDS, ...READS, 'fork', 'control', 'search', 'modelCatalog']) {
    if (typeof service?.[name] !== 'function') throw fault('INCOMPATIBLE_DSH');
    originals.set(name, service[name]);
  }
  // Some other native domains resolve Agents through their own retained resolver,
  // not sessionController.resolveAgent. Fence the public factory too: a metadata
  // shell must NEVER be resumed into a local AgentLoop.
  for (const name of ['create', 'resume']) {
    const registry = ctx.agents, original = registry?.[name];
    if (typeof original !== 'function') throw fault('INCOMPATIBLE_DSH');
    const wrapper = function (options) {
      if (bindings.has(options.sessionId)) throw fault('REMOTE_AGENT_REQUIRES_FORWARDING');
      return original.call(this, options);
    };
    registry[name] = wrapper;
    restoreAgents.push(() => { if (installed(registry, name, wrapper)) registry[name] = original; });
  }
  const uploads = ctx.fileUploads, originalUpload = uploads?.uploadStream;
  if (typeof originalUpload !== 'function') throw fault('INCOMPATIBLE_DSH');
  const uploadWrapper = function (request) {
    const binding = bindings.get(request.sessionId);
    if (!binding) return originalUpload.call(this, request);
    alive();
    return transport.upload(binding, { ...request, sessionId: binding.remoteSessionId });
  };
  uploads.uploadStream = uploadWrapper;
  restoreAgents.push(() => { if (installed(uploads, 'uploadStream', uploadWrapper)) uploads.uploadStream = originalUpload; });
  // Encoded native upload resolves an Agent before reaching fileUploads.upload.
  // Decorate the PUBLIC provider lookup, not the private SessionController resolver.
  // The proxy token is accepted only by our upload wrapper; other Agent operations
  // remain fenced. No registry publication or local AgentLoop is involved.
  const typert = ctx.typert, tokens = new Map();
  const ownLookups = Object.getOwnPropertyDescriptor(typert, 'lookups');
  let prototype = typert, lookupDescriptor;
  while (prototype && !lookupDescriptor) { lookupDescriptor = Object.getOwnPropertyDescriptor(prototype, 'lookups'); prototype = Object.getPrototypeOf(prototype); }
  if (typeof lookupDescriptor?.get !== 'function') throw fault('INCOMPATIBLE_DSH');
  const lookupGetter = function () {
    const view = lookupDescriptor.get.call(this);
    return { ...view, get(key) {
      const provider = view.get(key);
      if (key !== 'agent' || !provider) return provider;
      return { ...provider, resolve(id) {
        if (!bindings.has(id)) return provider.resolve(id);
        alive();
        if (!tokens.has(id)) tokens.set(id, Object.freeze({ id }));
        return tokens.get(id);
      } };
    } };
  };
  Object.defineProperty(typert, 'lookups', { configurable: true, get: lookupGetter });
  restoreAgents.push(() => { if (Object.getOwnPropertyDescriptor(typert, 'lookups')?.get === lookupGetter) { if (ownLookups) Object.defineProperty(typert, 'lookups', ownLookups); else delete typert.lookups; } });
  const originalEncoded = uploads.upload;
  const encodedWrapper = function (agent, request, signal) {
    const binding = bindings.get(agent.id);
    if (!binding) return originalEncoded.call(this, agent, request, signal);
    alive();
    if (tokens.get(agent.id) !== agent || typeof request.data !== 'string' || request.data.length % 4) throw fault('INVALID_UPLOAD');
    const data = { async *[Symbol.asyncIterator]() {
      const chars = UPLOAD_CHUNK_BYTES * 4 / 3;
      for (let offset = 0; offset < request.data.length; offset += chars) {
        const encoded = request.data.slice(offset, offset + chars), bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded) throw fault('INVALID_UPLOAD');
        yield bytes;
      }
    } };
    return transport.upload(binding, { sessionId: binding.remoteSessionId, data, name: request.name, signal });
  };
  uploads.upload = encodedWrapper;
  restoreAgents.push(() => { if (installed(uploads, 'upload', encodedWrapper)) uploads.upload = originalEncoded; });
  // Native composer discovery/commands are Agent-looked-up APIs as well. Forward
  // them before any local tool/command implementation receives a proxy token.
  for (const [serviceKey, method, endpoint] of [
    ['commands', 'list', 'commands/list'], ['commands', 'execute', 'commands/execute'],
    ['sessionFileReferences', 'list', 'fileReferences/list'],
  ]) {
    const owner = ctx.get?.(serviceKey), original = owner?.[method];
    if (typeof original !== 'function') continue;
    const wrapper = function (agent, ...args) {
      const binding = bindings.get(agent?.id);
      if (!binding) return original.call(this, agent, ...args);
      alive();
      const signal = args.at(-1) instanceof AbortSignal ? args.pop() : undefined;
      return transport.call(binding, endpoint, [binding.remoteSessionId, ...args], signal);
    };
    owner[method] = wrapper;
    restoreAgents.push(() => { if (installed(owner, method, wrapper)) owner[method] = original; });
  }
  // Optional timed question service may load after this plugin. Its native UI
  // opens attachWait and sends late answers separately from the $events result.
  const questionFiber = ctx.inject(['userQuestions'], inner => {
    const owner = inner.userQuestions;
    for (const method of ['answer', 'attachWait']) {
      const original = owner[method]; if (typeof original !== 'function') continue;
      const wrapper = function (agent, callId, ...args) {
        const binding = bindings.get(agent.id);
        if (!binding) return original.call(this, agent, callId, ...args);
        alive();
        const signal = args.at(-1) instanceof AbortSignal ? args.pop() : undefined;
        return method === 'attachWait'
          ? transport.stream(binding, 'userQuestions/attachWait', [binding.remoteSessionId, callId], signal)
          : transport.call(binding, 'userQuestions/answer', [binding.remoteSessionId, callId, ...args], signal);
      };
      owner[method] = wrapper;
      inner.effect(() => () => { if (installed(owner, method, wrapper)) owner[method] = original; });
    }
  });
  restoreAgents.push(() => questionFiber.dispose());
  const skills = ctx.get?.('sessionSkillCatalog'), originalSkills = skills?.list;
  if (typeof originalSkills === 'function') {
    const wrapper = function (request, signal) {
      const binding = bindings.get(request.sessionId);
      if (!binding) return originalSkills.call(this, request, signal);
      alive(); return transport.call(binding, 'skills/list', [{ ...request, sessionId: binding.remoteSessionId }], signal);
    };
    skills.list = wrapper; restoreAgents.push(() => { if (installed(skills, 'list', wrapper)) skills.list = originalSkills; });
  }
  function alive() { if (disposed) throw fault('PROXY_UNAVAILABLE'); }
  /** Restored bindings whose workspace membership still needs re-registration.
   * The writes cannot run during plugin apply — the storage-domain write chain
   * defers them until the boot transaction completes (observed live: the
   * attach hung when fired at restore time) — so they run on the first list. */
  const membershipPending = new Set();
  /** Re-register a session's workspace membership. The registry rebuilds its
   * in-memory session-path index at startup from the LOCAL session store;
   * remote-bound shells have no local journal, so after every local restart
   * the workspace getter filtered ALL remote sessions out of membership
   * (operator-reported: empty workspace lists). A detach+attach cycle re-runs
   * the member registration: attach validates the live shell's header and
   * remembers the canonical path (attach alone skips existing members). */
  async function rebindWorkspaceMembership(binding) {
    const registry = ctx.workspaceRegistry;
    const entity = typeof registry?.resolveByPath === 'function' ? await registry.resolveByPath(binding.cwd).catch(() => null) : null;
    if (!entity || typeof entity.attachSession !== 'function') return;
    if (typeof entity.detachSession === 'function') await entity.detachSession(binding.sessionId);
    await entity.attachSession(binding.sessionId);
  }
  function shell(binding) {
    if (shells.has(binding.sessionId)) return;
    if (ctx.sessions.get(binding.sessionId) || ctx.agents.get(binding.sessionId)) throw fault('REMOTE_BINDING_CONFLICT');
    const session = ctx.sessions.prepare(binding.sessionId, { meta: { cwd: binding.cwd } });
    const detach = ctx.sessions.enter(session);
    shells.set(binding.sessionId, { session, detach });
    try { ctx.sessions.announce(session); }
    catch (error) { detach(); shells.delete(binding.sessionId); throw error; }
  }
  /** Remove a local shell + durable binding for a session the remote store
   * no longer knows. The workspace membership row stays (native workspaces
   * keep their own archive); the session disappears from the list. */
  async function unbind(binding) {
    shells.get(binding.sessionId)?.detach();
    shells.delete(binding.sessionId);
    await bindings.delete(binding.sessionId);
    ctx.emit('api-session/removed', binding.sessionId);
  }
  function wrap(name, handler) {
    const original = originals.get(name);
    const wrapper = function (...args) { return handler.call(this, original, ...args); };
    service[name] = wrapper; wrappers.set(name, wrapper);
  }
  function remoteRequest(binding, request) {
    if (request.address) {
      if (request.address.kind === 'subagent') return { ...request, address: { ...request.address, parentSessionId: binding.remoteSessionId } };
      if (request.address.kind !== 'session') throw fault('UNSUPPORTED_REMOTE_ADDRESS');
      return { ...request, address: { ...request.address, sessionId: binding.remoteSessionId } };
    }
    return { ...request, sessionId: binding.remoteSessionId };
  }
  function localFrame(binding, frame, request) {
    if (frame.type === 'snapshot') {
      const child = request.address.kind === 'subagent';
      if (frame.header?.id !== (child ? request.address.childSessionId : binding.remoteSessionId) || frame.header?.version !== 4) throw fault('INVALID_REMOTE_SESSION');
      return { ...frame, header: { ...frame.header, id: child ? frame.header.id : binding.sessionId, cwd: binding.cwd, ...(child ? { parentSession: binding.sessionId } : {}) } };
    }
    return frame;
  }
  wrap('create', async function (original, request) {
    alive();
    if (request.workspaceId !== undefined && request.cwd !== undefined) throw fault('INVALID_REQUEST');
    const workspace = request.workspaceId === undefined ? undefined : ctx.workspaceRegistry.get(request.workspaceId);
    // Let the native method retain its own invalid-workspace handling.
    if (request.workspaceId !== undefined && !workspace) return original.call(this, request);
    const cwd = workspace?.path ?? request.cwd ?? process.cwd();
    const target = await resolveWorkspace(cwd);
    if (!target) {
      if (request.sessionId && bindings.has(request.sessionId)) throw fault('REMOTE_BINDING_CONFLICT');
      return original.call(this, request);
    }
    const sessionId = request.sessionId ?? `session-${randomUUID()}`;
    const existing = bindings.get(sessionId);
    if (existing && (existing.cwd !== cwd || existing.target !== target.target || existing.remoteCwd !== target.remoteCwd)) throw fault('REMOTE_BINDING_CONFLICT');
    if ((ctx.sessions?.get(sessionId) && ctx.sessions.get(sessionId) !== shells.get(sessionId)?.session) || ctx.agents?.get(sessionId)) throw fault('REMOTE_BINDING_CONFLICT');
    const signature = JSON.stringify([cwd, target.target, target.remoteCwd, target.authority, target.runtimeId, target.instanceId, request.agentPreset]);
    if (creations.has(sessionId)) {
      const inflight = creations.get(sessionId);
      if (inflight.signature !== signature) throw fault('REMOTE_BINDING_CONFLICT');
      return inflight.task;
    }
    const receiver = this;
    const task = (async () => {
      if (!existing && request.sessionId !== undefined) {
        const local = await originals.get('list').call(receiver, {}, new AbortController().signal);
        if (local.items.some(item => item.sessionId === sessionId)) throw fault('REMOTE_BINDING_CONFLICT');
      }
      // Reserve BEFORE the remote mutation: an unknown reply must not make this
      // id eligible for accidental local activation or another remote target.
      const binding = existing ?? { ...target, sessionId, remoteSessionId: sessionId, cwd };
      if (existing && ['authority', 'runtimeId', 'instanceId'].some(key => existing[key] !== target[key])) throw fault('REMOTE_BINDING_CONFLICT');
      await bindings.set(sessionId, binding);
      await observers.ensure(binding);
      const result = await transport.call(binding, 'session/create', [{ sessionId: binding.remoteSessionId, cwd: binding.remoteCwd, ...(request.agentPreset ? { agentPreset: request.agentPreset } : {}) }]);
      if (result.sessionId !== binding.remoteSessionId) throw fault('INVALID_REMOTE_SESSION');
      alive(); shell(binding);
      if (workspace) await workspace.attachSession(sessionId);
      // Session publication emits a native empty-shell summary. Immediately
      // replace that placeholder with the remote owner's real availability/title.
      try {
        const listing = await transport.call(binding, 'session/list', [{}]);
        const row = listing.items.find(item => item.sessionId === binding.remoteSessionId);
        if (!disposed && row) ctx.emit('api-session/added', { ...row, sessionId, cwd });
      } catch { /* creation already committed; next native list/follow reconciles */ }
      return { ...result, sessionId };
    })();
    creations.set(sessionId, { signature, task });
    try { return await task; } finally { creations.delete(sessionId); }
  });
  const adopting = new Map();
  /** A session created through ANOTHER remote interface (remote web, an
   * earlier binding era) never appears in the local session list — the list
   * only knows bound ids (operator-reported: "remote on-going session is not
   * properly synced to the local side"). Adopt workspace-mapped remote
   * sessions on first sight: bind + local shell + announce, so the session
   * list, transcript and live follow all sync through the ordinary paths. */
  async function adoptRemoteSessions(binding, remoteItems, signal) {
    if (!Array.isArray(remoteItems) || !remoteItems.length) return [];
    if (typeof resolveWorkspace?.snapshot !== 'function') return [];
    const mappings = resolveWorkspace.snapshot().filter(mapping => mapping.target === binding.target);
    if (!mappings.length) return [];
    const rows = [];
    for (const candidate of remoteItems) {
      const sessionId = candidate?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId || adopting.has(sessionId)) continue;
      if ([...bindings.values()].some(b => b.target === binding.target && b.remoteSessionId === sessionId)) continue;
      if (bindings.has(sessionId) || ctx.sessions?.get?.(sessionId) || ctx.agents?.get?.(sessionId)) continue; // never steal a local id
      const mapping = mappings.find(value => value.remotePath === candidate.cwd);
      if (!mapping) continue; // sessions of unmapped remote directories stay invisible
      adopting.set(sessionId, true);
      let adopted;
      try {
        const identityNow = await transport.identify(binding.target);
        adopted = { sessionId, remoteSessionId: sessionId, target: binding.target,
          cwd: mapping.localPath, remoteCwd: candidate.cwd,
          authority: identityNow.authority, runtimeId: identityNow.runtimeId, instanceId: identityNow.instanceId };
        await bindings.set(sessionId, adopted);
        shell(adopted);
        await observers.ensure(adopted).catch(() => {});
        await rebindWorkspaceMembership({ ...adopted, cwd: mapping.localPath, sessionId }).catch(() => {});
        ctx.emit('api-session/added', { ...candidate, sessionId, cwd: mapping.localPath });
        rows.push({ ...candidate, sessionId, cwd: mapping.localPath });
      } catch (error) {
        signal?.throwIfAborted?.();
        // Adoption is best-effort: a failed candidate retries on the next list.
      } finally { adopting.delete(sessionId); }
    }
    return rows;
  }
  wrap('list', async function (original, request, signal) {
    alive();
    // Post-boot: re-register restored sessions' workspace membership (see
    // membershipPending). One attempt per restore; the adoption path rebinds
    // directly (it never runs inside the boot transaction).
    for (const id of [...membershipPending]) {
      const binding = bindings.get(id);
      membershipPending.delete(id);
      if (binding) rebindWorkspaceMembership(binding).catch(() => {});
    }
    const local = await original.call(this, request, signal);
    const items = [...local.items.filter(item => !bindings.has(item.sessionId))];
    const byTarget = new Map();
    // Snapshot: rows adopted below join on the NEXT list, never this one.
    for (const binding of [...bindings.values()]) {
      let remote = byTarget.get(identity(binding));
      if (!remote) {
        try { await observers.ensure(binding); remote = await transport.call(binding, 'session/list', [request], signal); }
        catch (error) {
          signal?.throwIfAborted();
          remote = { items: [], offline: true };
          ctx.emit('api-session/error', binding.sessionId, 'Remote target unavailable; execution remains remote (' + (error.code || 'TRANSPORT_LOST') + ').');
        }
        byTarget.set(identity(binding), remote);
        if (!remote.offline) {
          // Remote-created sessions of mapped workspaces join the local list.
          for (const row of await adoptRemoteSessions(binding, remote.items, signal).catch(() => [])) items.push(row);
          // The remote store is authoritative: a bound session that is
          // CONFIRMED absent from an unfiltered list (a failed create that
          // reserved its binding, or a session deleted on the remote side)
          // must stop haunting the local list as an offline ghost.
          const unfiltered = !request || !Object.keys(request).some(key => request[key] !== undefined);
          if (unfiltered) {
            const known = new Set(remote.items.map(item => item.sessionId));
            for (const other of [...bindings.values()]) {
              if (other.target !== binding.target || known.has(other.remoteSessionId)) continue;
              if (creations.has(other.sessionId)) continue; // its remote create is still in flight
              try { await unbind(other); } catch { /* a failed ghost stays until the next list */ }
            }
          }
        }
      }
      const item = remote.items.find(item => item.sessionId === binding.remoteSessionId);
      if (item) items.push({ ...item, sessionId: binding.sessionId, cwd: binding.cwd });
      else if (remote.offline) items.push({ sessionId: binding.sessionId, cwd: binding.cwd, agentAvailable: false, running: false, blank: false, updatedAt: 0 });
    }
    return { ...local, items: items.sort((a, b) => b.updatedAt - a.updatedAt) };
  });
  wrap('search', async function (original, request, signal) {
    const local = await original.call(this, request, signal), items = [...local.items.filter(item => !bindings.has(item.sessionId))];
    let hasMore = local.hasMore;
    const targets = new Set();
    for (const binding of bindings.values()) {
      if (targets.has(identity(binding))) continue; targets.add(identity(binding));
      const result = await transport.call(binding, 'session/search', [request], signal); hasMore ||= result.hasMore;
      for (const item of result.items) {
        const owner = [...bindings.values()].find(value => identity(value) === identity(binding) && value.remoteSessionId === item.sessionId);
        if (owner) items.push({ ...item, sessionId: owner.sessionId });
      }
    }
    return { items, hasMore };
  });
  wrap('modelCatalog', async function (original) {
    const local = await original.call(this), groups = local.groups.map(group => ({ ...group, models: [...group.models] }));
    const providers = new Set(local.routableProviders), targets = new Set();
    for (const binding of bindings.values()) {
      if (targets.has(identity(binding))) continue; targets.add(identity(binding));
      try {
        const remote = await transport.call(binding, 'session/modelCatalog', []);
        for (const group of remote.groups) {
          const existing = groups.find(value => value.id === group.id);
          if (!existing) groups.push(group);
          else for (const model of group.models) if (!existing.models.some(value => value.id === model.id)) existing.models.push(model);
        }
        for (const provider of remote.routableProviders) providers.add(provider);
      } catch { /* one offline remote cannot remove the native local catalog */ }
    }
    return { ...local, groups, routableProviders: [...providers] };
  });
  restoreAgents.push(ctx.on('workspace/session-activity', async (request, next) => {
    const binding = bindings.get(request.sessionId); if (!binding) return next();
    const rows = await transport.call(binding, 'session/list', [{}]);
    const row = rows.items.find(value => value.sessionId === binding.remoteSessionId);
    if (!row) throw fault('REMOTE_SESSION_UNAVAILABLE');
    return row.running ? [{ kind: 'turn' }, ...await next()] : next();
  }));
  restoreAgents.push(ctx.on('workspace/session-stop', async request => {
    const binding = bindings.get(request.sessionId);
    if (binding) await transport.call(binding, 'session/cancel', [{ sessionId: binding.remoteSessionId }]);
  }));
  wrap('control', function (original, signal) { return observers.control(lifetime => original.call(this, lifetime), signal); });
  for (const name of COMMANDS) wrap(name, async function (original, request, signal) {
    const binding = bindings.get(request.sessionId);
    if (!binding) return original.call(this, request, signal);
    alive();
    await observers.ensure(binding);
    try {
      return await transport.call(binding, 'session/' + name, [remoteRequest(binding, request)], signal);
    } catch (error) {
      // Never mask a failed remote operation. Third-party composer seats may
      // swallow rejections, leaving the operator believing their pick landed
      // while the remote session silently keeps its previous selection
      // (operator-reported: "the remote session is not using the model I
      // select"). Surface the failure through the native session-error channel.
      const detail = error?.message ? ' (' + String(error.message).slice(0, 200) + ')' : '';
      ctx.emit('api-session/error', binding.sessionId, `Remote ${name} failed: ${error?.code || 'TRANSPORT_LOST'}${detail}.`);
      throw error;
    }
  });
  for (const name of READS) wrap(name, function (original, request, signal) {
    const binding = bindings.get(request.address?.kind === 'subagent' ? request.address.parentSessionId : request.address?.sessionId);
    if (!binding) return original.call(this, request, signal);
    alive();
    if (name === 'page') return transport.call(binding, 'session/page', [remoteRequest(binding, request)], signal);
    return { async *[Symbol.asyncIterator]() {
      await observers.ensure(binding);
      for await (const frame of transport.stream(binding, 'session/follow', [remoteRequest(binding, request)], signal)) yield localFrame(binding, frame, request);
    } };
  });
  // Other native domains cannot resume a local Agent for a remote-owned id.
  // Only explicitly forwarded agent-scoped endpoints may use the proxy token.
  wrap('resolveAgent', function (original, sessionId) {
    if (bindings.has(sessionId)) throw fault('REMOTE_AGENT_REQUIRES_FORWARDING');
    return original.call(this, sessionId);
  });
  wrap('fork', function (original, request) {
    if (bindings.has(request.sessionId)) throw fault('REMOTE_FORK_NOT_IMPLEMENTED');
    return original.call(this, request);
  });
  // Hydrate native metadata from durable bindings without creating/resuming any
  // remote run or local Agent. Native list/follow obtains authoritative remote data.
  for (const binding of bindings.values()) {
    shell(binding);
    observers.ensure(binding).catch(() => {});
    membershipPending.add(binding.sessionId);
  }
  return { async dispose() { restore(); await observers.dispose(); await Promise.allSettled([...teardown, ...[...creations.values()].map(value => value.task)]); } };
  } catch (error) { restore(); observers.dispose().catch(() => {}); throw error; }
}
