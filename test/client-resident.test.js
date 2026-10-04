import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Actual classic-script factory, no source rewriting, browser, network or deployment.
// The hook seam checks component contracts, not DOM layout or React reconciliation.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
async function settle() { for (let n = 0; n < 5; n++) await tick() }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function children(node) { return node?.props?.children || [] }
function text(node) { return Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? children(node).map(text).join('') : node == null || node === false ? '' : String(node) }
function walk(node, predicate, results = []) {
  if (Array.isArray(node)) { node.forEach(child => walk(child, predicate, results)); return results }
  if (!node || typeof node !== 'object') return results
  if (predicate(node)) results.push(node)
  children(node).forEach(child => walk(child, predicate, results)); return results
}
function element(tree, predicate) { const matches = walk(tree, predicate); assert.equal(matches.length, 1); return matches[0] }
function load({ fetchAction = async () => ({ machines: [] }), protocol = 'http:' } = {}) {
  let module, current
  const registrations = [], selections = [], requests = [], injections = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...nested) { return { type, props: { ...(props || {}), children: nested.flat(Infinity) } } },
    useState(initial) { const d = current, i = d.cursor++; if (!d.hooks[i]) d.hooks[i] = { value: typeof initial === 'function' ? initial() : initial }; const hook = d.hooks[i]; return [hook.value, value => { hook.value = typeof value === 'function' ? value(hook.value) : value; d.dirty = true }] },
    useRef(value) { const d = current, i = d.cursor++; return (d.hooks[i] ||= { current: value }) },
    useCallback(fn) { current.cursor++; return fn },
    useEffect(fn, deps) { const d = current, i = d.cursor++, old = d.hooks[i]; if (!old || !deps || deps.some((value, j) => !Object.is(value, old.deps[j]))) d.effects.push(() => { old?.cleanup?.(); d.hooks[i] = { deps, cleanup: fn() } }) },
  }
  const document = { body: {}, activeElement: { focus() {}, isConnected: true }, addEventListener() {}, removeEventListener() {} }
  const window = { location: { protocol, assign() { throw new Error('Forbidden native navigation') } }, __ModuleLoader__: { load(entry) { module = entry.factory(name => name === 'react' ? React : name === 'react-dom' ? { createPortal: node => node } : assert.fail(name)) } } }
  const fetch = async (path, opts) => { const body = opts.body ? JSON.parse(opts.body) : undefined; requests.push({ path, ...opts, body }); const value = await fetchAction(path, body); return { ok: true, status: 200, json: async () => value } }
  vm.runInNewContext(source, { window, document, fetch, AbortController, crypto: { randomUUID: () => 'fixture-id' }, setTimeout, console }, { filename: 'client.js', timeout: 1000 })
  const slots = { inject(name, fn) { injections.push(name); return fn() }, register(options, component) { registrations.push({ options, component }) } }
  const layout = { selectPanel(id) { selections.push(id) } }
  module.apply({ inject(names, fn) { assert.deepEqual(Array.from(names), ['slots', 'layout']); fn({ slots, layout, get(name) { return name === 'slots' ? slots : layout } }) } })
  function driver(component, props = {}) {
    const d = { hooks: [], effects: [], cursor: 0, dirty: true, props, tree: null,
      flush() { let rounds = 0; while (this.dirty) { assert.ok(++rounds < 30); this.dirty = false; this.cursor = 0; this.effects = []; current = this; this.tree = component(this.props); current = null; for (const node of walk(this.tree, n => n.props?.ref)) node.props.ref.current = { querySelectorAll: () => [], contains: () => true, focus() {} }; for (const effect of this.effects) effect() } },
      dispose() { for (const hook of this.hooks) hook?.cleanup?.() },
      field(label) { return element(this.tree, n => n.props?.['aria-label'] === label) },
      button(label) { return element(this.tree, n => n.type === 'button' && text(n) === label) },
      change(label, value) { this.field(label).props.onChange({ target: { type: 'text', value } }); this.flush() },
      click(label) { const b = this.button(label); assert.ok(!b.props.disabled); const result = b.props.onClick(); this.flush(); return result },
    }; d.flush(); return d
  }
  return { module, t: module.testing, registrations, selections, requests, driver }
}
const capabilities = [
  ...['list', 'create', 'prompt', 'page', 'cancel', 'selectModel', 'modelCatalog'].map(name => ({ endpoint: 'session/' + name, stream: false, parameters: name === 'modelCatalog' ? [] : ['request'] })),
  { endpoint: 'session/follow', stream: true, parameters: ['request'] },
]
const binding = (target = 'remote', epoch = 'epoch-1') => ({ id: 'binding-' + target, target, runtimeId: 'runtime-' + target, instanceId: epoch, authority: 'authority-' + target })
const record = (seq, type = 'user/message', data = { content: [{ type: 'text', text: 'Hello' }] }) => ({ type: 'event', event: { type, seq, time: seq, data, surfaceOp: 'append' } })
const snapshot = (records = [], more = false, activeAttempt, sessionId = 's') => ({ type: 'snapshot', header: { id: sessionId, version: 4 }, cursor: records.at(-1)?.event.seq ?? -1, records, hasMore: more, projections: { values: {} }, assistantStream: { revision: 0, ...(activeAttempt ? { activeAttempt } : {}) } })
function backend(t, action = () => undefined) {
  const requests = [], streams = new Map(); let streamSerial = 0, id = 0
  const transport = async (method, path, body, signal) => {
    requests.push({ method, path, body: plain(body), signal })
    const override = await action(path, body, signal)
    if (override !== undefined) return override
    if (path.endsWith('/attach')) return { binding: binding(body.target), hello: { protocol: 'dsh-remote-sessions/1', capabilities } }
    if (path.endsWith('/detach')) return { detached: true }
    const { method: op, params } = body
    if (op === 'open') { const streamId = 'stream-' + ++streamSerial; streams.set(streamId, { endpoint: params.endpoint, sessionId: params.values?.[0]?.address?.sessionId, first: true, pending: null }); return { streamId } }
    if (op === 'close') return { closed: true }
    if (op === 'next') {
      const s = streams.get(params.streamId)
      if (s.first) { s.first = false; return { items: [s.endpoint === '$events' ? { type: 'ready', clientId: 'client-' + params.streamId, host: { home: '/home/test' } } : snapshot([], false, undefined, s.sessionId)], done: false } }
      const pending = deferred(); s.pending = pending
      const abort = () => pending.reject(new Error('aborted'))
      signal?.addEventListener('abort', abort, { once: true })
      return pending.promise.finally(() => signal?.removeEventListener('abort', abort))
    }
    if (op === 'event-result') return { ok: true, value: undefined }
    if (op === 'call') {
      if (params.endpoint === 'session/list') return { ok: true, value: [{ sessionId: 's', cwd: '/work' }] }
      if (params.endpoint === 'session/create') return { ok: true, value: { sessionId: params.values[0].sessionId } }
      if (params.endpoint === 'session/modelCatalog') return { ok: true, value: { groups: [] } }
      return { ok: true, value: { accepted: true } }
    }
    throw new Error('Unexpected request ' + JSON.stringify(body))
  }
  const client = t.createResidentClient({ transport, uuid: () => String(++id), schedule: fn => fn() })
  async function connected(target = 'remote') { const c = await client.attach(target); await settle(); assert.equal(c.status, 'connected'); return c }
  async function push(endpoint, frame) { const s = [...streams.values()].filter(s => s.endpoint === endpoint && s.pending).at(-1); assert.ok(s); const pending = s.pending; s.pending = null; pending.resolve({ items: [frame], done: false }); await settle() }
  return { client, requests, streams, connected, push }
}

