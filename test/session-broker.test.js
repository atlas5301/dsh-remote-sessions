// Pure injected fixtures: no SSH, DSH stores, credentials, live server or agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionBroker, BROKER_LIMITS } from '../lib/session-broker.js';
import { machineIdentity } from '../lib/authority.js';
import { PROTOCOL, fault } from '../lib/protocol.js';

const code = expected => error => { assert.equal(error.code, expected); return true; };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const machine = (changes = {}) => ({ name: 'remote', ssh: ['fixture@invalid.example'],
  remoteNode: '/fixture/bin/node', socketPath: '/fixture/private/agent.sock', runtimeMode: 'remote-runtime', ...changes });
const hello = (changes = {}) => ({ protocol: PROTOCOL, runtimeId: 'fixture-runtime', instanceId: 'fixture-epoch',
  capabilities: [
    { endpoint: 'session/list', stream: false, parameters: ['filter'] },
    { endpoint: 'session/page', stream: false, parameters: ['id'] },
    { endpoint: 'session/create', stream: false, parameters: ['options'] },
    { endpoint: 'session/prompt', stream: false, parameters: ['id', 'prompt'] },
    { endpoint: 'session/cancel', stream: false, parameters: ['id'] },
    { endpoint: 'session/follow', stream: true, parameters: ['id'] },
  ], ...changes });
const request = (binding, endpoint = 'session/list', values = []) => ({ binding, method: 'call', params: { endpoint, values } });

function fixture(t, options = {}) {
  const registry = { machines: [machine()] }, remotes = [], locals = [], factoryCalls = [];
  let clock = 0;
  const makeRemote = (overrides = {}) => {
    const done = deferred();
    const remote = { hello: hello(), closed: 0, calls: [],
      peer: { closed: false, done: done.promise,
        async request(method, params, opts) { remote.calls.push({ method, params, ...opts }); return { ok: true, value: 'remote' }; },
      },
      close() { remote.closed++; remote.peer.closed = true; done.resolve(); },
      ...overrides,
    };
    remotes.push(remote); return remote;
  };
  const localAdapterFactory = (ctx, ids) => {
    factoryCalls.push({ ctx, ...ids });
    return { hello: hello(ids), client() {
      const client = { closed: 0, calls: [], streams: new Set(),
        async handle(method, params, signal) {
          client.calls.push({ method, params, signal });
          if (method === 'open') { const streamId = 'stream-' + locals.length; client.streams.add(streamId); return { streamId }; }
          if (method === 'next' && !client.streams.has(params.streamId)) throw fault('STREAM_GONE');
          if (method === 'event-result' && params.clientId !== client.clientId) throw fault('INVALID_EVENT_OWNER');
          return { ok: true, value: 'local' };
        },
        async dispose() { client.closed++; client.streams.clear(); },
      };
      client.clientId = 'events-' + locals.length; locals.push(client); return client;
    } };
  };
  const context = { fixture: true };
  const broker = createSessionBroker(context, registry, {
    connect: async () => makeRemote(), localAdapterFactory, now: () => clock,
    ...options,
  });
  t.after(() => broker.dispose());
  return { broker, registry, context, remotes, locals, factoryCalls, makeRemote, localAdapterFactory, advance: ms => { clock += ms; } };
}

