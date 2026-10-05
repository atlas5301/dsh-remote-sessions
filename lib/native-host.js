// Standalone backend entry. Native DSH supplies all frontend components; this
// plugin adds one settings/control client surface (machine + virtual-workspace
// management) and no chat, composer or remote-web replacement of any kind.
import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { normalizeMachines, publicMachine, failure } from './machine-registry.js';
import { Machine, registerRoutes, sshExchange, readSettingsSection, sendJson } from './index.js';
import { installSelectedActions } from './selected-actions.js';
import { installTransferActions } from './transfer-actions.js';
import { openNativeBindings } from './native-bindings.js';
import { createNativeTransport } from './native-transport.js';
import { createMirrorResolver } from './native-mirror.js';
import { createWorkspaceResolver } from './native-workspace.js';
import { installNativeSessionProxy } from './native-session-proxy.js';
import { installNativeServices } from './native-services.js';
import { createRemoteExec, createRemoteSetup, readLocalEnvironment } from './remote-setup.js';
import { createRemoteWorkspaces, browseRemoteDirectory, createRemoteDirectory } from './remote-workspaces.js';
import { createRemoteWeb } from './remote-web.js';
import { syncModelsToRemote } from './model-sync.js';

export const name = 'remote-sessions';
export const inject = ['connection', 'subprocess', 'settings', 'storage', 'storageDomain', 'sessionController', 'sessions', 'agents', 'fileUploads', 'typert', 'workspaceRegistry', 'typertGateway', 'commands', 'sessionFileReferences', 'sessionSkillCatalog'];
export const Config = z.object({
  // volatile: machine and workspace tables are live-editable through the
  // settings service (the settings tab persists through it); without the
  // marker the service refuses every write ("no volatile fields").
  machines: z.array(Machine).default([]).volatile(),
  workspaces: z.array(z.object({ localPath: z.string().required(), target: z.string().required(), remotePath: z.string().required() })).default([]).volatile(),
  mirrorRoot: z.string(),
  mirrorTargets: z.array(z.object({ target: z.string().required(), alias: z.string(), host: z.string(), username: z.string(), port: z.number() })).default([]),
});

/** Runtime-mutable machine table: callers reassign `machines` on save. */
function createRuntimeRegistry(raw) {
  const registry = { machines: normalizeMachines(raw, { allowLegacy: true }) };
  registry.replace = next => { registry.machines = normalizeMachines(next, { allowLegacy: true }); };
  return registry;
}

/** The local profile directory: where the user's model configuration lives.
 * Both the models/sync route and the environment reader (lifecycle writes)
 * must read the SAME source, or a provision pass can wipe synced model rows. */
function localProfileDirectory(ctx) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  let profileName;
  try { profileName = ctx.get?.('profileContext')?.name; } catch { profileName = undefined; }
  return join(dshHome, 'profiles', profileName ?? 'desktop');
}

/** Instance adoption hook for the transport: a resident restart changes the
 * instance id while the persisted session store survives. Rebind the durable
 * binding only after the remote confirms the bound session still exists. */
export function createInstanceAdoption({ bindings, timeoutMs = 30000 } = {}) {
  if (!bindings || typeof bindings.adopt !== 'function') throw new Error('createInstanceAdoption requires adoptable bindings');
  return async (binding, connection) => {
    const listing = await connection.peer.request('call', { endpoint: 'session/list', values: [{}] }, { timeoutMs }).catch(() => null);
    if (!listing?.ok || !Array.isArray(listing.value?.items)) return null;
    if (!listing.value.items.some(item => item.sessionId === binding.remoteSessionId)) return null;
    const adopted = { ...binding, instanceId: connection.hello.instanceId };
    await bindings.adopt(binding.sessionId, adopted);
    return adopted;
  };
}

/** Admitted control routes for the settings client and runtime lifecycle.
 * Exported so the behaviour-regression tests drive the real handlers. */
