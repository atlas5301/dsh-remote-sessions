import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/* Run: node --test dsh-remote-sessions/test/client-actions.test.js
 * Executes the unmodified classic-script client through its real factory/apply
 * and captured slots; internal components are NOT exported or source-rewritten.
 * A small hook/element driver invokes the actual button/field handlers. This is
 * deterministic client-contract coverage, NOT real React reconciliation, DOM
 * events/layout/focus, immutable browser Location, Cordis, SSH or backend safety.
 * picker-browser.html supplies real React/DOM coverage with failing prepare;
 * successful location.assign is observed only on this VM-owned Location seam.
 * Every HTTP response is mocked. No server, GUI, runtime or model starts here.
 */
const clientFile = new URL('../lib/client.js', import.meta.url)
const MOUNT = '/remote-sessions/native/test/0123456789abcdef0123/'
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))
const machine = {
  name: 'test', remoteCwd: '/remote/home', modelProvider: 'old-provider', modelId: 'old-model', effort: 'low',
  web: { remotePort: 8420 }, sync: { providers: true, credentials: true, defaultModel: true, skills: true, plugins: ['legacy-all'] },
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => data } }
function children(node) { return node && typeof node === 'object' ? node.props?.children || [] : [] }
function walk(node, match, found = []) {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, found)); return found }
  if (!node || typeof node !== 'object') return found
  if (match(node)) found.push(node)
  children(node).forEach(child => walk(child, match, found))
  return found
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  return node && typeof node === 'object' ? children(node).map(text).join('') : node == null || node === false ? '' : String(node)
}
function element(tree, predicate) {
  const matches = walk(tree, predicate)
  assert.equal(matches.length, 1, 'expected one matching element')
  return matches[0]
}
function button(driver, label) { return element(driver.tree, node => node.type === 'button' && text(node) === label) }
function field(driver, label) { return element(driver.tree, node => node.props?.['aria-label'] === label) }
function checkbox(driver, label) {
  const parent = element(driver.tree, node => node.type === 'label' && text(node).trim() === label.trim())
  return element(parent, node => node.type === 'input' && node.props.type === 'checkbox')
}
function change(driver, label, value) {
  const node = field(driver, label)
  assert.ok(!node.props.disabled, label + ' must be enabled')
  node.props.onChange({ target: { type: node.type === 'select' ? 'select-one' : 'text', value } })
  driver.flush()
}
function check(driver, label, checked = true) {
  const node = checkbox(driver, label)
  assert.ok(!node.props.disabled, label + ' must be enabled')
  node.props.onChange({ target: { type: 'checkbox', checked } })
  driver.flush()
}
function click(driver, label) {
  const node = button(driver, label)
  assert.ok(!node.props.disabled, label + ' must be enabled')
  const result = node.props.onClick()
  driver.flush()
  return result
}