test('explicit local attach owns separate clients with stable process identity and pinned capabilities', async t => {
  const f = fixture(t);
  assert.equal(f.locals.length, 0); assert.equal(f.remotes.length, 0);
  const first = await f.broker.attach({ target: 'local' });
  const second = await f.broker.attach({ target: 'local', expectedRuntimeId: first.hello.runtimeId, expectedInstanceId: first.hello.instanceId });
  assert.match(first.binding.id, /^[a-f0-9-]{36}$/);
  assert.notEqual(first.binding.id, second.binding.id);
  assert.equal(first.binding.target, 'local');
  assert.equal(first.binding.runtimeId, second.hello.runtimeId);
  assert.equal(first.binding.instanceId, second.hello.instanceId);
  assert.equal(first.binding.authority, second.binding.authority);
  assert.notEqual(f.locals[0], f.locals[1]);
  assert.equal(f.factoryCalls[0].ctx, f.context);
  assert.deepEqual(await f.broker.execute(request(first.binding)), { ok: true, value: 'local' });
  first.hello.capabilities.length = 0;
  assert.equal((await f.broker.execute(request(first.binding))).ok, true);
  const otherBroker = createSessionBroker(f.context, f.registry, { localAdapterFactory: f.localAdapterFactory });
  t.after(() => otherBroker.dispose());
  const third = await otherBroker.attach({ target: 'local' });
  assert.equal(third.hello.runtimeId, second.hello.runtimeId);
  assert.equal(third.hello.instanceId, second.hello.instanceId);
  assert.deepEqual(await f.broker.detach({ binding: first.binding }), { detached: true });
  assert.equal(f.locals[0].closed, 1); assert.equal(f.locals[1].closed, 0);
  await assert.rejects(f.broker.execute(request(first.binding)), code('BINDING_GONE'));
  assert.equal((await f.broker.execute(request(second.binding))).ok, true);
});

test('remote attachments have dedicated SSH transports; no implicit local fallback', async t => {
  const f = fixture(t);
  const first = await f.broker.attach({ target: 'remote' }), second = await f.broker.attach({ target: 'remote' });
  assert.equal(f.remotes.length, 2); assert.equal(f.locals.length, 0);
  assert.equal(first.binding.authority, machineIdentity(f.registry.machines[0]));
  assert.deepEqual(await f.broker.execute(request(first.binding)), { ok: true, value: 'remote' });
  assert.equal(f.remotes[0].calls.length, 1); assert.equal(f.remotes[1].calls.length, 0);
  await f.broker.detach({ binding: first.binding });
  assert.equal(f.remotes[0].closed, 1); assert.equal(f.remotes[1].closed, 0);
  await assert.rejects(f.broker.execute(request({ ...second.binding, target: 'local' })), code('BINDING_MISMATCH'));
  await assert.rejects(f.broker.execute(request({ ...second.binding, authority: 'forged' })), code('BINDING_MISMATCH'));
  await assert.rejects(f.broker.execute(request({ ...second.binding, instanceId: 'forged' })), code('BINDING_MISMATCH'));
  await assert.rejects(f.broker.execute(request({ ...second.binding, id: first.binding.id })), code('BINDING_GONE'));
  assert.equal(f.locals.length, 0);
});

test('approval clients and stream ids cannot leak across bindings', async t => {
  const f = fixture(t);
  const a = await f.broker.attach({ target: 'local' }), b = await f.broker.attach({ target: 'local' });
  const stream = await f.broker.execute({ binding: a.binding, method: 'open', params: { endpoint: '$events', values: [] } });
  await assert.rejects(f.broker.execute({ binding: b.binding, method: 'next', params: { streamId: stream.streamId } }), code('STREAM_GONE'));
  const params = { clientId: f.locals[0].clientId, eventId: 'approval-id', outcome: { approved: true } };
  await assert.rejects(f.broker.execute({ binding: b.binding, method: 'event-result', params }), code('INVALID_EVENT_OWNER'));
  assert.equal((await f.broker.execute({ binding: a.binding, method: 'event-result', params })).ok, true);
});

