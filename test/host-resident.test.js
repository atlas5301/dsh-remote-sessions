/** Authoritative resident-host tests. Imports real modules, never source slices.
 * Run: node --test test/host-resident.test.js
 * Optional DSH_TEST_DEPENDENCY_ANCHOR points to an installed DSH package.json.
 * No live config, SSH, GUI, runtime deployment or remote filesystem is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EventEmitter, getEventListeners } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, statSync, readdirSync, existsSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { installedAnchor } from './anchor.mjs';

// Resolution only: execute the installed schemastery implementation unchanged.
const anchor = installedAnchor();
const installed = createRequire(anchor);
const hook = registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (specifier !== '@deepseek-ai/schemastery') throw error;
    return { url: pathToFileURL(installed.resolve(specifier)).href, shortCircuit: true };
  }
} });
const host = await import('../lib/index.js');
hook.deregister();
const registryModule = await import('../lib/machine-registry.js');
const { normalizeMachine, normalizeMachines, publicMachine, browserMachines, createMachineRegistry, loadMachinesFile, validateSshArgs } = registryModule;
const machine = (extra = {}) => ({ name: 'remote-one', ssh: ['operator@host'], remoteNode: '/usr/bin/node', socketPath: '/home/operator/.dsh/resident.sock', remoteCwd: '/home/operator/work', ...extra });
function temporary(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-resident-host-')));
  // Only delete this exact test-created temporary directory, never config paths.
  assert.ok(dir.startsWith(realpathSync(tmpdir()) + '/dsh-resident-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
function response() {
  const res = new EventEmitter();
  return Object.assign(res, { statusCode: 200, headers: {}, writableEnded: false, destroyed: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(body) { this.body = JSON.parse(body); this.writableEnded = true; this.emit('finish'); },
  });
}
function request(value, method = 'POST') { const req = Readable.from(value === undefined ? [] : [JSON.stringify(value)]); req.method = method; req.headers = {}; return req; }
function context({ admit = () => ({ peer: {} }) } = {}) {
  const fetch = [], web = [], cleanup = [];
  const connection = { fetch: { register(route) { fetch.push(route); return () => {}; } }, admit };
  const server = { register(route) { web.push(route); return () => {}; } };
  const ctx = { get(key) { return { connection, webServer: server }[key]; }, effect(fn) { cleanup.push(fn()); }, inject(keys, fn) { fn(ctx); } };
  return { ctx, fetch, web, cleanup, connection };
}
function brokerMock() {
  const calls = [];
  return { calls,
    async attach(value, signal) { calls.push(['attach', value, signal]); return { binding: { target: value.target, runtimeId: 'runtime', instanceId: 'instance' }, hello: { capabilities: [] } }; },
    async execute(value, signal) { calls.push(['execute', value, signal]); return { result: value.params }; },
    async detach(value) { calls.push(['detach', value]); return { detached: true }; },
    async reconcile() { calls.push(['reconcile']); }, async dispose() { calls.push(['dispose']); },
  };
}
async function call(route, value, method = 'POST', options = {}) {
  return host.connectionRoute(route, options).fetch(new Request('http://local/api' + route.path, { method, ...(method === 'GET' ? {} : { body: JSON.stringify(value) }) }));
}

test('machine schema normalizes resident fields and excludes secrets from public projection', () => {
  const item = normalizeMachine(machine({ command: '/opt/private/ssh', env: { API_KEY: 'private-secret' }, sync: { credentials: true }, web: { startCommand: 'unsafe' }, permission: 'allow' }));
  assert.equal(item.runtimeMode, 'remote-runtime'); assert.equal(item.authorityRevision, '');
  assert.equal(item.sync, undefined); assert.equal(item.web, undefined); assert.equal(item.permission, undefined);
  const visible = publicMachine(item);
  assert.equal(visible.command, undefined); assert.equal(visible.env, undefined); assert.ok(!JSON.stringify(visible).includes('private-secret'));
  const edited = browserMachines([{ ...visible, remoteCwd: '/new/work' }], [item])[0];
  assert.equal(edited.command, '/opt/private/ssh'); assert.equal(edited.env.API_KEY, 'private-secret');
  assert.throws(() => browserMachines([{ ...visible, env: {} }], [item]), { code: 'INVALID_MACHINE_FIELDS' });
  assert.throws(() => browserMachines([{ ...visible, command: '/bin/evil' }], [item]), { code: 'INVALID_MACHINE_FIELDS' });
});

test('machine validation rejects reserved/duplicate names, paths, transport overrides and runtime modes', () => {
  for (const value of [machine({ name: 'LOCAL' }), machine({ remoteNode: 'node' }), machine({ remoteCwd: '~/work' }), machine({ socketPath: '/a/../b' }), machine({ socketPath: '/' + 'é'.repeat(60) }), machine({ runtimeMode: 'hybrid' }), machine({ modelId: 'model' }), machine({ env: { X: 3 } })]) assert.throws(() => normalizeMachine(value));
  assert.throws(() => normalizeMachines([machine(), machine({ name: 'REMOTE-ONE' })]), { code: 'DUPLICATE_MACHINE' });
  for (const args of [['-o', 'StrictHostKeyChecking=no', 'host'], ['-o', 'UserKnownHostsFile=/dev/null', 'host'], ['-o', 'ProxyCommand=touch secret', 'host'], ['-L', '123:host:123', 'host'], ['host', 'echo evil'], ['-tt', 'host'], ['host\nsecret']]) assert.throws(() => validateSshArgs(args));
  assert.deepEqual(validateSshArgs(['-p', '22', '-i', '/home/user/key', '-o', 'BatchMode=yes', 'user@host']), ['-p', '22', '-i', '/home/user/key', '-o', 'BatchMode=yes', 'user@host']);
});

test('legacy records are quarantined and can be retained unchanged or explicitly migrated', () => {
  const legacy = { name: 'old', command: 'ssh', ssh: ['host'], remoteCwd: '/work', env: { SECRET: 'keep-private' }, web: { remotePort: 8420, startCommand: 'do not run' }, sync: { credentials: true } };
  const record = normalizeMachines([legacy], { allowLegacy: true })[0];
  assert.equal(record.disabled, true); assert.equal(record.migrationRequired, true); assert.equal(record.web.startCommand, 'do not run');
  assert.deepEqual(browserMachines([publicMachine(record)], [record])[0], record);
  assert.throws(() => browserMachines([{ ...publicMachine(record), ssh: ['other'] }], [record]), { code: 'INVALID_LEGACY_MACHINE' });
  const active = browserMachines([machine({ name: 'old' })], [record])[0];
  assert.equal(active.disabled, undefined); assert.equal(active.web, undefined); assert.equal(active.env.SECRET, 'keep-private');
});

test('registry does not seed disk; saves are private atomic and validated before persistence', t => {
  const root = temporary(t), file = join(root, 'remote-sessions', 'machines.json');
  const registry = createMachineRegistry({ machines: [machine()], file });
  assert.equal(existsSync(file), false); assert.equal(registry.machines.length, 1);
  registry.save([machine({ remoteCwd: '/changed' })]);
  assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dirname(file)), ['machines.json']);
  const before = readFileSync(file, 'utf8');
  assert.throws(() => registry.save([machine(), machine()])); assert.equal(readFileSync(file, 'utf8'), before); assert.equal(registry.machines[0].remoteCwd, '/changed');
  assert.equal(loadMachinesFile(file)[0].remoteCwd, '/changed');
});

test('corrupt stores fail closed without seed replacement; symlink store is refused', t => {
  const root = temporary(t), file = join(root, 'machines.json');
  for (const text of ['{broken', '{}', '[{"name":"local"}]']) {
    writeFileSync(file, text); assert.throws(() => createMachineRegistry({ machines: [machine()], file }), { code: 'MALFORMED_MACHINE_STORE' }); assert.equal(readFileSync(file, 'utf8'), text);
  }
  const target = join(root, 'target.json'); writeFileSync(target, '[]'); const link = join(root, 'linked.json'); symlinkSync(target, link);
  assert.throws(() => loadMachinesFile(link), { code: 'UNSAFE_MACHINE_STORE' });
});

test('save rejects corruption introduced after activation and symlinked missing stores', t => {
  const root = temporary(t), file = join(root, 'store', 'machines.json');
  const registry = createMachineRegistry({ machines: [machine()], file }); registry.save([machine()]);
  writeFileSync(file, '{broken'); assert.throws(() => registry.save([machine({ remoteCwd: '/new' })]), { code: 'MALFORMED_MACHINE_STORE' }); assert.equal(readFileSync(file, 'utf8'), '{broken');
  const target = join(root, 'target'); mkdirSync(target); const link = join(root, 'link'); symlinkSync(target, link);
  assert.throws(() => createMachineRegistry({ machines: [machine()], file: join(link, 'missing.json') }), { code: 'UNSAFE_MACHINE_STORE' });
});

test('host activation has no ACP, SSH, save, connect or sync despite unsafe old flags', async t => {
  const root = temporary(t), file = join(root, 'private', 'machines.json'), setup = context(), broker = brokerMock(), installations = [];
  const state = host.installHost(setup.ctx, { machines: [machine()], syncAtStartup: true, connectAtStartup: true }, {
    file, createBroker(ctx, registry) { assert.equal(registry.machines.length, 1); return broker; },
    installSelected(ctx, registry, api) { installations.push(api); }, installTransfers(ctx, registry, api) { installations.push(api); },
  });
  assert.equal(state.broker, broker); assert.deepEqual(broker.calls, []); assert.equal(existsSync(file), false);
  assert.equal(installations.length, 2); assert.equal(installations[0].sshExchange, host.sshExchange);
  assert.ok(setup.fetch.some(route => route.path === '/api/remote-sessions/session/attach'));
  for (const dispose of setup.cleanup) await dispose?.(); assert.deepEqual(broker.calls, [['dispose']]);
});

test('session routes delegate exact bodies, signals and responses without wrapper drift', async () => {
  const broker = brokerMock(), routes = host.buildRoutes({}, { machines: [], save() {} }, broker);
  const attach = routes.find(route => route.path.endsWith('/attach'));
  let result = await call(attach, { target: 'local', expectedRuntimeId: 'runtime' });
  assert.equal(result.status, 200); assert.equal((await result.json()).binding.target, 'local'); assert.equal(broker.calls[0][2] instanceof AbortSignal, true);
  const execute = routes.find(route => route.path.endsWith('/execute'));
  result = await call(execute, { binding: { id: 'opaque' }, method: 'call', params: { endpoint: 'session/list', values: [] } });
  assert.deepEqual(await result.json(), { result: { endpoint: 'session/list', values: [] } });
  result = await call(attach, { target: 'local', command: 'secret' }); assert.equal(result.status, 400);
  result = await call(routes.find(route => route.path.endsWith('/detach')), { binding: { id: 'opaque' } }); assert.deepEqual(await result.json(), { detached: true });
});

test('machine route projects public fields and failed validation leaves state/persistence unchanged', async t => {
  const registry = createMachineRegistry({ machines: [machine({ env: { KEY: 'secret' } })], file: join(temporary(t), 'config', 'machines.json') });
  const broker = brokerMock(), route = host.buildRoutes({}, registry, broker)[0];
  const get = await call(route, null, 'GET'); assert.ok(!JSON.stringify(await get.json()).includes('secret'));
  const bad = await call(route, { machines: [machine({ name: 'local' })] }); assert.equal(bad.status, 400); assert.equal(registry.machines[0].name, 'remote-one'); assert.deepEqual(broker.calls, []);
  const saved = await call(route, { machines: [machine({ authorityRevision: '2' })] }); assert.deepEqual(await saved.json(), { ok: true, machines: 1 }); assert.deepEqual(broker.calls, [['reconcile']]);
});

test('legacy routes are terminal and cannot invoke broker or transport', async () => {
  const routes = host.buildRoutes({}, { machines: [] }, brokerMock());
  for (const suffix of ['url', 'sync', 'prepare', 'disconnect', 'skills', 'skills-sync', 'ws-mirror', 'ws-register']) {
    const route = routes.find(item => item.path.endsWith('/' + suffix)); const result = await call(route, {}, route.methods[0]);
    assert.equal(result.status, 410); assert.deepEqual(await result.json(), { error: 'LEGACY_ENDPOINT_DISABLED' });
  }
});

test('both registrars use authenticated carriers; legacy HTTP fails closed before handler', async () => {
  let invoked = 0; const setup = context({ admit: () => ({ rejection: 401 }) });
  host.registerRoutes(setup.ctx, [{ kind: 'exact', path: '/remote-sessions/probe', handler(req, res) { invoked++; host.sendJson(res, 200, {}); } }]);
  assert.equal(setup.fetch[0].path, '/api/remote-sessions/probe'); assert.equal(setup.fetch[0].requestBody, 'buffered');
  const res = response(); await setup.web[0].handler(request(undefined, 'GET'), res); assert.equal(res.statusCode, 401); assert.equal(invoked, 0);
  setup.connection.admit = undefined; const unavailable = response(); await setup.web[0].handler(request(), unavailable); assert.equal(unavailable.statusCode, 503);
  for (const dispose of setup.cleanup) await dispose?.();
});

test('Fetch abort remains active after body EOF; shim emits response close and removes listeners', async () => {
  const controller = new AbortController(); let entered, observed;
  const started = new Promise(resolve => { entered = resolve; });
  const route = host.connectionRoute({ path: '/remote-sessions/probe', async handler(req, res) {
    assert.deepEqual(await host.readJsonBody(req), { small: true });
    const life = host.requestLifetime(req, res); observed = life.signal; entered();
    try { await new Promise(resolve => life.signal.addEventListener('abort', resolve, { once: true })); }
    finally { life.dispose(); }
  } });
  const pending = route.fetch(new Request('http://local/api/remote-sessions/probe', { method: 'POST', body: '{"small":true}', signal: controller.signal }));
  await started; assert.equal(observed.aborted, false); controller.abort();
  const result = await pending; assert.equal(result.status, 499); assert.equal(observed.aborted, true); assert.equal(getEventListeners(controller.signal, 'abort').length <= 1, true);
});

test('pre-aborted Fetch requests do not dispatch handlers and Node disconnect aborts after EOF', async () => {
  const controller = new AbortController(); controller.abort(); let dispatched = false;
  const result = await host.connectionRoute({ path: '/remote-sessions/probe', handler() { dispatched = true; } }).fetch(new Request('http://local/api/remote-sessions/probe', { method: 'POST', body: '{}', signal: controller.signal }));
  assert.equal(result.status, 499); assert.equal(dispatched, false);
  const setup = context(); let started, observed;
  const entered = new Promise(resolve => { started = resolve; });
  host.registerRoutes(setup.ctx, [{ path: '/remote-sessions/probe', async handler(req, res) {
    await host.readJsonBody(req); observed = req.signal; started(); await new Promise(resolve => req.signal.addEventListener('abort', resolve, { once: true }));
  } }]);
  const req = request({}), res = response(), pending = setup.web[0].handler(req, res);
  await entered; assert.equal(observed.aborted, false); res.destroyed = true; res.emit('close'); await pending; assert.equal(observed.aborted, true);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
  for (const dispose of setup.cleanup) await dispose?.();
});

test('ordinary request close and completed response close do not abort operation', () => {
  const req = request(), res = response(), external = new AbortController(); req.signal = external.signal;
  const life = host.requestLifetime(req, res); req.emit('close'); assert.equal(life.signal.aborted, false);
  res.writableEnded = true; res.emit('close'); assert.equal(life.signal.aborted, false);
  life.dispose(); assert.equal(getEventListeners(external.signal, 'abort').length, 0);
  const disconnected = response(), other = host.requestLifetime(request(), disconnected);
  disconnected.emit('close'); assert.equal(other.signal.aborted, true); other.dispose();
});

test('Fetch bodies, stalled reads and raw errors are bounded and sanitized', async () => {
  const route = { path: '/remote-sessions/probe', async handler(req, res) { host.sendJson(res, 200, await host.readJsonBody(req)); } };
  let result = await host.connectionRoute(route).fetch(new Request('http://local/api/remote-sessions/probe', { method: 'POST', body: 'x'.repeat(host.HOST_LIMITS.bodyBytes + 1) }));
  assert.equal(result.status, 413);
  const stalled = new ReadableStream({ pull() {} });
  result = await host.connectionRoute(route, { timeoutMs: 20 }).fetch(new Request('http://local/api/remote-sessions/probe', { method: 'POST', body: stalled, duplex: 'half' }));
  assert.equal(result.status, 504);
  result = await call({ path: '/remote-sessions/probe', handler() { throw new Error('ssh -i SECRET-KEY private command'); } }, {});
  assert.deepEqual(await result.json(), { error: 'HOST_OPERATION_FAILED' });
});

function subprocess(output = 'ok', outcome = { exitCode: 0 }) {
  const records = []; let terminated = 0;
  const stdin = new PassThrough(); const privateChunks = []; stdin.on('data', chunk => privateChunks.push(chunk));
  const child = { stdin, stdout: Readable.from([output]), done: Promise.resolve(outcome), terminate() { terminated++; } };
  return { child, records, privateChunks, get terminated() { return terminated; }, ctx: { subprocess: { spawn(spec) { records.push(spec); return child; } } } };
}
test('native picker is capability-gated and cancelled by request lifetime', async () => {
  let picked = 0;
  const picker = host.buildWorkspaceRoutes({ get() { return { capability() { return { kind: 'native', pick(signal) { assert.equal(signal.aborted, false); picked++; return '/work/picked'; } }; } }; } }, { machines: [] })[0];
  assert.deepEqual(await (await call(picker, {})).json(), { path: '/work/picked' }); assert.equal(picked, 1);
  const unavailable = host.buildWorkspaceRoutes({}, { machines: [] })[0]; assert.equal((await call(unavailable, {})).status, 501);
});

test('directory listing quotes input, filters unsafe names, and refuses disabled/invalid targets', async () => {
  const mock = subprocess('/home/operator/work\0ordinary/\0bad\nname/\0');
  const route = host.buildWorkspaceRoutes(mock.ctx, { machines: [normalizeMachine(machine())] })[1];
  const req = request(undefined, 'GET'); req.url = '/remote-sessions/ws-ls?machine=remote-one&path=' + encodeURIComponent("/home/a'; touch pwned; '"); const res = response();
  await route.handler(req, res); assert.equal(res.statusCode, 200); assert.deepEqual(res.body.entries, [{ name: 'ordinary', path: '/home/operator/work/ordinary' }]);
  const command = mock.records[0].argv.at(-1); assert.ok(command.startsWith("cd '/home/a'\\''; touch pwned; '\\''' &&"));
  const invalid = request(undefined, 'GET'); invalid.url = '/remote-sessions/ws-ls?machine=remote-one&path=relative'; const rejected = response(); await route.handler(invalid, rejected); assert.equal(rejected.statusCode, 400); assert.equal(mock.records.length, 1);
});

test('SSH exchange uses validated configured command/env, strict known hosts and private stdin', async () => {
  const mock = subprocess('public-result');
  assert.equal(await host.sshExchange(mock.ctx, machine({ command: '/usr/bin/ssh', env: { PRIVATE: 'key' } }), 'static-program', 'private-input'), 'public-result');
  const spec = mock.records[0]; assert.equal(spec.argv[0], '/usr/bin/ssh'); assert.ok(spec.argv.includes('StrictHostKeyChecking=yes')); assert.equal(spec.argv.includes('private-input'), false);
  assert.equal(spec.env.PRIVATE, 'key'); assert.equal(Buffer.concat(mock.privateChunks).toString(), 'private-input'); assert.equal(spec.stdio.stderr, 'ignore');
});

test('SSH exchange caps output/time and never reflects private command or process errors', async () => {
  const output = subprocess('too much'); await assert.rejects(host.sshExchange(output.ctx, machine(), 'secret-command', 'private', undefined, { ...host.HOST_LIMITS, sshOutputBytes: 1 }), { code: 'SSH_OUTPUT_TOO_LARGE' }); assert.equal(output.terminated, 1);
  const failed = subprocess('', { exitCode: 255 }); await assert.rejects(host.sshExchange(failed.ctx, machine(), 'secret-command'), error => error.message === 'SSH_FAILED');
  const stalled = subprocess(); stalled.child.done = new Promise(() => {});
  await assert.rejects(host.sshExchange(stalled.ctx, machine(), 'secret-command', undefined, undefined, { ...host.HOST_LIMITS, sshMs: 20 }), { code: 'SSH_TIMEOUT' }); assert.ok(stalled.terminated >= 1);
  const controller = new AbortController(); controller.abort(); const aborted = subprocess(); await assert.rejects(host.sshExchange(aborted.ctx, machine(), 'static', undefined, controller.signal), { code: 'REQUEST_CANCELLED' }); assert.equal(aborted.records.length, 0);
  await assert.rejects(host.sshExchange(subprocess().ctx, { ...machine(), disabled: true }, 'static'), { code: 'MACHINE_DISABLED' });
});
