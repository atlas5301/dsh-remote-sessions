/**
 * Run: node --test dsh-remote-sessions/test/native-carrier.test.js
 * Uses real native-remote.js imports and Node's built-in test runner only.
 * Every socket is loopback. subprocess.spawn is an inert Cordis-shaped mock
 * owning an in-process fake runtime on the requested forward port; sshExchange
 * returns fixture log text. No SSH, child process, live GUI, remote host, package
 * dependency, copied carrier implementation, or filesystem mutation is used.
 * effect factories execute eagerly and retain returned disposers; web register
 * and registerUpgrade return synchronous disposers; admit returns {peer} or
 * {rejection}. This tests carrier behavior, not real SSH/Cordis authentication.
 * Graph fixtures use the actual __DSH_BOOT__ native wire schema and rendered
 * global syntax from dsh-host-webserver/dsh-client-modules.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  augmentGraph, composeRemoteIndex, forwardedHeaders, graphEvents,
  installNativeRemote, machineIdentity, mountPath, remotePath, responseHeaders,
} from '../lib/native-remote.js'

const WRAPPER = 'dsh-remote-sessions-wrapper'
const wrapperBytes = readFileSync(new URL('../lib/remote-ui.js', import.meta.url))
const wrapperRev = createHash('sha256').update(wrapperBytes).digest('hex').slice(0, 12)
const TOKEN = 'fixture_runtime_token_not_for_browser'
const REMOTE_COOKIE = 'dsh_runtime=fixture_host_only_secret'
const BROWSER_COOKIE = 'host_session=fixture_browser; private_local_cookie=never_forward'
const HOST_HEADERS = { host: 'local.browser.test', origin: 'http://local.browser.test', cookie: BROWSER_COOKIE }
const machine = (changes = {}) => ({
  name: 'fixture', command: 'inert-fixture-ssh', ssh: ['fixture@invalid.example'],
  env: { FIXTURE_ENV: 'no-process-executed' }, disposeGraceMs: 17,
  web: { remotePort: 8420, logPath: "~/fixture runtime's.log" }, ...changes,
})
const identity = machineIdentity(machine())
const mount = mountPath('fixture', identity)
const copy = value => structuredClone(value)
function graph(rev = 'native-fixture-1') {
  return { rev, entries: [
    { id: '@deepseek-ai/dsh-client-modules', url: '/plugins/combo/bootstrap.js?rev=bootstrap-1', rev: 'bootstrap-1', immediately: true },
    { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/combo/application.js?rev=application-1', rev: 'application-1', immediately: true },
    { id: '@deepseek-ai/dsh-client-ui-workspace', url: '/plugins/combo/application.js?rev=application-1', rev: 'application-1', inject: ['connection'], external: ['react'], immediately: false },
  ], batches: [
    { phase: 'bootstrap', url: '/plugins/combo/bootstrap.js?rev=bootstrap-1', rev: 'bootstrap-1', entries: ['@deepseek-ai/dsh-client-modules'] },
    { phase: 'application', url: '/plugins/combo/application.js?rev=application-1', rev: 'application-1', entries: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-workspace'] },
  ] }
}
function index(value = graph()) {
  return Buffer.from('<!doctype html><html><head><meta charset="utf-8"><script>globalThis["__DSH_BOOT__"] = ' +
    JSON.stringify(value).replaceAll('<', '\\u003c') + '</script>' +
    '<script>globalThis.fixtureBoundaryAtNativeBoot = globalThis.__DSH_REMOTE_HOST__?.identity;</script>' +
    '</head><body><main>原生 remote 🌍</main><script type="module" src="/assets/native-shell.js"></script></body></html>')
}
function executeIndex(bytes, id = identity) {
  class Storage {
    #values = new Map()
    get length() { return this.#values.size }
    getItem(key) { return this.#values.get(String(key)) ?? null }
    setItem(key, value) { this.#values.set(String(key), String(value)) }
    removeItem(key) { this.#values.delete(String(key)) }
    key(offset) { return [...this.#values.keys()][offset] ?? null }
    clear() { this.#values.clear() }
  }
  class XMLHttpRequest { open() {} }
  class Element { setAttribute() {} }
  const context = vm.createContext({
    URL, URLSearchParams, Request, Storage, XMLHttpRequest, Element,
    localStorage: new Storage(), sessionStorage: new Storage(), navigator: {},
    location: { href: 'http://local.browser.test' + mountPath('fixture', id) + '?workspace=%2Fremote%2Fworkspace' },
    document: { baseURI: 'http://local.browser.test' + mountPath('fixture', id), addEventListener() {} },
    fetch: async () => { throw new Error('Fixture inline scripts must not fetch') },
    addEventListener() {}, dispatchEvent() {},
  })
  vm.runInContext('window = globalThis', context)
  for (const match of bytes.toString().matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc\s*=/.test(match[1])) vm.runInContext(match[2], context, { timeout: 1000 })
  }
  return context
}
function assertWrapper(value, original) {
  assert.deepEqual(value.entries.slice(0, -1), original.entries)
  assert.deepEqual(value.batches.slice(0, -1), original.batches)
  assert.equal(value.entries.filter(entry => entry.id === WRAPPER).length, 1)
  assert.deepEqual(value.entries.at(-1), { id: WRAPPER, rev: wrapperRev, url: '_wrapper.js?rev=' + wrapperRev,
    external: ['react', 'react-dom'], inject: ['@deepseek-ai/dsh-client-ui-workspace'], immediately: true })
  assert.deepEqual(value.batches.at(-1), { phase: 'application', rev: wrapperRev, url: '_wrapper.js?rev=' + wrapperRev, entries: [WRAPPER] })
  assert.equal(value.rev, original.rev)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function within(promise, label, ms = 3000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out: ' + label)), ms)
  })]) } finally { clearTimeout(timer) }
}
async function eventBytes(chunks) {
  const result = []
  await pipeline(Readable.from(chunks), graphEvents(), new Writable({
    write(chunk, encoding, done) { result.push(Buffer.from(chunk)); done() },
  }))
  return Buffer.concat(result)
}
function dataEvents(bytes) {
  return bytes.toString().split(/\r?\n\r?\n/).filter(Boolean).flatMap(frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart())
    return data.length ? [JSON.parse(data.join('\n'))] : []
  })
}
function trackSockets(server) {
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  return sockets
}
async function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy()
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function fixture(t, options = {}) {
  const routes = new Map(), prefixes = new Map(), upgrades = new Map()
  const effects = [], children = [], runtimeRequests = [], hostRequests = [], exchanges = [], errors = [], handlers = new Set()
  const exchangeStarted = deferred(), registry = { machines: [machine()] }
  let disposed = false
  function register(table, route) {
    assert.equal(typeof route.path, 'string'); assert.equal(typeof route.handler, 'function')
    assert.ok(!table.has(route.path), 'Duplicate route: ' + route.path)
    table.set(route.path, route)
    let active = true
    return () => { if (active) { active = false; table.delete(route.path) } }
  }
  const webServer = {
    register(route) { assert.ok(['exact', 'prefix'].includes(route.kind)); return register(route.kind === 'exact' ? routes : prefixes, route) },
    registerUpgrade(route) { return register(upgrades, route) },
  }
  const connection = { admit(req) {
    if (req.headers.host !== HOST_HEADERS.host || req.headers.origin !== HOST_HEADERS.origin) return { rejection: 403 }
    return String(req.headers.cookie ?? '').split(';').some(part => part.trim() === 'host_session=fixture_browser')
      ? { peer: { id: 'fixture-operator', kind: 'operator' } } : { rejection: 401 }
  } }
  const services = { webServer, connection }
  function effect(factory, label) {
    assert.equal(typeof factory, 'function')
    const cleanup = factory()
    assert.equal(typeof cleanup, 'function', 'Effect must return disposer: ' + label)
    let active = true
    const dispose = () => { if (active) { active = false; return cleanup() } }
    effects.push({ label, dispose }); return dispose
  }
  const inner = { effect, get(name) { assert.ok(name in services, 'Unexpected service: ' + name); return services[name] } }
  function runHandler(handler, ...args) {
    const pending = Promise.resolve().then(() => handler(...args)).catch(error => {
      errors.push(error)
      const res = args[1]
      if (res instanceof http.ServerResponse && !res.destroyed && !res.writableEnded) { res.writeHead(500); res.end(String(error)) }
      else res?.destroy?.()
    }).finally(() => handlers.delete(pending))
    handlers.add(pending)
  }
  const host = http.createServer((req, res) => {
    const closed = deferred(); res.once('close', () => closed.resolve())
    hostRequests.push({ req, res, closed: closed.promise })
    const path = new URL(req.url, 'http://fixture.invalid').pathname
    const route = routes.get(path) ?? [...prefixes.values()].find(row => path.startsWith(row.path))
    if (route) runHandler(route.handler, req, res)
    else { res.writeHead(404); res.end('no fixture route') }
  })
  const hostSockets = trackSockets(host)
  host.on('upgrade', (req, socket, head) => {
    const closed = deferred(), ended = deferred()
    socket.once('close', () => closed.resolve()); socket.once('end', () => ended.resolve())
    hostRequests.push({ req, res: socket, closed: closed.promise, ended: ended.promise })
    const route = upgrades.get(new URL(req.url, 'http://fixture.invalid').pathname)
    if (route) runHandler(route.handler, req, socket, head)
    else socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
  })
  const ctx = {
    effect, get: inner.get,
    inject(dependencies, callback) { assert.ok(Array.isArray(dependencies)); for (const name of dependencies) assert.ok(name in services); return callback(inner) },
    subprocess: { spawn(spec) {
      assert.ok(Array.isArray(spec.argv)); assert.equal(spec.argv[0], 'inert-fixture-ssh')
      assert.ok(spec.argv.includes('-N'), 'Attach may only forward, never execute a runtime command')
      const offset = spec.argv.indexOf('-L'); assert.notEqual(offset, -1)
      const forward = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:8420$/.exec(spec.argv[offset + 1])
      assert.ok(forward, 'Only requested loopback forward allowed')
      const target = registry.machines.find(row => row.command === spec.argv[0])
      assert.deepEqual(spec.argv.slice(offset + 2), target.ssh); assert.deepEqual(spec.env, target.env)
      assert.equal(spec.cwd, process.cwd())
      assert.deepEqual(spec.stdio, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }); assert.equal(spec.graceMs, 17)
      const exit = deferred()
      const runtime = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        const record = { method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks) }
        runtimeRequests.push(record)
        if (req.url === '/?token=' + TOKEN) {
          res.writeHead(303, { location: '/', 'set-cookie': [REMOTE_COOKIE + '; HttpOnly; SameSite=Strict; Path=/'] }); res.end(); return
        }
        if (req.headers.cookie !== REMOTE_COOKIE) { res.writeHead(401); res.end('runtime auth required'); return }
        const path = new URL(req.url, 'http://runtime.invalid').pathname
        if (req.method === 'GET' && ['/', '/index.html'].includes(path)) {
          const bytes = options.index ?? index()
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': bytes.length,
            etag: '"remote-index-etag"', 'cache-control': 'public, max-age=3600',
            ...(options.csp ? { 'content-security-policy': options.csp } : {}) })
          res.end(bytes); return
        }
        if (path === '/plugins/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          for (const chunk of options.events ?? []) res.write(chunk)
          res.end(); return
        }
        if (path === '/redirect') {
          res.writeHead(302, { location: '../api/native?x=one%2Btwo#section', 'set-cookie': ['private_runtime=do_not_leak'] }); res.end(); return
        }
        const bytes = req.method === 'POST' ? record.body : (options.nativeResponse ?? Buffer.from('{"native":"unchanged","unicode":"会话🌍"}\n'))
        res.writeHead(options.nativeStatus ?? 201, { 'content-type': req.headers['content-type'] ?? 'application/json; charset=utf-8',
          'content-length': bytes.length, 'x-native-runtime': 'fixture-only', 'set-cookie': ['private_runtime=do_not_leak'],
          ...(options.nativeCsp ? { 'content-security-policy': options.nativeCsp } : {}) })
        res.end(bytes)
      })
      const sockets = trackSockets(runtime)
      runtime.on('upgrade', (req, socket, head) => {
        runtimeRequests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.alloc(0), websocket: true })
        if (req.headers.cookie !== REMOTE_COOKIE) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
        const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        const greeting = options.remoteHead ?? Buffer.from([0x82, 0x02, 0x00, 0xff])
        socket.write(Buffer.concat([Buffer.from('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' + accept + '\r\nSet-Cookie: never_forward=runtime_ws\r\n\r\n'), greeting]))
        if (head.length) socket.write(head)
        socket.on('data', bytes => socket.write(bytes))
      })
      const child = { spec, runtime, sockets, done: exit.promise, terminateCalls: 0, terminated: false,
        terminate() {
          this.terminateCalls++
          if (!this.terminated) {
            this.terminated = true; for (const socket of sockets) socket.destroy()
            runtime.close(() => {}); exit.resolve({ exitCode: 0, signal: null })
          }
          return this.done
        },
      }
      children.push(child); runtime.listen(Number(forward[1]), '127.0.0.1')
      runtime.on('error', error => { errors.push(error); exit.reject(error) })
      return child
    } },
  }
  // Injectable collaborator's auth fence mirrors real index.js registerRoutes.
  const registerRoutes = (owner, rows) => owner.inject(['webServer', 'connection'], context => {
    const disposers = rows.map(route => context.get('webServer').register({ ...route, async handler(req, res) {
      const admission = context.get('connection').admit(req)
      if ('rejection' in admission) {
        res.writeHead(admission.rejection, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: 'request not admitted' })); return
      }
      return route.handler(req, res)
    } }))
    return context.effect(() => () => { for (const dispose of disposers) dispose() }, 'fixture.register-routes')
  })
  installNativeRemote(ctx, registry, { registerRoutes, async sshExchange(owner, target, command, input, signal) {
    assert.equal(owner, ctx); assert.ok(registry.machines.includes(target)); assert.equal(input, undefined)
    assert.match(command, /^grep 'dsh web:'/)
    assert.doesNotMatch(command, /(?:^|[;&|\s])(?:nohup|pkill|kill|systemctl|dsh\s+web)(?:\s|$)/)
    assert.ok(signal instanceof AbortSignal, 'Token lookup must have lifetime signal')
    exchanges.push({ target, command, input, signal }); exchangeStarted.resolve()
    if (options.exchangeGate) await options.exchangeGate.promise
    return 'dsh web: http://127.0.0.1:8420/?token=' + TOKEN
  } })
  host.listen(0, '127.0.0.1'); await once(host, 'listening')
  const port = host.address().port
  async function dispose() {
    if (disposed) return
    disposed = true
    const transports = effects.find(row => row.label === 'remote-sessions.native-transports')
    if (transports) await transports.dispose()
    for (const row of [...effects].reverse()) await row.dispose()
  }
  t.after(async () => {
    options.exchangeGate?.resolve(); await dispose()
    for (const child of children) { child.terminate(); await closeServer(child.runtime, child.sockets) }
    await closeServer(host, hostSockets)
    await within(Promise.all([...handlers]), 'fixture handlers settle')
    assert.deepEqual(errors, [], 'Fixture failure must not mask carrier behavior')
  })
  function request(path, { method = 'GET', body, headers = {} } = {}) {
    let req
    const completed = new Promise((resolve, reject) => {
      req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { ...HOST_HEADERS, ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject)
        res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.once('error', reject); req.end(body)
    })
    completed.catch(() => {}) // Cancellation tests reject before awaiting.
    return { req, completed }
  }
  const fetch = (path, options) => within(request(path, options).completed, 'fixture HTTP ' + path)
  return { ctx, registry, port, upgrades, children, runtimeRequests, hostRequests, exchanges, exchangeStarted,
    request, fetch, dispose, prepare: () => fetch('/remote-sessions/prepare?machine=fixture', { method: 'POST' }),
    drain: () => within(Promise.all([...handlers]), 'fixture active handlers') }
}
async function rawUpgrade(t, harness, path, { headers = {}, head = Buffer.alloc(0) } = {}) {
  const socket = net.connect({ host: '127.0.0.1', port: harness.port }); t.after(() => socket.destroy())
  await within(once(socket, 'connect'), 'raw WS connect')
  const chunks = [], closed = deferred(), changed = new Set(); let error
  socket.on('data', chunk => { chunks.push(Buffer.from(chunk)); for (const notify of changed) notify() })
  socket.once('close', () => { closed.resolve(); for (const notify of changed) notify() })
  socket.on('error', failure => { error = failure; for (const notify of changed) notify() })
  const requestHeaders = { ...HOST_HEADERS, connection: 'Upgrade', upgrade: 'websocket',
    'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers }
  socket.write(Buffer.concat([Buffer.from('GET ' + path + ' HTTP/1.1\r\n' +
    Object.entries(requestHeaders).filter(([, value]) => value !== undefined).map(([key, value]) => key + ': ' + value + '\r\n').join('') + '\r\n'), head]))
  async function readUntil(predicate) {
    const ready = deferred()
    const check = () => {
      const bytes = Buffer.concat(chunks)
      if (predicate(bytes)) ready.resolve(bytes)
      else if (error) ready.reject(error)
      else if (socket.destroyed) ready.reject(new Error('Socket closed before expected bytes: ' + bytes.toString('latin1')))
    }
    changed.add(check)
    try { check(); return await within(ready.promise, 'raw WS bytes') } finally { changed.delete(check) }
  }
  const bytes = await readUntil(value => value.includes(Buffer.from('\r\n\r\n')))
  const boundary = bytes.indexOf(Buffer.from('\r\n\r\n')) + 4
  return { socket, closed: closed.promise, boundary, readUntil, handshake: bytes.subarray(0, boundary).toString('latin1') }
}

test('mounts and machine identity pin SSH authority, env, revision and port', () => {
  assert.match(identity, /^[a-f0-9]{20}$/)
  assert.equal(machineIdentity(machine({ env: { b: 'two', a: 'one' } })), machineIdentity(machine({ env: { a: 'one', b: 'two' } })))
  for (const changes of [{ command: 'other' }, { ssh: ['other@invalid.example'] }, { env: { FIXTURE_ENV: 'changed' } }, { web: { remotePort: 8421 } }, { authorityRevision: 'rotated-key' }]) assert.notEqual(machineIdentity(machine(changes)), identity)
  assert.equal(mount, '/remote-sessions/native/fixture/' + identity + '/')
  for (const name of ['', '../bad', 'bad/name', 'bad name', '中文']) assert.throws(() => mountPath(name, identity))
  for (const id of ['', 'a'.repeat(19), 'A'.repeat(20), 'g'.repeat(20), '../' + identity]) assert.throws(() => mountPath('fixture', id))
})
test('remotePath preserves query encoding and rejects traversal, nested mounts and tokens', () => {
  assert.equal(remotePath(mount + '?workspace=%2Fremote%2F会话&x=a%2Bb', mount), '/?workspace=%2Fremote%2F%E4%BC%9A%E8%AF%9D&x=a%2Bb')
  assert.equal(remotePath(mount + 'api/native?repeated=1&repeated=2&blob=%00%FF', mount), '/api/native?repeated=1&repeated=2&blob=%00%FF')
  for (const suffix of ['../api', './api', 'a/%2e%2e/b', '%2E/api', '%2fapi', 'a%5Cb', 'a%00b', 'remote-sessions/native/other/api', 'api?token=secret', 'api?%74oken=secret', '%E0%A4%A']) assert.throws(() => remotePath(mount + suffix, mount), undefined, suffix)
  assert.throws(() => remotePath('/api/native', mount))
})
test('forwarded headers isolate local credentials/hop headers and preserve native entity metadata', () => {
  assert.deepEqual(forwardedHeaders({ host: 'local', origin: 'http://local', cookie: BROWSER_COOKIE,
    authorization: 'Bearer local', referer: 'http://local/?token=local', 'accept-encoding': 'gzip',
    connection: 'Keep-Alive, X-Nominated', 'x-nominated': 'drop', 'keep-alive': 'timeout=5',
    'proxy-authorization': 'secret', te: 'trailers', trailer: 'x', upgrade: 'websocket',
    'sec-fetch-site': 'same-origin', 'x-forwarded-for': 'local', 'x-forwarded-host': 'local',
    'content-type': 'multipart/form-data; boundary=EXACT', 'content-length': '123',
    'x-native-metadata': 'untouched', 'sec-websocket-key': 'native-key', missing: undefined,
  }, 12345, REMOTE_COOKIE), { 'content-type': 'multipart/form-data; boundary=EXACT', 'content-length': '123',
    'x-native-metadata': 'untouched', 'sec-websocket-key': 'native-key', host: '127.0.0.1:12345',
    origin: 'http://127.0.0.1:12345', cookie: REMOTE_COOKIE, 'accept-encoding': 'identity' })
  const ws = forwardedHeaders({ connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-protocol': 'dsh.remote' }, 12345, REMOTE_COOKIE, true)
  assert.equal(ws.connection, 'Upgrade'); assert.equal(ws.upgrade, 'websocket'); assert.equal(ws['sec-websocket-protocol'], 'dsh.remote')
})
test('response headers preserve native CSP, drop secrets/hop headers and safely remount redirects', () => {
  const csp = "default-src 'self'; script-src 'sha256-native'; object-src 'none'"
  assert.deepEqual(responseHeaders({ connection: 'X-Nominated', 'x-nominated': 'drop', 'set-cookie': ['secret'],
    'content-security-policy': csp, 'content-type': 'application/octet-stream', 'content-length': '8', etag: '"native-etag"', location: '../download?x=a%2Bb#part',
  }, mount, false, '/api/items'), { 'content-security-policy': csp, 'content-type': 'application/octet-stream',
    'content-length': '8', etag: '"native-etag"', location: mount + 'download?x=a%2Bb#part', 'referrer-policy': 'no-referrer' })
  for (const location of ['https://outside.invalid/file', '//outside.invalid/file', 'http://127.0.0.1:8420/?token=secret', '/?token=secret', '/?%74oken=secret', 'javascript:alert(1)']) assert.equal(responseHeaders({ location }, mount).location, undefined, location)
  assert.equal(responseHeaders({ location: '/api/native' }, mount).location, mount + 'api/native')
  assert.deepEqual(responseHeaders({ 'sec-websocket-accept': 'native', 'set-cookie': ['secret'], connection: 'Upgrade', upgrade: 'websocket' }, mount, true), {
    'sec-websocket-accept': 'native', connection: 'Upgrade', upgrade: 'websocket', 'referrer-policy': 'no-referrer' })
})
test('augmentGraph preserves supported graph and appends exactly one wrapper batch', () => {
  const original = graph(); assertWrapper(augmentGraph(copy(original)), original)
})
test('composeRemoteIndex executes known native global and scopes authority before boot', () => {
  const original = graph(), output = composeRemoteIndex(index(original), { name: 'fixture', identity })
  assert.ok(Buffer.isBuffer(output)); assert.ok(output.toString().endsWith('</head><body><main>原生 remote 🌍</main><script type="module" src="/assets/native-shell.js"></script></body></html>'))
  const context = executeIndex(output)
  assert.equal(context.fixtureBoundaryAtNativeBoot, identity); assert.equal(context.__DSH_REMOTE_HOST__.mount, mount)
  assertWrapper(JSON.parse(JSON.stringify(context.__DSH_BOOT__)), original)
  context.localStorage.setItem('native-workspace', 'remote')
  assert.equal(context.localStorage.getItem('native-workspace'), 'remote'); assert.equal(context.localStorage.key(0), 'native-workspace')
  assert.ok(!output.includes(Buffer.from(TOKEN))); assert.ok(!output.includes(Buffer.from(REMOTE_COOKIE)))
})
const malformed = [
  ['missing graph rev', value => { delete value.rev }], ['non-string graph rev', value => { value.rev = 1 }],
  ['null entry', value => { value.entries[0] = null }], ['missing entry id', value => { delete value.entries[0].id }],
  ['non-string entry url', value => { value.entries[0].url = 3 }], ['non-string entry rev', value => { value.entries[0].rev = null }],
  ['bad optional inject', value => { value.entries[0].inject = ['connection', 7] }], ['bad optional external', value => { value.entries[0].external = 'react' }],
  ['bad optional immediately', value => { value.entries[0].immediately = 'true' }], ['duplicate native ID', value => { value.entries[1].id = value.entries[0].id }],
  ['wrapper ID collision', value => { value.entries[1].id = WRAPPER; value.batches[1].entries[0] = WRAPPER }],
  ['null batch', value => { value.batches[0] = null }], ['unsupported batch phase', value => { value.batches[0].phase = 'before-shell' }],
  ['non-string batch url', value => { value.batches[0].url = 1 }], ['non-string batch rev', value => { value.batches[0].rev = false }],
  ['duplicate batch url', value => { value.batches[1].url = value.batches[0].url }], ['empty batch entries', value => { value.batches[0].entries = [] }],
  ['non-array batch entries', value => { value.batches[0].entries = 'native-entry' }], ['unknown batch ID', value => { value.batches[0].entries = ['missing-native-entry'] }],
  ['ID in multiple batches', value => { value.batches[1].entries.push(value.entries[0].id) }], ['unbatched ID', value => { value.batches.pop() }],
  ['wrapper batch URL collision', value => { value.batches[1].url = '_wrapper.js?rev=' + wrapperRev }],
]
for (const [label, change] of malformed) test('reject malformed supported graph before mutation: ' + label, () => {
  const value = graph(); change(value); const before = copy(value)
  assert.throws(() => augmentGraph(value), undefined, 'Accepted malformed graph: ' + label)
  assert.deepEqual(value, before, 'Rejected graph must not be partially modified')
  assert.throws(() => composeRemoteIndex(index(before), { name: 'fixture', identity }), undefined, 'Index accepted: ' + label)
})
test('compose rejects non-native HTML and missing/decoy known graph assignments', () => {
  for (const html of ['<html><head></head><body>not DSH</body></html>', '<html><head><!-- __DSH_BOOT__ is a comment --></head></html>',
    '<html><head><script>globalThis["__DSH_BOOT__"] = null</script></head></html>',
    '<html><head><script>globalThis["OTHER_BOOT"] = {entries:[],batches:[]};</script></head><body>__DSH_BOOT__</body></html>']) assert.throws(() => composeRemoteIndex(Buffer.from(html), { name: 'fixture', identity }))
})
test('SSE preserves split UTF8 ordinary events and adds wrapper on every HMR graph', async () => {
  const ordinary = { type: 'reload', description: '会话🌍 café' }, first = graph('hmr-1'), second = graph('hmr-2')
  const input = Buffer.from(': keepalive\n\ndata: ' + JSON.stringify(ordinary) + '\n\ndata: ' +
    JSON.stringify({ type: 'graph', graph: first, description: '原生🌍' }) + '\n\ndata: ' + JSON.stringify({ type: 'graph', graph: second }) + '\n\n')
  const output = await eventBytes([...input].map(byte => Buffer.from([byte])))
  const ordinaryBytes = Buffer.from(': keepalive\n\ndata: ' + JSON.stringify(ordinary) + '\n\n')
  assert.deepEqual(output.subarray(0, ordinaryBytes.length), ordinaryBytes, 'Non-graph SSE frames must preserve their exact bytes')
  const events = dataEvents(output); assert.deepEqual(events[0], ordinary); assert.equal(events[1].description, '原生🌍')
  assertWrapper(events[1].graph, first); assertWrapper(events[2].graph, second)
})
test('SSE accepts arbitrarily split CRLF graph frames', async () => {
  const original = graph('crlf'), input = Buffer.from('event: plugins\r\ndata: ' + JSON.stringify({ type: 'graph', graph: original }) + '\r\n\r\n')
  const events = dataEvents(await eventBytes([...input].map(byte => Buffer.from([byte]))))
  assert.equal(events.length, 1); assertWrapper(events[0].graph, original)
})
test('SSE fails malformed graphs/collisions instead of forwarding them', async () => {
  const collision = graph(); collision.entries[0].id = WRAPPER
  for (const value of [null, { entries: [], batches: [] }, collision]) await assert.rejects(eventBytes([Buffer.from('data: ' + JSON.stringify({ type: 'graph', graph: value }) + '\n\n')]))
})
test('actual prepare is attach-only and recovered token/cookie stay host-side', async t => {
  const f = await fixture(t); assert.equal(f.children.length, 0)
  const response = await f.prepare(); assert.equal(response.status, 200, response.body.toString())
  assert.deepEqual(JSON.parse(response.body), { path: mount, name: 'fixture', identity, mode: 'remote-runtime' })
  assert.equal(response.headers['set-cookie'], undefined); assert.ok(!response.body.includes(Buffer.from(TOKEN))); assert.ok(!response.body.includes(Buffer.from(REMOTE_COOKIE)))
  assert.equal(f.children.length, 1); assert.equal(f.exchanges.length, 1)
  assert.equal(f.runtimeRequests.filter(req => req.url === '/?token=' + TOKEN).length, 1)
  assert.ok(f.runtimeRequests.some(req => req.url === '/' && req.headers.cookie === REMOTE_COOKIE))
  assert.ok(f.upgrades.has(mount + 'api/remote.mux'))
  assert.equal((await f.prepare()).status, 200); assert.equal(f.children.length, 1); assert.equal(f.exchanges.length, 1)
  await f.dispose(); assert.ok(f.children[0].terminated); assert.equal(f.upgrades.size, 0)
})
test('actual pinned GET ?workspace composes native graph without local mutation', async t => {
  const f = await fixture(t), response = await f.fetch(mount + '?workspace=%2Fremote%2Fworkspace&native=one%2Btwo')
  assert.equal(response.status, 200, response.body.toString())
  assertWrapper(JSON.parse(JSON.stringify(executeIndex(response.body).__DSH_BOOT__)), graph())
  assert.equal(response.headers['content-length'], String(response.body.length)); assert.equal(response.headers.etag, undefined)
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['set-cookie'], undefined)
  assert.ok(f.runtimeRequests.some(req => req.url === '/?workspace=%2Fremote%2Fworkspace&native=one%2Btwo'))
  assert.ok(f.runtimeRequests.every(req => req.method === 'GET'), 'Composition must not create a workspace')
})
test('composition rejects unsupported header/meta CSP instead of weakening policy', () => {
  const csp = "default-src 'self'; script-src 'none'; object-src 'none'"
  assert.throws(() => composeRemoteIndex(index(), { name: 'fixture', identity }, { 'content-security-policy': csp }), /content security policy/)
  for (const meta of [
    '<meta http-equiv="Content-Security-Policy" content="script-src &apos;none&apos;">',
    "<meta content=\"script-src 'none'\" HTTP-EQUIV='content-security-policy'>",
  ]) {
    const bytes = Buffer.from(index().toString().replace('<head>', '<head>' + meta))
    assert.throws(() => composeRemoteIndex(bytes, { name: 'fixture', identity }), /content security policy/)
  }
})
for (const route of ['prepare', 'native GET']) test('unsupported native index CSP fails ' + route + ' closed', async t => {
  // The supported native rc.2 contract has no index CSP. A different policy
  // is an unsupported contract, not permission to remove/weaken remote CSP.
  const f = await fixture(t, { csp: "default-src 'self'; script-src 'none'; object-src 'none'" })
  const response = route === 'prepare' ? await f.prepare() : await f.fetch(mount)
  assert.equal(response.status, 502)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['set-cookie'], undefined)
  assert.ok(!response.body.includes(Buffer.from(TOKEN))); assert.ok(!response.body.includes(Buffer.from(REMOTE_COOKIE)))
  assert.ok(!response.body.includes(Buffer.from('<script>')))
  assert.ok(f.children[0].terminated, 'Unsupported boot contract must close its owned forward')
  assert.equal(f.runtimeRequests.filter(req => req.method !== 'GET').length, 0)
})
test('actual native JSON GET preserves upstream status/bytes and isolates local headers', async t => {
  const bytes = Buffer.from(' { "sessions" : ["会话", "🌍"], "native": true }\r\n')
  const nativeCsp = "default-src 'none'; sandbox"
  const f = await fixture(t, { nativeResponse: bytes, nativeStatus: 206, nativeCsp })
  const response = await f.fetch(mount + 'api/native?cursor=a%2Bb&limit=2', { headers: { authorization: 'Bearer never_forward',
    referer: 'http://local.browser.test/?token=never_forward', 'x-forwarded-for': 'never_forward', 'sec-fetch-site': 'same-origin', 'accept-encoding': 'gzip' } })
  assert.equal(response.status, 206); assert.deepEqual(response.body, bytes); assert.equal(response.headers['content-length'], String(bytes.length))
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(response.headers['content-security-policy'], nativeCsp, 'Unmodified native response must retain its original CSP')
  const upstream = f.runtimeRequests.find(req => req.url === '/api/native?cursor=a%2Bb&limit=2'); assert.ok(upstream)
  assert.equal(upstream.headers.cookie, REMOTE_COOKIE); assert.equal(upstream.headers.host, '127.0.0.1:' + f.children[0].runtime.address().port)
  assert.equal(upstream.headers.origin, 'http://' + upstream.headers.host); assert.equal(upstream.headers['accept-encoding'], 'identity')
  for (const name of ['authorization', 'referer', 'sec-fetch-site', 'x-forwarded-for']) assert.equal(upstream.headers[name], undefined, name)
})
for (const [label, type, bytes] of [
  ['native JSON', 'application/json; charset=utf-8', Buffer.from('{ "input": "会话🌍", "extra": [1,2], "spacing" : true }\n')],
  ['multipart/binary', 'multipart/form-data; boundary=FIXTURE-BYTE-BOUNDARY', Buffer.concat([
    Buffer.from('--FIXTURE-BYTE-BOUNDARY\r\nContent-Disposition: form-data; name="attachment"; filename="raw.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'),
    Buffer.from([0, 255, 128, 13, 10, 0, 195, 169, 0, 1]), Buffer.from('\r\n--FIXTURE-BYTE-BOUNDARY--\r\n'),
  ])],
]) test('actual ' + label + ' POST forwards the exact entity once unchanged', async t => {
  const f = await fixture(t), response = await f.fetch(mount + 'api/native?transaction=native%2Bopaque', {
    method: 'POST', body: bytes, headers: { 'content-type': type, 'content-length': String(bytes.length), 'x-native-meta': 'exact' } })
  assert.equal(response.status, 201, response.body.toString()); assert.deepEqual(response.body, bytes); assert.equal(response.headers['content-type'], type)
  const requests = f.runtimeRequests.filter(req => req.method === 'POST'); assert.equal(requests.length, 1, 'Mutation must never replay')
  assert.equal(requests[0].url, '/api/native?transaction=native%2Bopaque'); assert.equal(requests[0].headers['content-type'], type)
  assert.equal(requests[0].headers['content-length'], String(bytes.length)); assert.equal(requests[0].headers['x-native-meta'], 'exact'); assert.deepEqual(requests[0].body, bytes)
})
test('actual unauthenticated prepare/HTTP/wrapper requests cannot open transport', async t => {
  const f = await fixture(t)
  for (const [path, method] of [['/remote-sessions/prepare?machine=fixture', 'POST'], [mount + 'api/native', 'GET'], [mount + '_wrapper.js', 'GET']]) {
    assert.equal((await f.fetch(path, { method, headers: { cookie: '' } })).status, 401)
    assert.equal((await f.fetch(path, { method, headers: { origin: 'https://foreign.invalid' } })).status, 403)
  }
  assert.equal(f.children.length, 0); assert.equal(f.exchanges.length, 0)
})
test('actual invalid mounts and stale identities fail closed without forwarding', async t => {
  const f = await fixture(t)
  for (const [path, expected] of [[mountPath('missing', identity) + 'api/native', 404], [mountPath('fixture', 'a'.repeat(20)) + 'api/native', 409],
    ['/remote-sessions/native/fixture/not-an-identity/api/native', 404], [mount + 'api/%2e%2e/%2e%2e/native', 400],
    [mount + 'api/native?token=browser_token', 400], [mount + 'api/native?%74oken=browser_token', 400]]) assert.equal((await f.fetch(path)).status, expected, path)
  assert.equal(f.children.length, 0); assert.equal((await f.prepare()).status, 200)
  f.registry.machines = [machine({ authorityRevision: 'changed' })]
  assert.equal((await f.fetch(mount + 'api/native')).status, 409); assert.equal(f.children.length, 1, 'Stale page must not silently switch authority')
})
test('actual wrapper bytes and relative redirects remain safe without leaking cookies', async t => {
  const f = await fixture(t), wrapper = await f.fetch(mount + '_wrapper.js?rev=' + wrapperRev)
  assert.equal(wrapper.status, 200); assert.deepEqual(wrapper.body, wrapperBytes); assert.equal(f.children.length, 0)
  const redirect = await f.fetch(mount + 'redirect')
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.location, mount + 'api/native?x=one%2Btwo#section'); assert.equal(redirect.headers['set-cookie'], undefined)
})
test('actual plugins/events adds wrapper to every native graph refresh', async t => {
  const first = graph('transport-hmr-1'), second = graph('transport-hmr-2')
  const f = await fixture(t, { events: [Buffer.from('data: ' + JSON.stringify({ type: 'graph', graph: first }) + '\n\n'),
    Buffer.from('data: ' + JSON.stringify({ type: 'graph', graph: second }) + '\n\n')] })
  const response = await f.fetch(mount + 'plugins/events'); assert.equal(response.status, 200); assert.equal(response.headers['content-length'], undefined)
  const events = dataEvents(response.body); assert.equal(events.length, 2); assertWrapper(events[0].graph, first); assertWrapper(events[1].graph, second)
})
for (const route of ['prepare', 'native GET']) test('cancelled pending ' + route + ' prevents late token auth', async t => {
  const gate = deferred(), f = await fixture(t, { exchangeGate: gate })
  const pending = f.request(route === 'prepare' ? '/remote-sessions/prepare?machine=fixture' : mount, { method: route === 'prepare' ? 'POST' : 'GET' })
  await within(f.exchangeStarted.promise, 'pending token lookup')
  const closed = new Promise(resolve => pending.req.once('close', resolve))
  pending.req.destroy(); await within(closed, 'browser client close'); await within(f.hostRequests[0].closed, 'carrier host close')
  gate.resolve(); await f.drain()
  assert.equal(f.runtimeRequests.filter(req => req.url === '/?token=' + TOKEN).length, 0, 'Cancelled attach must not authenticate a late token')
  assert.ok(f.exchanges[0].signal.aborted); assert.ok(f.children[0].terminated); await assert.rejects(pending.completed)
})
test('plugin disposal during pending token lookup prevents late token auth', async t => {
  const gate = deferred(), f = await fixture(t, { exchangeGate: gate }), pending = f.request('/remote-sessions/prepare?machine=fixture', { method: 'POST' })
  await within(f.exchangeStarted.promise, 'disposal token lookup'); await f.dispose()
  assert.ok(f.children[0].terminated); assert.ok(f.exchanges[0].signal.aborted)
  gate.resolve(); await f.drain()
  assert.equal((await within(pending.completed, 'disposed prepare')).status, 502)
  assert.equal(f.runtimeRequests.filter(req => req.url === '/?token=' + TOKEN).length, 0); assert.equal(f.upgrades.size, 0)
})
test('cancelled pending raw WS attach prevents late token authentication', async t => {
  const gate = deferred(), f = await fixture(t, { exchangeGate: gate })
  const socket = net.connect({ host: '127.0.0.1', port: f.port }); t.after(() => socket.destroy())
  await within(once(socket, 'connect'), 'pending WS connected')
  socket.write('GET ' + mount + 'api/remote.mux HTTP/1.1\r\nHost: ' + HOST_HEADERS.host +
    '\r\nOrigin: ' + HOST_HEADERS.origin + '\r\nCookie: ' + BROWSER_COOKIE +
    '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
  await within(f.exchangeStarted.promise, 'pending WS token lookup')
  const closed = new Promise(resolve => socket.once('close', resolve)); socket.destroy()
  await within(closed, 'pending WS browser close')
  // Node HTTP upgrade sockets may stay half-open after peer FIN; observe the
  // real EOF, not a fixture-induced socket.destroy() that hides cancellation.
  await within(Promise.race([f.hostRequests[0].closed, f.hostRequests[0].ended]), 'pending WS host EOF')
  gate.resolve(); await f.drain()
  assert.equal(f.runtimeRequests.filter(req => req.url === '/?token=' + TOKEN).length, 0)
  assert.ok(f.exchanges[0].signal.aborted); assert.ok(f.children[0].terminated)
})
test('registry change during pending attach prevents authentication of the old authority', async t => {
  const gate = deferred(), f = await fixture(t, { exchangeGate: gate })
  const pending = f.request('/remote-sessions/prepare?machine=fixture', { method: 'POST' })
  await within(f.exchangeStarted.promise, 'registry pending token lookup')
  f.registry.machines = [machine({ authorityRevision: 'changed-during-token-lookup' })]
  assert.equal(typeof f.registry.reconcileNative, 'function'); f.registry.reconcileNative()
  assert.ok(f.children[0].terminated); assert.ok(f.exchanges[0].signal.aborted)
  gate.resolve(); await f.drain()
  assert.equal((await within(pending.completed, 'changed pending authority')).status, 502)
  assert.equal(f.runtimeRequests.filter(req => req.url === '/?token=' + TOKEN).length, 0)
  assert.equal(f.children.length, 1, 'Reconciliation must not attach a replacement implicitly')
})
test('actual raw WS handshake and initial/stream bytes forward unchanged', async t => {
  const remoteHead = Buffer.from([0x82, 0x03, 0, 255, 127]), head = Buffer.from([0x82, 0x82, 1, 2, 3, 4, 255, 0])
  const f = await fixture(t, { remoteHead }), ws = await rawUpgrade(t, f, mount + 'api/remote.mux', { head })
  assert.match(ws.handshake, /^HTTP\/1\.1 101 Switching Protocols\r\n/)
  assert.match(ws.handshake, /sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i)
  assert.doesNotMatch(ws.handshake, /set-cookie|fixture_host_only_secret|fixture_runtime_token/i)
  let bytes = await ws.readUntil(value => value.length >= ws.boundary + remoteHead.length + head.length)
  assert.deepEqual(bytes.subarray(ws.boundary), Buffer.concat([remoteHead, head]))
  const later = Buffer.from([0x82, 0x83, 4, 3, 2, 1, 0, 255, 128]); ws.socket.write(later)
  bytes = await ws.readUntil(value => value.length >= ws.boundary + remoteHead.length + head.length + later.length)
  assert.deepEqual(bytes.subarray(ws.boundary), Buffer.concat([remoteHead, head, later]))
  const upstream = f.runtimeRequests.find(req => req.websocket)
  assert.equal(upstream.url, '/api/remote.mux'); assert.equal(upstream.headers.cookie, REMOTE_COOKIE); assert.equal(upstream.headers.origin, 'http://' + upstream.headers.host)
  await f.dispose(); await within(ws.closed, 'WS disposal'); assert.ok(f.children[0].terminated)
})
test('actual WS auth and stale authority reject before opening a forward', async t => {
  const f = await fixture(t), unauth = await rawUpgrade(t, f, mount + 'api/remote.mux', { headers: { cookie: '' } })
  assert.match(unauth.handshake, /^HTTP\/1\.1 403 /); assert.equal(f.children.length, 0)
  f.registry.machines = [machine({ authorityRevision: 'new' })]
  const stale = await rawUpgrade(t, f, mount + 'api/remote.mux')
  assert.match(stale.handshake, /^HTTP\/1\.1 409 /); assert.equal(f.children.length, 0)
})
test('registry reconciliation closes owned WS/transport and registers new authority without attaching', async t => {
  const f = await fixture(t), ws = await rawUpgrade(t, f, mount + 'api/remote.mux')
  assert.match(ws.handshake, /^HTTP\/1\.1 101 /)
  assert.equal(typeof f.registry.reconcileNative, 'function', 'Carrier must expose its actual registry hook')
  const next = machine({ authorityRevision: 'rotated' }), nextMount = mountPath(next.name, machineIdentity(next))
  f.registry.machines = [next]; f.registry.reconcileNative()
  assert.ok(f.children[0].terminated); await within(ws.closed, 'reconciled WS closed')
  assert.ok(!f.upgrades.has(mount + 'api/remote.mux')); assert.ok(f.upgrades.has(nextMount + 'api/remote.mux'))
  assert.equal(f.children.length, 1, 'Registry edit must not attach the new authority automatically')
  assert.equal((await f.fetch(mount + 'api/native')).status, 409)
  const response = await f.prepare(); assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).path, nextMount)
  assert.equal(f.children.length, 2)
  const nextWs = await rawUpgrade(t, f, nextMount + 'api/remote.mux')
  assert.match(nextWs.handshake, /^HTTP\/1\.1 101 /)
  assert.equal(f.children.length, 2, 'New authority WS reuses only its new owned forward')
  f.registry.machines = []; f.registry.reconcileNative()
  assert.ok(f.children[1].terminated); await within(nextWs.closed, 'removed authority WS closed')
  assert.equal(f.upgrades.size, 0)
  assert.equal((await f.fetch(nextMount + 'api/native')).status, 404)
  await f.dispose(); assert.equal(f.registry.reconcileNative, undefined)
})