test('unknown and extra route fields/methods and malformed operations are rejected before transport admission', async t => {
  const f = fixture(t);
  for (const body of [null, {}, { target: 'local', extra: 1 }, { target: 1 }, { target: 'local', expectedRuntimeId: '' }]) {
    await assert.rejects(f.broker.attach(body), code('INVALID_REQUEST'));
  }
  const { binding } = await f.broker.attach({ target: 'remote' });
  for (const body of [null, { ...request(binding), target: 'local' }, request({ ...binding, extra: true })]) {
    await assert.rejects(f.broker.execute(body), code('INVALID_REQUEST'));
  }
  for (const method of ['hello', 'dispose', 'constructor', 'request', '__proto__']) {
    await assert.rejects(f.broker.execute({ binding, method, params: {} }), code('UNSUPPORTED_OPERATION'));
  }
  for (const params of [{ endpoint: 'session/list', values: [], extra: true }, { endpoint: 'session/list', values: {} }]) {
    await assert.rejects(f.broker.execute({ binding, method: 'call', params }), code('INVALID_REQUEST'));
  }
  for (const [method, params] of [
    ['call', { endpoint: 'private/arbitrary', values: [] }],
    ['call', { endpoint: 'session/follow', values: [] }],
    ['call', { endpoint: 'session/list', values: [1, 2] }],
    ['open', { endpoint: 'session/list', values: [] }],
  ]) await assert.rejects(f.broker.execute({ binding, method, params }), code('UNSUPPORTED_OPERATION'));
  for (const [method, params] of [
    ['open', { endpoint: '$events', values: [1] }], ['next', { streamId: '', waitMs: 1 }],
    ['next', { streamId: 'id', waitMs: 25001 }], ['next', { streamId: 'id', waitMs: NaN }],
    ['close', { streamId: 'id', other: 1 }], ['event-result', { clientId: 'id', eventId: 'id', outcome: [] }],
  ]) await assert.rejects(f.broker.execute({ binding, method, params }), code('INVALID_REQUEST'));
  await assert.rejects(f.broker.detach({ binding, extra: true }), code('INVALID_REQUEST'));
  assert.equal(f.remotes[0].calls.length, 0);
});

test('remote config must be resident, complete and unambiguous; local name is reserved', async t => {
  const f = fixture(t);
  await assert.rejects(f.broker.attach({ target: 'missing' }), code('TARGET_NOT_FOUND'));
  for (const runtimeMode of ['legacy-acp', 'hybrid', 'other']) {
    f.registry.machines = [machine({ runtimeMode })];
    await assert.rejects(f.broker.attach({ target: 'remote' }), code('UNSUPPORTED_RUNTIME'));
  }
  for (const [changes, expected] of [
    [{ remoteNode: undefined }, 'INVALID_REMOTE_NODE'], [{ socketPath: undefined }, 'INVALID_SOCKET_PATH'],
    [{ ssh: [] }, 'INVALID_SSH'], [{ socketPath: '/fixture/../socket' }, 'INVALID_SOCKET_PATH'],
  ]) {
    f.registry.machines = [machine(changes)];
    await assert.rejects(f.broker.attach({ target: 'remote' }), code(expected));
  }
  f.registry.machines = [machine(), machine()];
  await assert.rejects(f.broker.attach({ target: 'remote' }), code('INVALID_MACHINE'));
  f.registry.machines = [machine({ name: 'local' })];
  await assert.rejects(f.broker.attach({ target: 'local' }), code('RESERVED_TARGET'));
  assert.equal(f.remotes.length, 0); assert.equal(f.locals.length, 0);
});

test('expected runtime/process identity prevents reconnect to a changed authority', async t => {
  const f = fixture(t);
  for (const expected of [{ expectedRuntimeId: 'wrong' }, { expectedInstanceId: 'wrong' }]) {
    await assert.rejects(f.broker.attach({ target: 'remote', ...expected }), code('RUNTIME_CHANGED'));
  }
  assert.equal(f.remotes.length, 2);
  assert.deepEqual(f.remotes.map(remote => remote.closed), [1, 1]);
  const attached = await f.broker.attach({ target: 'remote', expectedRuntimeId: 'fixture-runtime', expectedInstanceId: 'fixture-epoch' });
  assert.equal(attached.binding.instanceId, 'fixture-epoch');
  f.remotes[2].hello.instanceId = 'mutated-after-hello';
  assert.equal(attached.hello.instanceId, 'fixture-epoch');
  assert.equal((await f.broker.execute(request(attached.binding))).ok, true);
});

