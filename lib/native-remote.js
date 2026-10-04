/* Native DSH composition over SSH. This carrier never executes an agent locally,
 * starts/restarts a remote runtime, or retries a business request. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { pipeline, Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

const PREFIX = '/remote-sessions/native/'
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const MAX_INDEX = 8 * 1024 * 1024
const wrapper = readFileSync(new URL('./remote-ui.js', import.meta.url))
const wrapperRev = createHash('sha256').update(wrapper).digest('hex').slice(0, 12)
const bootstrap = readFileSync(new URL('./remote-bootstrap.js', import.meta.url), 'utf8')

export function mountPath(name, identity) {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !/^[a-f0-9]{20}$/.test(identity)) throw new Error('invalid machine identity')
  return PREFIX + name + '/' + identity + '/'
}
export function machineIdentity(machine) {
  const env = Object.entries(machine.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return createHash('sha256').update(JSON.stringify([machine.command, machine.ssh, env, machine.web?.remotePort ?? 8420, machine.authorityRevision ?? ''])).digest('hex').slice(0, 20)
}
export function remotePath(rawUrl, mount) {
  const raw = String(rawUrl ?? '')
  if (!raw.startsWith(mount)) throw new Error('wrong remote mount')
  const suffix = raw.slice(mount.length)
  const pathname = suffix.split('?')[0]
  const decoded = decodeURIComponent(pathname)
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(p => p === '..' || p === '.')) throw new Error('invalid remote path')
  if (decoded.startsWith('/') || decoded.startsWith('remote-sessions/')) throw new Error('invalid remote path')
  const url = new URL('/' + suffix, 'http://dsh.invalid')
  if (url.searchParams.has('token')) throw new Error('remote tokens are not accepted from the browser')
  return url.pathname + url.search
}
export function forwardedHeaders(headers, port, cookie, websocket = false) {
  const result = {}
  const nominated = new Set(String(headers.connection ?? '').toLowerCase().split(',').map(x => x.trim()))
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (HOP.has(lower) || nominated.has(lower) || ['host', 'origin', 'cookie', 'authorization', 'accept-encoding', 'referer'].includes(lower) || lower.startsWith('sec-fetch-') || lower.startsWith('x-forwarded-')) continue
    if (value !== undefined) result[lower] = value
  }
  result.host = `127.0.0.1:${port}`
  result.origin = `http://127.0.0.1:${port}`
  result.cookie = cookie
  result['accept-encoding'] = 'identity'
  if (websocket) { result.connection = 'Upgrade'; result.upgrade = 'websocket' }
  return result
}
export function responseHeaders(headers, mount, websocket = false, path = '/') {
  const result = {}
  const nominated = new Set(String(headers.connection ?? '').toLowerCase().split(',').map(x => x.trim()))
  for (const [key, value] of Object.entries(headers)) {
    if (HOP.has(key) || nominated.has(key) || key === 'set-cookie' || value === undefined) continue
    if (key === 'location') {
      let destination
      try { destination = new URL(String(value), new URL(path, 'http://dsh.invalid/')) } catch { continue }
      if (destination.origin !== 'http://dsh.invalid' || destination.searchParams.has('token')) continue
      result.location = mount + (destination.pathname + destination.search + destination.hash).replace(/^\//, '')
    } else result[key] = value
  }
  if (websocket) { result.connection = 'Upgrade'; result.upgrade = 'websocket' }
  result['referrer-policy'] = 'no-referrer'
  return result
}
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
function quote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'" }
function remoteLogPath(value) {
  if (value === '~' || value.startsWith('~/')) return '"$HOME"' + (value.length > 1 ? '/' + quote(value.slice(2)) : '')
  return quote(value)
}
function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)) })
  })
}
function requestBuffered(port, path, headers = {}, signal) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, headers, timeout: 5000, signal }, res => {
      const chunks = []; let size = 0
      res.on('data', chunk => { size += chunk.length; if (size > MAX_INDEX) res.destroy(new Error('native index exceeds limit')); else chunks.push(chunk) })
      res.once('error', reject)
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.once('timeout', () => req.destroy(new Error('remote runtime not responding')))
    req.once('error', reject)
  })
}
export function validateGraph(graph) {
  if (!graph || typeof graph.rev !== 'string' || !Array.isArray(graph.entries) || !Array.isArray(graph.batches)) throw new Error('native remote boot contract unavailable')
  const ids = new Set(), urls = new Set(), batched = new Set()
  const url = value => typeof value === 'string' && value.length > 0 && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value) && !value.includes('\\') && !value.includes('\0')
  for (const row of graph.entries) {
    if (!row || typeof row.id !== 'string' || typeof row.rev !== 'string' || !url(row.url) || ids.has(row.id)) throw new Error('unsupported native graph entry')
    for (const key of ['inject', 'external']) if (row[key] !== undefined && (!Array.isArray(row[key]) || row[key].some(item => typeof item !== 'string'))) throw new Error('unsupported native graph dependency')
    if (row.immediately !== undefined && typeof row.immediately !== 'boolean') throw new Error('unsupported native graph lifecycle')
    ids.add(row.id)
  }
  for (const batch of graph.batches) {
    if (!batch || !['bootstrap', 'application'].includes(batch.phase) || typeof batch.rev !== 'string' || !url(batch.url) || urls.has(batch.url) || !Array.isArray(batch.entries) || !batch.entries.length) throw new Error('unsupported native graph batch')
    urls.add(batch.url)
    for (const id of batch.entries) {
      if (!ids.has(id) || batched.has(id)) throw new Error('unsupported native graph batch membership')
      batched.add(id)
    }
  }
  if (ids.size !== batched.size) throw new Error('native graph has unbatched entries')
  return graph
}
export function augmentGraph(graph) {
  validateGraph(graph)
  const id = 'dsh-remote-sessions-wrapper'
  if (graph.entries.some(entry => entry.id === id) || graph.batches.some(batch => batch.url.split('?')[0].replace(/^\//, '') === '_wrapper.js')) throw new Error('remote graph collides with local wrapper')
  graph.entries.push({ id, rev: wrapperRev, url: '_wrapper.js?rev=' + wrapperRev, external: ['react', 'react-dom'], inject: ['@deepseek-ai/dsh-client-ui-workspace'], immediately: true })
  graph.batches.push({ phase: 'application', rev: wrapperRev, url: '_wrapper.js?rev=' + wrapperRev, entries: [id] })
  return graph
}
export function graphEvents() {
  let pending = ''
  const decoder = new StringDecoder('utf8')
  const consume = stream => {
    if (Buffer.byteLength(pending) > MAX_INDEX) throw new Error('native graph event exceeds limit')
    let separator
    while ((separator = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, separator.index), ending = separator[0]
      pending = pending.slice(separator.index + ending.length)
      const lines = frame.split(/\r?\n/)
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
      if (data) {
        let value
        try { value = JSON.parse(data) } catch { /* Forward non-graph events unchanged. */ }
        if (value?.type === 'graph') {
          augmentGraph(value.graph)
          stream.push(lines.filter(line => !line.startsWith('data:')).concat('data: ' + JSON.stringify(value)).join('\n') + ending)
          continue
        }
      }
      stream.push(frame + ending)
    }
  }
  return new Transform({
    transform(chunk, encoding, done) {
      try { pending += decoder.write(chunk); consume(this); done() } catch (error) { done(error) }
    },
    flush(done) {
      try { pending += decoder.end(); consume(this); if (pending) this.push(pending); done() } catch (error) { done(error) }
    }
  })
}
export function composeRemoteIndex(bytes, identity, headers = {}) {
  const html = bytes.toString('utf8')
  // This supported rc.2 index has no CSP. Do not weaken an unknown policy to
  // make injected scripts execute; arbitrary API/file responses keep their CSP.
  if (headers['content-security-policy'] || /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy\b/i.test(html)) throw new Error('unsupported native index content security policy')
  const globals = [...html.matchAll(/<script>\s*globalThis\["__DSH_BOOT__"\]\s*=\s*([\s\S]*?)<\/script>/g)]
  if (globals.length !== 1 || !html.includes('<head>') || !html.includes('</head>')) throw new Error('unsupported native DSH index contract')
  let graph
  try { graph = JSON.parse(globals[0][1].trim().replace(/;$/, '')) } catch { throw new Error('native DSH graph is not JSON') }
  augmentGraph(graph)
  const required = ['@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-workspace']
  if (required.some(id => !graph.entries.some(row => row.id === id))) throw new Error('required native remote client services unavailable')
  const graphMarkup = '<script>globalThis["__DSH_BOOT__"] = ' + JSON.stringify(graph).replaceAll('<', '\\u003c') + '</script>'
  // Scope every DSH browser cache before any remote plugin initializes. Local
  // keys remain untouched; a changed SSH authority gets a fresh namespace.
  const host = { ...identity, mount: mountPath(identity.name, identity.identity) }
  const early = '<script>' + bootstrap.replace('__REMOTE_HOST__', JSON.stringify(host).replaceAll('<', '\\u003c')) + '</script>'
  return Buffer.from(html.replace(globals[0][0], graphMarkup).replace('<head>', '<head>' + early))
}