export function buildManagementRoutes(ctx, { registry, setup, workspaces, remoteWeb, exec, sshExchange: exchange }) {
  const body = async (req, signal, cap = 256 * 1024) => {
    const chunks = []; let size = 0;
    const iterator = req[Symbol.asyncIterator]();
    while (true) {
      const step = iterator.next();
      // A plain webserver request may carry no abort signal; only race when present.
      const { value, done } = signal ? await Promise.race([step, new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(failure('REQUEST_CANCELLED', 499)), { once: true }))]) : await step;
      if (done) break;
      const bytes = Buffer.from(value); size += bytes.length;
      if (size > cap) throw failure('BODY_TOO_LARGE', 413);
      chunks.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw failure('INVALID_REQUEST', 400); }
  };
  const route = (path, methods, handler) => ({ kind: 'exact', path, methods, handler: async (req, res) => {
    try { await handler(req, res); }
    catch (error) { console.error('ROUTE-ERROR:', error?.stack ?? error?.message ?? String(error)); sendJson(res, Number.isInteger(error?.status) ? error.status : 502, { error: typeof error?.code === 'string' && /^[A-Z_]{2,64}$/.test(error.code) ? error.code : 'BACKEND_ERROR' }); }
  } });
  const machine = name => registry.machines.find(item => item.name === name && !item.disabled && !item.migrationRequired);
  return [
    route('/remote-sessions/machines', ['GET', 'POST'], async (req, res) => {
      if (req.method === 'GET') return sendJson(res, 200, { machines: registry.machines.map(publicMachine) });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      const request = await body(req, req.signal);
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['machines'].includes(key)) || !Array.isArray(request.machines)) throw failure('INVALID_REQUEST', 400);
      await workspaces.saveMachines(request.machines);
      sendJson(res, 200, { ok: true, machines: registry.machines.map(publicMachine) });
    }),
    route('/remote-sessions/machines/discover', ['POST'], async (req, res) => {
      const request = await body(req, req.signal);
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['ssh'].includes(key))) throw failure('INVALID_REQUEST', 400);
      sendJson(res, 200, { discovery: await workspaces.discover(request, req.signal) });
    }),
    route('/remote-sessions/workspaces', ['GET'], async (req, res) => {
      sendJson(res, 200, { workspaces: workspaces.currentWorkspaces(), anchorRoot: workspaces.anchorRoot() });
    }),
    route('/remote-sessions/workspaces/open', ['POST'], async (req, res) => {
      const request = await body(req, req.signal);
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['target', 'remotePath', 'create'].includes(key)) || typeof request.target !== 'string' || typeof request.remotePath !== 'string' || request.create !== undefined && typeof request.create !== 'boolean') throw failure('INVALID_REQUEST', 400);
      sendJson(res, 200, { workspace: await workspaces.open(request, req.signal) });
    }),
    route('/remote-sessions/workspaces/remove', ['POST'], async (req, res) => {
      const request = await body(req, req.signal);
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['localPath'].includes(key)) || typeof request.localPath !== 'string') throw failure('INVALID_REQUEST', 400);
      sendJson(res, 200, await workspaces.remove(request));
    }),
    route('/remote-sessions/ws-ls', ['GET'], async (req, res) => {
      const url = new URL(req.url, 'http://plugin.invalid');
      const found = machine(url.searchParams.get('machine') ?? '');
      if (!found) throw failure('UNKNOWN_MACHINE', 404);
      sendJson(res, 200, await browseRemoteDirectory(exchange, ctx, found, url.searchParams.get('path') || '~', req.signal));
    }),
    route('/remote-sessions/ws-mkdir', ['POST'], async (req, res) => {
      const request = await body(req, req.signal);
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['machine', 'path', 'name'].includes(key)) || typeof request.machine !== 'string' || typeof request.path !== 'string' || typeof request.name !== 'string') throw failure('INVALID_REQUEST', 400);
      const found = machine(request.machine);
      if (!found) throw failure('UNKNOWN_MACHINE', 404);
      sendJson(res, 200, await createRemoteDirectory(exchange, ctx, found, request.path, request.name, req.signal));
    }),
    route('/remote-sessions/runtime/status', ['GET'], async (req, res) => {
      const machines = registry.machines.filter(item => !item.disabled && !item.migrationRequired);
      const statuses = await Promise.all(machines.map(item => setup.status(item, req.signal)
        .catch(error => ({ name: item.name, state: 'unreachable', error: error.code }))));
      sendJson(res, 200, { machines: statuses });
    }),
    route('/remote-sessions/runtime/ensure', ['POST'], async (req, res) => {
      const request = await body(req, req.signal);
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['target'].includes(key)) || typeof request.target !== 'string') throw failure('INVALID_REQUEST', 400);
      const found = machine(request.target);
      if (!found) throw failure('UNKNOWN_MACHINE', 404);
      sendJson(res, 200, { ok: true, target: found.name, outcome: await setup.ensure(found, req.signal, { force: true }) });
    }),
    route('/remote-sessions/plugins/sync', ['POST'], async (req, res) => {
      const request = await body(req, req.signal);
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['target'].includes(key)) || typeof request.target !== 'string') throw failure('INVALID_REQUEST', 400);
      const found = machine(request.target);
      if (!found) throw failure('UNKNOWN_MACHINE', 404);
      sendJson(res, 200, { ok: true, target: found.name, outcome: await setup.sync(found, req.signal) });
    }),
    route('/remote-sessions/models/sync', ['POST'], async (req, res) => {
      const request = await body(req, req.signal);
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['target'].includes(key)) || typeof request.target !== 'string') throw failure('INVALID_REQUEST', 400);
      const found = machine(request.target);
      if (!found) throw failure('UNKNOWN_MACHINE', 404);
      // The local profile directory (where the user's model config lives).
      const localProfileDir = localProfileDirectory(ctx);
      // The remote DSH home: explicit config, or the probe's HOME line.
      const probed = await setup.probe(found, req.signal).catch(() => null);
      const remoteDshHome = found.remoteHome ?? probed?.home ?? null;
      if (!remoteDshHome) throw failure('PROBE_FAILED', 502);
      const result = await syncModelsToRemote({
        exec,
        machine: found,
        probe: probed ?? {},
        profileDir: join(remoteDshHome, 'profiles', probed?.marker?.profile ?? found.residentProfile ?? 'remote-resident'),
        localProfileDir,
        signal: req.signal,
      });
      // Restart the resident (it must reload the config).
      if (probed?.socket || probed?.marker) await setup.sync(found, req.signal);
      else await setup.ensure(found, req.signal, { force: true });
      sendJson(res, 200, { ok: true, target: found.name, synced: result });
    }),
    route('/remote-sessions/web/open', ['POST'], async (req, res) => {
      const request = await body(req, req.signal);
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['target'].includes(key)) || typeof request.target !== 'string') throw failure('INVALID_REQUEST', 400);
      const found = machine(request.target);
      if (!found) throw failure('UNKNOWN_MACHINE', 404);
      // The bridge profile composes the synced model catalog; the web-open
      // must read the same environment the models/sync route uses.
      const webEnvironment = await readLocalEnvironment(ctx.settings, localProfileDirectory(ctx)).catch(() => null);
      sendJson(res, 200, { ok: true, target: found.name, ...(await remoteWeb.open(found, req.signal, webEnvironment)) });
    }),
    route('/remote-sessions/web/close', ['POST'], async (req, res) => {
      const request = await body(req, req.signal);
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['target'].includes(key)) || typeof request.target !== 'string') throw failure('INVALID_REQUEST', 400);
      const found = machine(request.target);
      if (!found) throw failure('UNKNOWN_MACHINE', 404);
      sendJson(res, 200, { ok: true, target: found.name, ...(await remoteWeb.close(found)) });
    }),
    route('/remote-sessions/runtime/upgrade', ['POST'], async (req, res) => {
      const request = await body(req, req.signal);
      if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['target'].includes(key)) || typeof request.target !== 'string') throw failure('INVALID_REQUEST', 400);
      const found = machine(request.target);
      if (!found) throw failure('UNKNOWN_MACHINE', 404);
      sendJson(res, 200, { ok: true, target: found.name, outcome: await setup.upgrade(found, req.signal) });
    }),
  ];
}