test('registry changes evict only owned changed attachments; execute rechecks without explicit reconcile', async t => {
  const f = fixture(t);
  f.registry.machines.push(machine({ name: 'other', ssh: ['other@invalid.example'] }));
  const remote = await f.broker.attach({ target: 'remote' });
  const other = await f.broker.attach({ target: 'other' });
  const local = await f.broker.attach({ target: 'local' });
  f.registry.machines[0].socketPath = '/fixture/private/replaced.sock';
  assert.deepEqual(f.broker.reconcile(), { evicted: 1 }); await turn();
  assert.equal(f.remotes[0].closed, 1); assert.equal(f.remotes[1].closed, 0);
  await assert.rejects(f.broker.execute(request(remote.binding)), code('BINDING_GONE'));
  assert.equal((await f.broker.execute(request(other.binding))).ok, true);
  assert.equal((await f.broker.execute(request(local.binding))).ok, true);
  f.registry.machines = [];
  await assert.rejects(f.broker.execute(request(other.binding)), code('AUTHORITY_CHANGED')); await turn();
  assert.equal(f.remotes[1].closed, 1);
  assert.equal(f.locals[0].closed, 0);
});

test('all authority-bearing machine configuration changes invalidate bindings', async t => {
  const f = fixture(t);
  for (const changes of [{ ssh: ['changed@invalid.example'] }, { remoteNode: '/new/node' },
    { authorityRevision: 'new' }, { env: { REV: 'new' } }, { runtimeMode: 'legacy-acp' }]) {
    f.registry.machines = [machine()];
    const { binding } = await f.broker.attach({ target: 'remote' });
    Object.assign(f.registry.machines[0], changes);
    await assert.rejects(f.broker.execute(request(binding)), code('AUTHORITY_CHANGED'));
  }
});

test('registry change during remote handshake closes late transport and never returns a binding', async t => {
  const pending = deferred(), entered = deferred();
  let supplied;
  const f = fixture(t, { connect: async (config, { signal }) => { supplied = { config, signal }; entered.resolve(); return pending.promise; } });
  const attaching = f.broker.attach({ target: 'remote' });
  const rejected = assert.rejects(attaching, code('AUTHORITY_CHANGED'));
  await entered.promise;
  f.registry.machines[0].ssh[0] = 'changed@invalid.example';
  assert.equal(supplied.config.ssh[0], 'fixture@invalid.example');
  assert.deepEqual(f.broker.reconcile(), { evicted: 1 });
  await rejected;
  assert.equal(supplied.signal.aborted, true);
  const late = f.makeRemote(); pending.resolve(late); await turn();
  assert.equal(late.closed, 1);
});

test('attach checks registry again when connect resolves even without reconciliation', async t => {
  const pending = deferred();
  const f = fixture(t, { connect: () => pending.promise });
  const attaching = f.broker.attach({ target: 'remote' });
  f.registry.machines = [];
  const late = f.makeRemote(); pending.resolve(late);
  await assert.rejects(attaching, code('AUTHORITY_CHANGED'));
  assert.equal(late.closed, 1);
});

test('preaborted attach/execute never admit requests; cancellation during attach closes late results', async t => {
  const f = fixture(t);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.broker.attach({ target: 'remote' }, abort.signal), code('CANCELLED'));
  assert.equal(f.remotes.length, 0);
  const { binding } = await f.broker.attach({ target: 'remote' });
  await assert.rejects(f.broker.execute(request(binding, 'session/create'), abort.signal), code('CANCELLED'));
  assert.equal(f.remotes[0].calls.length, 0);
  const pending = deferred(), controller = new AbortController();
  const g = fixture(t, { connect: () => pending.promise });
  const attaching = g.broker.attach({ target: 'remote' }, controller.signal);
  controller.abort();
  await assert.rejects(attaching, code('CANCELLED'));
  const late = g.makeRemote(); pending.resolve(late); await turn();
  assert.equal(late.closed, 1);
});

