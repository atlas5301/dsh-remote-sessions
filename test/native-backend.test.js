import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { installedAnchor } from './anchor.mjs';
import { machineIdentity } from '../lib/authority.js';
const installed = createRequire(installedAnchor());
const hook = registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (!specifier.startsWith('@deepseek-ai/') && specifier !== 'zod') throw error;
    return { url: pathToFileURL(installed.resolve(specifier)).href, shortCircuit: true };
  }
} });
const { createNativeTransport } = await import('../lib/native-transport.js');
const { installNativeSessionProxy } = await import('../lib/native-session-proxy.js');
const { Config } = await import('../lib/native-host.js');
const { redactSecrets } = await import('@deepseek-ai/dsh-settings');
hook.deregister();

function fixture() {
  const registry = { machines: [{ name: 'remote', ssh: ['user@host'], socketPath: '/home/user/run/socket', remoteNode: '/usr/bin/node' }] };
  const calls = [], peers = []; let connects = 0, failure, epoch = 'one';
  const transport = createNativeTransport(registry, { async connect() {
    connects++; let end; const done = new Promise(resolve => { end = resolve; });
    const peer = { done, async request(method, params) { calls.push({ method, params }); if (failure) throw Object.assign(new Error(failure), { code: failure }); return { ok: true, value: { accepted: true } }; } };
    peers.push({ peer, end });
    return { peer, hello: { runtimeId: 'runtime', instanceId: epoch }, close: end };
  } });
  return { registry, calls, peers, transport, connects: () => connects, fail: value => { failure = value; }, epoch: value => { epoch = value; } };
}

test('native transport pins authority/runtime/epoch and never replays unknown mutation', async () => {
  const f = fixture(), binding = await f.transport.identify('remote');
  assert.equal(binding.authority, machineIdentity(f.registry.machines[0]));
  await f.transport.call(binding, 'session/prompt', [{ sessionId: 's' }]);
  f.fail('TRANSPORT_LOST');
  await assert.rejects(f.transport.call(binding, 'session/prompt', [{ sessionId: 's' }]), { code: 'UNKNOWN_MUTATION_OUTCOME' });
  assert.equal(f.calls.length, 2); assert.equal(f.connects(), 1);
  f.peers[0].end(); await new Promise(resolve => setImmediate(resolve)); f.fail(null); f.epoch('two');
  await assert.rejects(f.transport.call(binding, 'session/prompt', [{ sessionId: 's' }]), { code: 'INSTANCE_CHANGED' });
  assert.equal(f.calls.length, 2); await f.transport.dispose();
});
test('native explicit model selection carries default consent; authority edits reject before RPC', async () => {
  const f = fixture(), binding = await f.transport.identify('remote');
  await f.transport.call(binding, 'session/selectModel', [{ sessionId: 's', provider: 'p', model: 'm' }]);
  assert.equal(f.calls[0].params.confirmDefaultChange, true);
  f.registry.machines[0].socketPath = '/different/runtime';
  await assert.rejects(f.transport.call(binding, 'session/prompt', [{}]), { code: 'AUTHORITY_CHANGED' });
  assert.equal(f.calls.length, 1); await f.transport.dispose();
});
test('disabled target and cancelled submission do not open an SSH relay', async () => {
  const f = fixture(); f.registry.machines[0].disabled = true;
  await assert.rejects(f.transport.identify('remote'), { code: 'REMOTE_MACHINE_UNAVAILABLE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.transport.call({ target: 'remote' }, 'session/prompt', [{}], controller.signal), { name: 'AbortError' });
  assert.equal(f.connects(), 0); await f.transport.dispose();
});
test('partial activation rolls back factory fences and preserves native method receiver', async () => {
  const methods = ['create', 'list', 'resolveAgent', 'prompt', 'cancel', 'rename', 'selectModel', 'updateQueue', 'attachment', 'projections', 'page', 'follow', 'fork', 'control', 'search', 'modelCatalog'];
  const sessionController = Object.fromEntries(methods.map(name => [name, function () { assert.equal(this, sessionController); return name; }]));
  const agents = { create() { return 'local-create'; }, resume() { return 'local-resume'; } }, create = agents.create, resume = agents.resume;
  const ctx = { sessionController, agents }; // no uploads: setup must fail AFTER wrapping factory
  assert.throws(() => installNativeSessionProxy(ctx, { bindings: new Map(), transport: {}, resolveWorkspace() {} }), { code: 'INCOMPATIBLE_DSH' });
  assert.equal(agents.create, create); assert.equal(agents.resume, resume);
  assert.equal(sessionController.prompt(), 'prompt');
});

test('native generated settings redact machine environment values before frontend projection', () => {
  const secret = 'test-only-sensitive-transport-value';
  const value = { machines: [{ name: 'remote', ssh: ['host'], env: { EXAMPLE_TOKEN: secret } }] };
  const result = redactSecrets(Config, value);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.ok(result.secrets.some(item => item.path.join('.') === 'machines.0.env.EXAMPLE_TOKEN'));
  assert.equal(value.machines[0].env.EXAMPLE_TOKEN, secret);
});

test('release manifest packages the settings client but never the rejected remote chat UI', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.main, 'lib/native-host.js'); assert.equal(manifest.exports['.'], './lib/native-host.js');
  assert.equal(manifest.exports['./client'], './lib/client.js');
  assert.ok(manifest.files.includes('lib/client.js'), 'the settings client ships with the release');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dependencies?.['dsh-remote'], undefined); assert.equal(manifest.peerDependencies?.['dsh-remote'], undefined);
  for (const source of ['native-host', 'native-session-proxy', 'native-transport', 'native-observers', 'native-bindings', 'native-mirror', 'native-services', 'remote-setup', 'remote-workspaces', 'upload-relay']) assert.ok(manifest.files.includes('lib/' + source + '.js'));
  // The rejected UI surfaced a chat panel, a sidebar entry, a main-panel
  // takeover and workspace-picker hijacks. The settings client must never grow
  // any of those: one native settings section is its entire surface.
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  for (const forbidden of ['slots.inject(\'main\'', 'slots.inject("main"', 'sidebar.panellist', 'sidebarRight', 'conversation.hero', 'sidebar.workspaces.directoryFlow', 'shell.overlay', 'composer', 'iframe']) {
    assert.equal(client.includes(forbidden), false, `client must not reference rejected surface ${forbidden}`);
  }
  assert.ok(client.includes('settings.section'), 'the client registers a settings section');
});