function environment({ protocol = 'http:', fetchAction } = {}) {
  let currentDriver, module
  const requests = [], navigation = [], registrations = [], injections = [], listeners = new Map()
  const document = {
    body: {},
    activeElement: { isConnected: true, focus() { document.activeElement = this } },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
  }
  const location = { protocol, href: 'http://fixture.invalid/test', assign(value) { navigation.push(String(value)) } }
  // href assignment is forbidden in the VM: callers must exercise native assign,
  // rather than silently accepting a source regression to browser replacement.
  Object.defineProperty(location, 'href', { get: () => 'http://fixture.invalid/test', set() { throw new Error('Expected location.assign navigation seam') } })
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...nested) { return { type, props: { ...(props || {}), children: nested.flat(Infinity) } } },
    useState(initial) {
      const driver = currentDriver, index = driver.cursor++
      if (!driver.hooks[index]) driver.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      const hook = driver.hooks[index]
      return [hook.value, value => {
        const next = typeof value === 'function' ? value(hook.value) : value
        if (!Object.is(next, hook.value)) { hook.value = next; driver.dirty = true }
      }]
    },
    useRef(initial) {
      const driver = currentDriver, index = driver.cursor++
      if (!driver.hooks[index]) driver.hooks[index] = { ref: { current: initial } }
      return driver.hooks[index].ref
    },
    useCallback(fn, deps) {
      const driver = currentDriver, index = driver.cursor++, old = driver.hooks[index]
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) driver.hooks[index] = { fn, deps }
      return driver.hooks[index].fn
    },
    useEffect(fn, deps) {
      const driver = currentDriver, index = driver.cursor++, old = driver.hooks[index]
      if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        driver.effects.push(() => { old?.cleanup?.(); driver.hooks[index] = { deps, cleanup: fn() } })
      }
    },
  }
  const window = {
    location,
    __ModuleLoader__: { load(entry) {
      assert.equal(entry.id, 'dsh-remote-sessions')
      module = entry.factory(name => {
        if (name === 'react') return React
        if (name === 'react-dom') return { createPortal: (node, target) => { assert.equal(target, document.body); return node } }
        throw new Error('Unexpected dependency: ' + name)
      })
    } },
  }
  const fetch = async (path, options = {}) => {
    const url = new URL(path, 'http://fixture.invalid')
    const request = { path: url.pathname, query: url.search, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal }
    requests.push(request)
    const endpoint = url.pathname.replace(/^\/api(?=\/remote-sessions\/)/, '')
    if (endpoint === '/remote-sessions/machines' && options.method === 'GET') return response({ machines: [machine] })
    if (endpoint === '/remote-sessions/ws-ls' && options.method === 'GET') return response({ path: url.searchParams.get('path'), entries: [] })
    if (fetchAction) return fetchAction(request, endpoint)
    throw new Error('Unexpected request: ' + path)
  }
  vm.runInContext(readFileSync(clientFile, 'utf8'), vm.createContext({ window, document, fetch, AbortController, console }), { filename: clientFile.pathname, timeout: 1000 })
  const slots = {
    inject(name, fn) { return fn() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  }
  module.apply({ inject(names, fn) {
    injections.push(Array.from(names))
    return fn({ get(name) { assert.equal(name, 'slots', 'no legacy sidebar or adoption service'); return slots } })
  } })
  const driver = (component, initialProps = {}) => {
    const instance = {
      hooks: [], effects: [], cursor: 0, props: initialProps, tree: null, dirty: true, disposed: false,
      flush() {
        if (this.disposed) return
        let rounds = 0
        while (this.dirty) {
          assert.ok(++rounds < 30, 'hook driver must converge')
          this.dirty = false; this.cursor = 0; this.effects = []; currentDriver = this
          try { this.tree = component(this.props) } finally { currentDriver = null }
          // Minimal attached host refs, not a simulated browser DOM.
          for (const node of walk(this.tree, node => node.props?.ref)) {
            node.props.ref.current = { querySelectorAll: () => [], contains: target => target === node.props.ref.current, focus() { document.activeElement = this } }
          }
          for (const effect of this.effects) effect()
        }
      },
      update(props) { this.props = { ...this.props, ...props }; this.dirty = true; this.flush() },
      async settle() { for (let i = 0; i < 4; i++) { await tick(); this.flush() } },
      dispose() { this.disposed = true; for (const hook of this.hooks) hook?.cleanup?.() },
    }
    instance.flush()
    return instance
  }
  return { module, registrations, injections, requests, navigation, location, document, driver, listeners }
}
async function settingsActions(env) {
  const slot = env.registrations.find(slot => slot.options.name === 'settings.section')
  assert.ok(slot, 'settings page is captured through the public slot')
  const pageElement = slot.component()
  const page = env.driver(pageElement.type, pageElement.props)
  await page.settle()
  const actionElement = element(page.tree, node => typeof node.type === 'function' && node.type.name === 'SelectedActions')
  return { page, actions: env.driver(actionElement.type, actionElement.props) }
}
async function remotePicker(env) {
  const slot = env.registrations.find(slot => slot.options.name.endsWith('.directoryFlow'))
  const picked = [], cancelled = []
  const picker = env.driver(slot.component, { open: true, busy: false, onPicked: path => picked.push(path), onCancel: () => cancelled.push(true) })
  click(picker, 'Remote machines'); await picker.settle()
  assert.equal(field(picker, 'Remote directory').props.value, machine.remoteCwd)
  return { picker, picked, cancelled }
}
function onlyReadOr(env, allowed) {
  assert.ok(env.requests.every(request => {
    const endpoint = request.path.replace(/^\/api/, '')
    return request.method === 'GET'
      ? ['/remote-sessions/machines', '/remote-sessions/ws-ls'].includes(endpoint)
      : request.method === 'POST' && allowed.includes(endpoint)
  }), 'only documented read routes and explicit selected mutation/prepare endpoints; no legacy URL, sync, mirror or local workspace adoption')
}