test('attachment cap counts concurrent handshakes and releases canceled reservations', async t => {
  const pending = deferred();
  let connects = 0;
  const f = fixture(t, { connect: () => { connects++; return pending.promise; } });
  const controllers = Array.from({ length: BROKER_LIMITS.attachments }, () => new AbortController());
  const rejections = controllers.map(controller => assert.rejects(f.broker.attach({ target: 'remote' }, controller.signal), code('CANCELLED')));
  await assert.rejects(f.broker.attach({ target: 'local' }), code('BUSY'));
  assert.equal(connects, BROKER_LIMITS.attachments);
  for (const controller of controllers) controller.abort();
  await Promise.all(rejections);
  const attached = await f.broker.attach({ target: 'local' });
  assert.equal(attached.binding.target, 'local');
  // All pending fixture connects complete with distinct connection results below
  // in production. Here a rejected connector guarantees no residual resource.
  pending.reject(fault('SSH_FAILED')); await turn();
});

test('idle expiry reaps attachments while active long polls remain leased', async t => {
  const f = fixture(t);
  const a = await f.broker.attach({ target: 'remote' });
  f.advance(BROKER_LIMITS.idleMs - 1);
  assert.equal((await f.broker.execute(request(a.binding))).ok, true);
  f.advance(BROKER_LIMITS.idleMs - 1);
  assert.deepEqual(f.broker.reconcile(), { evicted: 0 });
  const pending = deferred();
  f.remotes[0].peer.request = () => pending.promise;
  const polling = f.broker.execute({ binding: a.binding, method: 'next', params: { streamId: 'owned-stream', waitMs: 25000 } });
  f.advance(BROKER_LIMITS.idleMs * 2);
  assert.deepEqual(f.broker.reconcile(), { evicted: 0 });
  assert.equal(f.remotes[0].closed, 0);
  pending.resolve({ done: false, items: [] }); await polling;
  f.advance(BROKER_LIMITS.idleMs - 1);
  assert.deepEqual(f.broker.reconcile(), { evicted: 0 });
  f.advance(1);
  assert.deepEqual(f.broker.reconcile(), { evicted: 1 }); await turn();
  assert.equal(f.remotes[0].closed, 1);
  await assert.rejects(f.broker.execute(request(a.binding)), code('BINDING_GONE'));
});

test('idle timer revokes expired attachments without later traffic', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.broker.attach({ target: 'local' });
  f.advance(BROKER_LIMITS.idleMs); t.mock.timers.tick(BROKER_LIMITS.idleMs);
  await Promise.resolve();
  assert.equal(f.locals[0].closed, 1);
});

test('remote mutation failure is explicitly unknown and is never replayed or locally redirected', async t => {
  const f = fixture(t);
  const { binding } = await f.broker.attach({ target: 'remote' });
  let admitted = 0;
  f.remotes[0].peer.request = () => { admitted++; throw fault('SSH_DISCONNECTED'); };
  await assert.rejects(f.broker.execute(request(binding, 'session/prompt', ['session-id', 'hello'])), error => {
    assert.equal(error.code, 'UNKNOWN_MUTATION_OUTCOME'); assert.match(error.message, /not automatically replay/i); return true;
  });
  await assert.rejects(f.broker.execute(request(binding, 'session/prompt', ['session-id', 'hello'])), code('BINDING_GONE'));
  assert.equal(admitted, 1); assert.equal(f.remotes.length, 1); assert.equal(f.locals.length, 0);
});

