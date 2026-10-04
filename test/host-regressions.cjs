'use strict';

/**
 * README — isolated host regressions (Node built-in test runner, no packages).
 *
 * Run: node --test test/host-regressions.cjs
 * Alternate runtime: /tmp/dshtest-opt/node22/bin/node --test test/host-regressions.cjs
 *
 * Every function under test is evaluated verbatim from the CURRENT lib/index.js.
 * Source slices avoid importing unavailable YAML/ACP/schema/host dependencies;
 * changed or ambiguous extraction anchors fail loudly instead of testing a copy.
 * The VM has no real filesystem, subprocess, network, Cordis host, or native UI
 * services. Service mocks model Cordis admission as { peer } / { rejection }.
 * These tests verify plugin control flow and transport wiring, NOT real Cordis
 * authentication, Electron dialog behavior, SSH connectivity, or host lifecycle
 * integration. Removed URL/sync entry points are tested as terminal 410 routes,
 * not as supported tunnel helpers. Startup tests forbid remote effects even
 * when deprecated boot flags are true. Native/selected/transfer installers are
 * inert wiring mocks; their real implementations have separate test suites.
 * ACP provider construction/registration uses actual extracted declarations,
 * but starting any ACP child is forbidden. Native mode cannot fall back to ACP.
 * No SSH, subprocess, live config, remote host, or GUI is contacted. The real
 * source is read only; all persistence calls are mocks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter, getEventListeners } = require('node:events');

const sourcePath = join(__dirname, '..', 'lib', 'index.js');
const source = readFileSync(sourcePath, 'utf8');

function sourceSlice(start, end, includeEnd = false) {
  const first = source.indexOf(start);
  assert.notEqual(first, -1, `Missing source anchor: ${start}`);
  assert.equal(source.indexOf(start, first + start.length), -1,
    `Ambiguous source anchor: ${start}`);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(last, -1, `Missing end anchor after ${start}: ${end}`);
  return {
    code: source.slice(first, last + (includeEnd ? end.length : 0)),
    lineOffset: source.slice(0, first).split('\n').length - 1,
  };
}

function sourceFunction(signature) {
  // These small top-level declarations have only indented nested closing braces.
  // Including the first unindented closing brace keeps extraction independent
  // of nearby legacy declarations/comments which are intentionally being removed.
  return sourceSlice(signature, '\n}', true);
}

const slices = {
  routes: sourceSlice('const MAX_BODY_BYTES =',
    '//#endregion\n\nfunction assertPositiveFinite'),
  web: sourceFunction('function machineWeb(machine) {'),
  normalize: sourceSlice('function normalizeMachine(raw) {',
    '/** The GUI-edited machine store;'),
  argv: sourceFunction('function machineArgv(machine) {'),
  settings: sourceFunction('function readSettingsSection(settings, namespace) {'),
  provider: sourceSlice('class RemoteAcpProvider {', 'const Machine = z.object({'),
  providerRegistry: sourceSlice('const providerDisposers = new Map();', '//#endregion'),
  apply: sourceSlice('function assertPositiveFinite(label, value) {',
    'const name = "remote-sessions";'),
};

const unsafeSymbols = [
  'syncProviders', 'syncDefaultModel', 'mergeHomePatch', 'pushSkillDirs',
  'pullSkillDirs', 'syncSkills', 'syncPlugins', 'syncCredentials', 'syncMachine',
  'ensureTunnel', 'tunnelResponds', 'waitTunnel', 'resolveWebUrl',
];

function forbidden(label, calls = []) {
  return (...args) => {
    calls.push({ label, args });
    throw new Error(`Unexpected isolated service call: ${label}`);
  };
}

function effectMocks(calls = []) {
  return Object.fromEntries([
    ...unsafeSymbols, 'sshExchange', 'runShell', 'fetch', 'startAcpRun',
    'readFile', 'readFileSync', 'writeFileSync', 'appendFileSync', 'mkdirSync',
    'existsSync', 'saveMachinesFile', 'registerMachineProvider', 'disposeMachineProvider',
    'setInterval', 'setTimeout',
  ].map((label) => [label, forbidden(label, calls)]));
}

function load(names, extra = {}) {
  const context = vm.createContext({
    AbortController, AbortSignal, Buffer, Error, Headers, Readable,
    Request, Response, URL, setTimeout, clearTimeout,
    process: { env: {}, cwd: () => '/isolated-workspace' },
    join,
    homedir: () => '/isolated-home',
    DEFAULT_DISPOSE_EOF_GRACE_MS: 6000,
    DEFAULT_DISPOSE_GRACE_MS: 3000,
    MAX_TIMER_DELAY_MS: 2147483647,
    dbg: () => {},
    ...effectMocks(),
    loadMachinesFile: forbidden('loadMachinesFile'),
    saveMachinesFile: forbidden('saveMachinesFile'),
    machinesFilePath: () => '/isolated-home/remote-sessions/machines.json',
    registerMachineProvider: forbidden('registerMachineProvider'),
    disposeMachineProvider: forbidden('disposeMachineProvider'),
    installNativeRemote: () => {}, // exercised by separate real-carrier tests
    installSelectedActions: () => {}, // no timers, credentials, or remote actions
    installTransferActions: () => {}, // no transfer staging or filesystem access
    ...extra,
  });
  for (const name of names) {
    const slice = slices[name];
    new vm.Script(slice.code, {
      filename: sourcePath,
      lineOffset: slice.lineOffset,
    }).runInContext(context);
  }
  return (expression) => vm.runInContext(expression, context);
}

function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.writableEnded = false;
  res.endCalls = 0;
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.end = (body) => {
    res.endCalls += 1;
    res.body = body;
    res.writableEnded = true;
  };
  return res;
}

function request(method = 'POST', signal) {
  const req = new EventEmitter();
  req.method = method;
  req.url = '/remote-sessions/local-pick';
  if (signal) req.signal = signal;
  return req;
}

function payload(res) { return JSON.parse(res.body); }

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function workspaceRoute(path, picker, overrides = {}) {
  const evaluate = load(['routes'], overrides);
  const ctx = { get: (name) => {
    assert.equal(name, 'directoryPicker');
    return picker;
  } };
  const routes = evaluate('buildWorkspaceRoutes')(ctx, { machines: [] });
  const route = routes.find((candidate) => candidate.path === path);
  assert.ok(route, `Missing actual route ${path}`);
  return route;
}

function nativeRoute(pick) {
  return workspaceRoute('/remote-sessions/local-pick', {
    capability: () => ({ kind: 'native', pick }),
  });
}

function listenerCounts(req, res) {
  return {
    signal: req.signal ? getEventListeners(req.signal, 'abort').length : 0,
    request: req.listenerCount('aborted'),
    response: res.listenerCount('close'),
  };
}

function routeRegistration(connection) {
  const webRoutes = [];
  const desktopRoutes = [];
  const cleanups = [];
  const disposed = [];
  const warnings = [];
  if (connection.fetch === undefined) {
    connection.fetch = { register: (route) => {
      desktopRoutes.push(route);
      return () => { disposed.push(`desktop:${route.path}`); };
    } };
  }
  const inner = {
    get: (name) => {
      if (name === 'connection') return connection;
      if (name === 'webServer') return { register: (route) => {
        webRoutes.push(route);
        return () => { disposed.push(`web:${route.path}`); };
      } };
      throw new Error(`Unexpected service ${name}`);
    },
    effect: (factory, label) => { cleanups.push({ cleanup: factory(), label }); },
  };
  const ctx = {
    inject: (dependencies, callback) => { callback(inner); },
    logger: { warn: (message) => warnings.push(message) },
  };
  return { ctx, webRoutes, desktopRoutes, cleanups, disposed, warnings };
}

for (const [label, admission, expectedStatus] of [
  ['authenticated Cordis {peer}', { peer: { id: 'browser-session' } }, 200],
  ['Cordis {rejection:401}', { rejection: 401 }, 401],
  ['Cordis {rejection:403}', { rejection: 403 }, 403],
]) {
  test(`legacy registerRoutes honors ${label}`, async () => {
    const evaluate = load(['routes']);
    const req = request('GET');
    const res = response();
    let admissionCalls = 0;
    let handlerCalls = 0;
    const registration = routeRegistration({ admit: (actualReq) => {
      assert.equal(actualReq, req);
      admissionCalls += 1;
      return admission;
    } });
    evaluate('registerRoutes')(registration.ctx, [{
      kind: 'exact', path: '/remote-sessions/probe',
      handler: (actualReq, actualRes) => {
        handlerCalls += 1;
        assert.equal(actualReq, req);
        evaluate('sendJson')(actualRes, 200, { authenticated: true });
      },
    }]);
    assert.equal(registration.webRoutes.length, 1);
    assert.equal(registration.desktopRoutes.length, 1);
    await registration.webRoutes[0].handler(req, res);
    assert.equal(res.statusCode, expectedStatus);
    assert.equal(admissionCalls, 1);
    assert.equal(handlerCalls, expectedStatus === 200 ? 1 : 0);
    assert.deepEqual(payload(res), expectedStatus === 200
      ? { authenticated: true } : { error: 'request not admitted' });
    assert.equal(res.headers['content-type'], 'application/json');
    for (const entry of registration.cleanups) await entry.cleanup();
    assert.deepEqual(registration.disposed.sort(), [
      'desktop:/api/remote-sessions/probe', 'web:/remote-sessions/probe',
    ]);
    assert.deepEqual(registration.warnings, []);
  });
}

for (const auth of [undefined, null, 123]) {
  test(`legacy registerRoutes fails closed with 503 when auth is ${String(auth)}`, async () => {
    const evaluate = load(['routes']);
    let handlerCalls = 0;
    const registration = routeRegistration({ admit: auth });
    evaluate('registerRoutes')(registration.ctx, [{
      path: '/remote-sessions/probe',
      handler: () => { handlerCalls += 1; },
    }]);
    const res = response();
    await registration.webRoutes[0].handler(request('POST'), res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(payload(res), { error: 'authentication service unavailable' });
    assert.equal(handlerCalls, 0);
  });
}

test('desktop connectionRoute forwards the exact Request.signal, normalized headers, query and buffered body', async () => {
  const evaluate = load(['routes']);
  const controller = new AbortController();
  const incoming = new Request('http://isolated.invalid/api/remote-sessions/probe?machine=a%20b', {
    method: 'POST',
    signal: controller.signal,
    headers: { Authorization: 'Bearer isolated', 'Content-Type': 'application/json', 'X-Probe': 'one' },
    body: JSON.stringify({ selected: '/isolated/local' }),
  });
  let shim;
  const route = evaluate('connectionRoute')({
    path: '/remote-sessions/probe',
    handler: async (req, res) => {
      shim = req;
      assert.equal(req.signal, incoming.signal);
      // VM-created plain objects have another realm's Object prototype.
      // Project their own fields before strict comparison; preserve all values.
      assert.deepEqual(Object.fromEntries(Object.entries(req.headers)), Object.fromEntries(incoming.headers));
      assert.equal(req.method, incoming.method);
      assert.equal(req.url, '/remote-sessions/probe?machine=a%20b');
      const body = await evaluate('readJsonBody')(req);
      assert.deepEqual(Object.fromEntries(Object.entries(body)), { selected: '/isolated/local' });
      res.setHeader('X-Response', 'forwarded');
      evaluate('sendJson')(res, 201, { ok: true });
    },
  });
  assert.equal(route.path, '/api/remote-sessions/probe');
  assert.deepEqual(Array.from(route.methods), ['GET', 'POST']);
  assert.equal(route.requestBody, 'buffered');
  const actual = await route.fetch(incoming);
  assert.equal(actual.status, 201);
  assert.equal(actual.headers.get('x-response'), 'forwarded');
  assert.equal(actual.headers.get('content-type'), 'application/json');
  assert.deepEqual(await actual.json(), { ok: true });
  assert.equal(shim.destroyed, true);
});

test('desktop connectionRoute rejects a pre-aborted Request without invoking its handler', async () => {
  const evaluate = load(['routes']);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const route = evaluate('connectionRoute')({
    path: '/remote-sessions/probe', handler: () => { calls += 1; },
  });
  const incoming = new Request('http://isolated.invalid/api/remote-sessions/probe', {
    signal: controller.signal,
  });
  await assert.rejects(route.fetch(incoming), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('desktop connectionRoute bounds bodies before invoking handlers', async () => {
  const evaluate = load(['routes']);
  let calls = 0;
  const route = evaluate('connectionRoute')({
    path: '/remote-sessions/probe', handler: () => { calls += 1; },
  });
  const incoming = new Request('http://isolated.invalid/api/remote-sessions/probe', {
    method: 'POST', body: Buffer.alloc(1024 * 1024 + 1),
  });
  const actual = await route.fetch(incoming);
  assert.equal(actual.status, 413);
  assert.deepEqual(await actual.json(), { error: 'request body too large' });
  assert.equal(calls, 0);
});

test('native local-pick passes an AbortSignal and cleans only its listeners after success', async () => {
  const controller = new AbortController();
  const req = request('POST', controller.signal);
  const res = response();
  const sentinel = () => {};
  controller.signal.addEventListener('abort', sentinel);
  req.on('aborted', sentinel);
  res.on('close', sentinel);
  const before = listenerCounts(req, res);
  const ready = deferred();
  const choice = deferred();
  let pickerSignal;
  const route = nativeRoute((signal) => {
    pickerSignal = signal;
    ready.resolve();
    return choice.promise;
  });
  const handling = route.handler(req, res);
  await ready.promise;
  assert.ok(pickerSignal instanceof AbortSignal);
  assert.notEqual(pickerSignal, controller.signal);
  assert.equal(pickerSignal.aborted, false);
  assert.deepEqual(listenerCounts(req, res), {
    signal: before.signal + 1, request: before.request + 1, response: before.response + 1,
  });
  choice.resolve('/isolated/chosen-directory');
  await handling;
  assert.equal(res.statusCode, 200);
  assert.deepEqual(payload(res), { path: '/isolated/chosen-directory' });
  assert.deepEqual(listenerCounts(req, res), before);
  // A later disconnect must not abort an already-settled dialog.
  controller.abort();
  req.emit('aborted');
  res.emit('close');
  assert.equal(pickerSignal.aborted, false);
});

for (const outcome of [undefined, null, '', false, { cancelled: true }]) {
  test(`native local-pick reports cancellation for ${JSON.stringify(outcome) ?? 'undefined'} and cleans listeners`, async () => {
    const controller = new AbortController();
    const req = request('POST', controller.signal);
    const res = response();
    const before = listenerCounts(req, res);
    const route = nativeRoute((signal) => {
      assert.ok(signal instanceof AbortSignal);
      return outcome;
    });
    await route.handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(payload(res), { cancelled: true });
    assert.deepEqual(listenerCounts(req, res), before);
  });
}

for (const [label, picker] of [
  ['missing directoryPicker service', undefined],
  ['missing capability method', {}],
  ['null capability', { capability: () => null }],
  ['undefined capability', { capability: () => undefined }],
  ['non-native capability', { capability: () => ({ kind: 'unavailable' }) }],
  ['native capability without pick', { capability: () => ({ kind: 'native' }) }],
  ['capability failure', { capability: () => { throw new Error('isolated capability failure'); } }],
  ['asynchronous capability failure', { capability: () => Promise.reject(new Error('isolated capability failure')) }],
]) {
  test(`local-pick returns 501 for ${label} without attaching disconnect listeners`, async () => {
    const req = request('POST', new AbortController().signal);
    const res = response();
    const before = listenerCounts(req, res);
    const route = workspaceRoute('/remote-sessions/local-pick', picker);
    await route.handler(req, res);
    assert.equal(res.statusCode, 501);
    assert.deepEqual(payload(res), { error: 'no native directory picker in this host' });
    assert.deepEqual(listenerCounts(req, res), before);
  });
}

test('local-pick checks POST before consulting native capability', async () => {
  let calls = 0;
  const route = workspaceRoute('/remote-sessions/local-pick', {
    capability: () => { calls += 1; throw new Error('must not open picker'); },
  });
  const res = response();
  await route.handler(request('GET'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(calls, 0);
});

for (const asynchronous of [false, true]) {
  test(`native local-pick returns 500 for ${asynchronous ? 'asynchronous' : 'synchronous'} pick failure and cleans listeners`, async () => {
    const req = request('POST', new AbortController().signal);
    const res = response();
    const before = listenerCounts(req, res);
    const route = nativeRoute((signal) => {
      assert.ok(signal instanceof AbortSignal);
      const error = new Error('isolated picker failed');
      if (asynchronous) return Promise.reject(error);
      throw error;
    });
    await route.handler(req, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(payload(res), { error: 'isolated picker failed' });
    assert.deepEqual(listenerCounts(req, res), before);
  });
}

for (const channel of ['Request.signal', 'request aborted', 'response close']) {
  test(`native local-pick aborts on ${channel}, suppresses disconnect errors, and cleans listeners`, async () => {
    const controller = new AbortController();
    const req = request('POST', channel === 'Request.signal' ? controller.signal : undefined);
    const res = response();
    const before = listenerCounts(req, res);
    const ready = deferred();
    let pickerSignal;
    const route = nativeRoute((signal) => {
      pickerSignal = signal;
      ready.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('dialog disconnected')), { once: true });
      });
    });
    const handling = route.handler(req, res);
    await ready.promise;
    assert.equal(pickerSignal.aborted, false);
    if (channel === 'Request.signal') controller.abort();
    else if (channel === 'request aborted') req.emit('aborted');
    else res.emit('close');
    await handling;
    assert.equal(pickerSignal.aborted, true);
    assert.equal(res.endCalls, 0, 'must not send a picker error to a disconnected client');
    assert.deepEqual(listenerCounts(req, res), before);
  });
}

test('native local-pick forwards a pre-aborted signal and still cleans listeners', async () => {
  const controller = new AbortController();
  controller.abort();
  const req = request('POST', controller.signal);
  const res = response();
  const before = listenerCounts(req, res);
  const route = nativeRoute((signal) => {
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, true);
    signal.throwIfAborted();
  });
  await route.handler(req, res);
  assert.equal(res.endCalls, 0);
  assert.deepEqual(listenerCounts(req, res), before);
});

test('desktop connectionRoute propagates caller disconnect through the actual native local-pick handler', async () => {
  const evaluate = load(['routes']);
  const controller = new AbortController();
  const ready = deferred();
  let pickerSignal;
  const native = nativeRoute((signal) => {
    pickerSignal = signal;
    ready.resolve();
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('dialog disconnected')), { once: true });
    });
  });
  const route = evaluate('connectionRoute')(native);
  const incoming = new Request('http://isolated.invalid/api/remote-sessions/local-pick', {
    method: 'POST', signal: controller.signal,
  });
  const before = getEventListeners(incoming.signal, 'abort').length;
  const fetching = route.fetch(incoming);
  await ready.promise;
  assert.equal(pickerSignal.aborted, false);
  controller.abort();
  const actual = await fetching;
  assert.equal(pickerSignal.aborted, true);
  assert.equal(getEventListeners(incoming.signal, 'abort').length, before);
  // The wrapper currently manufactures a 500 because a disconnected native
  // handler deliberately sends no response. The client has already aborted;
  // this assertion records current behavior, not an integration guarantee.
  assert.equal(actual.status, 500);
  assert.deepEqual(await actual.json(), { error: 'JSON handler did not finish its response' });
});

for (const path of ['/remote-sessions/ws-register', '/remote-sessions/ws-mirror']) {
  test(`${path}: POST 501 / all non-POST 405, with no storage, shell, restart, registry or body effects`, async () => {
    const calls = [];
    const evaluate = load(['routes'], effectMocks(calls));
    const ctx = { get: forbidden('ctx.get', calls), subprocess: { spawn: forbidden('spawn', calls) } };
    const registry = {};
    Object.defineProperty(registry, 'machines', { get: forbidden('registry.machines', calls) });
    const route = evaluate('buildWorkspaceRoutes')(ctx, registry).find((candidate) => candidate.path === path);
    assert.ok(route);
    for (const method of ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const req = request(method);
      req.url = `${path}?machine=isolated`;
      req[Symbol.asyncIterator] = forbidden('request body read', calls);
      const res = response();
      await route.handler(req, res);
      assert.equal(res.statusCode, method === 'POST' ? 501 : 405, method);
      if (method === 'POST') {
        assert.match(payload(res).error, /Legacy mirror\/registration is disabled/);
        assert.match(payload(res).error, /native remote runtime/);
        assert.match(payload(res).error, /no storage rewrite, runtime restart or local placeholder/);
      } else assert.deepEqual(payload(res), { error: 'method not allowed' });
      assert.equal(res.endCalls, 1);
    }
    assert.deepEqual(calls, []);
  });
}

test('native-only host source removes every legacy unsafe sync and tunnel symbol', () => {
  for (const symbol of unsafeSymbols) {
    assert.doesNotMatch(source, new RegExp(`\\b${symbol}\\b`),
      `${symbol} must be absent, not merely left unreachable`);
  }
});

for (const [path, acceptedMethod, message] of [
  ['/remote-sessions/url', 'GET', /Tokenized embed URLs are disabled/],
  ['/remote-sessions/sync', 'POST', /Full provider\/credential-store sync is disabled/],
  ['/remote-sessions/skills-sync', 'POST', /Legacy tar-based skill sync is disabled/],
  ['/remote-sessions/skills', 'GET', /Legacy skill listing is disabled/],
]) {
  test(`${path}: terminal 410 / unsupported methods 405, without body, registry or service effects`, async () => {
    const calls = [];
    const evaluate = load(['routes'], effectMocks(calls));
    const ctx = {
      get: forbidden('ctx.get', calls),
      subprocess: { spawn: forbidden('spawn', calls) },
    };
    Object.defineProperty(ctx, 'settings', { get: forbidden('ctx.settings', calls) });
    const registry = {};
    Object.defineProperty(registry, 'machines', { get: forbidden('registry.machines', calls) });
    const routes = [...evaluate('buildRoutes')(ctx, registry), ...evaluate('buildWorkspaceRoutes')(ctx, registry)];
    const route = routes.find((candidate) => candidate.path === path);
    assert.ok(route, `Missing terminal legacy route ${path}`);
    for (const query of ['', '?machine=missing', '?machine=isolated&token=OLD_TOKEN']) {
      for (const method of ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        const req = request(method);
        req.url = path + query;
        // Malformed, absent, oversized or credential-bearing bodies must not
        // matter: removed actions terminate before even reading the stream.
        req[Symbol.asyncIterator] = forbidden('request body read', calls);
        const res = response();
        await route.handler(req, res);
        assert.equal(res.statusCode, method === acceptedMethod ? 410 : 405, `${method} ${query}`);
        if (method === acceptedMethod) {
          assert.match(payload(res).error, message);
          assert.equal(Object.hasOwn(payload(res), 'url'), false);
          assert.equal(Object.hasOwn(payload(res), 'token'), false);
          assert.doesNotMatch(res.body, /OLD_TOKEN|http:\/\/127\.0\.0\.1/);
        } else assert.deepEqual(payload(res), { error: 'method not allowed' });
        assert.equal(res.endCalls, 1);
      }
    }
    assert.deepEqual(calls, []);
  });
}

for (const [path, method, body] of [
  ['/remote-sessions/url', 'GET'],
  ['/remote-sessions/sync', 'POST', '{not valid json'],
  ['/remote-sessions/skills-sync', 'POST', '{not valid json'],
]) {
  test(`desktop carrier preserves terminal 410 for ${path} without remote effects`, async () => {
    const calls = [];
    const evaluate = load(['routes'], effectMocks(calls));
    const ctx = { get: forbidden('ctx.get', calls), subprocess: { spawn: forbidden('spawn', calls) } };
    const registry = {};
    Object.defineProperty(registry, 'machines', { get: forbidden('registry.machines', calls) });
    const routes = [...evaluate('buildRoutes')(ctx, registry), ...evaluate('buildWorkspaceRoutes')(ctx, registry)];
    const route = evaluate('connectionRoute')(routes.find((candidate) => candidate.path === path));
    const incoming = new Request(`http://isolated.invalid/api${path}?machine=missing&token=OLD_TOKEN`, { method, body });
    const actual = await route.fetch(incoming);
    assert.equal(actual.status, 410);
    const output = await actual.json();
    assert.equal(typeof output.error, 'string');
    assert.equal(Object.hasOwn(output, 'url'), false);
    assert.equal(Object.hasOwn(output, 'token'), false);
    assert.deepEqual(calls, []);
  });
}

function machineHarness(rawMachines) {
  const calls = { forbidden: [], saves: [], providers: [], disposals: [], reconcile: 0 };
  const ctx = {
    get: forbidden('ctx.get', calls.forbidden),
    subprocess: { spawn: forbidden('spawn', calls.forbidden) },
    subagents: { registerProvider: (provider) => {
      assert.equal(provider.ctx, ctx);
      calls.providers.push(provider.name);
      return () => { calls.disposals.push(provider.name); };
    } },
  };
  const evaluate = load(['normalize', 'argv', 'provider', 'providerRegistry', 'web', 'routes'], {
    ...effectMocks(calls.forbidden),
    saveMachinesFile: (machines) => { calls.saves.push(JSON.parse(JSON.stringify(machines))); },
  });
  const registry = {
    machines: rawMachines.map(evaluate('normalizeMachine')),
    reconcileNative: () => { calls.reconcile += 1; },
  };
  const route = evaluate('buildRoutes')(ctx, registry).find((candidate) => candidate.path === '/remote-sessions/machines');
  assert.ok(route);
  return {
    calls, registry,
    async run(method, body) {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      req.method = method;
      req.url = route.path;
      const res = response();
      await route.handler(req, res);
      return { status: res.statusCode, body: payload(res) };
    },
  };
}

const machineIdentityFields = ['name', 'runtimeMode', 'command', 'ssh', 'args', 'env', 'authorityRevision'];
function identityFields(machine) {
  return Object.fromEntries(machineIdentityFields.map((key) => [key, machine[key]]));
}

for (const method of ['PUT', 'POST']) {
  test(`machine GET -> ${method} -> GET preserves SSH authority command/env/args/revision without remote effects`, async () => {
    const raw = {
      name: 'isolated', runtimeMode: 'remote-runtime', command: 'isolated-ssh-wrapper',
      ssh: ['-o', 'BatchMode=yes', 'isolated-target'],
      args: ['--legacy-preserved', 'isolated-target', 'DO_NOT_EXECUTE_ACP'],
      env: { ISOLATED_ROUTE: 'test-only', SSH_AUTH_SOCK: '/isolated/socket' },
      authorityRevision: 'host-generation-7',
      acpCommand: 'DO_NOT_EXECUTE_ACP', remoteCwd: '/isolated/remote',
      web: { remotePort: 28420, logPath: '~/isolated-web.log' },
    };
    const harness = machineHarness([raw]);
    const first = await harness.run('GET');
    assert.equal(first.status, 200);
    assert.equal(first.body.machines.length, 1);
    assert.deepEqual(identityFields(first.body.machines[0]), identityFields(raw));
    assert.equal(Object.hasOwn(first.body.machines[0], 'tunnelUp'), false);
    const saved = await harness.run(method, first.body);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { ok: true, machines: 1 });
    assert.equal(harness.calls.saves.length, 1);
    assert.deepEqual(identityFields(harness.calls.saves[0][0]), identityFields(raw));
    const second = await harness.run('GET');
    assert.equal(second.status, 200);
    assert.deepEqual(identityFields(second.body.machines[0]), identityFields(raw));
    assert.equal(harness.calls.reconcile, 1, 'only inert native-cache reconciliation is requested');
    assert.deepEqual(harness.calls.providers, [], 'saving a native machine must not register an ACP fallback');
    assert.deepEqual(harness.calls.forbidden, []);
  });
}

test('machine GET supplies stable default authority revision instead of dropping the field', async () => {
  const harness = machineHarness([{ name: 'isolated', ssh: ['isolated-target'], remoteCwd: '/isolated/remote' }]);
  const result = await harness.run('GET');
  assert.equal(result.status, 200);
  const machine = result.body.machines[0];
  assert.equal(Object.hasOwn(machine, 'authorityRevision'), true);
  assert.equal(machine.authorityRevision, '');
  assert.equal(machine.command, 'ssh');
  assert.equal(machine.runtimeMode, 'remote-runtime');
  assert.deepEqual(machine.args, []);
  assert.deepEqual(machine.env, {});
  assert.deepEqual(harness.calls.saves, []);
  assert.deepEqual(harness.calls.forbidden, []);
});

for (const method of ['PUT', 'POST']) {
  test(`machine ${method} saves a remote-only default without an ACP command or remote side effects`, async () => {
    const harness = machineHarness([]);
    const machine = {
      name: 'native', ssh: ['isolated-native-target'],
      remoteCwd: '/isolated/remote', web: { remotePort: 28420 },
    };
    const saved = await harness.run(method, { machines: [machine] });
    assert.equal(saved.status, 200);
    const result = await harness.run('GET');
    assert.equal(result.body.machines[0].runtimeMode, 'remote-runtime');
    assert.equal(Object.hasOwn(result.body.machines[0], 'acpCommand'), false);
    assert.deepEqual(harness.calls.providers, []);
    assert.deepEqual(harness.calls.forbidden, []);
    assert.equal(harness.calls.saves.length, 1);
  });
}

for (const [label, changes] of [
  ['reserved hybrid', { runtimeMode: 'hybrid' }],
  ['unknown mode', { runtimeMode: 'local-fallback' }],
  ['native without web', { web: undefined }],
  ['invalid authority revision', { authorityRevision: 7 }],
  ['invalid environment value', { env: { INVALID: 7 } }],
]) {
  test(`machine save rejects ${label} before persistence, reconciliation or provider effects`, async () => {
    const harness = machineHarness([]);
    const machine = {
      name: 'isolated', ssh: ['isolated-target'], remoteCwd: '/isolated/remote',
      web: { remotePort: 28420 }, ...changes,
    };
    const result = await harness.run('PUT', { machines: [machine] });
    assert.equal(result.status, 400);
    assert.deepEqual(harness.calls.saves, []);
    assert.deepEqual(harness.calls.providers, []);
    assert.deepEqual(harness.calls.forbidden, []);
    assert.equal(harness.calls.reconcile, 0);
    assert.deepEqual(harness.registry.machines, []);
  });
}

test('machine legacy ACP command remains explicit and survives GET/save without being started', async () => {
  const machine = {
    name: 'adapter', runtimeMode: 'legacy-acp', command: 'isolated-ssh-wrapper',
    ssh: ['isolated-acp-target'], args: ['preserved'], env: { ISOLATED: 'yes' },
    authorityRevision: 'legacy-generation-2',
    acpCommand: 'DO_NOT_EXECUTE_ACP', remoteCwd: '/isolated/remote',
  };
  const harness = machineHarness([machine]);
  const before = await harness.run('GET');
  assert.deepEqual(identityFields(before.body.machines[0]), identityFields(machine));
  const result = await harness.run('PUT', before.body);
  assert.equal(result.status, 200);
  const after = await harness.run('GET');
  assert.deepEqual(identityFields(after.body.machines[0]), identityFields(machine));
  assert.deepEqual(harness.calls.providers, ['remote-adapter']);
  assert.deepEqual(harness.calls.forbidden, []);
});

test('changing an explicitly registered ACP adapter to native mode disposes it rather than retaining a fallback', async () => {
  const harness = machineHarness([]);
  const legacy = {
    name: 'isolated', runtimeMode: 'legacy-acp', ssh: ['isolated-target'],
    acpCommand: 'DO_NOT_EXECUTE_ACP', remoteCwd: '/isolated/remote',
  };
  assert.equal((await harness.run('PUT', { machines: [legacy] })).status, 200);
  assert.deepEqual(harness.calls.providers, ['remote-isolated']);
  const native = { ...legacy, runtimeMode: 'remote-runtime', web: { remotePort: 28420 } };
  assert.equal((await harness.run('PUT', { machines: [native] })).status, 200);
  assert.deepEqual(harness.calls.providers, ['remote-isolated'], 'must not register another ACP provider');
  assert.deepEqual(harness.calls.disposals, ['remote-isolated']);
  assert.equal((await harness.run('GET')).body.machines[0].runtimeMode, 'remote-runtime');
  assert.deepEqual(harness.calls.forbidden, []);
});

const baseRoutePaths = [
  '/remote-sessions/machines', '/remote-sessions/url', '/remote-sessions/sync',
  '/remote-sessions/local-pick', '/remote-sessions/ws-ls', '/remote-sessions/skills',
  '/remote-sessions/skills-sync', '/remote-sessions/ws-mirror', '/remote-sessions/ws-register',
];
const selectedRoutePaths = ['/remote-sessions/selected-sync/preview', '/remote-sessions/selected-sync/apply'];
const transferRoutePaths = ['/remote-sessions/selected-transfer/preview', '/remote-sessions/selected-transfer/apply'];

function startupHarness(rawMachines, { selectedRoutes = false, stored = null } = {}) {
  const calls = { forbidden: [], providers: [], saves: [], logs: [], warnings: [], installs: [] };
  const registration = routeRegistration({ admit: () => ({ peer: {} }) });
  const ctx = {
    ...registration.ctx,
    get: forbidden('ctx.get', calls.forbidden),
    subprocess: { spawn: forbidden('spawn', calls.forbidden) },
    subagents: { registerProvider: (provider) => {
      assert.equal(provider.ctx, ctx);
      calls.providers.push(provider.name);
      return () => {};
    } },
    logger: {
      info: (message) => calls.logs.push(message),
      warn: (message) => calls.warnings.push(message),
    },
  };
  Object.defineProperty(ctx, 'settings', { get: forbidden('ctx.settings', calls.forbidden) });
  const installer = (name, paths) => (actualCtx, registry, dependencies) => {
    assert.equal(actualCtx, ctx);
    assert.equal(typeof dependencies.sshExchange, 'function');
    assert.equal(typeof dependencies.registerRoutes, 'function');
    if (name === 'selected') assert.equal(typeof dependencies.readSettingsSection, 'function');
    calls.installs.push({ name, registry, dependencies });
    if (selectedRoutes && paths.length) {
      // Installation/wiring only: mock handlers may never run. Do not import
      // real installers or recreate preview/apply implementations in this VM.
      dependencies.registerRoutes(ctx, paths.map((path) => ({
        kind: 'exact', path, handler: forbidden(`mock route ${path}`, calls.forbidden),
      })));
    }
  };
  const evaluate = load(['normalize', 'argv', 'settings', 'provider', 'providerRegistry', 'routes', 'web', 'apply'], {
    ...effectMocks(calls.forbidden),
    loadMachinesFile: () => stored,
    saveMachinesFile: (machines) => { calls.saves.push(machines); },
    installNativeRemote: installer('native', []),
    installSelectedActions: installer('selected', selectedRoutePaths),
    installTransferActions: installer('transfer', transferRoutePaths),
  });
  const apply = evaluate('apply');
  return { calls, registration, run: (flags = {}) => apply(ctx, { machines: rawMachines, ...flags }) };
}

const eligibleMachine = {
  name: 'isolated', ssh: ['isolated-target'], acpCommand: 'isolated-acp', remoteCwd: '/isolated/remote',
  sync: { providers: true, credentials: true, defaultModel: true, skills: true, plugins: ['isolated-plugin'] },
  web: { localPort: 18420, remotePort: 28420, startCommand: 'DO_NOT_EXECUTE' },
};

function assertBaseRoutes(registration) {
  assert.equal(registration.webRoutes.length, 9);
  assert.equal(registration.desktopRoutes.length, 9);
  assert.deepEqual(registration.webRoutes.map((route) => route.path).sort(), [...baseRoutePaths].sort());
  assert.deepEqual(registration.desktopRoutes.map((route) => route.path).sort(), baseRoutePaths.map((path) => '/api' + path).sort());
}

for (const [label, flags] of [
  ['omitted flags (default startup)', {}],
  ['explicitly false flags', { syncAtStartup: false, connectAtStartup: false }],
  ['deprecated syncAtStartup', { syncAtStartup: true }],
  ['deprecated connectAtStartup', { connectAtStartup: true }],
  ['both deprecated boot flags', { syncAtStartup: true, connectAtStartup: true }],
]) {
  test(`apply ${label}: boot flags never cause SSH, sync, tunneling or native prepare`, () => {
    const harness = startupHarness([eligibleMachine]);
    harness.run(flags);
    assert.deepEqual(harness.calls.forbidden, []);
    assert.equal(harness.calls.saves.length, 1, 'seed persistence is an isolated mock');
    assertBaseRoutes(harness.registration);
    assert.deepEqual(harness.calls.installs.map((entry) => entry.name).sort(), ['native', 'selected', 'transfer']);
    assert.equal(new Set(harness.calls.installs.map((entry) => entry.registry)).size, 1);
    for (const [flag, warning] of [
      ['syncAtStartup', /deprecated boot sync is ignored/],
      ['connectAtStartup', /deprecated boot tunnel is ignored/],
    ]) {
      assert.equal(harness.calls.warnings.some((message) => warning.test(message)), flags[flag] === true, flag);
    }
    assert.deepEqual(harness.calls.providers, [], 'native runtime is never an ACP fallback');
  });
}

for (const sync of [{ providers: true }, { credentials: true }, { defaultModel: true }, { skills: true }, { plugins: ['isolated-plugin'] }]) {
  test(`apply ignores deprecated ${Object.keys(sync)[0]} boot sync without reading settings or stores`, () => {
    const harness = startupHarness([{ ...eligibleMachine, runtimeMode: 'legacy-acp', sync, web: undefined }]);
    harness.run({ syncAtStartup: true, connectAtStartup: true });
    assert.deepEqual(harness.calls.forbidden, []);
    assert.ok(harness.calls.warnings.some((message) => /boot sync is ignored/.test(message)));
    assert.ok(harness.calls.warnings.some((message) => /boot tunnel is ignored/.test(message)));
  });
}

for (const runtimeMode of [undefined, 'remote-runtime']) {
  test(`apply ${runtimeMode ?? 'default'} native machine requires no acpCommand and registers no ACP provider`, () => {
    const machine = {
      name: 'native', ssh: ['isolated-native-target'], remoteCwd: '/isolated/remote', web: { remotePort: 28420 },
      ...(runtimeMode === undefined ? {} : { runtimeMode }),
    };
    const harness = startupHarness([machine]);
    harness.run({ syncAtStartup: true, connectAtStartup: true });
    assert.deepEqual(harness.calls.providers, []);
    assert.deepEqual(harness.calls.forbidden, []);
    assert.equal(harness.calls.saves[0][0].runtimeMode, 'remote-runtime');
    assert.equal(harness.calls.saves[0][0].acpCommand, undefined);
    assertBaseRoutes(harness.registration);
    assert.ok(harness.calls.logs.some((message) => /remote-runtime/.test(message)));
  });
}

for (const [label, transport] of [
  ['ssh+acpCommand', { ssh: ['isolated-acp-target'], acpCommand: 'DO_NOT_EXECUTE_ACP' }],
  ['legacy flat args', { args: ['isolated-acp-target', 'DO_NOT_EXECUTE_ACP'] }],
]) {
  test(`apply explicit legacy-acp ${label} only registers its optional one-shot adapter without starting it`, () => {
    const machine = { name: 'adapter', runtimeMode: 'legacy-acp', remoteCwd: '/isolated/remote', ...transport };
    const harness = startupHarness([machine]);
    harness.run({ syncAtStartup: true, connectAtStartup: true });
    assert.deepEqual(harness.calls.providers, ['remote-adapter']);
    assert.deepEqual(harness.calls.forbidden, []);
    assertBaseRoutes(harness.registration);
    assert.ok(harness.calls.logs.some((message) => /legacy-acp/.test(message)));
  });
}

for (const [label, changes, error] of [
  ['reserved hybrid', { runtimeMode: 'hybrid' }, /Hybrid.*not implemented.*no local fallback/i],
  ['unknown mode', { runtimeMode: 'local-fallback' }, /invalid remote runtime mode/],
  ['native without web', { web: undefined, acpCommand: undefined }, /Native remote runtime requires/],
]) {
  test(`apply rejects ${label} rather than starting an ACP or local fallback`, () => {
    const harness = startupHarness([{ ...eligibleMachine, ...changes }]);
    assert.throws(() => harness.run(), error);
    assert.deepEqual(harness.calls.providers, []);
    assert.deepEqual(harness.calls.forbidden, []);
    assert.deepEqual(harness.calls.installs, []);
    assert.deepEqual(harness.registration.webRoutes, []);
    assert.deepEqual(harness.registration.desktopRoutes, []);
  });
}

test('apply installs four selected action routes separately from its nine base routes on both transports', async () => {
  const harness = startupHarness([eligibleMachine], { selectedRoutes: true });
  harness.run();
  const expected = [...baseRoutePaths, ...selectedRoutePaths, ...transferRoutePaths].sort();
  assert.equal(harness.registration.webRoutes.length, 13);
  assert.equal(harness.registration.desktopRoutes.length, 13);
  assert.deepEqual(harness.registration.webRoutes.map((route) => route.path).sort(), expected);
  assert.deepEqual(harness.registration.desktopRoutes.map((route) => route.path).sort(), expected.map((path) => '/api' + path));
  assert.deepEqual(harness.calls.forbidden, []);
  for (const entry of harness.registration.cleanups) await entry.cleanup();
  assert.equal(harness.registration.disposed.length, 26);
});

test('apply ignores deprecated boot flags even without machines', () => {
  const harness = startupHarness([]);
  harness.run({ syncAtStartup: true, connectAtStartup: true });
  assert.deepEqual(harness.calls.forbidden, []);
  assert.deepEqual(harness.calls.providers, []);
  assert.deepEqual(harness.calls.saves, []);
  assertBaseRoutes(harness.registration);
  assert.ok(harness.calls.warnings.some((message) => /boot sync is ignored/.test(message)));
  assert.ok(harness.calls.warnings.some((message) => /boot tunnel is ignored/.test(message)));
});