test('real factory installs a plugin-owned MAIN panel and native sidebar entry', () => {
  const env = load()
  const main = env.registrations.find(r => r.options.name === 'main')
  assert.deepEqual(plain(main.options), { name: 'main', key: 'remote-sessions' })
  const sidebar = env.registrations.find(r => r.options.name === 'sidebar.panellist')
  assert.deepEqual(plain(sidebar.options), { name: 'sidebar.panellist', id: 'remote-sessions', label: 'Remote sessions', order: 40 })
  assert.ok(sidebar.component({ size: 20, active: true }))
  env.t.openPanel('remote', '/remote/work')
  assert.deepEqual(env.selections, ['remote-sessions'])
  assert.equal(env.t.resident.target, 'remote')
  assert.equal(env.t.resident.cwd, '/remote/work')
  assert.equal(env.requests.length, 0)
  assert.doesNotMatch(source, /location\.assign|dangerouslySetInnerHTML|localStorage|createElement\(['"]iframe/)
})

test('machine form round-trips SSH argv boundaries and exposes no command/env/ACP controls', () => {
  const { t } = load()
  const machine = { name: 'ssh', ssh: ['-i', '/home/path with spaces/key', 'host'], remoteNode: '/bin/node', socketPath: '/run/agent.sock', remoteCwd: '/work', command: '/private/ssh', env: { TOKEN: 'secret' } }
  const form = t.toForm(machine), saved = t.fromForm(form)
  assert.deepEqual(plain(saved.ssh), machine.ssh)
  assert.equal(saved.remoteNode, '/bin/node'); assert.equal(saved.socketPath, '/run/agent.sock')
  assert.ok(!('command' in saved)); assert.ok(!('env' in saved)); assert.ok(!('acpCommand' in saved))
  assert.throws(() => t.fromForm({ ...form, sshText: 'host -p 22' }), /JSON array/)
  assert.throws(() => t.fromForm({ ...form, sshText: '[1]' }), /array of strings/)
})

test('remote directory picker selects plugin panel and never adopts a native local root', async () => {
  const env = load({ fetchAction: async () => ({ machines: [{ name: 'remote', remoteCwd: '/remote/work' }] }) })
  const picked = [], canceled = []
  const d = env.driver(env.t.DirPicker, { open: true, busy: false, onPicked: p => picked.push(p), onCancel: () => canceled.push(true) })
  d.click('Remote machines'); await settle(); d.flush()
  d.change('Remote directory', '/remote/space &?#目录')
  d.click('Open Remote sessions here')
  assert.deepEqual(env.selections, ['remote-sessions']); assert.deepEqual(picked, []); assert.equal(canceled.length, 1)
  assert.equal(env.t.resident.cwd, '/remote/space &?#目录')
  assert.ok(env.requests.every(r => r.method === 'GET' && r.path.endsWith('/machines')))
  d.dispose()
})

test('local directory picker preserves local onPicked', async () => {
  const env = load(), picked = []
  const d = env.driver(env.t.DirPicker, { open: true, busy: false, onPicked: p => picked.push(p), onCancel() {} })
  d.change('Local directory', ' /local/work '); await d.click('Use this local path')
  assert.deepEqual(picked, ['/local/work']); assert.deepEqual(env.selections, []); d.dispose()
})

test('selected sync form still previews explicit selections then consumes apply token', async () => {
  const env = load({ fetchAction: async path => path.endsWith('/preview') ? { token: 'preview', preview: { entries: [] } } : { ok: true } })
  const d = env.driver(env.t.SelectedActions, { machine: { name: 'remote' } })
  d.click('Show selected sync / transfer'); d.change('Selected provider', 'p'); d.change('Selected model', 'm')
  await d.click('Preview selection'); d.flush(); assert.equal(d.button('Confirm and apply this preview').props.disabled, false)
  await d.click('Confirm and apply this preview'); d.flush()
  assert.deepEqual(env.requests.map(r => r.body), [{ machine: 'remote', selections: [{ provider: 'p', model: 'm' }], credentialRefs: [] }, { token: 'preview', confirm: true }])
  assert.equal(d.button('Confirm and apply this preview').props.disabled, true)
})

test('session identity includes target and runtime, never only the session id', () => {
  const { t } = load()
  assert.notEqual(t.sessionKey(binding('local'), 'same'), t.sessionKey(binding('remote'), 'same'))
  assert.notEqual(t.sessionKey(binding(), 'same'), t.sessionKey({ ...binding(), runtimeId: 'other' }, 'same'))
})

test('text projection handles installed payloads without fetching images or HTML', () => {
  const { t } = load()
  assert.equal(t.eventView(record(0).event).text, 'Hello')
  assert.equal(t.eventView(record(1, 'assistant/message', { message: { content: [{ type: 'text', text: '<script>unsafe()</script>' }] } }).event).text, '<script>unsafe()</script>')
  assert.equal(t.eventView(record(2, 'tool/call', { name: 'bash', arguments: '{"command":"pwd"}' }).event).text, '{"command":"pwd"}')
  assert.equal(t.eventView(record(3, 'tool/result', { message: { content: [{ type: 'text', text: '/remote' }] } }).event).text, '/remote')
  assert.match(t.contentText([{ type: 'image', url: '/api/private' }, { type: 'file', path: '/tmp/file' }]), /not loaded/)
  assert.equal(t.compactText([{ type: 'text-chunks', texts: ['a', 'b'] }, { type: 'reasoning-chunks', texts: ['secret'] }, { type: 'chunk', chunk: { type: 'text-delta', textDelta: 'c' } }]), 'abc')
})

test('snapshot active baseline and stream revisions/indexes are validated', () => {
  const { t } = load()
  let s = t.snapshotState(snapshot([record(0)], false, { attemptId: 'a', startedAfterSeq: 0, turn: 1, step: 1, nextIndex: 2, stream: [{ type: 'text-chunks', texts: ['base'] }] }))
  assert.equal(s.active.text, 'base')
  s = t.acceptFrame(s, { type: 'assistant-stream', frame: { type: 'chunk', revision: 1, attemptId: 'a', index: 2, chunk: { type: 'text-delta', text: ' plus' } } })
  assert.equal(s.active.text, 'base plus')
  assert.throws(() => t.acceptFrame(s, { type: 'assistant-stream', frame: { type: 'chunk', revision: 3, attemptId: 'a', index: 3 } }), /revision gap/)
  assert.throws(() => t.acceptFrame(s, { type: 'assistant-stream', frame: { type: 'chunk', revision: 2, attemptId: 'a', index: 9 } }), /index gap/)
  assert.throws(() => t.acceptFrame(s, record(2)), /cursor gap/)
  assert.throws(() => t.snapshotState({ ...snapshot([record(0)]), cursor: 4 }), /cursor mismatch/)
  assert.throws(() => t.snapshotState(snapshot([record(0), record(2)])), /sequence gap/)
  assert.throws(() => t.acceptFrame(s, { type: 'assistant-stream', frame: { type: 'end', revision: 2, attemptId: 'a', index: 3, outcome: { kind: 'committed', seq: 1, eventType: 'assistant/message' } } }), /durable event/)
})

test('history window is bounded; pagination is contiguous and never silently drops loaded events', () => {
  const { t } = load()
  const records = Array.from({ length: t.MAX_EVENTS + 20 }, (_, n) => record(n))
  const s = t.snapshotState(snapshot(records))
  assert.equal(s.records.length, t.MAX_EVENTS); assert.equal(s.records[0].event.seq, 20); assert.equal(s.trimmed, true)
  assert.throws(() => t.prependPage(s, { records: [record(19)], hasMore: true }), /limit reached/)
  const small = t.snapshotState(snapshot([record(5), record(6)], true))
  assert.deepEqual(plain(t.prependPage(small, { records: [record(3), record(4)], hasMore: true }).records.map(r => r.event.seq)), [3, 4, 5, 6])
  assert.throws(() => t.prependPage(small, { records: [record(2)], hasMore: false }), /contiguous/)
})

test('attach opens global events first; list/create/pins/follow use positional request values', async () => {
  const { t } = load(), b = backend(t), c = await b.connected()
  assert.equal(b.requests.find(r => r.body?.method === 'open').body.params.endpoint, '$events')
  assert.deepEqual(b.requests.find(r => r.body?.method === 'open').body.params.values, [])
  await b.client.refresh(c)
  const s = await b.client.create(c, '/remote/work', { modelProvider: 'p', modelId: 'm', effort: 'high' })
  await settle()
  const calls = b.requests.filter(r => r.body?.method === 'call').map(r => r.body.params)
  assert.deepEqual(calls.find(r => r.endpoint === 'session/list').values, [{}])
  assert.deepEqual(calls.find(r => r.endpoint === 'session/create').values, [{ cwd: '/remote/work', sessionId: 'session-1' }])
  assert.equal(calls.some(r => r.endpoint === 'session/selectModel'), false, 'creating a session must not silently change runtime defaults')
  assert.equal(s.modelPinBlocked, true)
  await assert.rejects(b.client.model(s, 'p', 'm', 'high'), /Confirm the runtime-default change/)
  await b.client.model(s, 'p', 'm', 'high', true)
  const model = b.requests.find(r => r.body?.params?.endpoint === 'session/selectModel').body.params
  assert.deepEqual(model.values, [{ sessionId: 'session-1', provider: 'p', model: 'm', reasoningEffort: 'high' }]); assert.equal(model.confirmDefaultChange, true)
  assert.deepEqual(b.requests.find(r => r.body?.params?.endpoint === 'session/follow').body.params.values, [{ address: { kind: 'session', sessionId: 'session-1' }, assistantStream: true, maxMessages: 100 }])
  assert.equal(s.target, 'remote'); assert.equal(s.runtimeId, 'runtime-remote')
  await b.client.close()
  assert.ok(!b.requests.some(r => r.body?.params?.endpoint === 'session/cancel'))
})

test('local mode uses exact same resident bridge with explicit local binding', async () => {
  const { t } = load(), b = backend(t), c = await b.connected('local')
  const s = await b.client.select(c, 'existing-local-session'); await settle(); s.draft = 'local hello'; await b.client.prompt(s)
  const prompt = b.requests.find(r => r.body?.params?.endpoint === 'session/prompt')
  assert.equal(prompt.body.binding.target, 'local'); assert.equal(prompt.body.params.values[0].sessionId, 'existing-local-session')
  assert.equal(prompt.body.params.values[0].mode, 'queue'); assert.deepEqual(prompt.body.params.values[0].content, [{ type: 'text', text: 'local hello' }])
  await b.client.close()
})

test('lost prompt acknowledgement retains exact requestId and text; reconnect never replays', async () => {
  const { t } = load(); let lose = true
  const b = backend(t, (path, body) => { if (body?.params?.endpoint === 'session/prompt' && lose) { lose = false; throw new Error('lost ack') } })
  const c = await b.connected(), s = await b.client.select(c, 's'); await settle(); s.draft = 'Do not replay this'
  await assert.rejects(b.client.prompt(s), /lost ack/)
  assert.equal(s.requests[0].status, 'unknown'); assert.equal(s.requests[0].requestId, 'request-1'); assert.equal(s.requests[0].text, 'Do not replay this')
  assert.equal(c.status, 'disconnected'); await b.client.attach('remote'); await settle()
  assert.deepEqual(b.requests.filter(r => r.path.endsWith('/attach')).at(-1).body, { target: 'remote', expectedRuntimeId: 'runtime-remote' })
  assert.equal(b.requests.filter(r => r.body?.params?.endpoint === 'session/prompt').length, 1)
  await b.client.select(b.client.connections.get('remote'), 's'); await settle()
  await b.push('session/follow', record(0, 'user/message', { source: { kind: 'user', rpcId: 'request-1' }, content: [{ type: 'text', text: 'Do not replay this' }] }))
  assert.equal(s.requests[0].status, 'observed in journal')
  await b.client.close()
})

test('epoch changes interrupt and require explicit observation; no cancellation or prompt replay', async () => {
  const { t } = load(); let epoch = 'epoch-1'
  const b = backend(t, (path, body) => path.endsWith('/attach') ? { binding: binding(body.target, epoch), hello: { protocol: 'dsh-remote-sessions/1', capabilities } } : undefined)
  const c = await b.connected(); await b.client.detach(c); epoch = 'epoch-2'
  const next = await b.client.attach('remote'); assert.equal(next.status, 'interrupted')
  assert.match(next.message, /restarted/); assert.equal(next.streams.size, 0)
  const attaches = b.requests.filter(r => r.path.endsWith('/attach')).length
  assert.equal(await b.client.attach('remote'), next)
  assert.equal(b.requests.filter(r => r.path.endsWith('/attach')).length, attaches, 'epoch review cannot be bypassed by ordinary reconnect')
  await b.client.attach('remote', { acceptEpoch: true }); await settle(); assert.equal(b.client.connections.get('remote').status, 'connected')
  assert.ok(!b.requests.some(r => ['session/prompt', 'session/cancel'].includes(r.body?.params?.endpoint)))
  await b.client.close()
})

test('stale attach is detached and cannot resurrect a closed panel', async () => {
  const { t } = load(), pending = deferred()
  const b = backend(t, path => path.endsWith('/attach') ? pending.promise : undefined)
  const attaching = b.client.attach('remote'); await settle(); await b.client.close()
  pending.resolve({ binding: binding(), hello: { protocol: 'dsh-remote-sessions/1', capabilities } }); await attaching
  assert.equal(b.client.connections.get('remote').status, 'detached')
  assert.equal(b.requests.filter(r => r.body?.method === 'open').length, 0)
  assert.ok(b.requests.some(r => r.path.endsWith('/detach')))
})

test('cursor gap triggers fresh snapshot replacement, never silent drop or mutation replay', async () => {
  const { t } = load(), b = backend(t), c = await b.connected(), s = await b.client.select(c, 's'); await settle()
  await b.push('session/follow', record(2))
  assert.equal(b.requests.filter(r => r.body?.method === 'open' && r.body.params.endpoint === 'session/follow').length, 2)
  assert.equal(s.state.cursor, -1); assert.equal(s.loading, false)
  assert.ok(!b.requests.some(r => r.body?.params?.endpoint === 'session/prompt'))
  await b.client.close()
})

test('pagination request pins opening snapshot cursor and lower bound', async () => {
  const { t } = load(), b = backend(t, (path, body) => body?.params?.endpoint === 'session/page' ? { ok: true, value: { records: [record(0)], hasMore: false } } : undefined)
  const c = await b.connected(), s = await b.client.select(c, 's'); await settle()
  await b.push('session/follow', snapshot([record(1), record(2)], true)); await b.push('session/follow', record(3))
  await b.client.page(s)
  assert.deepEqual(b.requests.find(r => r.body?.params?.endpoint === 'session/page').body.params.values, [{ address: { kind: 'session', sessionId: 's' }, throughSeq: 2, beforeSeq: 1, maxMessages: 100 }])
  assert.deepEqual(plain(s.state.records.map(r => r.event.seq)), [0, 1, 2, 3]); await b.client.close()
})

test('approval cards retain target-global identities, cancel removes, replies bind clientId', async () => {
  const { t } = load(), b = backend(t), c = await b.connected()
  await b.push('$events', { type: 'waterfall', event: 'approval/request', eventId: 'approval-1', agentId: 'not-selected', request: { toolName: 'bash', reason: 'run command' } })
  const card = c.pending.get('approval-1'); assert.equal(card.target, 'remote'); assert.equal(card.agentId, 'not-selected')
  await b.client.answer(c, card, { kind: 'result', value: 'allowed-once' })
  const reply = b.requests.find(r => r.body?.method === 'event-result')
  assert.deepEqual(reply.body.params, { clientId: 'client-stream-1', eventId: 'approval-1', outcome: { kind: 'result', value: 'allowed-once' } })
  await b.push('$events', { type: 'waterfall', event: 'mystery/request', eventId: 'unknown', agentId: 'other', request: {} })
  assert.equal(b.requests.filter(r => r.body?.method === 'event-result').length, 1, 'unknown waterfall never autoallows/delegates')
  await b.push('$events', { type: 'cancel', eventId: 'unknown' }); assert.equal(c.pending.size, 0)
  await b.client.close()
})

test('question card emits answer arrays and unsupported cards require explicit denial/delegation', async () => {
  const env = load(), c = { status: 'connected' }, card = { target: 'remote', runtimeId: 'runtime', agentId: 'session-1', eventId: 'event', status: 'pending', event: 'user-questions/request', request: { questions: [{ id: 'q', question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }], multiSelect: true }] } }
  const answers = []; env.t.resident.answer = async (connection, item, outcome) => { answers.push(plain(outcome)) }
  const d = env.driver(env.t.PendingCard, { connection: c, card }); assert.match(text(d.tree), /Timed-question/)
  d.change('Custom answer: q', ' Custom '); await d.click('Submit answers')
  assert.deepEqual(answers, [{ kind: 'result', value: { answers: [{ id: 'q', selected: [], custom: 'Custom' }] } }])
  const unknown = env.driver(env.t.PendingCard, { connection: c, card: { ...card, event: 'unknown/request', request: {} } })
  assert.ok(unknown.button('Deny request')); assert.ok(unknown.button('Delegate to another handler')); assert.equal(answers.length, 1)
  d.dispose(); unknown.dispose()
})

test('answer lost acknowledgement disables replay and Stop is only an explicit command', async () => {
  const { t } = load(), b = backend(t, (path, body) => { if (body?.method === 'event-result') throw new Error('answer ack lost') })
  const c = await b.connected(), s = await b.client.select(c, 's'); await settle()
  await b.client.stop(s)
  assert.equal(b.requests.filter(r => r.body?.params?.endpoint === 'session/cancel').length, 1)
  await b.push('$events', { type: 'waterfall', event: 'approval/request', eventId: 'a', agentId: 's', request: {} })
  const card = c.pending.get('a')
  await assert.rejects(b.client.answer(c, card, { kind: 'result', value: 'rejected' }), /ack lost/)
  assert.equal(card.status, 'unknown'); assert.equal(card.stale, true)
  await assert.rejects(b.client.answer(c, card, { kind: 'result', value: 'allowed-once' }), /Reconnect/)
  await b.client.close(); assert.equal(b.requests.filter(r => r.body?.method === 'event-result').length, 1)
  assert.equal(b.requests.filter(r => r.body?.params?.endpoint === 'session/cancel').length, 1)
})

test('unsupported snapshot format and wrong session identity fail closed', async () => {
  const { t } = load()
  assert.throws(() => t.snapshotState({ ...snapshot(), header: { id: 's', version: 99 } }), /Unsupported session format/)
  const b = backend(t), c = await b.connected(), s = await b.client.select(c, 's'); await settle()
  await b.push('session/follow', { ...snapshot(), header: { id: 'other', version: 4 } })
  assert.equal(c.status, 'disconnected'); assert.equal(s.observing, false)
  assert.match(c.message, /identity mismatch/)
  await b.client.close()
})

test('failed requested model pin blocks prompts until an explicit selection succeeds', async () => {
  const { t } = load(); let fail = true
  const b = backend(t, (path, body) => fail && body?.params?.endpoint === 'session/selectModel' ? { ok: false, error: { code: 'model/not-found', message: 'Not available' } } : undefined)
  const c = await b.connected(), s = await b.client.create(c, '/remote/work', { modelProvider: 'p', modelId: 'missing' }); await settle()
  s.draft = 'Must not use the default model'; assert.equal(s.modelPinBlocked, true)
  await assert.rejects(b.client.prompt(s), /Confirm the selected model/)
  assert.equal(b.requests.filter(r => r.body?.params?.endpoint === 'session/prompt').length, 0)
  await assert.rejects(b.client.model(s, 'p', 'missing', undefined, true), /Not available/)
  assert.equal(s.modelPinBlocked, true)
  fail = false; await b.client.model(s, 'p', 'available', undefined, true); await b.client.prompt(s)
  assert.equal(s.modelPinBlocked, false)
  await b.client.close()
})

test('adopting an existing session rechecks configured model after GUI state loss', async () => {
  const { t } = load(), b = backend(t), c = await b.connected()
  const s = await b.client.select(c, 's', { modelProvider: 'p', modelId: 'required' }); await settle()
  s.draft = 'Do not silently use default'; assert.equal(s.modelPinBlocked, true)
  await assert.rejects(b.client.prompt(s), /Confirm the selected model/)
  await b.push('session/follow', { ...snapshot(), projections: { values: { modelSelection: { next: { provider: 'p', model: 'required' } } } } })
  assert.equal(s.modelPinBlocked, false)
  await b.client.prompt(s); await b.client.close()
})

test('same-generation refresh cannot overwrite newer metadata and subagents cannot detach target', async () => {
  const { t } = load(), first = deferred(), second = deferred(); let reads = 0
  const b = backend(t, (path, body) => body?.params?.endpoint === 'session/list' ? (++reads === 1 ? first.promise : second.promise) : undefined)
  const c = await b.connected(), old = b.client.refresh(c), latest = b.client.refresh(c)
  second.resolve({ ok: true, value: [{ sessionId: 'new' }, { sessionId: 'child', origin: 'subagent' }] }); await latest
  first.resolve({ ok: true, value: [{ sessionId: 'old' }] }); await old
  assert.equal(c.list[0].sessionId, 'new')
  await assert.rejects(b.client.select(c, 'child'), /Subagent conversations/)
  assert.equal(c.status, 'connected'); assert.ok(c.clientId)
  await b.client.close()
})

test('live model evidence supersedes prior acknowledged display selection', async () => {
  const { t } = load(), b = backend(t), c = await b.connected(), s = await b.client.select(c, 's'); await settle()
  await b.client.model(s, 'p', 'a', undefined, true); assert.equal(s.confirmedModel.model, 'a')
  await b.push('session/follow', record(0, 'model/selection', { provider: 'p', model: 'b' }))
  assert.equal(s.confirmedModel, null); assert.equal(s.state.projections.values.modelSelection.next.model, 'b')
  assert.match(t.eventView(record(1, 'user/message', { source: { kind: 'runtime-context' }, content: [] }).event).role, /Context/)
  await b.client.close()
})

test('API helper retains dsh-app prefix without navigating remote UI', async () => {
  const env = load({ protocol: 'dsh-app:' })
  const d = env.driver(env.t.DirPicker, { open: true, busy: false, onPicked() {}, onCancel() {} })
  d.click('Remote machines'); await settle(); assert.equal(env.requests[0].path, '/api/remote-sessions/machines'); d.dispose()
})