/** Volatile config fields resolve to live-update references (cosmokit Volatile);
 * consumers here need the plain current value. */
const unwrapVolatile = value => value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;

export async function installNativeHost(ctx, config, options = {}) {
  // Native Config is the sole source of machine settings. Do not let a legacy
  // custom-panel machines.json silently override the operator's profile edits.
  const registry = options.registry ?? createRuntimeRegistry(unwrapVolatile(config.machines) ?? []);
  const bindings = await openNativeBindings(ctx);
  const exec = options.exec ?? createRemoteExec(ctx);
  // The upgrade guard asks the remote itself which sessions are still running;
  // a link that cannot be opened leaves the guard to the socket/pid evidence.
  // The transport reference is late-bound: setup.ensure is itself the hook the
  // transport uses before its first connect retry.
  let transportForGuard = null;
  const setup = options.setup ?? createRemoteSetup({
    exec, spawn: ctx.subprocess?.spawn?.bind(ctx.subprocess),
    readEnvironment: async () => readLocalEnvironment(ctx.settings, localProfileDirectory(ctx)),
    listRunning: async machine => {
      if (!transportForGuard) return undefined;
      const identity = await transportForGuard.identify(machine.name).catch(() => null);
      if (!identity) return undefined;
      const listing = await transportForGuard.call(identity, 'session/list', [{}]).catch(() => undefined);
      if (!listing) return undefined;
      return listing.items.filter(item => item.running);
    },
  });
  const transport = createNativeTransport(registry, { ...(options.transport ?? {}), setup: options.setup ? undefined : { ensure: setup.ensure }, ...(options.transport ? {} : { adopt: options.adopt ?? createInstanceAdoption({ bindings }) }) });
  transportForGuard = transport;
  let proxy, services, resolveWorkspace, workspaces;
  try {
  const identify = target => transport.identify(target);
  const compatibility = config.mirrorTargets?.length ? createMirrorResolver({
    root: config.mirrorRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'remote-workspaces'),
    targets: config.mirrorTargets, identify,
  }) : undefined;
  resolveWorkspace = createWorkspaceResolver({ workspaces: unwrapVolatile(config.workspaces) ?? [], identify, compatibility });
    // Validate anchor canonicalization before interception. Otherwise the native
    // workspace picker realpaths a symlink while an unmatched configured alias
    // could accidentally look like an ordinary local path.
    for (const workspace of resolveWorkspace.snapshot()) {
      const anchor = resolve(workspace.localPath);
      if (await fs.realpath(anchor) !== anchor || !(await fs.stat(anchor)).isDirectory()) throw new Error('UNSAFE_WORKSPACE_BINDING');
      if (!registry.machines.some(machine => machine.name === workspace.target && !machine.disabled && !machine.migrationRequired)) throw new Error('REMOTE_MACHINE_UNAVAILABLE');
    }
    proxy = installNativeSessionProxy(ctx, { bindings, transport, resolveWorkspace });
    services = installNativeServices(ctx, { bindings, transport });
    // Machine + managed virtual-workspace control and runtime lifecycle.
    workspaces = options.workspaces ?? createRemoteWorkspaces(ctx, {
      registry, transport, resolveWorkspace, sshExchange: options.sshExchange ?? sshExchange,
      namespace: options.namespace ?? 'remote-sessions', persist: options.persist !== false,
    });
    const remoteWeb = options.remoteWeb ?? createRemoteWeb({ exec });
    ctx.effect(() => () => remoteWeb.dispose(), 'remote-sessions.web-forwards');
    if (options.managementRoutes !== false) {
      registerRoutes(ctx, buildManagementRoutes(ctx, { registry, setup, workspaces, remoteWeb, exec, sshExchange: options.sshExchange ?? sshExchange }));
    }
    // Retain explicit selected sync/transfer endpoints, never automatic startup
    // synchronization. Their existing conflict previews and guards are unchanged.
    if (options.selectedActions !== false) {
      installSelectedActions(ctx, registry, { sshExchange, registerRoutes, readSettingsSection });
      installTransferActions(ctx, registry, { sshExchange, registerRoutes });
    }
  } catch (error) { await transport.dispose(); await proxy?.dispose(); await services?.dispose(); await bindings.close(); throw error; }
  let disposed;
  const dispose = () => disposed ??= (async () => {
    // Abort physical links first to unblock every pending observation read.
    await transport.dispose(); await proxy.dispose(); await services.dispose(); await bindings.close();
  })();
  ctx.effect(() => dispose, 'remote-sessions.native-backend');
  return { registry, bindings, transport, proxy, services, setup, resolveWorkspace, workspaces, dispose };
}
export async function apply(ctx, config) { await installNativeHost(ctx, config); }