export function installNativeRemote(ctx, registry, { sshExchange, registerRoutes }) {
  const connections = new Map()
  const upgraded = new Map()
  let webContext
  let disposed = false
  const find = name => registry.machines.find(m => m.name === name && m.web)
  function close(entry) {
    if (entry.closed) return
    entry.closed = true
    entry.lifetime.abort()
    for (const socket of entry.sockets) socket.destroy()
    entry.sockets.clear()
    // Terminate our SSH forward only. No signal/command reaches the DSH process.
    entry.child?.terminate()
  }
  ctx.effect(() => () => { disposed = true; for (const entry of connections.values()) close(entry); connections.clear() }, 'remote-sessions.native-transports')
  function startAttach(machine) {
    if (disposed) throw new Error('remote transport disposed')
    const identity = machineIdentity(machine)
    let entry = connections.get(machine.name)
    if (entry && entry.identity === identity && !entry.closed) return entry
    if (entry) close(entry)
    entry = { identity, sockets: new Set(), closed: false, settled: false, waiters: 0, lifetime: new AbortController() }
    connections.set(machine.name, entry)
    entry.ready = (async () => {
      entry.port = await reservePort()
      if (disposed || entry.closed) throw new Error('remote transport disposed')
      entry.child = ctx.subprocess.spawn({
        argv: [machine.command || 'ssh', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-N', '-L', `127.0.0.1:${entry.port}:127.0.0.1:${machine.web.remotePort ?? 8420}`, ...machine.ssh],
        cwd: process.cwd(), stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }, env: machine.env, graceMs: machine.disposeGraceMs
      })
      entry.child.done.then(() => close(entry), () => close(entry))
      const deadline = Date.now() + 10000
      let answered = false
      while (!entry.closed && Date.now() < deadline) {
        try { const res = await requestBuffered(entry.port, '/', {}, entry.lifetime.signal); if (res.status === 401 || res.status === 200) { answered = true; break } } catch {}
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!answered) throw new Error('existing remote runtime is unavailable; no start or restart was attempted')
      const logPath = remoteLogPath(machine.web.logPath || '~/dsh-web.log')
      entry.lifetime.signal.throwIfAborted()
      const line = await sshExchange(ctx, machine, `grep 'dsh web:' ${logPath} 2>/dev/null | tail -1`, undefined, entry.lifetime.signal)
      entry.lifetime.signal.throwIfAborted()
      const token = /token=([A-Za-z0-9_-]+)/.exec(line)?.[1]
      if (!token) throw new Error('existing runtime authentication could not be recovered from its DSH log')
      const auth = await requestBuffered(entry.port, '/?token=' + token, {}, entry.lifetime.signal)
      const cookies = auth.headers['set-cookie']
      if (auth.status !== 303 || !Array.isArray(cookies) || cookies.length !== 1) throw new Error('remote runtime authentication failed')
      entry.cookie = cookies[0].split(';')[0]
      const index = await requestBuffered(entry.port, '/', { cookie: entry.cookie }, entry.lifetime.signal)
      if (index.status !== 200) throw new Error('remote runtime refused authenticated index')
      composeRemoteIndex(index.body, { name: machine.name, identity }, index.headers) // version/boot gate before switching
      if (disposed || entry.closed) throw new Error('remote transport disconnected during attach')
      entry.settled = true
      return entry
    })().catch(error => { close(entry); throw error })
    return entry
  }
  async function attach(machine, signal) {
    signal?.throwIfAborted()
    const entry = startAttach(machine)
    entry.waiters++
    let cancel
    const aborted = signal && new Promise((resolve, reject) => {
      cancel = () => reject(signal.reason ?? new Error('remote request cancelled'))
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
    try { return await (aborted ? Promise.race([entry.ready, aborted]) : entry.ready) }
    finally {
      signal?.removeEventListener('abort', cancel)
      entry.waiters--
      if (!entry.settled && entry.waiters === 0) close(entry)
    }
  }
  function requestLifetime(req, res) {
    const lifetime = new AbortController(), abort = () => lifetime.abort()
    req.once('aborted', abort); res.once('close', abort)
    const rawSocket = res instanceof net.Socket
    if (rawSocket) res.once('end', abort)
    if (req.aborted || res.destroyed || (rawSocket && res.readableEnded)) abort()
    return { signal: lifetime.signal, dispose() { req.off('aborted', abort); res.off('close', abort); if (rawSocket) res.off('end', abort) } }
  }
  function admit(inner, req, res) {
    const connection = inner.get('connection')
    if (typeof connection.admit !== 'function') { json(res, 503, { error: 'authentication service unavailable' }); return false }
    const admission = connection.admit(req)
    if ('rejection' in admission) { json(res, admission.rejection, { error: 'request not admitted' }); return false }
    return true
  }
  async function proxy(inner, req, res) {
    if (!admit(inner, req, res)) return
    const match = /^\/remote-sessions\/native\/([A-Za-z0-9_-]+)\/([a-f0-9]{20})\//.exec(req.url ?? '')
    const machine = match && find(match[1])
    if (!machine) return json(res, 404, { error: 'unknown remote runtime' })
    if (machineIdentity(machine) !== match[2]) return json(res, 409, { error: 'SSH authority changed. Return to local and explicitly open the new target; this page will not switch hosts.' })
    const mount = mountPath(machine.name, match[2])
    let path
    try { path = remotePath(req.url, mount) } catch { return json(res, 400, { error: 'invalid native remote path' }) }
    if (req.method === 'CONNECT' || req.method === 'TRACE') return json(res, 405, { error: 'method not allowed' })
    if (path.split('?')[0] === '/_wrapper.js') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); res.end(wrapper); return
    }
    const caller = requestLifetime(req, res)
    try {
      const entry = await attach(machine, caller.signal)
      caller.signal.throwIfAborted()
      if (res.destroyed) return
      if ((path.split('?')[0] === '/' || path.split('?')[0] === '/index.html') && req.method === 'GET') {
        const index = await requestBuffered(entry.port, path, forwardedHeaders(req.headers, entry.port, entry.cookie), AbortSignal.any([caller.signal, entry.lifetime.signal]))
        if (index.status !== 200) return json(res, 502, { error: 'remote runtime index unavailable; local execution is not a fallback' })
        const body = composeRemoteIndex(index.body, { name: machine.name, identity: entry.identity }, index.headers)
        const headers = responseHeaders(index.headers, mount, false, path)
        delete headers.etag; delete headers['content-encoding']
        headers['content-length'] = body.length; headers['cache-control'] = 'no-store'
        res.writeHead(200, headers); res.end(body); return
      }
      const upstream = http.request({ hostname: '127.0.0.1', port: entry.port, path, method: req.method, signal: entry.lifetime.signal, headers: forwardedHeaders(req.headers, entry.port, entry.cookie) }, response => {
        const headers = responseHeaders(response.headers, mount, false, path)
        const graph = path.split('?')[0] === '/plugins/events' && response.statusCode === 200
        if (graph) { delete headers['content-length']; delete headers.etag }
        res.writeHead(response.statusCode, headers)
        if (graph) pipeline(response, graphEvents(), res, () => {})
        else pipeline(response, res, () => {})
      })
      const abort = () => upstream.destroy()
      req.once('aborted', abort); res.once('close', abort)
      upstream.once('close', () => { req.off('aborted', abort); res.off('close', abort) })
      upstream.once('error', () => json(res, 502, { error: 'remote transport disconnected; request outcome may be unknown. No mutation was replayed and no local fallback was used.' }))
      req.pipe(upstream)
    } catch { json(res, 502, { error: 'remote runtime unavailable; retry connection explicitly. No local fallback or remote restart was attempted.' }) }
    finally { caller.dispose() }
  }
  function installUpgrade(machine) {
    const identity = machineIdentity(machine), key = machine.name + ':' + identity
    if (!webContext || upgraded.has(key)) return
    const inner = webContext, mount = mountPath(machine.name, identity)
    const dispose = inner.get('webServer').registerUpgrade({ path: mount + 'api/remote.mux', handler: async (req, socket, head) => {
      const admission = inner.get('connection').admit?.(req)
      if (!admission || 'rejection' in admission) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
      const current = find(machine.name)
      if (!current || machineIdentity(current) !== identity) { socket.end('HTTP/1.1 409 Authority changed\r\nConnection: close\r\n\r\n'); return }
      let entry
      const caller = requestLifetime(req, socket)
      try { entry = await attach(current, caller.signal) } catch { if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); return }
      finally { caller.dispose() }
      if (socket.destroyed || caller.signal.aborted) return
      const upstream = http.request({ hostname: '127.0.0.1', port: entry.port, path: '/api/remote.mux', method: 'GET', signal: entry.lifetime.signal, headers: forwardedHeaders(req.headers, entry.port, entry.cookie, true) })
      const stop = () => upstream.destroy()
      socket.once('close', stop)
      upstream.once('error', () => socket.destroy())
      upstream.once('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Remote unavailable\r\nConnection: close\r\n\r\n`) })
      upstream.once('upgrade', (response, remote, remoteHead) => {
        entry.sockets.add(socket); entry.sockets.add(remote)
        const cleanup = () => { socket.destroy(); remote.destroy(); entry.sockets.delete(socket); entry.sockets.delete(remote) }
        socket.once('close', cleanup); remote.once('close', cleanup)
        remote.once('error', cleanup); socket.once('error', cleanup)
        const headers = responseHeaders(response.headers, mount, true)
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n')
        if (remoteHead.length) socket.write(remoteHead)
        if (head.length) remote.write(head)
        socket.pipe(remote); remote.pipe(socket)
      })
      upstream.end()
    } })
    let active = true
    const unregister = () => { if (!active) return; active = false; dispose(); upgraded.delete(key) }
    upgraded.set(key, { name: machine.name, identity, unregister })
    inner.effect(() => unregister, 'remote-sessions.native-mux.' + key)
  }
  const reconcile = () => {
    for (const [name, entry] of connections) {
      const current = find(name)
      if (!current || machineIdentity(current) !== entry.identity) { close(entry); connections.delete(name) }
    }
    for (const row of upgraded.values()) {
      const current = find(row.name)
      if (!current || machineIdentity(current) !== row.identity) row.unregister()
    }
    for (const machine of registry.machines.filter(m => m.web)) installUpgrade(machine)
  }
  registry.reconcileNative = reconcile
  ctx.effect(() => () => { if (registry.reconcileNative === reconcile) delete registry.reconcileNative }, 'remote-sessions.native-registry')
  registerRoutes(ctx, [{ kind: 'exact', path: '/remote-sessions/prepare', handler: async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const machine = find(new URL(req.url, 'http://dsh.invalid').searchParams.get('machine'))
    if (!machine) return json(res, 404, { error: 'unknown remote runtime' })
    const caller = requestLifetime(req, res)
    try {
      const entry = await attach(machine, caller.signal)
      caller.signal.throwIfAborted()
      if (entry.closed || find(machine.name) !== machine) throw new Error('remote authority changed during preparation')
      installUpgrade(machine)
      json(res, 200, { path: mountPath(machine.name, entry.identity), name: machine.name, identity: entry.identity, mode: 'remote-runtime' })
    } catch (error) { json(res, 502, { error: String(error.message) }) }
    finally { caller.dispose() }
  } }])
  ctx.inject(['webServer', 'connection'], inner => {
    webContext = inner
    inner.effect(() => inner.get('webServer').register({ kind: 'prefix', path: PREFIX, handler: (req, res) => proxy(inner, req, res) }), 'remote-sessions.native-http')
    for (const machine of registry.machines.filter(m => m.web)) installUpgrade(machine)
  })
}