test('readonly failures and known runtime replies preserve semantics without replay', async t => {
  const f = fixture(t);
  const a = await f.broker.attach({ target: 'remote' });
  let admitted = 0;
  f.remotes[0].peer.request = async () => { admitted++; throw fault('TRANSPORT_LOST'); };
  await assert.rejects(f.broker.execute(request(a.binding)), code('TRANSPORT_LOST'));
  assert.equal(admitted, 1);
  const b = await f.broker.attach({ target: 'remote' });
  const knownRejection = { ok: false, error: { code: 'APPLICATION_REJECTED' } };
  f.remotes[1].peer.request = async () => knownRejection;
  assert.equal(await f.broker.execute(request(b.binding, 'session/create')), knownRejection);
  assert.equal(f.remotes.length, 2); assert.equal(f.locals.length, 0);
});

test('detach races abort observers, suppress late replies, and mark admitted mutation outcome unknown', async t => {
  const f = fixture(t);
  const a = await f.broker.attach({ target: 'remote' }), b = await f.broker.attach({ target: 'remote' });
  const read = deferred(), write = deferred();
  f.remotes[0].peer.request = () => read.promise;
  f.remotes[1].peer.request = () => write.promise;
  const readFailure = assert.rejects(f.broker.execute(request(a.binding)), code('BINDING_GONE'));
  const writeFailure = assert.rejects(f.broker.execute(request(b.binding, 'session/create')), code('UNKNOWN_MUTATION_OUTCOME'));
  await f.broker.detach({ binding: a.binding }); await f.broker.detach({ binding: b.binding });
  await Promise.all([readFailure, writeFailure]);
  read.resolve({ ok: true }); write.resolve({ ok: true }); await turn();
  assert.deepEqual(f.remotes.map(remote => remote.closed), [1, 1]);
});

test('event-result transport failure is unknown, cancellation is forwarded without replay', async t => {
  const f = fixture(t);
  const { binding } = await f.broker.attach({ target: 'remote' });
  let admitted = 0, remoteSignal;
  const pending = deferred(), controller = new AbortController();
  f.remotes[0].peer.request = (method, params, { signal }) => { admitted++; remoteSignal = signal; return pending.promise; };
  const execution = f.broker.execute({ binding, method: 'event-result', params: { clientId: 'events', eventId: 'id', outcome: { approved: true } } }, controller.signal);
  controller.abort();
  await assert.rejects(execution, code('UNKNOWN_MUTATION_OUTCOME'));
  assert.equal(remoteSignal.aborted, true); assert.equal(admitted, 1);
  pending.resolve({ ok: true }); await turn();
  assert.equal(f.remotes.length, 1);
});

test('registry changes during admitted calls suppress stale successes', async t => {
  const f = fixture(t);
  const a = await f.broker.attach({ target: 'remote' });
  const pending = deferred();
  f.remotes[0].peer.request = () => pending.promise;
  const execution = f.broker.execute(request(a.binding, 'session/create'));
  f.registry.machines[0].authorityRevision = 'new';
  pending.resolve({ ok: true });
  await assert.rejects(execution, code('UNKNOWN_MUTATION_OUTCOME'));
  assert.equal(f.remotes[0].closed, 1);
});

test('peer loss evicts exactly its own attachment', async t => {
  const f = fixture(t);
  const a = await f.broker.attach({ target: 'remote' }), b = await f.broker.attach({ target: 'remote' });
  f.remotes[0].peer.closed = true;
  await assert.rejects(f.broker.execute(request(a.binding)), code('TRANSPORT_LOST'));
  assert.equal((await f.broker.execute(request(b.binding))).ok, true);
});

test('invalid remote hello is closed, and connect errors never create a local adapter', async t => {
  let closeCount = 0;
  for (const badHello of [hello({ protocol: 'wrong' }), hello({ instanceId: '' }), hello({ capabilities: [{}] }), hello({ capabilities: [hello().capabilities[0], hello().capabilities[0]] })]) {
    const f = fixture(t, { connect: async () => ({ hello: badHello, peer: { request() {} }, close() { closeCount++; } }) });
    await assert.rejects(f.broker.attach({ target: 'remote' }), code('INCOMPATIBLE_PROTOCOL'));
    assert.equal(f.locals.length, 0);
  }
  assert.equal(closeCount, 4);
  const f = fixture(t, { connect: async () => { throw fault('SSH_FAILED'); } });
  await assert.rejects(f.broker.attach({ target: 'remote' }), code('SSH_FAILED'));
  assert.equal(f.locals.length, 0);
});