const show = 'Show selected sync / transfer'
const preview = 'Preview selection'
const apply = 'Confirm and apply this preview'
const pin = 'Explicitly set the remote default to this selected model'
const approval = 'I approve these source selections and the existing remote destination root'

test('factory/apply use only native slots and do not automatically synchronize legacy flags', async () => {
  const env = environment()
  assert.deepEqual(Object.keys(env.module).sort(), ['apply', 'inject', 'name'])
  assert.deepEqual(plain(env.module.inject), ['slots'])
  assert.deepEqual(env.injections, [['slots']])
  assert.deepEqual(env.registrations.map(slot => slot.options.name), ['settings.section', 'conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'])
  assert.equal(env.registrations[1].component, env.registrations[2].component)
  const { page, actions } = await settingsActions(env)
  assert.deepEqual(env.requests.map(request => [request.method, request.path]), [['GET', '/remote-sessions/machines']])
  assert.equal(actions.tree.type, 'div')
  assert.equal(walk(page.tree, node => node.type === 'iframe').length, 0)
  page.dispose(); actions.dispose()
})

test('selected model preview sends only explicit selections, key refs and an opt-in pin; apply sends only consumed token', async () => {
  const env = environment({ fetchAction(request, endpoint) {
    if (endpoint.endsWith('/preview')) return response({ token: 'model-preview-1', preview: { entries: [{ provider: 'chosen-provider', model: 'chosen-model' }], credentialRefs: ['chosen-ref'] } })
    if (endpoint.endsWith('/apply')) return response({ ok: true })
    throw new Error('Unexpected endpoint ' + endpoint)
  } })
  const { actions } = await settingsActions(env)
  click(actions, show)
  assert.ok(button(actions, apply).props.disabled, 'apply is unavailable before a preview')
  change(actions, 'Selected provider', ' chosen-provider ')
  change(actions, 'Selected model', ' chosen-model ')
  change(actions, 'API-key refs to copy (one per line; empty copies no keys)', ' chosen-ref\n\n another-ref ')
  check(actions, pin)
  change(actions, 'Default reasoning effort (optional)', ' high ')
  await click(actions, preview); await actions.settle()
  const first = env.requests.at(-1)
  assert.equal(first.path, '/remote-sessions/selected-sync/preview')
  assert.equal(first.method, 'POST')
  assert.deepEqual(first.body, { machine: 'test', selections: [{ provider: 'chosen-provider', model: 'chosen-model' }], credentialRefs: ['chosen-ref', 'another-ref'], defaultPin: { provider: 'chosen-provider', model: 'chosen-model', reasoningEffort: 'high' } })
  assert.match(text(actions.tree), /Preview only — no remote files were written/)
  const oldHandler = button(actions, apply).props.onClick
  const firstApply = click(actions, apply)
  oldHandler() // two clicks before request settlement cannot duplicate mutation
  await firstApply; await actions.settle()
  assert.deepEqual(env.requests.at(-1).body, { token: 'model-preview-1', confirm: true })
  assert.equal(env.requests.filter(request => request.path.endsWith('/apply')).length, 1)
  assert.ok(button(actions, apply).props.disabled, 'a token is consumed before mutation and cannot be replayed')
  check(actions, pin, false)
  change(actions, 'API-key refs to copy (one per line; empty copies no keys)', '')
  await click(actions, preview); await actions.settle()
  assert.deepEqual(env.requests.at(-1).body, { machine: 'test', selections: [{ provider: 'chosen-provider', model: 'chosen-model' }], credentialRefs: [] })
  change(actions, 'Selected model', 'new-selection')
  assert.ok(button(actions, apply).props.disabled, 'editing any selection invalidates the preview')
  assert.equal(walk(actions.tree, node => node.type === 'pre' && node.props.role !== 'status').length, 0)
  onlyReadOr(env, ['/remote-sessions/selected-sync/preview', '/remote-sessions/selected-sync/apply'])
  actions.dispose()
})

