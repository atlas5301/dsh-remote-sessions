// Behaviour-regression suite. Every test here encodes an operator-reported
// failure of the live v0.8.0 installation; run: node --test test/behaviour-regressions.test.js
//
// Reported bugs this file pins:
// 1. "Action failed: BACKEND_ERROR" on the Sync models action — a TDZ
//    ReferenceError inside syncModelsToRemote's home-patch step, which the
//    route wrapper maps to BACKEND_ERROR. The old code declared
//    remoteDshHome AFTER first use; these tests execute the full function.
// 2. "Cannot connect to the remote workspace" — the machine's configured
//    runtimeDirectory/socketPath drifted from the resident's profile patch
//    (Detect/Edit rewrote socketPath from the raw machine name; the stopped
//    resident was blindly restarted with the stale patch and bound elsewhere).
//    These tests pin the drift-heal and the client field preservation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { installedAnchor } from './anchor.mjs';

// Resolution only: execute the installed schemastery implementation unchanged.
const anchor = installedAnchor();
// Runtime-anchored fallbacks (localDshVersion, optionalBundles) read the env.
process.env.DSH_TEST_DEPENDENCY_ANCHOR = anchor;
const installed = createRequire(anchor);
const hook = registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (!specifier.startsWith('@deepseek-ai/') && specifier !== 'zod') throw error;
    return { url: pathToFileURL(installed.resolve(specifier)).href, shortCircuit: true };
  }
} });
const { normalizeMachine } = await import('../lib/machine-registry.js');
const { createRemoteSetup, startScript, stopScript, shellQuote, readLocalEnvironment, profileManifestText, profilePatchText, setupSignature } = await import('../lib/remote-setup.js');
const { syncModelsToRemote, extractYamlSection } = await import('../lib/model-sync.js');
const { buildManagementRoutes, createInstanceAdoption } = await import('../lib/native-host.js');
const { createNativeTransport } = await import('../lib/native-transport.js');
const { machineIdentity } = await import('../lib/authority.js');
const { installNativeSessionProxy } = await import('../lib/native-session-proxy.js');
const { adoptableBindings } = await import('../lib/native-bindings.js');
const { createRemoteWeb, webBridgeProfileName, webBridgePatchText } = await import('../lib/remote-web.js');
hook.deregister();

/** Minimal native-service graph for driving the real session proxy overlay:
 * the proxy only touches the surfaces redefined here. */
function proxyContext({ mappings, remoteSessions }) {
  const rows = new Map();
  const emitted = {};
  const attached = [];
  const localSessionIds = [];
  const shells = new Map();
  const emit = (event, ...args) => { (emitted[event] ??= []).push(args.length === 1 ? args[0] : args); };
  const sessionLike = { id: undefined, snapshotEvents: () => [] };
  const originalList = async () => ({ items: localSessionIds.map(id => ({ sessionId: 'local-' + id })) });
  const sessionController = {
    async list() { return { items: [] }; }, async create() { throw new Error('unused'); },
    async resolveAgent() { throw new Error('unused'); },
    async prompt() { throw new Error('unused'); }, async cancel() { throw new Error('unused'); },
    async rename() { throw new Error('unused'); }, async selectModel() { throw new Error('unused'); },
    async updateQueue() { throw new Error('unused'); }, async attachment() { throw new Error('unused'); },
    async projections() { throw new Error('unused'); }, async page() { throw new Error('unused'); },
    async follow() { throw new Error('unused'); }, async fork() { throw new Error('unused'); },
    async control() { throw new Error('unused'); }, async search() { throw new Error('unused'); },
    async modelCatalog() { return { groups: [], routableProviders: [] }; },
  };
  const transport = {
    async call(binding, endpoint, values) {
      if (endpoint === 'session/list') return { items: remoteSessions.map(item => ({ ...item })) };
      if (endpoint === 'session/create') return { sessionId: values[0].sessionId };
      return {};
    },
    // Production observation streams stay open for the connection lifetime.
    // Production transports expose stream() as an async generator method: the
    // CALL returns an async iterable directly, never a promise of one.
    stream(binding, endpoint, values, signal) {
      // Mirror production: $events yields a ready frame, control a baseline,
      // then the stream stays open until its abort signal fires.
      return (async function* () {
        if (endpoint === '$events') yield { type: 'ready', clientId: 'client-1' };
        if (endpoint === 'session/control') yield { type: 'baseline', value: { projections: {} } };
        await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }));
      })();
    },
    async identify(target) {
      const binding = [...rows.values()].find(value => value.target === target);
      return { target, authority: binding?.authority ?? 'a', runtimeId: binding?.runtimeId ?? 'r', instanceId: binding?.instanceId ?? 'i' };
    },
    async upload() { throw new Error('unused'); }, async eventResult() { throw new Error('unused'); },
    async dispose() {},
  };
  const resolveWorkspace = async cwd => (mappings.some(mapping => mapping.localPath === cwd)
    ? { ...await transport.identify(mappings.find(mapping => mapping.localPath === cwd).target), remoteCwd: mappings.find(mapping => mapping.localPath === cwd).remotePath, target: mappings.find(mapping => mapping.localPath === cwd).target }
    : null);
  resolveWorkspace.snapshot = () => mappings.map(value => ({ ...value }));
  const ctx = {
    sessionController, localSessionIds, emitted, attached,
    agents: { create() { throw new Error('no local agents'); }, resume() { throw new Error('no local agents'); }, get: () => undefined, list: () => [] },
    sessions: {
      get: id => (shells.has(id) || localSessionIds.includes(id) ? sessionLike : undefined),
      prepare: (id, value) => { sessionLike.id = id; return sessionLike; },
      enter: () => () => shells.set(sessionLike.id, true),
      announce: () => emit('session/announced', { sessionId: sessionLike.id }),
      list: () => [],
    },
    workspaceRegistry: { resolveByPath: async path => ({ path, attachSession: async id => attached.push(id) }) },
    fileUploads: { uploadStream() { throw new Error('unused'); }, upload() { throw new Error('unused'); } },
    typert: { lookups: {} },
    emit,
    on: () => () => {},
    inject: () => ({ dispose: () => {} }),
    effect: fn => () => fn?.(),
    get: () => undefined,
    bindings: {
      get size() { return rows.size; }, has: id => rows.has(id), get: id => rows.get(id),
      *values() { for (const [, value] of rows.entries()) yield value; },
      async set(id, value) { rows.set(id, Object.freeze({ ...value })); },
      async adopt(id, value) {
        const previous = rows.get(id);
        if (!previous) throw Object.assign(new Error('UNKNOWN_BINDING'), { code: 'UNKNOWN_BINDING' });
        if (['sessionId', 'remoteSessionId', 'target', 'cwd', 'remoteCwd', 'authority', 'runtimeId'].some(key => previous[key] !== value[key]))
          throw Object.assign(new Error('REMOTE_BINDING_CONFLICT'), { code: 'REMOTE_BINDING_CONFLICT' });
        rows.set(id, Object.freeze({ ...value }));
      },
      put: async (id, value) => rows.set(id, Object.freeze({ ...value })),
      delete: id => rows.delete(id),
      close: () => {},
    },
    waterfall: async () => { throw new Error('unused'); },
  };
  Object.defineProperty(ctx.typert, 'lookups', { configurable: true, get: () => ({ get: () => undefined }) });
  ctx.transport = transport;
  ctx.resolveWorkspace = resolveWorkspace;
  return ctx;
}