test('dispose is idempotent, closes clients only, aborts in-flight operations and late attach races', async t => {
  const late = deferred();
  const f = fixture(t);
  await f.broker.attach({ target: 'local' });
  const remote = await f.broker.attach({ target: 'remote' });
  const pending = deferred();
  f.remotes[0].peer.request = () => pending.promise;
  const aborted = assert.rejects(f.broker.execute(request(remote.binding)), code('BROKER_DISPOSED'));
  const firstDisposal = f.broker.dispose();
  assert.equal(firstDisposal, f.broker.dispose());
  await firstDisposal; await aborted;
  assert.equal(f.locals[0].closed, 1); assert.equal(f.remotes[0].closed, 1);
  pending.resolve({ ok: true });
  await assert.rejects(f.broker.attach({ target: 'local' }), code('BROKER_DISPOSED'));
  await assert.rejects(f.broker.execute(request(remote.binding)), code('BROKER_DISPOSED'));
  await assert.rejects(f.broker.detach({ binding: remote.binding }), code('BROKER_DISPOSED'));
  assert.deepEqual(f.broker.reconcile(), { evicted: 0 });
  const g = fixture(t, { connect: () => late.promise });
  const attaching = assert.rejects(g.broker.attach({ target: 'remote' }), code('BROKER_DISPOSED'));
  await g.broker.dispose(); await attaching;
  const remoteLate = g.makeRemote(); late.resolve(remoteLate); await turn();
  assert.equal(remoteLate.closed, 1);
});

test('plain abort reasons become CANCELLED for readonly operations and no replay occurs', async t => {
  const f = fixture(t);
  const { binding } = await f.broker.attach({ target: 'remote' });
  const pending = deferred(), controller = new AbortController();
  let admitted = 0;
  f.remotes[0].peer.request = () => { admitted++; return pending.promise; };
  const executing = f.broker.execute(request(binding), controller.signal);
  controller.abort();
  await assert.rejects(executing, code('CANCELLED'));
  pending.resolve({ ok: true }); await turn();
  assert.equal(admitted, 1);
  assert.equal(f.remotes[0].closed, 0);
});

test('attach snapshots expected authority fields before an asynchronous handshake', async t => {
  const pending = deferred();
  const f = fixture(t, { connect: () => pending.promise });
  const body = { target: 'remote', expectedInstanceId: 'original-required-epoch' };
  const attaching = f.broker.attach(body);
  body.target = 'local'; body.expectedInstanceId = 'fixture-epoch';
  const remote = f.makeRemote(); pending.resolve(remote);
  await assert.rejects(attaching, code('RUNTIME_CHANGED'));
  assert.equal(remote.closed, 1);
});

test('remote reply loss immediately revokes its binding and closes only its carrier', async t => {
  const disconnected = deferred();
  const f = fixture(t, { connect: async () => f.makeRemote({
    peer: { done: disconnected.promise, closed: false, request: async () => ({ ok: true }) },
  }) });
  const { binding } = await f.broker.attach({ target: 'remote' });
  disconnected.resolve(fault('TRANSPORT_LOST')); await turn();
  await assert.rejects(f.broker.execute(request(binding)), code('BINDING_GONE'));
  assert.equal(f.remotes[0].closed, 1);
});

test('local adapter factory late completion after disposal never creates a client', async t => {
  const pending = deferred(); let clients = 0;
  const f = fixture(t, { localAdapterFactory: () => pending.promise });
  const attaching = assert.rejects(f.broker.attach({ target: 'local' }), code('BROKER_DISPOSED'));
  await f.broker.dispose(); await attaching;
  pending.resolve({ client() { clients++; }, hello: hello() }); await turn();
  assert.equal(clients, 0);
});