test('selected skills preview requires explicit root approval and changing mode invalidates token', async () => {
  const env = environment({ fetchAction: () => response({ token: 'skills-preview', preview: { entries: [] } }) })
  const { actions } = await settingsActions(env)
  click(actions, show)
  change(actions, 'Selected operation', 'skills')
  assert.ok(button(actions, preview).props.disabled, 'transfer preview requires destination approval')
  change(actions, 'Local DSH skills root (absolute)', ' /local/.dsh/skills ')
  change(actions, 'Selected skill directory names (one per line)', ' office-docx\n\n office-pptx ')
  check(actions, approval)
  await click(actions, preview); await actions.settle()
  assert.equal(env.requests.at(-1).path, '/remote-sessions/selected-transfer/preview')
  assert.deepEqual(env.requests.at(-1).body, { machine: 'test', kind: 'skills', localRoot: '/local/.dsh/skills', selections: ['office-docx', 'office-pptx'], approval: { kind: 'skills', root: '~/.dsh/skills', confirmed: true } })
  await click(actions, apply); await actions.settle()
  assert.deepEqual(env.requests.at(-1).body, { machine: 'test', token: 'skills-preview', confirm: true, conflictAuthorizations: [] })
  await click(actions, preview); await actions.settle()
  change(actions, 'Selected operation', 'files')
  assert.ok(button(actions, apply).props.disabled, 'switching operation consumes no old-mode preview')
  onlyReadOr(env, ['/remote-sessions/selected-transfer/preview', '/remote-sessions/selected-transfer/apply'])
  actions.dispose()
})

test('selected files apply requires per-conflict hashes, consumes uncertain mutation once and never sends bytes/secrets', async () => {
  const mutation = deferred()
  const env = environment({ fetchAction(request, endpoint) {
    if (endpoint.endsWith('/preview')) return response({ token: 'files-preview', preview: { entries: [
      { path: 'note.txt', status: 'conflict', localSha256: 'a'.repeat(64), remoteSha256: 'b'.repeat(64) },
      { path: 'new.txt', status: 'new', localSha256: 'c'.repeat(64) },
    ] } })
    if (endpoint.endsWith('/apply')) return mutation.promise
    throw new Error('Unexpected endpoint ' + endpoint)
  } })
  const { actions } = await settingsActions(env)
  click(actions, show); change(actions, 'Selected operation', 'files')
  change(actions, 'Local workspace root (absolute)', ' /local/work ')
  change(actions, 'Existing remote workspace root (absolute)', ' /remote/work ')
  change(actions, 'Selected relative file paths (one per line)', ' note.txt\n new.txt\n ')
  check(actions, approval)
  await click(actions, preview); await actions.settle()
  assert.deepEqual(env.requests.at(-1).body, { machine: 'test', kind: 'files', localRoot: '/local/work', selections: ['note.txt', 'new.txt'], approval: { kind: 'files', root: '/remote/work', confirmed: true } })
  assert.ok(button(actions, apply).props.disabled, 'differing file requires an explicit per-file authorization')
  check(actions, 'Approve replacement of exactly this differing file: note.txt')
  const oldHandler = button(actions, apply).props.onClick
  const applying = click(actions, apply)
  oldHandler()
  assert.equal(env.requests.filter(request => request.path.endsWith('/apply')).length, 1, 'pending mutation cannot be duplicated')
  assert.ok(button(actions, apply).props.disabled)
  assert.deepEqual(env.requests.at(-1).body, { machine: 'test', token: 'files-preview', confirm: true, conflictAuthorizations: [{ path: 'note.txt', approveOverwrite: true, expectedLocalSha256: 'a'.repeat(64), expectedRemoteSha256: 'b'.repeat(64) }] })
  mutation.reject(new Error('Connection lost after remote may have committed'))
  await applying; await actions.settle()
  assert.match(text(actions.tree), /No retry was attempted/)
  assert.match(text(actions.tree), /obtain a new preview/)
  assert.ok(button(actions, apply).props.disabled)
  click(actions, 'Hide selected sync / transfer'); click(actions, show); await actions.settle()
  assert.equal(env.requests.filter(request => request.path.endsWith('/apply')).length, 1, 'hide/show and rerenders do not replay consumed mutations')
  assert.ok(button(actions, apply).props.disabled)
  for (const request of env.requests.filter(request => request.method === 'POST')) {
    const serialized = JSON.stringify(request.body)
    assert.doesNotMatch(serialized, /"(?:body|content|bytes|apiKey|apiKeys|secret|secrets|credentials|providers|memories|prune|overwriteAll)"\s*:/, 'browser sends selection references/hashes only, never file contents, full stores or secret values')
  }
  onlyReadOr(env, ['/remote-sessions/selected-transfer/preview', '/remote-sessions/selected-transfer/apply'])
  actions.dispose()
})