const ORIGINAL_DSH_HOME = process.env.DSH_HOME;
function temporary(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  assert.ok(dir.startsWith(realpathSync(tmpdir()) + '/' + prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function machine(overrides = {}) {
  return normalizeMachine({
    name: 'build-host', ssh: ['operator@build-host'], remoteNode: '/usr/bin/node',
    socketPath: '/home/operator/.dsh/rs-runtime/build-host/agent.sock',
    remoteCwd: '/home/operator/work', syncModels: true,
    ...overrides,
  });
}

/** Scripted strict-SSH executor: routes by matching distinctive fragments. */
function scriptedExec(script = []) {
  const calls = [];
  const usage = new Map();
  const exec = async (target, text, { input } = {}) => {
    calls.push({ script: text, input });
    for (const entry of script) {
      const used = usage.get(entry) ?? 0;
      if (used >= (entry.times ?? Infinity) || !entry.match.test(text)) continue;
      usage.set(entry, used + 1);
      if (typeof entry.reply === 'function') return entry.reply(text, input, calls);
      return { code: entry.code ?? 0, stdout: entry.stdout ?? '' };
    }
    throw new Error('unexpected remote script: ' + text.slice(0, 200));
  };
  return { exec, calls };
}

const probeReply = ({ home = '/home/operator/.dsh', socket = false, marker = null, pid, cliBin = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js' } = {}) =>
  ['HOME:' + home, 'NODE:/usr/bin/node', 'SOCKET:' + (socket ? 'yes' : 'no'),
    marker ? 'MARKER:' + JSON.stringify(marker) : 'MARKER:none',
    pid ? 'PID:' + pid : '', 'CLIBIN:' + cliBin, 'CLIROOT:' + cliBin.replace(/\/lib\/bin\.js$/, ''),
    'NPM:/usr/bin/npm', 'END'].filter(Boolean).join('\n') + '\n';

/** A local profile with real model sections and a real local credential. */
function localEnvironment(t) {
  const home = temporary(t, 'dsh-regression-home-');
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true });
  writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      deepinfra:',
    '        apiKeyEnv: REGRESSION_API_KEY',
    '        api: openai-completions',
    '        models:',
    '          - id: zai-org/GLM-5.3',
    '            name: zai-org/GLM-5.3',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: deepinfra',
    '    model: zai-org/GLM-5.3',
    '    reasoningEffort: high',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(home, '.credentials.yaml'), '  REGRESSION_API_KEY: regression-secret-value\n', 'utf8');
  process.env.DSH_HOME = home;
  t.after(() => { process.env.DSH_HOME = ORIGINAL_DSH_HOME; });
  return home;
}

const PROFILE_PATCH = '/home/operator/.dsh/profiles/rs-build-host/cordis.patch.yml';

// ── 1. Sync models: the reported BACKEND_ERROR ────────────────────────────────

test('syncModelsToRemote completes the home-patch and credential steps (TDZ regression)', async () => {
  const t = test; const local = localEnvironment(t);
  const target = machine();
  const remotePatch = [
    '# Generated by dsh-remote-sessions automatic setup.',
    '- id: remote-resident',
    '  config:',
    '    runtimeDirectory: "/home/operator/.dsh/rs-runtime/build-host"',
    '- id: storage-json',
    '  config:',
    '    root: "/home/operator/.dsh/rs-runtime/build-host/storages"',
    '- id: llm-pi-ai',
    '  config: {stale: true}',
    '',
  ].join('\n');
  const homePatch = '- id: session-log-deepseek\n  disabled: true\n';
  const { exec, calls } = scriptedExec([
    { match: /cat .*profiles.*cordis\.patch\.yml' 2>\/dev\/null/, stdout: remotePatch, times: 1 },
    { match: /cat > '/, code: 0, times: 2 },
    { match: /cat .*cordis\.patch\.yml' 2>\/dev\/null/, stdout: homePatch, times: 1 },
    { match: /grep -q/, code: 0, times: 1 },
  ]);
  const probe = { home: '/home/operator/.dsh', marker: { profile: 'rs-build-host' } };
  const result = await syncModelsToRemote({
    exec, machine: target, probe,
    profileDir: '/home/operator/.dsh/profiles/rs-build-host',
    localProfileDir: join(local, 'profiles', 'desktop'),
  });
  assert.deepEqual(result, { providers: true, defaultModel: true, credential: true });
  const written = calls.find(item => /cat >/.test(item.script) && /profiles/.test(item.script));
  assert.ok(written, 'the remote profile patch must be rewritten');
  assert.ok(written.input.includes('id: llm-pi-ai'), 'the local provider section is merged');
  assert.ok(written.input.includes('apiKeyEnv: REGRESSION_API_KEY'), 'the provider section carries the env var');
  assert.ok(written.input.includes('id: agent-default-model'), 'the local default model is merged');
  assert.ok(!written.input.includes('stale: true'), 'the stale provider section is removed');
  assert.ok(written.input.includes('id: storage-json'), 'unrelated sections are preserved');
});

test('model sync writes the credential over stdin, never on the SSH command line', async () => {
  const t = test; const local = localEnvironment(t);
  const target = machine();
  const { exec, calls } = scriptedExec([
    { match: /cat .*profiles.*cordis\.patch\.yml' 2>\/dev\/null/, stdout: '- id: remote-resident\n  config:\n    runtimeDirectory: "/x"\n', times: 1 },
    { match: /cat > '/, code: 0, times: 1 },
    { match: /grep -q/, code: 0, times: 1 },
  ]);
  await syncModelsToRemote({
    exec, machine: target, probe: { home: '/home/operator/.dsh' },
    profileDir: '/home/operator/.dsh/profiles/rs-build-host',
    localProfileDir: join(local, 'profiles', 'desktop'),
  });
  const credential = calls.find(item => /grep -q/.test(item.script));
  assert.ok(credential, 'the credential step must run');
  assert.ok(credential.script.includes('/home/operator/.dsh/rs-runtime/build-host/credentials.yaml'), 'the store is resident-owned');
  assert.ok(credential.script.includes('umask 077'), 'a fresh remote credential store is created owner-only');
  assert.ok(!credential.script.includes('regression-secret-value'), 'the API key never appears in the SSH argv (process list)');
  assert.ok(String(credential.input ?? '').includes('REGRESSION_API_KEY: regression-secret-value'), 'the key streams over stdin');
});

test('route-level model sync: healthy flow returns ok, failures surface named codes, never BACKEND_ERROR', async () => {
  const t = test;
  const local = localEnvironment(t);
  const target = machine();
  const marker = {
    version: 1, bundleVersion: '0.8.0', bundleSha256: 'x', profile: 'rs-build-host',
    runtimeDirectory: '/home/operator/.dsh/rs-runtime/build-host', socketPath: target.socketPath,
    cliBin: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', nodePath: '/usr/bin/node',
  };
  const remotePatch = '- id: remote-resident\n  config:\n    runtimeDirectory: "/home/operator/.dsh/rs-runtime/build-host"\n';
  const { exec } = scriptedExec([
    { match: /printf 'HOME:%s/, stdout: probeReply({ marker }), times: 3 },
    { match: /cat .*profiles.*cordis\.patch\.yml' 2>\/dev\/null/, stdout: remotePatch, times: 1 },
    { match: /cat > '/, times: 4 },
    { match: /grep -q/, times: 1 },
    { match: /kill|pkill/, code: 0, times: 1 },
    { match: /readlink -f|if \[ -x/, stdout: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', times: 2 },
    { match: /require\(process\.argv\[1\]/, stdout: '0.2.0-rc.2\n', times: 1 },
    { match: /mkdir|chmod/, times: 2 },
    { match: /tar -xzf -/, times: 1 },
    { match: /rm -rf|mv |rmdir|ln -s/, times: 1 },
    { match: /setsid|nohup/, code: 0, times: 1 },
  ]);
  const setup = createRemoteSetup({
    exec,
    spawn: () => ({ stdout: Readable.from([Buffer.from('bundle-tar')]), done: Promise.resolve({ exitCode: 0 }), terminate() {} }),
    // The production environment source: settings rows PLUS the local profile's
    // model catalog, so lifecycle writes carry the synced provider section.
    readEnvironment: async () => readLocalEnvironment({ describe: () => [{ ns: 'agent-default-model', value: { provider: 'deepinfra', model: 'zai-org/GLM-5.3', reasoningEffort: 'high' } }] }, join(local, 'profiles', 'desktop')),
  });
  const routes = buildManagementRoutes(
    { get: key => key === 'profileContext' ? { name: 'desktop' } : undefined },
    {
      registry: { machines: [target] },
      setup,
      workspaces: { saveMachines: async () => {}, discover: async () => ({}) },
      remoteWeb: { open: async () => ({}), close: async () => ({}) },
      exec, sshExchange: async () => '',
    });
  const modelsRoute = routes.find(route => route.path === '/remote-sessions/models/sync');
  assert.ok(modelsRoute, 'the models/sync route must exist');

  const res = response();
  await modelsRoute.handler(request({ target: 'build-host' }), res);
  assert.equal(res.statusCode, 200, 'a healthy sync must succeed');
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.synced, { providers: true, defaultModel: true, credential: true });

  // SSH-down: the client must see a named code, never BACKEND_ERROR.
  const down = response();
  const unreachable = createRemoteSetup({ exec: async () => { throw Object.assign(new Error('ssh'), { code: 'SSH_FAILED', status: 502 }); }, spawn: null });
  const failing = buildManagementRoutes({ get: () => undefined }, {
    registry: { machines: [target] }, setup: unreachable,
    workspaces: { saveMachines: async () => {}, discover: async () => ({}) },
    remoteWeb: { open: async () => ({}), close: async () => ({}) },
    exec, sshExchange: async () => '',
  }).find(route => route.path === '/remote-sessions/models/sync');
  await failing.handler(request({ target: 'build-host' }), down);
  assert.equal(down.statusCode, 502);
  assert.equal(down.body.error, 'PROBE_FAILED', 'SSH-down surfaces a named code, never BACKEND_ERROR');

  // The wrapper's own mapping stays: an unexpected internal error still
  // reports BACKEND_ERROR (documenting the exact user-visible symptom class).
  // The poisoned facade probes successfully (so the route proceeds) and then
  // its inner exec throws a bare ReferenceError like the shipped TDZ bug.
  const poisoned = response();
  const poisonSetup = {
    probe: async () => ({ home: '/home/operator/.dsh', marker: { profile: 'rs-build-host' } }),
    sync: async () => { throw new Error('ReferenceError: Cannot access before initialization'); },
    ensure: async () => { throw new Error('ReferenceError: Cannot access before initialization'); },
  };
  const poisonedRoute = buildManagementRoutes({ get: () => undefined }, {
    registry: { machines: [target] }, setup: poisonSetup,
    workspaces: { saveMachines: async () => {}, discover: async () => ({}) },
    remoteWeb: { open: async () => ({}), close: async () => ({}) },
    exec: async () => { throw new Error('ReferenceError: Cannot access before initialization'); }, sshExchange: async () => '',
  }).find(route => route.path === '/remote-sessions/models/sync');
  await poisonedRoute.handler(request({ target: 'build-host' }), poisoned);
  assert.equal(poisoned.statusCode, 502);
  assert.equal(poisoned.body.error, 'BACKEND_ERROR');
});

// ── 2. Runtime drift: the reported remote-workspace connection failure ─────────

const BUNDLE_FAKE = () => ({ stdout: Readable.from([Buffer.from('bundle-tar')]), done: Promise.resolve({ exitCode: 0 }), terminate() {} });

function driftScripts({ markerRuntime, patchRuntime, socketAfterStop = true }) {
  return [
    { match: /printf 'HOME:%s/, reply: (text) => ({ code: 0, stdout: probeReply({ marker: {
      version: 1, bundleVersion: '0.8.0', bundleSha256: 'x', profile: 'rs-build-host',
      runtimeDirectory: markerRuntime, socketPath: '/home/operator/.dsh/rs-runtime/build-host/agent.sock',
      cliBin: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', nodePath: '/usr/bin/node',
    } }) }), times: 2 },
    { match: /kill|pkill/, code: 0, times: 1 },
    { match: /readlink -f|if \[ -x/, stdout: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', times: 2 },
    { match: /cat .*profiles.*cordis\.patch\.yml' 2>\/dev\/null/, reply: () => ({ code: 0, stdout: `- id: remote-resident\n  config:\n    runtimeDirectory: "${patchRuntime}"\n` }), times: 1 },
    { match: /mkdir|chmod/, times: 2 },
    { match: /tar -xzf -/, times: 1 },
    { match: /rm -rf|mv |rmdir|ln -s/, times: 1 },
    { match: /cat > '/, times: 4 },
    { match: /setsid|nohup/, code: 0, times: 1 },
  ];
}

test('ensure re-provisions a stopped resident whose marker recorded a different runtime', async () => {
  const target = machine(); // runtimeDirectory: /home/operator/.dsh/rs-runtime/build-host
  const { exec, calls } = scriptedExec(driftScripts({ markerRuntime: '/home/operator/.dsh/rs-runtime/OLD-host', patchRuntime: '/home/operator/.dsh/rs-runtime/OLD-host' }));
  const setup = createRemoteSetup({ exec, spawn: BUNDLE_FAKE, readEnvironment: async () => null });
  const outcome = await setup.ensure(target);
  assert.equal(outcome.outcome, 'reprovisioned', 'a drifted resident must be re-provisioned, not blindly restarted');
  assert.ok(calls.some(item => /tar -xzf -/.test(item.script)), 'the bundle is re-uploaded to the configured runtime directory');
  const patchWrite = calls.find(item => /cat >/.test(item.script) && /profiles/.test(item.script) && String(item.input ?? '').includes('remote-resident'));
  assert.ok(patchWrite, 'the profile patch is rewritten');
  assert.ok(patchWrite.input.includes('"/home/operator/.dsh/rs-runtime/build-host"'), 'the patch now names the configured runtimeDirectory');
  const start = calls.find(item => /setsid|nohup/.test(item.script));
  assert.ok(start, 'the resident is started');
  assert.ok(start.script.includes('/home/operator/.dsh/rs-runtime/build-host/agent.sock'), 'start waits for the CONFIGURED socket path');
});

test('ensure detects a profile patch that binds another runtime even when the marker matches', async () => {
  const target = machine();
  // The exact live incident: marker consistent with config, but the shared
  // resident profile patch points at an older runtime directory.
  const { exec, calls } = scriptedExec(driftScripts({ markerRuntime: '/home/operator/.dsh/rs-runtime/build-host', patchRuntime: '/home/operator/.dsh/rs-runtime/OLD-host' }));
  const setup = createRemoteSetup({ exec, spawn: BUNDLE_FAKE, readEnvironment: async () => null });
  const outcome = await setup.ensure(target);
  assert.equal(outcome.outcome, 'reprovisioned');
  const patchWrite = calls.find(item => /cat >/.test(item.script) && /profiles/.test(item.script) && String(item.input ?? '').includes('remote-resident'));
  assert.ok(patchWrite && patchWrite.input.includes('"/home/operator/.dsh/rs-runtime/build-host"'),
    'the resident profile must be healed to the configured runtime directory');
});

test('ensure cheap-starts a consistent stopped resident without re-uploading the bundle', async () => {
  const target = machine();
  const consistent = [
    { match: /printf 'HOME:%s/, stdout: probeReply({ marker: {
      version: 1, bundleVersion: '0.8.0', bundleSha256: 'x', profile: 'rs-build-host',
      runtimeDirectory: '/home/operator/.dsh/rs-runtime/build-host', socketPath: target.socketPath,
      cliBin: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', nodePath: '/usr/bin/node',
    } }), times: 1 },
    { match: /kill|pkill/, code: 0, times: 1 },
    { match: /if \[ -x/, stdout: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', times: 1 },
    { match: /cat .*profiles.*cordis\.patch\.yml' 2>\/dev\/null/, stdout: '- id: remote-resident\n  config:\n    runtimeDirectory: "/home/operator/.dsh/rs-runtime/build-host"\n', times: 1 },
    { match: /setsid|nohup/, code: 0, times: 1 },
  ];
  const { exec, calls } = scriptedExec(consistent);
  const setup = createRemoteSetup({ exec, spawn: BUNDLE_FAKE, readEnvironment: async () => null });
  const outcome = await setup.ensure(target);
  assert.equal(outcome.outcome, 'started', 'a consistent stopped resident starts without re-provisioning');
  assert.ok(!calls.some(item => /tar -xzf -/.test(item.script)), 'no bundle upload on the cheap-start path');
  assert.ok(!calls.some(item => /cat >/.test(item.script)), 'no file rewrites on the cheap-start path');
});

test('route-level model sync heals a drifted resident and restarts it at the configured socket', async () => {
  const t = test;
  const local = localEnvironment(t);
  const target = machine();
  const marker = {
    version: 1, bundleVersion: '0.8.0', bundleSha256: 'x', profile: 'rs-build-host',
    runtimeDirectory: '/home/operator/.dsh/rs-runtime/build-host', socketPath: target.socketPath,
    cliBin: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', nodePath: '/usr/bin/node',
  };
  const remotePatch = '- id: remote-resident\n  config:\n    runtimeDirectory: "/home/operator/.dsh/rs-runtime/OLD-host"\n';
  const { exec, calls } = scriptedExec([
    { match: /printf 'HOME:%s/, stdout: probeReply({ marker }), times: 3 },
    { match: /cat .*profiles.*cordis\.patch\.yml' 2>\/dev\/null/, stdout: remotePatch, times: 2 },
    { match: /cat > '/, times: 4 },
    { match: /grep -q/, times: 1 },
    { match: /kill|pkill/, code: 0, times: 1 },
    { match: /readlink -f|if \[ -x/, stdout: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', times: 2 },
    { match: /require\(process\.argv\[1\]/, stdout: '0.2.0-rc.2\n', times: 1 },
    { match: /mkdir|chmod/, times: 2 },
    { match: /tar -xzf -/, times: 1 },
    { match: /rm -rf|mv |rmdir|ln -s/, times: 1 },
    { match: /setsid|nohup/, code: 0, times: 1 },
  ]);
  const setup = createRemoteSetup({
    exec, spawn: BUNDLE_FAKE,
    readEnvironment: async () => readLocalEnvironment({ describe: () => [{ ns: 'agent-default-model', value: { provider: 'deepinfra', model: 'zai-org/GLM-5.3', reasoningEffort: 'high' } }] }, join(local, 'profiles', 'desktop')),
  });
  const route = buildManagementRoutes(
    { get: key => key === 'profileContext' ? { name: 'desktop' } : undefined },
    {
      registry: { machines: [target] }, setup,
      workspaces: { saveMachines: async () => {}, discover: async () => ({}) },
      remoteWeb: { open: async () => ({}), close: async () => ({}) },
      exec, sshExchange: async () => '',
    }).find(item => item.path === '/remote-sessions/models/sync');
  const res = response();
  await route.handler(request({ target: 'build-host' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  const start = calls.find(item => /setsid|nohup/.test(item.script));
  assert.ok(start.script.includes('/home/operator/.dsh/rs-runtime/build-host/agent.sock'),
    'the restarted resident is expected at the configured socket path');
  const patchWrites = calls.filter(item => /cat > '/.test(item.script) && /profiles/.test(item.script) && String(item.input ?? '').includes('remote-resident'));
  const patchWrite = patchWrites.at(-1); // the provision pass is the last write
  assert.ok(patchWrite && patchWrite.input.includes('"/home/operator/.dsh/rs-runtime/build-host"'), 'the resident profile is healed');
  // Regression (model-sync wipe): the lifecycle provision pass that restarts
  // the resident must carry the synced provider catalog, not regenerate the
  // patch without it — the exact sequence that left the live resident without
  // its deepinfra models after a successful-looking Sync models click.
  assert.ok(patchWrite.input.includes('id: llm-pi-ai'), 'the provisioned patch keeps the synced provider catalog');
  assert.ok(patchWrite.input.includes('id: agent-default-model'), 'the provisioned patch keeps the default model');
});

// ── 2b. Model-config wipe: lifecycle writes must keep the synced catalog ─────

test('plugins sync re-provisions when the model catalog changed, and stays in-sync when it did not', async () => {
  const t = test;
  const local = localEnvironment(t);
  const target = machine();
  const markerBase = {
    version: 1, bundleVersion: '0.8.0', bundleSha256: 'x', profile: 'rs-build-host',
    runtimeDirectory: '/home/operator/.dsh/rs-runtime/build-host', socketPath: target.socketPath,
    cliBin: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', nodePath: '/usr/bin/node',
  };
  const probeWithMarker = marker => ({ code: 0, stdout: probeReply({ socket: true, pid: 4242, marker }) });
  const patchText = '- id: remote-resident\n  config:\n    runtimeDirectory: "/home/operator/.dsh/rs-runtime/build-host"\n';
  // First sync: the marker predates the model catalog (old-style signature),
  // so the resident must be re-provisioned and restarted even though the
  // plugin list never changed.
  {
    const { exec, calls } = scriptedExec([
      { match: /printf 'HOME:%s/, reply: () => probeWithMarker({ ...markerBase, plugins: 'oldstyle' }), times: 2 },
      { match: /kill|pkill/, code: 0, times: 1 },
      { match: /readlink -f|if \[ -x/, stdout: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', times: 2 },
      { match: /require\(process\.argv\[1\]/, stdout: '0.2.0-rc.2\n', times: 1 },
      { match: /mkdir|chmod/, times: 2 },
      { match: /tar -xzf -/, times: 1 },
      { match: /rm -rf|mv |rmdir|ln -s/, times: 1 },
      { match: /cat > '/, times: 4 },
      { match: /cat .*profiles.*cordis\.patch\.yml' 2>\/dev\/null/, stdout: patchText, times: 1 },
      { match: /setsid|nohup/, code: 0, times: 1 },
    ]);
    const setup = createRemoteSetup({
      exec, spawn: BUNDLE_FAKE,
      readEnvironment: async () => readLocalEnvironment({ describe: () => [{ ns: 'agent-default-model', value: { provider: 'deepinfra', model: 'zai-org/GLM-5.3', reasoningEffort: 'high' } }] }, join(local, 'profiles', 'desktop')),
    });
    const outcome = await setup.sync(target);
    assert.equal(outcome.outcome, 'synced', 'a marker that predates the model catalog must not report in-sync');
    const markerWrite = calls.filter(item => /cat > '/.test(item.script) && /resident\.json/.test(item.script)).at(-1);
    assert.ok(markerWrite, 'the marker is rewritten');
    const marker = JSON.parse(markerWrite.input);
    const patchWrite = calls.filter(item => /cat > '/.test(item.script) && /profiles/.test(item.script) && String(item.input ?? '').includes('remote-resident')).at(-1);
    assert.ok(patchWrite.input.includes('id: llm-pi-ai'), 'the fresh patch carries the model catalog');
    assert.ok(marker.plugins && marker.plugins !== 'oldstyle', 'the marker records the full setup signature');
    // Second sync with the SAME environment: now genuinely in-sync, no restart.
    const { exec: exec2, calls: calls2 } = scriptedExec([
      { match: /printf 'HOME:%s/, reply: () => probeWithMarker(marker), times: 1 },
    ]);
    const setup2 = createRemoteSetup({
      exec: exec2, spawn: BUNDLE_FAKE,
      readEnvironment: async () => readLocalEnvironment({ describe: () => [{ ns: 'agent-default-model', value: { provider: 'deepinfra', model: 'zai-org/GLM-5.3', reasoningEffort: 'high' } }] }, join(local, 'profiles', 'desktop')),
    });
    const again = await setup2.sync(target);
    assert.equal(again.outcome, 'in-sync', 'an unchanged catalog stays in-sync without a restart');
    assert.ok(!calls2.some(item => /setsid|nohup/.test(item.script)), 'no restart when nothing changed');
  }
});

// ── 3. Machine save: settings edits must not silently drop machine fields ────

const { browserMachines } = await import('../lib/machine-registry.js');

test('machine save preserves protected setup fields the panel does not edit', () => {
  const previous = [machine({
    remoteHome: '/srv/dsh-data', runtimeDirectory: '/home/operator/.dsh/rs-runtime/build-host',
    residentProfile: 'custom-profile', autoSetup: false, npmInstall: false, dshVersion: '0.2.0-rc.2',
    authorityRevision: 'r7', env: { TOKEN: 'secret' },
    plugins: [{ package: '@hytime/dsh-thinking-effort', version: '0.3.6' }],
  })];
  // The panel posts only its form fields (plus ssh/command/env via the route).
  const posted = [{ name: 'build-host', ssh: ['operator@new-host'], remoteNode: '/usr/bin/node',
    socketPath: '/home/operator/.dsh/rs-runtime/build-host/agent.sock', remoteCwd: '/home/operator/work',
    syncModels: true, syncPluginStates: false }];
  const saved = browserMachines(posted, previous);
  assert.equal(saved.length, 1);
  const record = saved[0];
  assert.equal(record.ssh.join(' '), 'operator@new-host', 'the edited field changes');
  assert.equal(record.remoteHome, '/srv/dsh-data', 'remoteHome survives the edit');
  assert.equal(record.runtimeDirectory, '/home/operator/.dsh/rs-runtime/build-host', 'runtimeDirectory survives the edit');
  assert.equal(record.residentProfile, 'custom-profile', 'residentProfile survives the edit');
  assert.equal(record.autoSetup, false, 'autoSetup survives the edit');
  assert.equal(record.npmInstall, false, 'npmInstall survives the edit');
  assert.equal(record.dshVersion, '0.2.0-rc.2', 'dshVersion survives the edit');
  assert.equal(record.authorityRevision, 'r7', 'authorityRevision survives the edit');
  assert.equal(record.plugins?.length, 1, 'the pinned plugin list survives the edit');
  assert.deepEqual(record.plugins, [{ package: '@hytime/dsh-thinking-effort', version: '0.3.6' }]);
  // An explicit empty plugin list is honored (the operator cleared it).
  const cleared = browserMachines([{ ...posted[0], plugins: [] }], previous);
  assert.equal(cleared[0].plugins, undefined, 'an explicit empty plugin list removes the pins');
});

test('start and stop scripts stay anchored and syntactically valid POSIX sh', async () => {
  const target = machine();
  const start = startScript(target, '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', 'rs-build-host');
  const stop = stopScript(target);
  const { execFileSync } = await import('node:child_process');
  for (const script of [start, stop]) {
    execFileSync('/bin/sh', ['-n'], { input: script, stdio: ['pipe', 'ignore', 'ignore'] });
  }
  assert.ok(/pkill -f "node \.\* --profile rs-build-host\$"/.test(stop), 'the stop pattern is anchored to the node binary and profile');
  assert.ok(!stop.includes('&;'), 'no `&;` syntax error');
  assert.ok(start.includes('--profile'), 'start launches the recorded profile');
});

// ── 4. Client panel: Detect must not rewire a provisioned machine ─────────────

function interactiveReact() {
  const instances = new Map();
  let currentInstance = null;
  let renderRoot = null;
  const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}) }, children: children.flat(Infinity) });
  const rerender = () => { if (renderRoot) renderRoot(); };
  const react = {
    createElement,
    useState(initial) {
      const inst = currentInstance; const index = inst.cursor++;
      if (!(index in inst.hooks)) inst.hooks[index] = [typeof initial === 'function' ? initial() : initial];
      return [inst.hooks[index][0], value => { inst.hooks[index][0] = typeof value === 'function' ? value(inst.hooks[index][0]) : value; rerender(); }];
    },
    useCallback: fn => fn, useMemo: fn => fn, useEffect: () => {}, useRef: value => ({ current: value }),
  };
  react.mount = element => { renderRoot = () => { renderNode(element); }; renderRoot(); return () => renderNode(element); };
  /** Materializes the current tree: host nodes carry expanded children and
   * function components are re-executed (hooks persist per component). */
  function renderNode(element) {
    if (element === null || element === undefined || element === false || element === true) return null;
    if (typeof element === 'string' || typeof element === 'number') return element;
    if (Array.isArray(element)) return element.map(renderNode);
    assert.ok(element && typeof element === 'object' && 'type' in element, `unexpected node ${JSON.stringify(element)}`);
    if (typeof element.type === 'function') {
      const existing = instances.get(element.type) ?? { hooks: {}, cursor: 0 };
      instances.set(element.type, existing);
      existing.cursor = 0;
      const previous = currentInstance;
      currentInstance = existing;
      try { return renderNode(element.type(element.props ?? {})); }
      finally { currentInstance = previous; }
    }
    return { ...element, children: (element.children ?? []).map(renderNode) };
  }
  return react;
}

function loadClientModule(React, fetch) {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: entry => { captured = entry; } }, location: { protocol: 'https:' } },
    document: undefined, fetch,
    console, setTimeout, clearTimeout, Error, TypeError, RangeError, Object, Array, JSON, String, Boolean, Number, Math, Promise, Date, RegExp, Symbol, Proxy, WeakMap, Map, Set,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox, { filename: 'client.js' });
  assert.ok(captured, 'the client module must register through window.__ModuleLoader__.load');
  return captured.factory(specifier => {
    if (specifier === 'react') return React;
    if (specifier === 'react-dom') return { createPortal: null };
    throw new Error('unexpected client require: ' + specifier);
  });
}

function findAll(root, pred, found = []) {
  if (!root || typeof root !== 'object') return found;
  if (Array.isArray(root)) { for (const item of root) findAll(item, pred, found); return found; }
  if (pred(root)) found.push(root);
  for (const child of root.children ?? []) findAll(child, pred, found);
  return found;
}
const inputByPlaceholder = (root, placeholder) => findAll(root, node => node.type === 'input' && node.props?.placeholder === placeholder).at(-1);
const buttonByText = (root, text) => findAll(root, node => node.type === 'button' && (node.children ?? []).some(child => child === text)).at(-1);
async function settle(rounds = 8) { for (let i = 0; i < rounds; i++) await new Promise(resolve => setTimeout(resolve, 5)); }

function mountSection(fetch, initialState) {
  const React = interactiveReact();
  const exports = loadClientModule(React, fetch);
  const registrations = [];
  const graph = { slots: { register: (options, component) => { registrations.push({ options, component }); return () => {}; } }, inject: (name, install) => install() };
  graph.slots.inject = (name, install) => install();
  exports.apply({ slots: graph.slots, locale: { bind: () => key => key, register: () => () => {} }, workspaces: { create: async () => ({ workspaceId: 'w1' }), list: { getSnapshot: () => ({ items: [] }) } }, sessions: { create: async () => 's1' }, effect: fn => { fn(); return () => {}; } });
  const registration = registrations.find(entry => entry.options.id === 'remote-sessions');
  const root = React.mount(React.createElement(registration.component, { t: key => key, initialState }));
  return { React, root, registration };
}

test('client Detect keeps an edited machine socket path and slugs new-machine defaults', async () => {
  const existing = { name: 'ssh-host', ssh: ['ssh-host'], remoteNode: '/usr/bin/node',
    socketPath: '/home/operator/.dsh/rs-runtime/ssh-dl1/agent.sock', remoteCwd: '/home/operator', syncModels: true };
  const requests = [];
  const fetch = async (url, opts = {}) => {
    requests.push({ method: opts.method, url, body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'POST' && String(url).includes('/machines/discover'))
      return { ok: true, json: async () => ({ discovery: { home: '/home/operator', node: '/usr/bin/node', nodeVersion: 'v22.3.0', cliBin: null, npm: null } }) };
    if (String(url).includes('/runtime/status')) return { ok: true, json: async () => ({ machines: [] }) };
    if (opts.method === 'POST') return { ok: true, json: async () => ({ ok: true, machines: [existing] }) };
    return { ok: true, json: async () => ({ machines: [existing], workspaces: [] }) };
  };
  const seeded = { machines: [existing], workspaces: [], runtime: {} };
  const { root } = mountSection(fetch, seeded);
  await settle();
  assert.ok(buttonByText(root(), 'machines.edit'), 'the Edit button renders');
  // Edit the existing machine: its provisioned socket path must survive Detect.
  buttonByText(root(), 'machines.edit').props.onClick();
  await settle();
  const socketInput = inputByPlaceholder(root(), '/home/user/.dsh/rs-runtime/<name>.sock');
  assert.equal(socketInput.props.value, '/home/operator/.dsh/rs-runtime/ssh-dl1/agent.sock');
  buttonByText(root(), 'machines.detect').props.onClick();
  await settle();
  const afterDetect = inputByPlaceholder(root(), '/home/user/.dsh/rs-runtime/<name>.sock');
  assert.equal(afterDetect.props.value, '/home/operator/.dsh/rs-runtime/ssh-dl1/agent.sock',
    'Detect must never rewrite the socket path of an already-configured machine');

  // A NEW machine (empty socket field) gets a slugged default, matching the
  // resident-profile naming convention (underscores collapse to dashes).
  buttonByText(root(), 'machines.save').props.onClick();
  await settle();
  const nameInput = inputByPlaceholder(root(), 'dl1');
  nameInput.props.onChange({ target: { value: 'ssh-host' } });
  await settle();
  const sshInput = findAll(root(), node => node.type === 'input' && node.props?.placeholder === 'user@host / ssh-alias / -p 2222 user@host').at(-1);
  sshInput.props.onChange({ target: { value: 'ssh-host' } });
  await settle();
  buttonByText(root(), 'machines.detect').props.onClick();
  await settle();
  const freshSocket = inputByPlaceholder(root(), '/home/user/.dsh/rs-runtime/<name>.sock');
  assert.equal(freshSocket.props.value, '/home/operator/.dsh/rs-runtime/ssh-host/agent.sock',
    'the Detect default slugs the machine name exactly like the resident profile');
});

test('client Edit + Save posts explicit flags and the protected fields it did not edit', async () => {
  const existing = { name: 'ssh-host', ssh: ['ssh-host'], remoteNode: '/usr/bin/node',
    socketPath: '/home/operator/.dsh/rs-runtime/ssh-dl1/agent.sock', remoteCwd: '/home/operator',
    remoteHome: '/srv/dsh-data', runtimeDirectory: '/home/operator/.dsh/rs-runtime/ssh-dl1',
    residentProfile: 'rs-ssh-dl1', autoSetup: true, npmInstall: false, dshVersion: '0.2.0-rc.2',
    authorityRevision: 'r7', plugins: [{ package: '@hytime/dsh-thinking-effort', version: '0.3.6' }],
    syncModels: true, syncPluginStates: false };
  const requests = [];
  const fetch = async (url, opts = {}) => {
    requests.push({ method: opts.method, url, body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'POST') return { ok: true, json: async () => ({ ok: true, machines: [existing] }) };
    return { ok: true, json: async () => ({ machines: [existing], workspaces: [] }) };
  };
  const { root } = mountSection(fetch, { machines: [existing], workspaces: [], runtime: {} });
  await settle();
  buttonByText(root(), 'machines.edit').props.onClick();
  await settle();
  // Uncheck "Sync models" to verify the panel posts an explicit false.
  const modelFlags = findAll(root(), node => node.type === 'input' && node.props?.type === 'checkbox');
  assert.ok(modelFlags.length >= 2);
  modelFlags[0].props.onChange({ target: { checked: false } });
  await settle();
  buttonByText(root(), 'machines.save').props.onClick();
  await settle();
  const saved = requests.find(item => item.method === 'POST' && item.body?.machines)?.body.machines.find(m => m.name === 'ssh-host');
  assert.ok(saved, 'the save must POST the machines');
  assert.equal(saved.syncModels, false, 'unchecking sync models posts an explicit false');
  assert.equal(saved.syncPluginStates, false);
  assert.equal(saved.remoteHome, '/srv/dsh-data', 'protected fields ride along from the record being edited');
  assert.equal(saved.runtimeDirectory, '/home/operator/.dsh/rs-runtime/ssh-dl1');
  assert.equal(saved.residentProfile, 'rs-ssh-dl1');
  assert.equal(saved.autoSetup, true);
  assert.equal(saved.npmInstall, false);
  assert.equal(saved.dshVersion, '0.2.0-rc.2');
  assert.equal(saved.authorityRevision, 'r7');
  assert.deepEqual(saved.plugins, [{ package: '@hytime/dsh-thinking-effort', version: '0.3.6' }]);
});

// ── 5b. Environment isolation: the resident owns its footprint ────────────────

test('the generated resident patch pins a resident-owned credential store', () => {
  const target = machine(); // runtimeDirectory /home/operator/.dsh/rs-runtime/build-host
  const text = profilePatchText(target, [], { defaultModel: null, pluginStates: [] });
  assert.ok(text.includes('- id: credentials'), 'the patch pins the credentials plugin');
  assert.ok(text.includes('"/home/operator/.dsh/rs-runtime/build-host/credentials.yaml"'),
    'the store lives in the resident-owned runtime directory, never the shared home');
});

// ── 12. Operator round 8: membership rebinds retry until VERIFIED ────────────

test('a failed membership rebind retries on the next list until the session is visible', async () => {
  // The real failure mode: at restart the registry's write chain is busy; a
  // one-shot detach+attach can lose the race (operator-reported: mygo has 3
  // sessions, only 2 visible locally). The rebind must verify the session
  // reached the workspace's VISIBLE membership and retry otherwise.
  const stored = new Map([['w', { path: '/anchor', sessionIds: ['session-flaky'] }]]);
  const pathIndex = new Map();
  let attachAttempts = 0;
  const entity = {
    get path() { return '/anchor'; },
    get sessionIds() { return (stored.get('w')?.sessionIds ?? []).filter(id => pathIndex.get(id) === '/anchor'); },
    async attachSession(id) {
      attachAttempts += 1;
      if (attachAttempts === 1) throw new Error('registry write chain busy'); // transient failure
      if (!(stored.get('w').sessionIds.includes(id))) {
        pathIndex.set(id, '/anchor');
        stored.get('w').sessionIds = [id, ...stored.get('w').sessionIds];
      }
    },
    async detachSession(id) { stored.get('w').sessionIds = stored.get('w').sessionIds.filter(x => x !== id); },
  };
  const ctx = proxyContext({
    mappings: [{ localPath: '/anchor', target: 'build-host', remotePath: '/home/operator/work' }],
    remoteSessions: [{ sessionId: 'session-flaky', cwd: '/home/operator/work', updatedAt: 2 }],
  });
  ctx.workspaceRegistry = { resolveByPath: async path => (path === '/anchor' ? entity : null) };
  const binding = { sessionId: 'session-flaky', remoteSessionId: 'session-flaky', target: 'build-host',
    cwd: '/anchor', remoteCwd: '/home/operator/work', authority: 'a', runtimeId: 'r', instanceId: 'i' };
  await ctx.bindings.set('session-flaky', binding);
  const proxy = installNativeSessionProxy(ctx, { bindings: ctx.bindings, resolveWorkspace: ctx.resolveWorkspace, transport: ctx.transport });
  try {
    await ctx.sessionController.list({});   // first attempt: the attach throws
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(entity.sessionIds.includes('session-flaky'), false, 'the transient failure leaves the session invisible');
    await ctx.sessionController.list({});   // retry on the next list
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(entity.sessionIds.includes('session-flaky'), true,
      'the rebind retries until the session reaches VISIBLE workspace membership');
    assert.ok(attachAttempts >= 2, 'at least two attach attempts ran');
  } finally { await proxy.dispose(); }
});

// ── 11. Operator round 7: a bridge boot must never lose the session store ────

test('web open verifies the bridge patch and repairs a clobbered store pin before launching', async () => {
  const target = machine({ remoteCli: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js' });
  const patchPath = "profiles/rs-web-build-host/cordis.patch.yml";
  const script = [
    { match: /tail -5 .*web\.log/, stdout: '', times: 1 },
    { match: /pkill/, code: 0, times: 1 },
    { match: /if \[ -x/, stdout: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', times: 1 },
    { match: /curl -s/, stdout: 'DEAD', times: 1 },
    // The provision writes the patch…
    { match: /--dump-config|cat > '/, reply: (text, input) => {
        if (/--dump-config/.test(text)) return { code: 0, stdout: '[]' };
        if (input === undefined || !String(input).includes('/rs-runtime/build-host/sessions')) {
          throw new Error('provision wrote a patch WITHOUT the session pin');
        }
        return { code: 0, stdout: '' };
      }, times: 2 },
    // …the launch is GATED on the written content: grep the pin in the patch.
    { match: /grep -/, reply: (text) => ({ code: /rs-runtime\/build-host\/sessions/.test(text) ? 0 : 1, stdout: '' }), times: 2 },
    { match: /setsid|nohup/, code: 0, times: 1 },
    { match: /cat .*web\.log/, stdout: 'dsh web: http://127.0.0.1:39999/?token=bridge-Tok_456', times: 1 },
  ];
  const { exec, calls } = scriptedExec(script);
  const remoteWeb = createRemoteWeb({ exec });
  await assert.rejects(remoteWeb.open(target), error => ['WEB_FORWARD_FAILED', 'WEB_START_TIMEOUT'].includes(error.code));
  const launch = calls.find(call => /setsid|nohup/.test(call.script));
  assert.ok(launch, 'the launch ran');
  // The launch must have been preceded by a content check of the bridge patch.
  const grep = calls.filter(call => /grep -/.test(call.script));
  assert.ok(grep.length >= 1, 'the bridge patch content was verified before launch');
  assert.ok(grep.every(call => call.script.includes('/rs-runtime/build-host/sessions')), 'the verification greps for the session-store pin');
  await remoteWeb.dispose();
});

test('web open repairs a previously clobbered patch ([]) and then launches', async () => {
  const target = machine({ remoteCli: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js' });
  let patchContent = ''; // simulates the remote file
  const script = [
    { match: /tail -5 .*web\.log/, stdout: '', times: 1 },
    { match: /pkill/, code: 0, times: 1 },
    { match: /if \[ -x/, stdout: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', times: 1 },
    { match: /curl -s/, stdout: 'DEAD', times: 1 },
    { match: /--dump-config/, reply: () => { patchContent = '[]\n'; return { code: 0, stdout: '' }; }, times: 1 },
    // The FIRST verify fails (clobbered content) → the repair rewrites the patch.
    { match: /grep -/, reply: () => ({ code: patchContent.includes('/rs-runtime/build-host/sessions') ? 0 : 1 }), times: 1 },
    { match: /cat > '/, reply: (text, input) => { patchContent = String(input); return { code: 0, stdout: '' }; }, times: 1 },
    { match: /grep -/, reply: () => ({ code: patchContent.includes('/rs-runtime/build-host/sessions') ? 0 : 1 }), times: 1 },
    { match: /setsid|nohup/, code: 0, times: 1 },
    { match: /cat .*web\.log/, stdout: 'dsh web: http://127.0.0.1:39999/?token=bridge-Tok_789', times: 1 },
  ];
  const { exec } = scriptedExec(script);
  const remoteWeb = createRemoteWeb({ exec });
  await assert.rejects(remoteWeb.open(target), error => ['WEB_FORWARD_FAILED', 'WEB_START_TIMEOUT'].includes(error.code));
  assert.ok(patchContent.includes('/rs-runtime/build-host/sessions'), 'the clobbered patch was repaired before launch');
  await remoteWeb.dispose();
});

// ── 10. Operator round 6: workspace membership survives a local restart ──────

test('restored bindings re-register their workspace path after a local restart', async () => {
  // Model the REAL registry semantics: the in-memory session-path index is
  // rebuilt at startup from the LOCAL store (remote shells have no local
  // journal), and attachSession only registers the path for NEW members —
  // so after every restart the workspace getter filtered ALL remote-bound
  // sessions out (operator-reported: empty workspace lists).
  const stored = new Map([['w', { path: '/anchor', sessionIds: ['session-restored'] }]]);
  const pathIndex = new Map(); // the in-memory sessionPaths, empty after restart
  const entity = {
    get path() { return '/anchor'; },
    get sessionIds() { return (stored.get('w')?.sessionIds ?? []).filter(id => pathIndex.get(id) === '/anchor'); },
    async attachSession(id) {
      if ((stored.get('w')?.sessionIds ?? []).includes(id)) return; // existing member: no re-registration
      pathIndex.set(id, '/anchor');
      stored.get('w').sessionIds = [id, ...stored.get('w').sessionIds];
    },
    async detachSession(id) { stored.get('w').sessionIds = stored.get('w').sessionIds.filter(x => x !== id); },
  };
  const ctx = proxyContext({
    mappings: [{ localPath: '/anchor', target: 'build-host', remotePath: '/home/operator/work' }],
    remoteSessions: [{ sessionId: 'session-restored', cwd: '/home/operator/work', updatedAt: 2 }],
  });
  ctx.workspaceRegistry = {
    resolveByPath: async path => (path === '/anchor' ? entity : null),
    attachSession: () => { throw new Error('registry-level attach is not the entity'); },
  };
  const binding = { sessionId: 'session-restored', remoteSessionId: 'session-restored', target: 'build-host',
    cwd: '/anchor', remoteCwd: '/home/operator/work', authority: 'a', runtimeId: 'r', instanceId: 'i' };
  await ctx.bindings.set('session-restored', binding);
  // The stored membership EXISTS (created before the restart) but the index is empty.
  assert.deepEqual(entity.sessionIds, [], 'precondition: the restart emptied the index');
  const proxy = installNativeSessionProxy(ctx, { bindings: ctx.bindings, resolveWorkspace: ctx.resolveWorkspace, transport: ctx.transport });
  try {
    // The rebind is deferred to the first list (writes inside the boot
    // transaction hang); after one list round it must have settled.
    await ctx.sessionController.list({});
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(entity.sessionIds, ['session-restored'],
      'the restored session re-registers its workspace path and stays visible in the workspace');
    const listing = await ctx.sessionController.list({});
    assert.ok(listing.items.some(item => item.sessionId === 'session-restored'), 'the session lists');
  } finally { await proxy.dispose(); }
});

// ── 9. Operator round 5: previously-created sessions must stay visible ──────

test('a stale-instance binding still lists its session after a resident restart (full proxy path)', async () => {
  // The exact live failure: every binding went "offline" after a restart
  // because adoption wrote through the immutable set and conflicted.
  const ctx = proxyContext({
    mappings: [{ localPath: '/anchor', target: 'build-host', remotePath: '/home/operator/work' }],
    remoteSessions: [{ sessionId: 'session-old', cwd: '/home/operator/work', updatedAt: 5, title: 'previous work', agentAvailable: true, running: false, blank: false }],
  });
  const stale = { sessionId: 'session-old', remoteSessionId: 'session-old', target: 'build-host',
    cwd: '/anchor', remoteCwd: '/home/operator/work', authority: 'a', runtimeId: 'r', instanceId: 'stale-instance' };
  await ctx.bindings.set('session-old', stale);
  const proxy = installNativeSessionProxy(ctx, { bindings: ctx.bindings, resolveWorkspace: ctx.resolveWorkspace, transport: ctx.transport });
  try {
    const listing = await ctx.sessionController.list({});
    const row = listing.items.find(item => item.sessionId === 'session-old');
    assert.ok(row, 'the previously-created session stays listed');
    assert.equal(row.agentAvailable, true, 'the REAL remote row is served, not an offline placeholder');
    assert.equal(row.title, 'previous work');
  } finally { await proxy.dispose(); }
});

test('a binding whose remote session is confirmed gone is unbound, not a permanent ghost', async () => {
  const ctx = proxyContext({
    mappings: [{ localPath: '/anchor', target: 'build-host', remotePath: '/home/operator/work' }],
    remoteSessions: [{ sessionId: 'session-live', cwd: '/home/operator/work', updatedAt: 3 }],
  });
  const live = { sessionId: 'session-live', remoteSessionId: 'session-live', target: 'build-host',
    cwd: '/anchor', remoteCwd: '/home/operator/work', authority: 'a', runtimeId: 'r', instanceId: 'i' };
  const orphan = { sessionId: 'session-orphan', remoteSessionId: 'session-orphan', target: 'build-host',
    cwd: '/anchor', remoteCwd: '/home/operator/work', authority: 'a', runtimeId: 'r', instanceId: 'i' };
  await ctx.bindings.set('session-live', live);
  await ctx.bindings.set('session-orphan', orphan);
  const proxy = installNativeSessionProxy(ctx, { bindings: ctx.bindings, resolveWorkspace: ctx.resolveWorkspace, transport: ctx.transport });
  try {
    const listing = await ctx.sessionController.list({});
    assert.ok(listing.items.some(item => item.sessionId === 'session-live'), 'live sessions stay');
    assert.equal(listing.items.some(item => item.sessionId === 'session-orphan'), false,
      'a confirmed-absent remote session disappears from the list');
    assert.equal(ctx.bindings.has('session-orphan'), false, 'the orphaned binding is removed');
  } finally { await proxy.dispose(); }
});

// ── 8. A legacy standalone web instance is never mistaken for the bridge ─────

test('a legacy bare-web announcement is never reused: the bridge replaces it', async () => {
  const target = machine({ remoteCli: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js' });
  const { exec, calls } = scriptedExec([
    { match: /tail -5 .*web\.log/, stdout: 'dsh web: http://127.0.0.1:39871/?token=legacy-Tok_123', times: 1 },
    { match: /curl -s .*39871/, stdout: 'ALIVE', times: 1 },                              // the old web IS alive…
    { match: /pgrep -f/, stdout: '', times: 1 },                                          // …but NOT on the bridge profile
    { match: /pkill/, code: 0, times: 1 },                                               // → killed, never reused
    { match: /if \[ -x/, stdout: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', times: 1 },
    { match: /curl -s/, stdout: 'DEAD', times: 1 },
    { match: /--dump-config/, stdout: '[]', times: 1 },
    { match: /cat > '/, times: 1 },
    { match: /grep -q/, code: 0, times: 1 },
    { match: /setsid|nohup/, code: 0, times: 1 },
    { match: /cat .*web\.log/, stdout: 'dsh web: http://127.0.0.1:39999/?token=bridge-Tok_456', times: 1 },
  ]);
  const remoteWeb = createRemoteWeb({ exec });
  await assert.rejects(remoteWeb.open(target), error => ['WEB_FORWARD_FAILED', 'WEB_START_TIMEOUT'].includes(error.code));
  const ordered = calls.map(call => call.script.split(' ')[0] + (call.script.includes('pgrep') ? ':pgrep' : call.script.includes('pkill') ? ':pkill' : call.script.includes('dump-config') ? ':dump' : call.script.includes('setsid') ? ':launch' : ''));
  const pkillIndex = ordered.findIndex(tag => tag.endsWith(':pkill'));
  const launchIndex = ordered.findIndex(tag => tag.endsWith(':launch'));
  assert.ok(pkillIndex >= 0 && launchIndex > pkillIndex, 'the legacy instance is killed before the bridge boots');
  assert.equal(ordered.findIndex(tag => tag.endsWith(':pgrep')) < pkillIndex, true, 'the bridge-ownership check precedes the kill');
  await remoteWeb.dispose();
});

// ── 7. Operator round 4: the remote web UI must share the resident's sessions ──

test('the web bridge profile shares the resident session store, not a parallel one', async () => {
  const target = machine(); // runtimeDirectory /home/operator/.dsh/rs-runtime/build-host
  const environment = { defaultModel: { provider: 'deepinfra', model: 'zai-org/GLM-5.3' }, pluginStates: [], modelProvidersSection: '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers: {}\n' };
  // Profile name is machine-scoped, like the resident profile.
  assert.equal(webBridgeProfileName(target), 'rs-web-build-host');
  const patch = webBridgePatchText(target, environment);
  // The session store is THE resident's store: sessions created through the
  // bridge web UI land where the resident (and therefore the local UI's
  // adoption) can see them, and vice versa.
  assert.ok(patch.includes('root: "/home/operator/.dsh/rs-runtime/build-host/sessions"'),
    'the bridge pins the resident session store');
  assert.ok(patch.includes('path: "/home/operator/.dsh/rs-runtime/build-host/credentials.yaml"'),
    'the bridge reads the resident-owned credential store');
  assert.ok(patch.includes('dshHome: "/home/operator/.dsh/rs-runtime/build-host"'),
    'the bridge shares the resident attachment store');
  assert.ok(patch.includes('llm-pi-ai'), 'the bridge composes the synced provider catalog');
  // Its own writable state stays isolated from the resident's.
  assert.ok(patch.includes('web-storages'), 'the bridge keeps its own JSON storage root');
  assert.equal(patch.includes('- id: remote-resident'), false, 'the bridge never mounts the companion');
});

test('web open provisions the bridge profile before launching the web app on it', async () => {
  const target = machine({ remoteCli: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js' });
  const { exec, calls } = scriptedExec([
    { match: /tail -5 .*web\.log/, stdout: '', times: 1 },                       // no prior announcement
    { match: /pkill/, code: 0, times: 1 },
    { match: /if \[ -x/, stdout: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', times: 1 },
    { match: /curl -s/, stdout: 'DEAD', times: 1 },                               // free port probe
    { match: /--dump-config/, stdout: '[]', times: 1 },                            // create the bridge profile
    { match: /cat > '/, times: 1 },                                               // write the bridge patch
    { match: /grep -q/, code: 0, times: 1 },                                      // content gate passes
    { match: /setsid|nohup/, code: 0, times: 1 },                                 // launch the web app
    { match: /cat .*web\.log/, stdout: 'dsh web: http://127.0.0.1:39871/?token=abc-DEF_123', times: 1 },
  ]);
  const remoteWeb = createRemoteWeb({ exec });
  // The tunnel spawn will fail (no such host in the test env); the remote-side
  // sequence must already be correct at that point.
  await assert.rejects(remoteWeb.open(target), error => ['WEB_FORWARD_FAILED', 'WEB_START_TIMEOUT', 'LOCAL_PORT_UNAVAILABLE'].includes(error.code));
  const scripts = calls.map(call => call.script);
  const create = scripts.find(text => /--dump-config/.test(text));
  assert.ok(create, 'the bridge profile is created from the web template');
  assert.ok(/--profile 'rs-web-build-host'/.test(create) && create.includes('--from-default-profile web'),
    'creation initializes the machine-scoped bridge from the shipped web template');
  const patchWrite = calls.find(call => /cat > '/.test(call.script));
  assert.ok(patchWrite.script.includes("profiles/rs-web-build-host/cordis.patch.yml") || patchWrite.script.includes('profiles/' + 'rs-web-build-host' + '/cordis.patch.yml'), 'the bridge patch is written into its profile');
  assert.ok(String(patchWrite.input ?? '').includes('/rs-runtime/build-host/sessions'), 'the patch pins the resident session store');
  const launch = calls.find(call => /setsid|nohup/.test(call.script));
  assert.ok(/--profile .*rs-web-build-host/.test(launch.script), 'the web app boots ON the bridge profile');
  assert.equal(launch.script.includes('--from-default-profile'), false, 'an existing bridge never re-initializes');
  assert.equal(/pkill -f 'lib\/bin\.js(\.*)? ?web'/.test(scripts.find(text => /pkill/.test(text))), false,
    'the stale-kill pattern matches the bridge launch line, not only the legacy bare-web form');
  await remoteWeb.dispose();
});

// ── 6. Operator round 3: remote model selection must never fail silently ────

test('a rejected remote model selection surfaces a session error, never silence', async () => {
  const ctx = proxyContext({
    mappings: [{ localPath: '/anchor', target: 'build-host', remotePath: '/home/operator/work' }],
    remoteSessions: [{ sessionId: 'session-bound', cwd: '/home/operator/work', updatedAt: 1 }],
  });
  // The transport rejects the forwarded selection exactly as the resident does
  // for an unsupported reasoning effort.
  ctx.transport.call = async (binding, endpoint) => {
    if (endpoint === 'session/selectModel') {
      const error = new Error('provider "deepinfra" model "XiaomiMiMo/MiMo-V2.6-Pro" does not support reasoning effort "xhigh"');
      error.code = 'session/model-unavailable';
      throw error;
    }
    if (endpoint === 'session/list') return { items: ctx.remoteSessions.map(item => ({ ...item })) };
    return {};
  };
  const bound = { sessionId: 'session-bound', remoteSessionId: 'session-bound', target: 'build-host',
    cwd: '/anchor', remoteCwd: '/home/operator/work', authority: 'a', runtimeId: 'r', instanceId: 'i' };
  await ctx.bindings.set('session-bound', bound);
  const proxy = installNativeSessionProxy(ctx, { bindings: ctx.bindings, resolveWorkspace: ctx.resolveWorkspace, transport: ctx.transport });
  try {
    await assert.rejects(ctx.sessionController.selectModel({ sessionId: 'session-bound', provider: 'deepinfra', model: 'XiaomiMiMo/MiMo-V2.6-Pro', reasoningEffort: 'xhigh' }),
      { code: 'session/model-unavailable' }, 'the resident rejection propagates');
    const errors = ctx.emitted['api-session/error'] ?? [];
    assert.ok(errors.length >= 1, 'the failure is surfaced through the session-error channel');
    assert.match(String(errors[0]), /selectModel/, 'the surfaced message names the failed operation');
    assert.match(String(errors[0]), /does not support reasoning effort/, 'the surfaced message carries the resident reason');
    // A successful selection surfaces nothing.
    ctx.transport.call = async (binding, endpoint) => (endpoint === 'session/list' ? { items: [] } : {});
    ctx.emitted['api-session/error'] = [];
    await ctx.sessionController.selectModel({ sessionId: 'session-bound', provider: 'deepinfra', model: 'XiaomiMiMo/MiMo-V2.6-Pro' });
    assert.equal((ctx.emitted['api-session/error'] ?? []).length, 0, 'successful selections stay silent');
  } finally { await proxy.dispose(); }
});

// ── 5. Operator round 2: omlx credentials, auto-review, live sync ─────────────

test('model sync writes credentials for EVERY provider, not just the first', async () => {
  const t = test;
  const local = localEnvironment(t);
  // Two providers with distinct keys: deepinfra (first) and omlx (second).
  writeFileSync(join(local, 'profiles', 'desktop', 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      deepinfra:',
    '        apiKeyEnv: DEEPINFRA_TEST_KEY',
    '        api: openai-completions',
    '      omlx:',
    '        apiKeyEnv: OMLX_TEST_KEY',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:8000/v1',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: deepinfra',
    '    model: zai-org/GLM-5.3',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(local, '.credentials.yaml'), '  DEEPINFRA_TEST_KEY: deep-key-value\n  OMLX_TEST_KEY: omlx-key-value\n', 'utf8');
  const target = machine();
  const remotePatch = '- id: remote-resident\n  config:\n    runtimeDirectory: "/home/operator/.dsh/rs-runtime/build-host"\n';
  const { exec, calls } = scriptedExec([
    { match: /cat .*profiles.*cordis\.patch\.yml' 2>\/dev\/null/, stdout: remotePatch, times: 1 },
    { match: /cat > '/, code: 0, times: 1 },
    { match: /grep -q/, times: 2 },
  ]);
  const result = await syncModelsToRemote({
    exec, machine: target, probe: { home: '/home/operator/.dsh' },
    profileDir: '/home/operator/.dsh/profiles/rs-build-host',
    localProfileDir: join(local, 'profiles', 'desktop'),
  });
  assert.deepEqual(result, { providers: true, defaultModel: true, credential: true });
  // Environment isolation: the SHARED home level is never written.
  for (const call of calls) {
    assert.equal(call.script.includes('/home/operator/.dsh/.credentials.yaml'), false, 'the shared home credential store is never written');
    assert.equal(/dsh\/cordis\.patch\.yml/.test(call.script) && !/profiles/.test(call.script), false, 'the shared home-level patch is never touched');
  }
  const credentialSteps = calls.filter(item => /grep -q/.test(item.script));
  for (const step of credentialSteps) assert.ok(step.script.includes('/home/operator/.dsh/rs-runtime/build-host/credentials.yaml'),
    'credentials land in the resident-owned runtime directory');
  assert.equal(credentialSteps.length, 2, 'one credential step per provider key');
  const vars = credentialSteps.map(item => (/grep -q '(\w+):'/.exec(item.script) ?? [])[1]);
  assert.deepEqual([...vars].sort(), ['DEEPINFRA_TEST_KEY', 'OMLX_TEST_KEY'], 'every provider apiKeyEnv syncs');
  for (const step of credentialSteps) {
    assert.ok(step.script.includes('umask 077'), 'owner-only creation');
    assert.ok(!step.script.includes('key-value'), 'keys never appear in argv');
    assert.ok(String(step.input ?? '').match(/\w+_TEST_KEY: [\w-]+\n/), 'the key streams over stdin');
  }
  const inputs = credentialSteps.map(item => String(item.input ?? ''));
  assert.ok(inputs.some(value => value.includes('OMLX_TEST_KEY: omlx-key-value')), 'the omlx key reaches the remote');
  assert.ok(inputs.some(value => value.includes('DEEPINFRA_TEST_KEY: deep-key-value')), 'the deepinfra key reaches the remote');
});

test('environment sync derives session-behavior bundle pins from the local profile', async () => {
  const t = test;
  const local = localEnvironment(t);
  const profileDir = join(local, 'profiles', 'desktop');
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    private: true, type: 'module',
    dependencies: {},
    dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-experimental-agent-team-profile',
      '@deepseek-ai/dsh-experimental-auto-review',
      '@deepseek-ai/dsh-experimental-voice-input-bundle',
      'dsh-cost-meter',
      '@hytime/dsh-thinking-effort',
    ] } },
  }, null, 2), 'utf8');
  const environment = await readLocalEnvironment({ describe: () => [{ ns: 'agent-default-model', value: { provider: 'deepinfra', model: 'zai-org/GLM-5.3' } }] }, profileDir);
  const pins = (environment.bundlePins ?? []).map(pin => pin.package).sort();
  assert.ok(pins.includes('@deepseek-ai/dsh-experimental-auto-review'), 'locally-enabled auto-review pins onto the resident');
  assert.ok(pins.includes('@deepseek-ai/dsh-experimental-agent-team-profile'), 'locally-enabled agent-team pins onto the resident');
  assert.equal(pins.includes('@deepseek-ai/dsh-experimental-voice-input-bundle'), false, 'client-only bundles never pin');
  assert.equal(pins.includes('dsh-cost-meter'), false, 'non-optional local bundles never pin');
  assert.equal(pins.includes('@hytime/dsh-thinking-effort'), false, 'operator pins stay explicit (machine.plugins)');
  for (const pin of environment.bundlePins) assert.ok(/^\d+[.]\d+[.]\d+/.test(pin.version ?? ''), 'pins carry a resolvable version: ' + JSON.stringify(pin));
  // The manifest composes the pinned bundles into the resident profile.
  const manifest = JSON.parse(profileManifestText(machine(), [], environment));
  assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-auto-review'));
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-experimental-auto-review'], undefined,
    'CLI-shipped bundles compose from the installation, never as npm dependencies');
  // The signature changes when the local bundle set changes.
  const without = setupSignature(machine(), { defaultModel: null, pluginStates: [] });
  const withPins = setupSignature(machine(), environment);
  assert.notEqual(without, withPins, 'bundle pins enter the provision signature');
  // The resident-owned credential-store pin is part of the patch: a resident
  // provisioned before the pin never reports in-sync.
  assert.notEqual(without, setupSignature(machine({ runtimeDirectory: '/other/runtime' }), { defaultModel: null, pluginStates: [] }),
    'the credential store pin enters the provision signature');
});

test('CLI-shipped bundle pins compose WITHOUT npm install (no duplicate module trees)', async () => {
  const target = machine();
  const marker = {
    version: 1, bundleVersion: '0.8.1', bundleSha256: 'x', profile: 'rs-build-host',
    runtimeDirectory: '/home/operator/.dsh/rs-runtime/build-host', socketPath: target.socketPath,
    cliBin: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', nodePath: '/usr/bin/node',
    plugins: 'old',
  };
  const environment = { defaultModel: null, pluginStates: [], bundlePins: [{ package: '@deepseek-ai/dsh-experimental-auto-review', version: '0.2.0-rc.2' }] };
  const { exec, calls } = scriptedExec([
    { match: /printf 'HOME:%s/, stdout: probeReply({ marker }), times: 2 },
    { match: /kill|pkill/, code: 0, times: 1 },
    { match: /readlink -f|if \[ -x/, stdout: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', times: 2 },
    { match: /require\(process\.argv\[1\]/, stdout: '0.2.0-rc.2\n', times: 1 },
    { match: /cat .*profiles.*cordis\.patch\.yml' 2>\/dev\/null/, stdout: '- id: remote-resident\n  config:\n    runtimeDirectory: "/home/operator/.dsh/rs-runtime/build-host"\n', times: 1 },
    { match: /mkdir|chmod/, times: 2 },
    { match: /tar -xzf -/, times: 1 },
    { match: /rm -rf|mv |rmdir|ln -s/, times: 1 },
    { match: /cat > '/, times: 4 },
    { match: /npm('|")? install/, times: 1 },
    { match: /setsid|nohup/, code: 0, times: 1 },
  ]);
  const setup = createRemoteSetup({ exec, spawn: BUNDLE_FAKE, readEnvironment: async () => environment });
  const outcome = await setup.sync(target);
  assert.equal(outcome.outcome, 'synced');
  // Regression (resident "SessionQueryError: session not found" on every
  // create): npm-installing CLI-shipped bundles into the profile node_modules
  // duplicated the whole @deepseek-ai stack — two module copies, broken
  // instanceof across them. Bundles compose from the INSTALLATION through the
  // profile bundles list; npm stays reserved for operator plugin pins.
  assert.equal(calls.some(item => /npm('|")? install/.test(item.script)), false, 'bundle pins never npm-install');
  const manifestWrite = calls.find(item => /cat > '/.test(item.script) && /package\.json/.test(item.script));
  assert.ok(manifestWrite, 'the resident profile manifest is written');
  const manifest = JSON.parse(manifestWrite.input);
  assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-auto-review'), 'the pin composes via the bundles list');
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-experimental-auto-review'], undefined, 'CLI-shipped bundles carry no npm dependency');
  const patchWrite = calls.filter(item => /cat > '/.test(item.script) && /profiles.*cordis\.patch/.test(item.script)).at(-1);
  assert.ok(patchWrite, 'the resident patch is rewritten');
});

test('transport rebinds a persisted session after a resident restart when the remote session survives', async () => {
  const base = { name: 'build-host', ssh: ['operator@build-host'], remoteNode: '/usr/bin/node',
    socketPath: '/home/operator/.dsh/rs-runtime/build-host/agent.sock', remoteCwd: '/home/operator/work' };
  const registry = { machines: [normalizeMachine(base)] };
  const stale = { sessionId: 'session-1', remoteSessionId: 'session-1', target: 'build-host',
    cwd: '/anchor', remoteCwd: '/home/operator/work', authority: machineIdentity(registry.machines[0]),
    runtimeId: 'runtime', instanceId: 'old-instance' };
  let instance = 'new-instance';
  const peers = [];
  const connect = async () => {
    const requests = [];
    const peer = { async request(method, params) {
      requests.push({ method, params });
      if (method === 'hello') return { protocol: 'dsh-remote-sessions/1', runtimeId: 'runtime', instanceId: instance, capabilities: [] };
      if (method === 'call' && params.endpoint === 'session/list') return { ok: true, value: { items: [{ sessionId: 'session-1' }] } };
      if (method === 'call') return { ok: true, value: {} };
      return {};
    }, done: Promise.resolve({}), close() {} };
    peers.push({ peer, requests });
    return { peer, hello: { runtimeId: 'runtime', instanceId: instance, capabilities: [] }, close: () => {}, authority: machineIdentity(registry.machines[0]) };
  };
  const adopted = [];
  const adopt = async binding => { adopted.push(binding.sessionId); return { ...binding, instanceId: 'new-instance' }; };
  const transport = createNativeTransport(registry, { connect, adopt });
  const listing = await transport.call(stale, 'session/list', [{}]);
  assert.equal(listing.items.length, 1, 'a survived remote session keeps serving after the restart');
  assert.deepEqual(adopted, ['session-1'], 'the adoption hook ran for the stale binding');
  // No adopter: the binding fails closed exactly as before.
  const strict = createNativeTransport(registry, { connect });
  await assert.rejects(strict.call({ ...stale }, 'session/list', [{}]), { code: 'INSTANCE_CHANGED' });
  // A runtime identity change is never adopted.
  const nextRegistry = { machines: [normalizeMachine(base)] };
  await assert.rejects(createNativeTransport(nextRegistry, { connect, adopt: async () => true })
    .call({ ...stale, runtimeId: 'other-runtime' }, 'session/list', [{}]), { code: 'RUNTIME_CHANGED' });
  await transport.dispose(); await strict.dispose();
});

test('durable bindings adopt a new resident instance only for surviving sessions', async () => {
  const rows = new Map();
  // The REAL store's set() forbids EVERY field change including instanceId;
  // adoption must therefore write through the low-level put, never set().
  const bindings = adoptableBindings({
    get size() { return rows.size; }, has: id => rows.has(id), get: id => rows.get(id),
    *values() { for (const [, value] of rows.entries()) yield value; },
    async put(id, value) { rows.set(id, Object.freeze({ ...value })); },
    async set() { throw Object.assign(new Error('set is immutable'), { code: 'REMOTE_BINDING_CONFLICT' }); },
    close: () => {},
  });
  const previous = { sessionId: 'session-1', remoteSessionId: 'session-1', target: 'build-host',
    cwd: '/anchor', remoteCwd: '/work', authority: 'a', runtimeId: 'r', instanceId: 'old' };
  await bindings.put('session-1', previous);
  // Every field but the instance must stay pinned.
  await bindings.adopt('session-1', { ...previous, instanceId: 'new' });
  assert.equal(rows.get('session-1').instanceId, 'new');
  await assert.rejects(bindings.adopt('session-1', { ...previous, remoteSessionId: 'session-2', instanceId: 'newer' }), /REMOTE_BINDING_CONFLICT/);
  await assert.rejects(bindings.adopt('session-missing', { ...previous, sessionId: 'session-missing', instanceId: 'x' }), /UNKNOWN_BINDING/);
});

test('listing adopts remote-created sessions of mapped workspaces into the local interface', async () => {
  const ctx = proxyContext({
    mappings: [{ localPath: '/anchor', target: 'build-host', remotePath: '/home/operator/work' }],
    remoteSessions: [
      { sessionId: 'session-bound', cwd: '/home/operator/work', running: false, updatedAt: 2 },
      { sessionId: 'session-remote-made', cwd: '/home/operator/work', running: true, updatedAt: 3, title: 'remote web session' },
      { sessionId: 'session-elsewhere', cwd: '/home/ubuntu/other', running: false, updatedAt: 1 },
    ],
  });
  const bound = { sessionId: 'session-bound', remoteSessionId: 'session-bound', target: 'build-host',
    cwd: '/anchor', remoteCwd: '/home/operator/work', authority: 'a', runtimeId: 'r', instanceId: 'i' };
  await ctx.bindings.set('session-bound', bound);
  const proxy = installNativeSessionProxy(ctx, { bindings: ctx.bindings, resolveWorkspace: ctx.resolveWorkspace, transport: ctx.transport });
  try {
    const listing = await ctx.sessionController.list({});
    if (process.env.DEBUG18) { console.log('LISTING:', JSON.stringify(listing).slice(0, 400)); console.log('ERRORS:', JSON.stringify(ctx.emitted['api-session/error'])); }
    const ids = listing.items.map(item => item.sessionId);
    assert.ok(ids.includes('session-bound'), 'bound sessions stay listed');
    assert.ok(ids.includes('session-remote-made'), 'a remote-created session of a mapped workspace is adopted');
    assert.equal(ids.includes('session-elsewhere'), false, 'sessions of unmapped remote directories stay invisible');
    const adoptedRow = ctx.bindings.get('session-remote-made');
    assert.equal(adoptedRow.cwd, '/anchor', 'the adopted binding anchors to the mapped local directory');
    assert.equal(adoptedRow.remoteCwd, '/home/operator/work');
    assert.equal(adoptedRow.remoteSessionId, 'session-remote-made');
    assert.deepEqual(ctx.emitted['api-session/added']?.map(item => item.sessionId), ['session-remote-made'], 'the local UI is told about the adopted session');
    assert.equal(ctx.attached.includes('session-remote-made'), true, 'the session joins the local workspace');
    const item = listing.items.find(value => value.sessionId === 'session-remote-made');
    assert.equal(item.cwd, '/anchor');
    assert.equal(item.running, true, 'the remote running state rides along');
  } finally { await proxy.dispose(); }
});

test('adoption never steals an existing local session id and never breaks the list', async () => {
  const ctx = proxyContext({
    mappings: [{ localPath: '/anchor', target: 'build-host', remotePath: '/home/operator/work' }],
    remoteSessions: [{ sessionId: 'session-collides', cwd: '/home/operator/work', updatedAt: 1 }],
  });
  // A LOCAL session already owns the id; the remote session must not be adopted.
  ctx.localSessionIds.push('session-collides');
  const bound = { sessionId: 'session-bound', remoteSessionId: 'session-bound', target: 'build-host',
    cwd: '/anchor', remoteCwd: '/home/operator/work', authority: 'a', runtimeId: 'r', instanceId: 'i' };
  await ctx.bindings.set('session-bound', bound);
  const proxy = installNativeSessionProxy(ctx, { bindings: ctx.bindings, resolveWorkspace: ctx.resolveWorkspace, transport: ctx.transport });
  try {
    const listing = await ctx.sessionController.list({});
    assert.equal(ctx.bindings.has('session-collides'), false, 'no binding is created for a colliding id');
    assert.equal(listing.items.some(item => item.sessionId === 'session-collides' && item.cwd === '/anchor'), false);
  } finally { await proxy.dispose(); }
});

// ── helpers ────────────────────────────────────────────────────────────────────

function response() {
  const res = new EventEmitter();
  return Object.assign(res, { statusCode: 200, headers: {}, writableEnded: false, destroyed: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(body) { this.body = body === undefined ? undefined : JSON.parse(body); this.writableEnded = true; this.emit('finish'); },
  });
}
function request(value, method = 'POST') {
  const req = Readable.from(value === undefined ? [] : [JSON.stringify(value)]);
  req.method = method; req.headers = {}; req.signal = undefined;
  return req;
}
