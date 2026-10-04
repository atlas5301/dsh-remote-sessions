/**
 * Run: node --test dsh-remote-sessions/test/resident-protocol.test.js
 *
 * Only Node built-ins and the four production modules are imported. All traffic
 * uses real framed Unix sockets in a mode-0700, canonical os.tmpdir directory.
 * No live DSH, SSH, browser, deployment, or external package is started.
 *
 * The injected fixture implements the installed public Connection ClientRequest /
 * ServerResponse, Typert descriptor, Gateway.wireStream.open, and Remote Event
 * ready/waterfall/result contracts. Domain data below is deliberately modeled:
 * these tests prove observer/transport isolation, NOT real Agent persistence or
 * real permission execution. An independent fake run owns its own lifetime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { PROTOCOL, LIMITS, RpcPeer, StreamShelf, exact, fault, plain, wireError } from '../lib/protocol.js';
import { listenCompanion, privateDirectory, runtimeIdentity } from '../lib/companion-server.js';
import { createRuntimeAdapter, EMPTY_UPLINK } from '../lib/runtime-adapter.js';
import { connectSsh, RELAY, shellQuote, validateSsh } from '../lib/ssh-carrier.js';

const TEST = { timeout: 8000 };
const SESSION = 'fixture-session';
const ADDRESS = { sessionId: SESSION, workspace: '/fixture/workspace' };
const PROMPT = { requestId: 'fixture-request', sessionId: SESSION, mode: 'queue', content: [{ type: 'text', text: 'modeled work' }] };
const code = value => ({ code: value });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function within(promise, label, ms = 2000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out: ' + label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function frame(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}
function header(length) { const value = Buffer.alloc(4); value.writeUInt32BE(length); return value; }
async function privateTemp(t, beforeCleanup = async () => {}) {
  // macOS's os.tmpdir can itself contain /var -> /private/var symlinks.
  const root = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(join(root, 'dsh-rp-'));
  await fs.chmod(directory, 0o700);
  t.after(async () => {
    await beforeCleanup();
    // Check the resolved absolute target immediately before recursive deletion.
    const actual = await fs.realpath(directory);
    assert.equal(actual, directory);
    assert.equal(resolve(actual), actual);
    assert.equal(dirname(actual), root);
    assert.ok(basename(actual).startsWith('dsh-rp-'));
    const stat = await fs.lstat(actual);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(stat.uid, process.getuid());
    await fs.rm(actual, { recursive: true });
  });
  return directory;
}

// Abort-aware public Gateway iterator; aborting it never controls the fake run.
function queue(signal) {
  const values = [], pending = [];
  const stopped = deferred(), read = deferred();
  let ended = false, reads = 0, returns = 0;
  function stop() {
    if (ended) return;
    ended = true;
    while (pending.length) pending.shift()({ done: true });
    signal?.removeEventListener('abort', stop);
    stopped.resolve();
  }
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  return {
    stopped: stopped.promise, read: read.promise,
    get reads() { return reads; }, get returns() { return returns; },
    push(value) { if (!ended) { if (pending.length) pending.shift()({ done: false, value }); else values.push(value); } },
    next() {
      reads++; read.resolve();
      if (ended) return Promise.resolve({ done: true });
      if (values.length) return Promise.resolve({ done: false, value: values.shift() });
      return new Promise(resolve => pending.push(resolve));
    },
    async return() { returns++; stop(); return { done: true }; },
    [Symbol.asyncIterator]() { return this; },
  };
}

function publicRuntime() {
  const descriptors = new Map([
    ['session/list', { parameters: [{ wire: '_request' }] }],
    ['session/create', { parameters: [{ wire: 'request' }] }],
    ['session/prompt', { parameters: [{ wire: 'request' }] }],
    ['session/page', { parameters: [{ wire: 'request' }] }],
    ['session/cancel', { parameters: [{ wire: 'request' }] }],
    ['session/rename', { parameters: [{ wire: 'request' }] }],
    ['session/modelCatalog', { parameters: [] }],
    ['session/follow', { mode: 'stream', parameters: [{ wire: 'request' }] }],
    ['session/control', { mode: 'stream', parameters: [] }],
    // Never exposed: allow-listing must not depend on registry contents alone.
    ['internal/dangerous', { parameters: [] }],
  ]);
  const calls = [], opens = [], events = new Map(), follow = new Set();
  const promptCommitted = deferred(), receipt = deferred();
  const run = { id: 'fixture-active-run', running: false, cancelled: 0, prompts: 0, progress: 0, approved: false };
  const runtime = {
    descriptors, calls, opens, events, run, promptCommitted,
    holdPromptReceipt: false, reply: undefined,
    releaseReceipt() { receipt.resolve(); },
    advance() {
      assert.equal(run.running, true);
      run.progress++;
      for (const source of follow) source.push({ type: 'fixture-progress', runId: run.id, progress: run.progress });
    },
    snapshot() {
      return { type: 'fixture-snapshot', sessionId: SESSION, activeRunId: run.running ? run.id : null, progress: run.progress };
    },
    approval(clientId) {
      const source = events.get(clientId);
      assert.ok(source, 'approval goes through an active public event generation');
      const eventId = randomUUID();
      source.pending.add(eventId);
      const value = { type: 'waterfall', event: 'fixture/approval', eventId, agentId: SESSION,
        request: { tool: 'fixture-tool', question: 'Allow modeled work?' } };
      source.push(value);
      return value;
    },
  };
  const operator = Object.freeze({ id: 'fixture-operator', kind: 'operator' });
  const connection = {
    operator,
    createSharedFetchHandler(channel) {
      assert.equal(channel, '/api');
      return {
        async fetch(request) {
          assert.ok(request instanceof Request);
          assert.equal(request.method, 'POST');
          assert.equal(request.headers.get('content-type'), 'application/json');
          const envelope = await request.json();
          assert.deepEqual(Object.keys(envelope).sort(), ['method', 'payload', 'rpcId', 'type']);
          assert.equal(envelope.type, 'client-request');
          assert.equal(typeof envelope.rpcId, 'string');
          assert.equal(new URL(request.url).pathname, '/api/' + envelope.method);
          assert.deepEqual(Object.keys(envelope.payload), ['args']);
          calls.push({ ...envelope, signal: request.signal });
          let result;
          if (envelope.method === 'session/prompt') {
            run.prompts++; run.running = true; promptCommitted.resolve();
            if (runtime.holdPromptReceipt) await receipt.promise;
            result = { ok: true, value: { accepted: true } };
          } else if (envelope.method === 'session/cancel') {
            run.cancelled++; run.running = false;
            result = { ok: true, value: { accepted: true } };
          } else if (envelope.method === 'session/page') {
            result = { ok: true, value: runtime.snapshot() };
          } else if (envelope.method === '$events/result') {
            const { clientId, eventId, outcome } = envelope.payload.args;
            const source = events.get(clientId);
            // This is the Gateway's public result validation, not adapter logic.
            const valid = source?.pending.has(eventId) &&
              (outcome?.kind === 'next' || outcome?.kind === 'result' ||
                (outcome?.kind === 'rejected' && typeof outcome.error?.message === 'string'));
            if (!valid) result = { ok: false, error: { code: 'gateway/input-invalid', message: 'Invalid event result', details: {} } };
            else {
              source.pending.delete(eventId);
              run.approved = outcome.kind === 'result' && outcome.value?.approved === true;
              result = { ok: true, value: null };
            }
          } else result = { ok: true, value: { method: envelope.method, args: envelope.payload.args } };
          if (runtime.reply) return runtime.reply(envelope, result);
          return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result });
        },
      };
    },
  };
  const typertGateway = { wireStream: {
    async open(endpoint, payload, uplink, peer, signal) {
      assert.equal(peer, operator);
      assert.equal(uplink, EMPTY_UPLINK);
      assert.ok(signal instanceof AbortSignal);
      const source = queue(signal);
      const item = { endpoint, payload, signal, source };
      opens.push(item);
      if (endpoint === '$events') {
        assert.deepEqual(payload, { args: {} });
        const clientId = randomUUID();
        item.clientId = clientId; source.pending = new Set();
        events.set(clientId, source);
        source.stopped.then(() => events.delete(clientId));
        source.push({ type: 'ready', clientId, host: { home: '/fixture/home' } });
      } else if (endpoint === 'session/follow') {
        follow.add(source); source.stopped.then(() => follow.delete(source));
        source.push(runtime.snapshot());
      } else if (endpoint !== 'session/control') throw new Error('Unexpected fixture stream: ' + endpoint);
      return source;
    },
  } };
  const typert = { local: { get: endpoint => descriptors.get(endpoint) } };
  runtime.ctx = { get: name => ({ connection, typertGateway, typert })[name] };
  runtime.services = { connection, typertGateway, typert };
  return runtime;
}

async function resident(t, options = {}) {
  let cleanup = async () => {};
  const directory = await privateTemp(t, () => cleanup());
  const socketPath = join(directory, 's');
  assert.ok(socketPath.length <= 100, 'test socket obeys production path cap');
  const runtime = publicRuntime();
  const runtimeId = await runtimeIdentity(directory);
  const adapter = createRuntimeAdapter(runtime.ctx, { runtimeId, instanceId: 'fixture-instance' });
  const server = await listenCompanion({ socketPath, adapter, ...options });
  const sockets = new Set(), clients = new Set();
  cleanup = async () => {
    runtime.releaseReceipt();
    for (const peer of clients) peer.close();
    for (const socket of sockets) socket.destroy();
    await server.close();
    await turn();
  };
  async function raw() {
    const socket = net.connect(socketPath);
    sockets.add(socket); socket.on('error', () => {});
    await within(once(socket, 'connect'), 'Unix client connect');
    return socket;
  }
  async function client() {
    const peer = new RpcPeer(await raw()); clients.add(peer); return peer;
  }
  return { directory, socketPath, runtime, adapter, runtimeId, server, raw, client };
}
async function open(peer, endpoint, values = []) { return (await peer.request('open', { endpoint, values })).streamId; }
async function next(peer, streamId, waitMs = 100) { return peer.request('next', { streamId, waitMs }); }
async function call(peer, endpoint, values) { return peer.request('call', { endpoint, values }); }
async function ready(peer) {
  const streamId = await open(peer, '$events');
  const batch = await next(peer, streamId);
  assert.equal(batch.items[0].type, 'ready');
  return { streamId, clientId: batch.items[0].clientId };
}

async function rpcPair(t, handle, { maxFrame = LIMITS.frame, serverPending = 128, clientPending = 128 } = {}) {
  let cleanup = async () => {};
  const directory = await privateTemp(t, () => cleanup()), peers = new Set(), sockets = new Set();
  const accepted = deferred();
  const server = net.createServer(socket => {
    sockets.add(socket);
    const peer = new RpcPeer(socket, { handle, maxFrame, maxPending: serverPending });
    peers.add(peer); accepted.resolve(peer);
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(join(directory, 's'), ok); });
  await fs.chmod(join(directory, 's'), 0o600);
  cleanup = async () => {
    for (const peer of peers) peer.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(ok => server.close(ok));
  };
  const socket = net.connect(join(directory, 's')); sockets.add(socket);
  await within(once(socket, 'connect'), 'pair connection');
  const peer = new RpcPeer(socket, { maxFrame, maxPending: clientPending }); peers.add(peer);
  return { peer, serverPeer: await accepted.promise };
}

test('private socket and stable runtime identity reject unsafe filesystem state without replacement', TEST, async t => {
  const f = await resident(t);
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(f.socketPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(join(f.directory, 'runtime-id'))).mode & 0o777, 0o600);
  assert.equal(await runtimeIdentity(f.directory), f.runtimeId);
  assert.match(f.runtimeId, /^[a-f\d-]{36}$/);
  await assert.rejects(listenCompanion({ socketPath: f.socketPath, adapter: f.adapter }), code('SOCKET_EXISTS'));
  const first = await (await f.client()).request('hello', { protocol: PROTOCOL });
  assert.equal(first.runtimeId, f.runtimeId, 'refusing replacement did not disturb resident');
  const insecure = join(f.directory, 'insecure');
  await fs.mkdir(insecure, { mode: 0o700 }); await fs.chmod(insecure, 0o755);
  await assert.rejects(privateDirectory(insecure), code('UNSAFE_RUNTIME_DIRECTORY'));
  const link = join(f.directory, 'link');
  await fs.symlink(f.directory, link);
  await assert.rejects(privateDirectory(link), code('UNSAFE_RUNTIME_DIRECTORY'));
  const identity = join(insecure, 'runtime-id');
  await fs.chmod(insecure, 0o700); await fs.symlink(join(f.directory, 'runtime-id'), identity);
  await assert.rejects(runtimeIdentity(insecure), code('UNSAFE_RUNTIME_ID'));
  await assert.rejects(listenCompanion({ socketPath: join(f.directory, 'x'.repeat(101)), adapter: f.adapter }), code('SOCKET_PATH_TOO_LONG'));
});

test('real clients detach observers, then reattach the same resident runtime and active modeled run', TEST, async t => {
  const f = await resident(t), a = await f.client();
  const hello = await a.request('hello', { protocol: PROTOCOL });
  assert.equal(hello.instanceId, 'fixture-instance');
  assert.ok(!hello.capabilities.some(value => value.endpoint === 'internal/dangerous'));
  assert.deepEqual(await call(a, 'session/prompt', [PROMPT]), { ok: true, value: { accepted: true } });
  const runId = f.runtime.run.id;
  const streamId = await open(a, 'session/follow', [{ address: ADDRESS }]);
  const initial = await next(a, streamId);
  assert.equal(initial.items[0].activeRunId, runId);
  const observer = f.runtime.opens.at(-1);
  const pending = next(a, streamId, 25000);
  const lost = assert.rejects(pending, code('TRANSPORT_LOST'));
  a.stream.destroy();
  await lost;
  await within(observer.source.stopped, 'observer detached after lost connection');
  assert.equal(observer.signal.aborted, true);
  assert.equal(f.runtime.run.running, true, 'observer lifetime must not own agent lifetime');
  assert.equal(f.runtime.run.cancelled, 0);
  f.runtime.advance();
  const b = await f.client();
  assert.deepEqual(await b.request('hello', { protocol: PROTOCOL }), hello);
  const replacement = await open(b, 'session/follow', [{ address: ADDRESS }]);
  assert.notEqual(replacement, streamId);
  assert.deepEqual((await next(b, replacement)).items, [f.runtime.snapshot()]);
  assert.equal(f.runtime.run.id, runId);
  assert.equal(f.runtime.run.prompts, 1, 'reattach is not a new prompt');
  const source = f.runtime.opens.at(-1);
  await b.request('close', { streamId: replacement });
  await within(source.source.stopped, 'explicit stream close');
  assert.equal(f.runtime.run.running, true);
  await assert.rejects(next(b, replacement), code('STREAM_GONE'));
  await call(b, 'session/cancel', [{ sessionId: SESSION }]);
  assert.equal(f.runtime.run.cancelled, 1, 'only explicit public cancel stops modeled work');
  assert.equal(f.runtime.run.running, false);
});

test('a lost mutation receipt is never automatically replayed on a new connection', TEST, async t => {
  const f = await resident(t), a = await f.client();
  f.runtime.holdPromptReceipt = true;
  const lost = assert.rejects(call(a, 'session/prompt', [PROMPT]), code('TRANSPORT_LOST'));
  await within(f.runtime.promptCommitted.promise, 'modeled mutation committed');
  a.stream.destroy(); await lost;
  const b = await f.client();
  const hello = await b.request('hello', { protocol: PROTOCOL });
  assert.equal(hello.runtimeId, f.runtimeId);
  const page = await call(b, 'session/page', [{ address: ADDRESS, throughSeq: 1 }]);
  assert.equal(page.value.activeRunId, f.runtime.run.id);
  assert.equal(f.runtime.run.prompts, 1);
  assert.equal(f.runtime.calls.filter(value => value.method === 'session/prompt').length, 1);
  f.runtime.releaseReceipt();
  await turn();
  assert.equal(f.runtime.run.running, true);
  assert.equal(f.runtime.run.cancelled, 0);
  assert.equal(f.runtime.run.prompts, 1, 'late receipt cannot initiate a retry');
});

test('public event approvals are isolated by client generation and detached ownership is revoked', TEST, async t => {
  const f = await resident(t), a = await f.client(), b = await f.client();
  const alice = await ready(a), bob = await ready(b);
  assert.notEqual(alice.clientId, bob.clientId);
  const aliceApproval = f.runtime.approval(alice.clientId), bobApproval = f.runtime.approval(bob.clientId);
  assert.deepEqual((await next(a, alice.streamId)).items, [aliceApproval]);
  assert.deepEqual((await next(b, bob.streamId)).items, [bobApproval]);
  const outcome = { kind: 'result', value: { approved: true } };
  const before = f.runtime.calls.length;
  await assert.rejects(b.request('event-result', { clientId: alice.clientId, eventId: aliceApproval.eventId, outcome }), code('INVALID_EVENT_OWNER'));
  await assert.rejects(a.request('event-result', { clientId: bob.clientId, eventId: bobApproval.eventId, outcome }), code('INVALID_EVENT_OWNER'));
  await assert.rejects(next(b, alice.streamId), code('STREAM_GONE'));
  await b.request('close', { streamId: alice.streamId });
  assert.equal(f.runtime.calls.length, before, 'cross-client results never reach Connection');
  // Owning one's clientId does not grant another generation's eventId: Gateway
  // validates that pair through the public route, not a private approval API.
  const wrongEvent = await b.request('event-result', { clientId: bob.clientId, eventId: aliceApproval.eventId, outcome });
  assert.equal(wrongEvent.ok, false);
  assert.equal(f.runtime.run.approved, false);
  assert.deepEqual(await a.request('event-result', { clientId: alice.clientId, eventId: aliceApproval.eventId, outcome }), { ok: true, value: null });
  assert.equal(f.runtime.run.approved, true);
  assert.deepEqual(f.runtime.calls.at(-1).payload, { args: { clientId: alice.clientId, eventId: aliceApproval.eventId, outcome } });
  assert.equal(f.runtime.calls.at(-1).method, '$events/result');
  await a.request('close', { streamId: alice.streamId });
  await assert.rejects(a.request('event-result', { clientId: alice.clientId, eventId: aliceApproval.eventId, outcome }), code('INVALID_EVENT_OWNER'));
  const replacement = await ready(a);
  assert.notEqual(replacement.clientId, alice.clientId);
  const declined = await b.request('event-result', { clientId: bob.clientId, eventId: bobApproval.eventId, outcome: { kind: 'next' } });
  assert.equal(declined.ok, true);
});

test('descriptor routing and public envelopes preserve domain results and reject unsupported mutations', TEST, async t => {
  const f = await resident(t), peer = await f.client();
  const request = { workspace: '/fixture/workspace' };
  assert.deepEqual(await call(peer, 'session/list', [request]), { ok: true, value: { method: 'session/list', args: { _request: request } } });
  assert.deepEqual(await call(peer, 'session/modelCatalog', []), { ok: true, value: { method: 'session/modelCatalog', args: {} } });
  const checks = [
    ['hello', { protocol: 'other/1' }, 'INCOMPATIBLE_PROTOCOL'],
    ['hello', { protocol: PROTOCOL, token: 'not-allowed' }, 'INVALID_REQUEST'],
    ['call', { endpoint: 'internal/dangerous', values: [] }, 'UNSUPPORTED_OPERATION'],
    ['call', { endpoint: 'session/follow', values: [{}] }, 'UNSUPPORTED_OPERATION'],
    ['open', { endpoint: 'session/prompt', values: [PROMPT] }, 'UNSUPPORTED_OPERATION'],
    ['open', { endpoint: '$events', values: [{}] }, 'INVALID_REQUEST'],
    ['call', { endpoint: 'session/list', values: [1, 2] }, 'UNSUPPORTED_OPERATION'],
    ['call', { endpoint: 'session/list', values: {} }, 'UNSUPPORTED_OPERATION'],
    ['call', { endpoint: 'session/list', values: [], private: true }, 'INVALID_REQUEST'],
    ['call', null, 'INVALID_REQUEST'],
    ['unknown', {}, 'UNSUPPORTED_OPERATION'],
  ];
  const count = f.runtime.calls.length;
  for (const [method, params, expected] of checks) await assert.rejects(peer.request(method, params), code(expected));
  assert.equal(f.runtime.calls.length, count);
  f.runtime.descriptors.set('session/list', { parameters: [{ wire: 'newRequest' }] });
  await assert.rejects(call(peer, 'session/list', [request]), code('RUNTIME_CHANGED'));
  const domainFailure = { ok: false, error: { code: 'fixture/domain', message: 'domain error', details: { sample: true } } };
  f.runtime.reply = envelope => Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: domainFailure });
  assert.deepEqual(await call(peer, 'session/page', [{}]), domainFailure);
});

test('adapter refuses missing public services and missing required descriptors', TEST, async () => {
  for (const ctx of [{}, { connection: {} }, { get: () => undefined }]) {
    assert.throws(() => createRuntimeAdapter(ctx, { runtimeId: 'r' }), code('INCOMPATIBLE_DSH'));
  }
  const f = publicRuntime();
  f.descriptors.delete('session/prompt');
  assert.throws(() => createRuntimeAdapter(f.ctx, { runtimeId: 'r' }), code('INCOMPATIBLE_DSH'));
});

test('adapter refuses incompatible public Connection replies without exposing raw diagnostics', TEST, async t => {
  const f = await resident(t), peer = await f.client();
  const cases = [
    [() => new Response('secret /runtime/token', { status: 500 }), 'UNSUPPORTED_RESPONSE'],
    [() => new Response('not-json', { headers: { 'Content-Type': 'text/plain' } }), 'UNSUPPORTED_RESPONSE'],
    [() => Response.json({ type: 'server-response', rpcId: 'wrong', result: { ok: true } }), 'INVALID_RUNTIME_REPLY'],
    [env => Response.json({ type: 'wrong', rpcId: env.rpcId, result: { ok: true } }), 'INVALID_RUNTIME_REPLY'],
    [env => Response.json({ type: 'server-response', rpcId: env.rpcId, result: { ok: 'yes' } }), 'INVALID_RUNTIME_REPLY'],
    [() => { throw Object.assign(new Error('secret /runtime/token'), { code: 'private/path' }); }, 'BACKEND_ERROR'],
  ];
  for (const [reply, expected] of cases) {
    f.runtime.reply = reply;
    await assert.rejects(call(peer, 'session/page', [{}]), error => error.code === expected && !error.message.includes('secret'));
  }
});

test('framing handles fragmented Unicode and coalesced messages over a real Unix socket', TEST, async t => {
  const f = await resident(t), socket = await f.raw(), client = new RpcPeer(socket);
  t.after(() => client.close());
  // A raw writer plus the production client parser also checks independent framing.
  const replies = new Map();
  for (const id of ['one', 'two']) {
    const done = deferred(); client.pending.set(id, { finish(error, value) { client.pending.delete(id); error ? done.reject(error) : done.resolve(value); } });
    replies.set(id, done.promise);
  }
  const first = frame({ type: 'request', id: 'one', method: 'call', params: { endpoint: 'session/rename', values: [{ title: '测试 🌍' }] } });
  const second = frame({ type: 'request', id: 'two', method: 'hello', params: { protocol: PROTOCOL } });
  socket.write(first.subarray(0, 2)); await turn();
  socket.write(first.subarray(2, 9)); await turn();
  socket.write(Buffer.concat([first.subarray(9), second]));
  assert.equal((await within(replies.get('one'), 'fragmented frame')).value.args.request.title, '测试 🌍');
  assert.equal((await within(replies.get('two'), 'coalesced frame')).protocol, PROTOCOL);
});

test('malformed, oversized, duplicate-active and extra-field frames close only the offending client', TEST, async t => {
  const f = await resident(t);
  const request = { type: 'request', id: 'bad', method: 'hello', params: { protocol: PROTOCOL } };
  const bad = [
    header(0), header(LIMITS.frame + 1), frame(Buffer.from('{broken')),
    frame(null), frame([]), frame({ ...request, id: 1 }), frame({ ...request, id: 'x'.repeat(129) }),
    frame({ ...request, method: 1 }), frame({ ...request, method: 'x'.repeat(129) }),
    frame({ ...request, type: 'unknown' }), frame({ ...request, extra: true }),
    frame({ type: 'cancel', id: 'bad', extra: true }),
    frame({ type: 'response', id: 'bad', ok: 'yes' }),
    Buffer.concat([frame(request), frame(request)]),
  ];
  for (const bytes of bad) {
    const socket = await f.raw();
    const closed = once(socket, 'close'); socket.write(bytes);
    await within(closed, 'malformed peer closed');
  }
  const good = await f.client();
  assert.equal((await good.request('hello', { protocol: PROTOCOL })).runtimeId, f.runtimeId);
  assert.equal(f.runtime.run.prompts, 0);
});

test('RPC pending/active caps reject excess work and a cancelled request does not poison the peer', TEST, async t => {
  const gate = deferred(), entered = deferred(), cancelled = deferred();
  let seenSignal;
  const { peer } = await rpcPair(t, async (method, params, signal) => {
    if (method === 'hold') {
      seenSignal = signal;
      signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      entered.resolve(); await gate.promise;
    }
    return params;
  }, { serverPending: 1, clientPending: 2 });
  t.after(() => gate.resolve());
  const controller = new AbortController();
  const rejected = assert.rejects(peer.request('hold', { first: true }, { signal: controller.signal }), code('CANCELLED'));
  await entered.promise;
  await assert.rejects(peer.request('over-server-cap', {}), code('BUSY'));
  controller.abort(); await rejected;
  await within(cancelled.promise, 'cancel frame reaches remote handler');
  assert.equal(seenSignal.aborted, true);
  gate.resolve(); await turn(); await turn();
  assert.deepEqual(await peer.request('echo', { recovered: true }), { recovered: true });
  const local = await rpcPair(t, () => new Promise(() => {}), { clientPending: 1 });
  const first = assert.rejects(local.peer.request('hold', {}, { timeoutMs: 0 }), code('TRANSPORT_LOST'));
  await assert.rejects(local.peer.request('second', {}), code('BUSY'));
  local.peer.close(); await first;
});

test('RPC timeout cancels only its handler; send caps and backpressure leave no pending entry', TEST, async t => {
  const entered = deferred(), cancelled = deferred();
  const f = await rpcPair(t, async (method, params, signal) => {
    entered.resolve();
    signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    await cancelled.promise;
    return null;
  }, { maxFrame: 256 });
  await assert.rejects(f.peer.request('oversize', 'x'.repeat(300)), code('FRAME_TOO_LARGE'));
  assert.equal(f.peer.pending.size, 0);
  const timeout = assert.rejects(f.peer.request('hold', {}, { timeoutMs: 100 }), code('TIMEOUT'));
  await entered.promise; await timeout; await within(cancelled.promise, 'timeout abort reaches handler');
  assert.equal(f.peer.pending.size, 0);
  Object.defineProperty(f.peer.stream, 'writableLength', { configurable: true, value: 513 });
  await assert.rejects(f.peer.request('blocked', {}), code('BACKPRESSURE'));
  assert.equal(f.peer.pending.size, 0);
});

test('StreamShelf caps streams and concurrent polls, retains one read across timeouts, and cleans up', TEST, async () => {
  const shelf = new StreamShelf({ max: 1, idleMs: 10000 });
  let source, lifetime;
  try {
    const id = await shelf.open(signal => { lifetime = signal; source = queue(signal); return source; });
    await assert.rejects(shelf.open(() => queue()), code('BUSY'));
    const first = shelf.next(id, { waitMs: 25 });
    await source.read;
    await assert.rejects(shelf.next(id), code('POLL_IN_PROGRESS'));
    assert.deepEqual(await first, { done: false, items: [] });
    assert.deepEqual(await shelf.next(id, { waitMs: 1 }), { done: false, items: [] });
    assert.equal(source.reads, 1, 'timed polling must reuse, not multiply pending iterator.next');
    source.push({ progress: 1 });
    assert.deepEqual(await shelf.next(id), { done: false, items: [{ progress: 1 }] });
    await shelf.close(id);
    assert.equal(lifetime.aborted, true);
    assert.equal(source.returns, 1);
    await shelf.close(id);
    await assert.rejects(shelf.next(id), code('STREAM_GONE'));
  } finally { await shelf.dispose(); }
});

test('StreamShelf idle expiry and aborted polls detach source lifetimes', TEST, async () => {
  const shelf = new StreamShelf({ idleMs: 20 });
  try {
    let source;
    const id = await shelf.open(signal => (source = queue(signal)));
    await within(source.stopped, 'idle stream expiry');
    await assert.rejects(shelf.next(id), code('STREAM_GONE'));
    const second = await shelf.open(signal => (source = queue(signal)));
    const controller = new AbortController();
    const cancelled = assert.rejects(shelf.next(second, { signal: controller.signal }), code('CANCELLED'));
    await source.read; controller.abort(); await cancelled;
    assert.equal(source.returns, 1);
    assert.equal(shelf.items.size, 0);
  } finally { await shelf.dispose(); }
});

test('stream poll validation rejects invalid waitMs and stream IDs without consuming the source', TEST, async t => {
  const f = await resident(t), peer = await f.client();
  const id = await open(peer, 'session/control');
  for (const waitMs of [0, -1, 25001, 1.5, null, '100', {}, []]) {
    await assert.rejects(peer.request('next', { streamId: id, waitMs }), code('INVALID_REQUEST'));
  }
  for (const streamId of [null, '', 1, {}, []]) {
    await assert.rejects(peer.request('next', { streamId, waitMs: 1 }), code('INVALID_REQUEST'));
  }
  assert.equal(f.runtime.opens.at(-1).source.reads, 0);
  f.runtime.opens.at(-1).source.push({ stillUsable: true });
  assert.deepEqual((await next(peer, id)).items, [{ stillUsable: true }]);
});

test('a disposed StreamShelf refuses new factories and aborted opening does not poison the remaining cap', TEST, async () => {
  const shelf = new StreamShelf({ max: 1 });
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const factory = signal => { calls++; return queue(signal); };
  await assert.rejects(shelf.open(factory, controller.signal), error => error.name === 'AbortError' || error.code === 'CANCELLED');
  assert.equal(calls, 0);
  const id = await shelf.open(factory);
  assert.equal(calls, 1);
  await shelf.close(id); await shelf.dispose();
  await assert.rejects(shelf.open(factory), code('TRANSPORT_LOST'));
  assert.equal(calls, 1);
});

test('StreamShelf propagates caller cancellation while its asynchronous factory is still opening', TEST, async () => {
  const shelf = new StreamShelf(), entered = deferred(), release = deferred();
  const controller = new AbortController();
  let lifetime;
  const opening = shelf.open(async signal => {
    lifetime = signal; entered.resolve();
    await release.promise;
    return queue(signal);
  }, controller.signal);
  // Attach the rejection observer before triggering cancellation.
  const rejected = assert.rejects(opening, error => error.name === 'AbortError' || error.code === 'CANCELLED');
  try {
    await entered.promise;
    controller.abort();
    await turn();
    const cancelledBeforeFactoryReturn = lifetime.aborted;
    release.resolve(); await rejected;
    assert.equal(cancelledBeforeFactoryReturn, true,
      'open cancellation must reach a blocked Gateway factory before it returns');
  } finally { release.resolve(); await shelf.dispose(); }
});

test('StreamShelf disposal during opening rejects the late stream and returns its iterator', TEST, async () => {
  const shelf = new StreamShelf(), entered = deferred(), release = deferred(), returned = deferred();
  let source;
  const opening = shelf.open(async signal => {
    entered.resolve(); await release.promise;
    source = queue(signal);
    const cleanup = source.return.bind(source);
    source.return = async () => { const value = await cleanup(); returned.resolve(); return value; };
    return source;
  });
  const settled = opening.then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise;
    await shelf.dispose();
    release.resolve();
    const result = await settled;
    assert.ok(result.error, 'disposed shelf must not return a streamId already absent from its map');
    await within(returned.promise, 'late-created iterator return cleanup');
    assert.equal(source.returns, 1, 'late-created iterator still needs return() cleanup');
    assert.equal(shelf.items.size, 0);
  } finally { release.resolve(); await shelf.dispose(); await source?.return(); }
});

test('real companion enforces per-client stream cap without exhausting another client', TEST, async t => {
  const f = await resident(t), a = await f.client(), b = await f.client();
  const ids = [];
  for (let i = 0; i < LIMITS.streams; i++) ids.push(await open(a, 'session/control'));
  await assert.rejects(open(a, 'session/control'), code('BUSY'));
  const other = await open(b, 'session/control');
  assert.ok(other);
  await a.request('close', { streamId: ids[0] });
  assert.ok(await open(a, 'session/control'));
  const sources = f.runtime.opens.map(row => row.source.stopped);
  a.close(); b.close();
  await within(Promise.all(sources), 'all capped-client streams detached');
});

test('silent orphan carriers expire and release capacity without cancelling resident work', TEST, async t => {
  const f = await resident(t, { maxClients: 1, idleMs: 50 }), first = await f.client();
  await call(first, 'session/prompt', [PROMPT]);
  await within(first.done, 'idle transport expiry');
  assert.equal(f.runtime.run.running, true); assert.equal(f.runtime.run.cancelled, 0);
  const second = await f.client();
  assert.equal((await second.request('hello', { protocol: PROTOCOL })).runtimeId, f.runtimeId);
  assert.equal(f.runtime.run.prompts, 1);
});

test('public model selection requires explicit default-change consent before dispatch', TEST, async t => {
  const runtime = publicRuntime();
  runtime.descriptors.set('session/selectModel', { parameters: [{ wire: 'request' }] });
  const client = createRuntimeAdapter(runtime.ctx, { runtimeId: 'fixture' }).client();
  t.after(() => client.dispose());
  await assert.rejects(client.handle('call', { endpoint: 'session/selectModel', values: [{ sessionId: SESSION, provider: 'p', model: 'm' }] }), code('DEFAULT_CHANGE_CONFIRMATION_REQUIRED'));
  assert.equal(runtime.calls.length, 0);
  await assert.rejects(client.handle('call', { endpoint: 'session/list', values: [{}], confirmDefaultChange: true }), code('INVALID_REQUEST'));
  assert.equal(runtime.calls.length, 0);
});

test('companion connection cap rejects a new carrier without disrupting an existing client', TEST, async t => {
  const f = await resident(t, { maxClients: 1 }), a = await f.client();
  await a.request('hello', { protocol: PROTOCOL });
  const b = new RpcPeer(await f.raw());
  t.after(() => b.close());
  await assert.rejects(b.request('hello', { protocol: PROTOCOL }), code('TRANSPORT_LOST'));
  assert.equal((await a.request('hello', { protocol: PROTOCOL })).runtimeId, f.runtimeId);
});

test('protocol helpers reject exotic envelopes and redact infrastructure secrets', TEST, () => {
  assert.equal(plain({}), true); assert.equal(plain(Object.create(null)), true);
  for (const value of [null, [], new Date(), new (class {})()]) assert.equal(plain(value), false);
  assert.throws(() => exact({ unexpected: true }, ['allowed']), code('INVALID_REQUEST'));
  const safe = wireError(Object.assign(new Error('/private/token password=secret'), { code: 'VALID_CODE' }));
  assert.equal(safe.code, 'VALID_CODE');
  assert.ok(!JSON.stringify(safe).includes('secret'));
  assert.equal(wireError({ code: 'private/path', message: 'secret' }).code, 'BACKEND_ERROR');
});

const machine = changes => ({ ssh: ['fixture@invalid.example'], socketPath: '/private/fixture/s', remoteNode: '/opt/node/bin/node', ...changes });
function fakeSsh(socketPath, launches) {
  return (command, args, options) => {
    launches.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = [];
    const socket = net.connect(socketPath);
    socket.on('error', error => child.emit('error', error));
    socket.on('connect', () => { child.stdin.pipe(socket); socket.pipe(child.stdout); });
    socket.on('close', () => { child.stdout.end(); child.emit('exit', 0); });
    child.kill = signal => { child.kills.push(signal); socket.destroy(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); return true; };
    launches.at(-1).child = child;
    return child;
  };
}

test('SSH configuration quotes remote code/path and forces noninteractive strict transport options', TEST, () => {
  assert.equal(shellQuote("a'b c"), "'a'\\''b c'");
  const value = machine({ remoteNode: "/opt/Node's bin/node", socketPath: "/private/runtime's dir/s" });
  const args = validateSsh(value);
  assert.equal(args[0], '-T');
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ConnectTimeout=15']) {
    const index = args.indexOf(option);
    assert.ok(index > 0 && index < args.indexOf('fixture@invalid.example'), 'strict option precedes operator argv: ' + option);
    assert.equal(args[index - 1], '-o');
  }
  assert.equal(args.at(-2), 'fixture@invalid.example');
  assert.equal(args.at(-1), shellQuote(value.remoteNode) + ' -e ' + shellQuote(RELAY) + ' ' + shellQuote(value.socketPath));
  for (const ssh of [[], 'host', [''], ['host\ncommand'], ['nul\0host'], [7]]) assert.throws(() => validateSsh(machine({ ssh })), code('INVALID_SSH'));
  for (const socketPath of ['relative', '/a/../b', '/a/./b', '/nul\0', '/line\n', '/' + 'x'.repeat(100)]) assert.throws(() => validateSsh(machine({ socketPath })), code('INVALID_SOCKET_PATH'));
  for (const remoteNode of ['node', '/nul\0', '/line\n', '/line\r', null]) assert.throws(() => validateSsh(machine({ remoteNode })), code('INVALID_REMOTE_NODE'));
});

test('injected SSH carrier uses real framed Unix transport and never reconnects or replays by itself', TEST, async t => {
  const f = await resident(t), launches = [];
  const spawnProcess = fakeSsh(f.socketPath, launches);
  const a = await connectSsh(machine({ socketPath: f.socketPath }), { spawnProcess });
  t.after(() => a.close());
  assert.equal(launches.length, 1); assert.equal(launches[0].command, 'ssh');
  assert.deepEqual(launches[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(a.hello.runtimeId, f.runtimeId);
  await call(a.peer, 'session/prompt', [PROMPT]);
  launches[0].child.emit('exit', 255);
  await within(a.peer.done, 'simulated SSH exit');
  assert.equal(f.runtime.run.running, true);
  assert.equal(launches.length, 1, 'no reconnect is initiated on transport exit');
  await assert.rejects(call(a.peer, 'session/prompt', [PROMPT]), code('TRANSPORT_LOST'));
  assert.equal(f.runtime.run.prompts, 1);
  const b = await connectSsh(machine({ socketPath: f.socketPath }), { spawnProcess });
  t.after(() => b.close());
  assert.equal(launches.length, 2, 'only an explicit second connect creates another child');
  assert.deepEqual(b.hello, a.hello);
  assert.equal(f.runtime.run.prompts, 1);
  a.close(); b.close();
  assert.ok(launches.every(row => row.child.kills.includes('SIGTERM')));
  assert.equal(f.runtime.run.cancelled, 0);
});

test('SSH handshake failures and startup errors kill only the injected relay and redact stderr', TEST, async t => {
  const wrong = await resident(t, { adapter: { client() {
    return { handle: async () => ({ protocol: 'unexpected/1', runtimeId: 'r', instanceId: 'i', capabilities: [] }), dispose: async () => {} };
  } } });
  const launches = [];
  await assert.rejects(connectSsh(machine({ socketPath: wrong.socketPath }), { spawnProcess: fakeSsh(wrong.socketPath, launches) }), code('INCOMPATIBLE_PROTOCOL'));
  assert.ok(launches[0].child.kills.includes('SIGTERM'));
  const f = await resident(t), errors = [];
  const spawn = fakeSsh(f.socketPath, errors);
  await assert.rejects(connectSsh(machine({ socketPath: f.socketPath }), { spawnProcess(...args) {
    const child = spawn(...args);
    child.stderr.write('private ssh-key path and password=secret');
    queueMicrotask(() => child.emit('error', new Error('private ssh-key path and password=secret')));
    return child;
  } }), error => error.code === 'SSH_FAILED' && !error.message.includes('secret'));
  assert.ok(errors[0].child.kills.includes('SIGTERM'));
  assert.equal(f.runtime.run.cancelled, 0);
});

test('an already-aborted SSH request never spawns a child', TEST, async () => {
  const controller = new AbortController(); controller.abort();
  let spawned = false;
  await assert.rejects(connectSsh(machine(), { signal: controller.signal, spawnProcess() { spawned = true; } }), { name: 'AbortError' });
  assert.equal(spawned, false);
});