test('pending preview deduplicates clicks and failed preview cannot enable apply', async () => {
  const pending = deferred()
  const env = environment({ fetchAction: () => pending.promise })
  const { actions } = await settingsActions(env)
  click(actions, show)
  const handler = button(actions, preview).props.onClick
  const running = click(actions, preview)
  handler()
  assert.equal(env.requests.filter(request => request.method === 'POST').length, 1)
  assert.ok(field(actions, 'Selected operation').props.disabled)
  pending.resolve(response({ error: 'Preview denied' }, 403))
  await running; await actions.settle()
  assert.match(text(actions.tree), /Preview denied/)
  assert.ok(button(actions, apply).props.disabled)
  assert.ok(!button(actions, preview).props.disabled)
  actions.dispose()
})

test('native picker performs real prepare POST then one pinned assign with encoded workspace and no local adoption', async () => {
  const pending = deferred()
  const env = environment({ fetchAction: () => pending.promise })
  const { picker, picked } = await remotePicker(env)
  change(picker, 'Remote directory', '/remote/space &?#目录')
  const handler = button(picker, 'Open remote runtime here').props.onClick
  const connecting = click(picker, 'Open remote runtime here')
  handler()
  assert.equal(env.requests.filter(request => request.method === 'POST').length, 1)
  assert.deepEqual(env.requests.at(-1).body, {})
  assert.equal(env.requests.at(-1).path, '/remote-sessions/prepare')
  assert.equal(env.requests.at(-1).query, '?machine=test')
  assert.ok(env.requests.at(-1).signal instanceof AbortSignal)
  assert.equal(picked.length, 0)
  pending.resolve(response({ path: MOUNT }))
  await connecting; await picker.settle()
  assert.deepEqual(env.navigation, [MOUNT + '?workspace=' + encodeURIComponent('/remote/space &?#目录')])
  assert.deepEqual(picked, [])
  onlyReadOr(env, ['/remote-sessions/prepare'])
  picker.dispose()
})

test('failed prepare preserves picker/error and never mutates URL, sync, mirror or local workspace', async () => {
  const env = environment({ fetchAction: () => response({ error: 'Existing runtime is unavailable' }, 503) })
  const { picker, picked } = await remotePicker(env)
  await click(picker, 'Open remote runtime here'); await picker.settle()
  assert.equal(walk(picker.tree, node => node.props?.role === 'dialog').length, 1)
  assert.match(text(element(picker.tree, node => node.props?.role === 'alert')), /Existing runtime is unavailable/)
  assert.ok(!button(picker, 'Open remote runtime here').props.disabled)
  assert.deepEqual(env.navigation, [])
  assert.deepEqual(picked, [])
  onlyReadOr(env, ['/remote-sessions/prepare'])
  picker.dispose()
})

for (const path of ['https://evil.invalid/', '//evil.invalid/', '/remote-sessions/native/test/not-pinned/', MOUNT + '../other/', MOUNT + '?token=host-secret', '/remote-sessions/native/test/0123456789abcdef0123/extra']) {
  test('native picker rejects noncanonical prepare mount ' + JSON.stringify(path), async () => {
    const env = environment({ fetchAction: () => response({ path }) })
    const { picker, picked } = await remotePicker(env)
    await click(picker, 'Open remote runtime here'); await picker.settle()
    assert.deepEqual(env.navigation, [])
    assert.deepEqual(picked, [])
    assert.match(text(element(picker.tree, node => node.props?.role === 'alert')), /Invalid.*(?:mount|runtime)/)
    picker.dispose()
  })
}

for (const outcome of ['success', 'failure']) {
  test('close/reopen aborts prepare and ignores stale ' + outcome + ' without unlocking a newer generation', async () => {
    const first = deferred(), second = deferred()
    let count = 0
    const env = environment({ fetchAction: () => (++count === 1 ? first : second).promise })
    const { picker, picked } = await remotePicker(env)
    const oldConnect = click(picker, 'Open remote runtime here')
    const oldRequest = env.requests.at(-1)
    picker.update({ open: false })
    assert.equal(oldRequest.signal.aborted, true)
    picker.update({ open: true }); await picker.settle()
    const newConnect = click(picker, 'Open remote runtime here')
    assert.ok(button(picker, 'Connecting…').props.disabled)
    first.resolve(outcome === 'success' ? response({ path: MOUNT }) : response({ error: 'stale failure' }, 503))
    await oldConnect; await picker.settle()
    assert.deepEqual(env.navigation, [])
    assert.deepEqual(picked, [])
    assert.equal(walk(picker.tree, node => node.props?.role === 'alert').length, 0)
    assert.ok(button(picker, 'Connecting…').props.disabled, 'old finally does not unlock newer pending generation')
    second.resolve(response({ error: 'Current generation failure' }, 503))
    await newConnect; await picker.settle()
    assert.match(text(element(picker.tree, node => node.props?.role === 'alert')), /Current generation failure/)
    assert.ok(!button(picker, 'Open remote runtime here').props.disabled)
    onlyReadOr(env, ['/remote-sessions/prepare'])
    picker.dispose()
  })
}

test('native picker rejects an otherwise valid mount for a different machine authority', async () => {
  const env = environment({ fetchAction: () => response({ path: MOUNT.replace('/test/', '/other/') }) })
  const { picker, picked } = await remotePicker(env)
  await click(picker, 'Open remote runtime here'); await picker.settle()
  assert.deepEqual(env.navigation, [])
  assert.deepEqual(picked, [])
  assert.match(text(element(picker.tree, node => node.props?.role === 'alert')), /authority.*match selection/)
  onlyReadOr(env, ['/remote-sessions/prepare'])
  picker.dispose()
})

test('relative remote directory disables native connect without issuing a prepare', async () => {
  const env = environment()
  const { picker, picked } = await remotePicker(env)
  change(picker, 'Remote directory', 'relative/path')
  assert.ok(button(picker, 'Open remote runtime here').props.disabled)
  assert.equal(env.requests.filter(request => request.method === 'POST').length, 0)
  assert.deepEqual(env.navigation, [])
  assert.deepEqual(picked, [])
  picker.dispose()
})

test('disposing picker aborts prepare and suppresses a late successful mount', async () => {
  const pending = deferred()
  const env = environment({ fetchAction: () => pending.promise })
  const { picker, picked } = await remotePicker(env)
  const connecting = click(picker, 'Open remote runtime here')
  const request = env.requests.at(-1)
  picker.dispose()
  assert.equal(request.signal.aborted, true)
  pending.resolve(response({ path: MOUNT }))
  await connecting
  assert.deepEqual(env.navigation, [])
  assert.deepEqual(picked, [])
})

test('dsh-app prepare uses /api prefix but navigates only to the returned pinned native mount', async () => {
  const env = environment({ protocol: 'dsh-app:', fetchAction: () => response({ path: MOUNT }) })
  const { picker, picked } = await remotePicker(env)
  await click(picker, 'Open remote runtime here'); await picker.settle()
  assert.equal(env.requests.at(-1).path, '/api/remote-sessions/prepare')
  assert.deepEqual(env.navigation, [MOUNT + '?workspace=' + encodeURIComponent('/remote/home')])
  assert.deepEqual(picked, [])
  picker.dispose()
})
