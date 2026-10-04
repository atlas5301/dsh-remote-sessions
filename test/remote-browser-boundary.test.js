import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/* Run with: node --test dsh-remote-sessions/test/remote-browser-boundary.test.js
 * These tests execute the actual, unmodified browser source, not copies of its
 * mapping/intent logic. No fetch is sent and no SSH, GUI or third-party code runs.
 * VM limits: Node's real URL/Request/FormData/AbortController supply URL and body
 * semantics, but are not a browser fetch implementation. DOM/Storage/transports
 * below implement only the exercised surfaces, not layout, React rendering,
 * CORS, redirects, named Storage properties or native event delivery. Trusted
 * storage events are explicitly injected by the harness (JS cannot forge one in
 * a browser); constructed events remain untrusted. Service reactivation models
 * cleanup followed by calling the SAME saved injection callback with new inner
 * effects. It is not an integration test of Cordis or the native UI service.
 */
const bootstrapFile = new URL('../lib/remote-bootstrap.js', import.meta.url)
const uiFile = new URL('../lib/remote-ui.js', import.meta.url)
const ORIGIN = 'http://127.0.0.1:19387'
const IDENTITY = '0123456789abcdef0123'
const OTHER_IDENTITY = 'fedcba9876543210fedc'
const MOUNT = `/remote-sessions/native/edge/${IDENTITY}/`
const PREFIX = `remote-dsh.${IDENTITY}.`
const HOST = Object.freeze({ name: 'edge', identity: IDENTITY, mount: MOUNT })
const mounted = path => ORIGIN + MOUNT + path.replace(/^\//, '')
const tick = () => new Promise(resolve => setImmediate(resolve))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Storage.key takes a WebIDL unsigned long, not an arbitrary array subscript.
function unsignedLong(value) {
  const number = +value
  if (!Number.isFinite(number) || number === 0) return 0
  return ((Math.trunc(number) % 2 ** 32) + 2 ** 32) % 2 ** 32
}
function domString(value) { return `${value}` }

function makeBrowser({ search = '', baseURI = mounted(''), installBoundary = true } = {}) {
  const calls = { fetch: [], xhr: [], websocket: [], eventsource: [], beacon: [], navigation: [], history: [], order: [] }
  const eventState = new WeakMap()
  class BrowserEvent {
    constructor(type, init = {}, trusted = false) {
      this.type = String(type)
      this.defaultPrevented = false
      Object.defineProperty(this, 'isTrusted', { value: trusted, enumerable: true })
      Object.assign(this, init)
      eventState.set(this, { stopped: false })
    }
    stopImmediatePropagation() { eventState.get(this).stopped = true }
    preventDefault() { this.defaultPrevented = true }
  }
  class StorageEvent extends BrowserEvent {
    constructor(type, init = {}) {
      super(type)
      this.key = init.key == null ? null : domString(init.key)
      this.oldValue = init.oldValue == null ? null : domString(init.oldValue)
      this.newValue = init.newValue == null ? null : domString(init.newValue)
      this.storageArea = init.storageArea ?? null
      this.url = init.url == null ? '' : domString(init.url)
    }
  }
  class EventTarget {
    constructor() { this.listeners = [] }
    addEventListener(type, listener, options = false) {
      const capture = typeof options === 'object' ? !!options.capture : !!options
      if (!this.listeners.some(entry => entry.type === type && entry.listener === listener && entry.capture === capture)) {
        this.listeners.push({ type, listener, capture })
      }
    }
    removeEventListener(type, listener, options = false) {
      const capture = typeof options === 'object' ? !!options.capture : !!options
      this.listeners = this.listeners.filter(entry => !(entry.type === type && entry.listener === listener && entry.capture === capture))
    }
    dispatchEvent(event) {
      const listeners = this.listeners.filter(entry => entry.type === event.type)
      // Window capture listeners run before non-capture listeners at the target.
      for (const entry of [...listeners.filter(entry => entry.capture), ...listeners.filter(entry => !entry.capture)]) {
        if (eventState.get(event).stopped) break
        entry.listener.call(this, event)
      }
      return !event.defaultPrevented
    }
  }

  // A fresh Storage prototype for EVERY VM prevents instrumentation leaking
  // between tests. Raw inspection never calls the patched public methods.
  const storageData = new WeakMap()
  class Storage {
    constructor(entries = []) { storageData.set(this, new Map(entries)) }
    getItem(key) {
      if (!arguments.length) throw new TypeError('getItem requires a key')
      return storageData.get(this).get(domString(key)) ?? null
    }
    setItem(key, value) {
      if (arguments.length < 2) throw new TypeError('setItem requires key and value')
      storageData.get(this).set(domString(key), domString(value))
    }
    removeItem(key) {
      if (!arguments.length) throw new TypeError('removeItem requires a key')
      storageData.get(this).delete(domString(key))
    }
    key(index) {
      if (!arguments.length) throw new TypeError('key requires an index')
      return [...storageData.get(this).keys()][unsignedLong(index)] ?? null
    }
    clear() { storageData.get(this).clear() }
  }
  Object.defineProperty(Storage.prototype, 'length', {
    configurable: true, enumerable: true,
    get() { return storageData.get(this).size },
  })
  const localStorage = new Storage()
  const sessionStorage = new Storage()
  const unrelatedStorage = new Storage()
  const rawStorage = storage => storageData.get(storage)

  let href = mounted('conversation/thread') + search
  const location = {
    get href() { return href },
    set href(value) {
      href = new URL(String(value), href).href
      calls.navigation.push(href)
      calls.order.push('navigate')
    },
    get search() { return new URL(href).search },
    get hash() { return new URL(href).hash },
    get origin() { return new URL(href).origin },
  }
  const history = {
    replaceState(state, title, value) {
      const next = new URL(String(value), href)
      assert.equal(next.origin, new URL(href).origin, 'replaceState cannot change origin')
      href = next.href
      calls.history.push({ state, title, href })
      calls.order.push('replaceState')
    },
  }
  class Element {
    constructor(tagName = 'DIV') {
      this.tagName = tagName
      this.attributes = new Map()
      this.style = { cssText: '' }
      this.children = []
      this.parentNode = null
      this.isConnected = false
      this.textContent = ''
    }
    setAttribute(name, value) { this.attributes.set(String(name).toLowerCase(), domString(value)) }
    getAttribute(name) { return this.attributes.get(String(name).toLowerCase()) ?? null }
    append(child) {
      child.parentNode = this
      child.isConnected = this.isConnected
      this.children.push(child)
    }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this)
      this.parentNode = null
      this.isConnected = false
    }
    closest(selector) { return selector === 'a[href]' && this.tagName === 'A' && this.getAttribute('href') !== null ? this : null }
    focus() { document.activeElement = this }
  }
  const elementClasses = {}
  const tagClasses = new Map()
  for (const [className, tagName, attributes] of [
    ['HTMLAnchorElement', 'A', ['href']], ['HTMLFormElement', 'FORM', ['action']],
    ['HTMLScriptElement', 'SCRIPT', ['src']], ['HTMLLinkElement', 'LINK', ['href']],
    ['HTMLImageElement', 'IMG', ['src']], ['HTMLIFrameElement', 'IFRAME', ['src']],
    ['HTMLSourceElement', 'SOURCE', ['src']], ['HTMLVideoElement', 'VIDEO', ['src', 'poster']],
    ['HTMLAudioElement', 'AUDIO', ['src']],
  ]) {
    const Constructor = class extends Element { constructor() { super(tagName) } }
    for (const attribute of attributes) Object.defineProperty(Constructor.prototype, attribute, {
      configurable: true, enumerable: true,
      get() { const value = this.getAttribute(attribute); return value === null ? '' : new URL(value, document.baseURI).href },
      // Native IDL setters do not call a JS override of setAttribute.
      set(value) { this.attributes.set(attribute, domString(value)) },
    })
    elementClasses[className] = Constructor
    tagClasses.set(tagName, Constructor)
  }
  const document = new EventTarget()
  document.baseURI = baseURI
  document.body = new Element('BODY')
  document.body.isConnected = true
  document.activeElement = document.body
  document.createElement = name => {
    const tagName = String(name).toUpperCase()
    const Constructor = tagClasses.get(tagName)
    return Constructor ? new Constructor() : new Element(tagName)
  }

  const window = new EventTarget()
  const resolveUrl = value => new URL(String(value), document.baseURI).href
  class XMLHttpRequest {
    open(method, url, ...rest) {
      this.openCall = { receiver: this, method, url: resolveUrl(url), rawUrl: url, rest }
      calls.xhr.push(this.openCall)
    }
    send(body) { this.body = body }
  }
  class WebSocket {
    static CONNECTING = 0
    static OPEN = 1
    constructor(url, protocols) {
      const resolved = new URL(String(url), document.baseURI)
      if (resolved.protocol === 'http:') resolved.protocol = 'ws:'
      if (resolved.protocol === 'https:') resolved.protocol = 'wss:'
      if (!['ws:', 'wss:'].includes(resolved.protocol)) throw new SyntaxError('Unsupported WebSocket scheme')
      this.url = resolved.href
      this.protocols = protocols
      calls.websocket.push({ receiver: this, url: this.url, rawUrl: url, protocols })
    }
  }
  class EventSource {
    constructor(url, options) {
      this.url = resolveUrl(url)
      this.options = options
      calls.eventsource.push({ receiver: this, url: this.url, rawUrl: url, options })
    }
  }
  const navigator = {
    sendBeacon(url, body) {
      assert.equal(this, navigator, 'native beacon receiver is retained')
      calls.beacon.push({ url: resolveUrl(url), rawUrl: url, body })
      return true
    },
  }
  Object.assign(window, {
    window, document, navigator, location, history, localStorage, sessionStorage,
    URL, URLSearchParams, Request, Headers, FormData, Blob, AbortController,
    Storage, StorageEvent, Element, XMLHttpRequest, WebSocket, EventSource,
    ...elementClasses, __REMOTE_HOST__: HOST,
    fetch(input, init) {
      assert.equal(this, window, 'native fetch receiver is retained')
      calls.fetch.push({ input, init, url: input instanceof Request ? input.url : resolveUrl(input) })
      return Promise.resolve({ ok: true })
    },
  })
  // Keep the mock Window separate from the contextified global proxy. Using
  // Window itself as the sandbox changes its identity across the VM membrane
  // and would produce a fake native-fetch receiver failure. These source files
  // use the supplied window; globalThis === window is outside this harness.
  const context = vm.createContext({ ...window, window })
  if (installBoundary) vm.runInContext(readFileSync(bootstrapFile, 'utf8'), context, { filename: bootstrapFile.pathname })
  return {
    window, context, document, calls, rawStorage, unrelatedStorage,
    emitNativeStorage(init) {
      const event = new BrowserEvent('storage', init, true)
      window.dispatchEvent(event)
      return event
    },
  }
}

const transportNames = ['fetch', 'Request', 'XHR', 'WebSocket', 'EventSource', 'beacon']
function transport(browser, name, url) {
  const { window } = browser
  switch (name) {
    case 'fetch': return window.fetch(url)
    case 'Request': return window.fetch(new Request(new URL(url, browser.document.baseURI)))
    case 'XHR': { const xhr = new window.XMLHttpRequest(); xhr.open('GET', url, true); return xhr }
    case 'WebSocket': return new window.WebSocket(url)
    case 'EventSource': return new window.EventSource(url)
    case 'beacon': return window.navigator.sendBeacon(url, new Blob(['body']))
    default: throw new Error(`Unknown transport: ${name}`)
  }
}
function transportCall(browser, name) {
  const key = { fetch: 'fetch', Request: 'fetch', XHR: 'xhr', WebSocket: 'websocket', EventSource: 'eventsource', beacon: 'beacon' }[name]
  return browser.calls[key].at(-1)
}
function nativeCallCount(browser) {
  return ['fetch', 'xhr', 'websocket', 'eventsource', 'beacon'].reduce((sum, key) => sum + browser.calls[key].length, 0)
}
async function expectBlocked(browser, name, url) {
  const count = nativeCallCount(browser)
  if (name === 'fetch' || name === 'Request') {
    let result
    assert.doesNotThrow(() => { result = transport(browser, name, url) }, `${name} returns a rejection rather than throwing`)
    assert.equal(typeof result?.then, 'function')
    await assert.rejects(result, /cannot (?:access another local runtime|switch authority implicitly)/i)
  } else {
    assert.throws(() => transport(browser, name, url), /cannot (?:access another local runtime|switch authority implicitly)/i)
  }
  assert.equal(nativeCallCount(browser), count, `${name} must not reach the native transport`)
}

for (const name of transportNames) {
  test(`${name}: root-absolute business URLs are pinned to the selected identity mount`, async () => {
    const browser = makeBrowser()
    assert.equal(browser.window.__DSH_REMOTE_HOST__, HOST)
    await transport(browser, name, '/api/workspaces?label=one%20two&n=3')
    const expected = mounted('api/workspaces?label=one%20two&n=3')
    assert.equal(transportCall(browser, name).url, name === 'WebSocket' ? expected.replace(/^http:/, 'ws:') : expected)
    await transport(browser, name, ORIGIN + '/api/native-token')
    assert.equal(new URL(transportCall(browser, name).url).pathname, MOUNT + 'api/native-token')
  })

  test(`${name}: same-origin relative and already-mounted URLs keep their destination`, async () => {
    const browser = makeBrowser({ baseURI: mounted('client/views/') })
    for (const url of ['api/workspaces', './api/workspaces?q=a%2Fb', '../assets/runtime.js', '?generation=2', MOUNT + 'api/pinned', mounted('api/pinned')]) {
      await transport(browser, name, url)
      const expected = new URL(url, browser.document.baseURI)
      if (name === 'WebSocket') expected.protocol = 'ws:'
      assert.equal(transportCall(browser, name).url, expected.href, url)
      assert.equal(expected.pathname.startsWith(MOUNT), true)
    }
  })

  test(`${name}: another machine or identity native mount is blocked before transport`, async () => {
    const browser = makeBrowser()
    for (const path of [
      `/remote-sessions/native/edge/${OTHER_IDENTITY}/api/workspaces`,
      `/remote-sessions/native/other/${IDENTITY}/api/workspaces`,
      `/remote-sessions/native/edge/${IDENTITY}-lookalike/api/workspaces`,
      MOUNT + '../' + OTHER_IDENTITY + '/api/workspaces',
    ]) {
      await expectBlocked(browser, name, path)
      await expectBlocked(browser, name, ORIGIN + path)
    }
  })
}

// WHATWG URL canonicalization covers shortened, integer and hex IPv4 spellings.
// Trailing-dot localhost and IPv4-mapped IPv6 still designate loopback; a guard
// must not confuse their spelling with permission to reach a second runtime.
for (const hostname of [
  '127.0.0.1', '127.0.0.2', '127.255.255.254', '127.1', '2130706433', '0x7f000001',
  'localhost', 'plugin.localhost', '[::1]', 'localhost.', 'plugin.localhost.', '[::ffff:127.0.0.1]',
]) {
  test(`all transports block loopback ${hostname} on another port`, async t => {
    for (const name of transportNames) await t.test(name, async () => {
      const browser = makeBrowser()
      const scheme = name === 'WebSocket' ? 'ws' : 'http'
      await expectBlocked(browser, name, `${scheme}://${hostname}:19388/api/local-token`)
    })
  })
}

test('secure transports and protocol-relative URLs cannot reach another local port', async t => {
  for (const name of transportNames) await t.test(name, async () => {
    const browser = makeBrowser()
    const scheme = name === 'WebSocket' ? 'wss' : 'https'
    await expectBlocked(browser, name, `${scheme}://localhost:19388/api/local-token`)
    await expectBlocked(browser, name, '//127.0.0.1:19388/api/local-token')
  })
})

test('non-loopback external authorities are not spuriously rewritten', async () => {
  const browser = makeBrowser()
  const external = 'https://example.invalid/api/plugin?q=1'
  for (const name of transportNames) {
    const url = name === 'WebSocket' ? external.replace('https:', 'wss:') : external
    await transport(browser, name, url)
    assert.equal(transportCall(browser, name).url, url)
    if (name === 'fetch') assert.equal(transportCall(browser, name).input, url)
  }
  const request = new Request(external)
  await browser.window.fetch(request)
  assert.equal(browser.calls.fetch.at(-1).input, request, 'an unchanged Request keeps its identity')
})

test('fetch init multipart body, headers and AbortSignal are forwarded untouched', async () => {
  const browser = makeBrowser()
  const form = new FormData()
  form.append('directory', '/remote/work space')
  form.append('upload', new Blob(['file bytes'], { type: 'text/plain' }), 'note.txt')
  const controller = new AbortController()
  const headers = new Headers({ 'x-plugin-token': 'remote-only' })
  const init = { method: 'POST', body: form, signal: controller.signal, headers, credentials: 'include', cache: 'no-store' }
  await browser.window.fetch('/api/upload', init)
  const call = browser.calls.fetch.at(-1)
  assert.equal(call.url, mounted('api/upload'))
  assert.equal(call.init, init)
  assert.equal(call.init.body, form)
  assert.equal(call.init.signal, controller.signal)
  assert.equal(call.init.headers, headers)
  assert.equal(headers.has('content-type'), false, 'wrapper must not invent a multipart boundary')
  assert.equal(form.get('upload').name, 'note.txt')
  controller.abort(new Error('cancel upload'))
  assert.equal(call.init.signal.aborted, true)
})

test('mapped real Request retains multipart boundary, metadata and following signal', async () => {
  const browser = makeBrowser()
  const form = new FormData()
  form.append('directory', '/remote/work space')
  form.append('upload', new Blob(['file bytes'], { type: 'text/plain' }), 'note.txt')
  const controller = new AbortController()
  const request = new Request(ORIGIN + '/api/upload', {
    method: 'POST', body: form, signal: controller.signal,
    headers: { 'x-plugin-token': 'remote-only' }, credentials: 'include',
    mode: 'cors', redirect: 'manual', cache: 'no-store',
  })
  const contentType = request.headers.get('content-type')
  assert.match(contentType, /^multipart\/form-data; boundary=/)
  const overrides = { headers: { 'x-second-option': 'preserved' } }
  await browser.window.fetch(request, overrides)
  const call = browser.calls.fetch.at(-1)
  const mappedRequest = call.input
  assert.ok(mappedRequest instanceof Request, 'use the real Request rather than a URL-only mock')
  assert.notEqual(mappedRequest, request)
  assert.equal(mappedRequest.url, mounted('api/upload'))
  for (const property of ['method', 'credentials', 'mode', 'redirect', 'cache', 'integrity', 'referrerPolicy']) {
    assert.equal(mappedRequest[property], request[property], property)
  }
  assert.equal(mappedRequest.headers.get('content-type'), contentType)
  assert.equal(mappedRequest.headers.get('x-plugin-token'), 'remote-only')
  assert.equal(call.init, overrides)
  const parsed = await mappedRequest.clone().formData()
  assert.equal(parsed.get('directory'), '/remote/work space')
  assert.equal(parsed.get('upload').name, 'note.txt')
  assert.equal(await parsed.get('upload').text(), 'file bytes')
  assert.equal(mappedRequest.signal.aborted, false)
  const reason = new Error('cancel request')
  controller.abort(reason)
  assert.equal(request.signal.aborted, true)
  assert.equal(mappedRequest.signal.aborted, true, 'Request cloning may create a following, not identical, signal')
  assert.equal(mappedRequest.signal.reason, reason)
})

test('transport wrappers preserve XHR options/body, constructor prototypes, arguments and beacon body', () => {
  const browser = makeBrowser()
  const { window } = browser
  const body = new FormData()
  body.append('token', 'remote')
  const xhr = new window.XMLHttpRequest()
  xhr.open('POST', '/api/upload', false, 'remote-user', 'remote-password')
  xhr.send(body)
  assert.equal(xhr.openCall.method, 'POST')
  assert.deepEqual(xhr.openCall.rest, [false, 'remote-user', 'remote-password'])
  assert.equal(xhr.body, body)
  const protocols = ['remote-mux', 'v2']
  class PluginSocket extends window.WebSocket {}
  const socket = new PluginSocket('/api/remote.mux', protocols)
  assert.ok(socket instanceof PluginSocket)
  assert.ok(socket instanceof window.WebSocket)
  assert.equal(window.WebSocket.OPEN, 1)
  assert.equal(socket.protocols, protocols)
  assert.equal(socket.url, mounted('api/remote.mux').replace(/^http:/, 'ws:'))
  const options = { withCredentials: true }
  class PluginEvents extends window.EventSource {}
  const events = new PluginEvents('/api/events', options)
  assert.ok(events instanceof PluginEvents)
  assert.ok(events instanceof window.EventSource)
  assert.equal(events.options, options)
  assert.equal(window.navigator.sendBeacon('/api/telemetry', body), true)
  assert.equal(browser.calls.beacon.at(-1).body, body)
})

test('root-absolute dynamic resource and form attributes/properties are pinned; cross-mount links cannot navigate', () => {
  const browser = makeBrowser()
  for (const [tag, attributes] of [
    ['a', ['href']], ['form', ['action']], ['script', ['src']], ['link', ['href']],
    ['img', ['src']], ['iframe', ['src']], ['source', ['src']], ['video', ['src', 'poster']], ['audio', ['src']],
  ]) {
    for (const attribute of attributes) {
      const element = browser.document.createElement(tag)
      element.setAttribute(attribute.toUpperCase(), '/assets/file?a=1')
      assert.equal(element[attribute], mounted('assets/file?a=1'), `${tag}.${attribute} attribute`)
      element[attribute] = '/api/download'
      assert.equal(element[attribute], mounted('api/download'), `${tag}.${attribute} property`)
      element.setAttribute(attribute, 'assets/relative')
      assert.equal(element.getAttribute(attribute), 'assets/relative', 'relative attribute itself is unchanged')
    }
  }
  const anchor = browser.document.createElement('a')
  assert.throws(() => { anchor.href = `/remote-sessions/native/edge/${OTHER_IDENTITY}/` }, /cannot switch authority/i)
  // Native parser-created attributes do not pass through a JS setAttribute patch.
  anchor.attributes.set('href', `/remote-sessions/native/other/${OTHER_IDENTITY}/`)
  let prevented = false
  browser.document.listeners.find(entry => entry.type === 'click').listener({ target: anchor, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
})

for (const storageName of ['localStorage', 'sessionStorage']) {
  test(`${storageName}: every Storage method isolates arbitrary native and plugin token keys`, () => {
    const browser = makeBrowser()
    const storage = browser.window[storageName]
    const raw = browser.rawStorage(storage)
    const keys = ['dsh-plugin-token', 'third.party.oauth.access_token', 'token', '', 'remote-dsh.not-the-authority.token']
    for (const key of keys) {
      raw.set(key, 'LOCAL-' + key)
      raw.set(`remote-dsh.${OTHER_IDENTITY}.` + key, 'FOREIGN-' + key)
    }
    raw.set(PREFIX + 'persisted', 'selected-before-boot')
    assert.equal(storage.length, 1)
    assert.equal(storage.key(0), 'persisted')
    assert.equal(storage.getItem('persisted'), 'selected-before-boot')
    for (const key of keys) {
      assert.equal(storage.getItem(key), null, `no local/foreign ${JSON.stringify(key)} leaks`)
      assert.equal(storage.setItem(key, 'REMOTE-' + key), undefined)
      assert.equal(storage.getItem(key), 'REMOTE-' + key)
      assert.equal(raw.get(PREFIX + key), 'REMOTE-' + key)
      assert.equal(raw.get(key), 'LOCAL-' + key)
      assert.equal(raw.get(`remote-dsh.${OTHER_IDENTITY}.` + key), 'FOREIGN-' + key)
    }
    assert.equal(storage.length, keys.length + 1)
    assert.deepEqual(Array.from({ length: storage.length }, (_, index) => storage.key(index)), ['persisted', ...keys])
    assert.equal(storage.key(storage.length), null)
    assert.equal(storage.key(-1), null)
    assert.equal(storage.removeItem('dsh-plugin-token'), undefined)
    assert.equal(storage.getItem('dsh-plugin-token'), null)
    assert.equal(storage.length, keys.length)
    assert.equal(raw.get('dsh-plugin-token'), 'LOCAL-dsh-plugin-token')
    storage.setItem({ toString: () => 'coerced-plugin-key' }, 42)
    assert.equal(storage.getItem('coerced-plugin-key'), '42')
    assert.equal(storage.clear(), undefined)
    assert.equal(storage.length, 0)
    assert.equal(storage.key(0), null)
    assert.equal(storage.getItem('persisted'), null)
    assert.equal([...raw.keys()].some(key => key.startsWith(PREFIX)), false)
    for (const key of keys) {
      assert.equal(raw.get(key), 'LOCAL-' + key, 'clear leaves local keys intact')
      assert.equal(raw.get(`remote-dsh.${OTHER_IDENTITY}.` + key), 'FOREIGN-' + key, 'clear leaves other authorities intact')
    }
  })

  test(`${storageName}: key retains native unsigned-long enumeration semantics`, async t => {
    const browser = makeBrowser()
    const storage = browser.window[storageName]
    storage.setItem('first-plugin-token', 'a')
    storage.setItem('second-plugin-token', 'b')
    const native = browser.unrelatedStorage
    native.setItem('first-plugin-token', 'a')
    native.setItem('second-plugin-token', 'b')
    for (const [label, index] of [['fraction', 1.9], ['NaN', NaN], ['Infinity', Infinity], ['wraparound', 2 ** 32], ['numeric string', '1'], ['undefined', undefined]]) {
      await t.test(label, () => {
        assert.equal(storage.key(index), native.key(index), `key(${label}) should match the native unsigned-long conversion`)
      })
    }
  })
}

test('local and session storage are independent; unrelated Storage objects stay native', () => {
  const browser = makeBrowser()
  const { localStorage, sessionStorage } = browser.window
  localStorage.setItem('arbitrary-token', 'local-remote')
  sessionStorage.setItem('arbitrary-token', 'session-remote')
  assert.equal(localStorage.getItem('arbitrary-token'), 'local-remote')
  assert.equal(sessionStorage.getItem('arbitrary-token'), 'session-remote')
  localStorage.clear()
  assert.equal(sessionStorage.getItem('arbitrary-token'), 'session-remote')
  const unrelated = browser.unrelatedStorage
  unrelated.setItem('dsh-plugin-token', 'untouched')
  assert.equal(browser.rawStorage(unrelated).get('dsh-plugin-token'), 'untouched')
  assert.equal(unrelated.getItem('dsh-plugin-token'), 'untouched')
  assert.equal(unrelated.length, 1)
  assert.equal(unrelated.key(0), 'dsh-plugin-token')
  unrelated.removeItem('dsh-plugin-token')
  assert.equal(unrelated.length, 0)
  unrelated.setItem('x', 'y')
  unrelated.clear()
  assert.equal(unrelated.length, 0)
})

for (const storageName of ['localStorage', 'sessionStorage']) {
  test(`${storageName}: trusted events suppress foreign namespaces and remap selected namespace once`, () => {
    const browser = makeBrowser()
    const seen = []
    const storageArea = browser.window[storageName]
    const listener = event => seen.push(event)
    browser.window.addEventListener('storage', listener)
    const values = { oldValue: 'old-token', newValue: 'new-token', storageArea, url: mounted('other-tab') }
    for (const key of ['dsh-plugin-token', `remote-dsh.${OTHER_IDENTITY}.dsh-plugin-token`, 'remote-dsh.0123456789abcdef01230.dsh-plugin-token', null]) {
      browser.emitNativeStorage({ ...values, key })
      assert.equal(seen.length, 0, 'foreign/local/native clear events never expose local namespaces')
    }
    browser.emitNativeStorage({ ...values, key: PREFIX + 'arbitrary-plugin-oauth-token' })
    assert.equal(seen.length, 1, 'synthetic remap must not recursively remap or duplicate delivery')
    const event = seen[0]
    assert.ok(event instanceof browser.window.StorageEvent)
    assert.equal(event.isTrusted, false)
    assert.equal(event.key, 'arbitrary-plugin-oauth-token')
    assert.equal(event.oldValue, values.oldValue)
    assert.equal(event.newValue, values.newValue)
    assert.equal(event.storageArea, storageArea)
    assert.equal(event.url, values.url)
    browser.emitNativeStorage({ ...values, key: PREFIX, newValue: null })
    assert.equal(seen.at(-1).key, '', 'empty logical storage key is not a native clear event')
    assert.equal(seen.at(-1).newValue, null)
  })
}

test('untrusted StorageEvents and trusted unrelated-storage events pass through unchanged', () => {
  const browser = makeBrowser()
  const seen = []
  browser.window.addEventListener('storage', event => seen.push(event))
  const synthetic = new browser.window.StorageEvent('storage', {
    key: PREFIX + 'plugin-token', storageArea: browser.window.localStorage, newValue: 'synthetic',
  })
  browser.window.dispatchEvent(synthetic)
  assert.equal(seen[0], synthetic)
  assert.equal(seen[0].key, PREFIX + 'plugin-token')
  const unrelated = browser.emitNativeStorage({ key: 'unrelated-token', storageArea: browser.unrelatedStorage, oldValue: null, newValue: 'value', url: ORIGIN })
  assert.equal(seen[1], unrelated)
})

function loadUi(browser) {
  let wrapper
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    // We do not render React components or pretend a VM validates hooks/layout.
    useState() { throw new Error('React render is outside this service harness') },
    useRef() { throw new Error('React render is outside this service harness') },
    useEffect() { throw new Error('React render is outside this service harness') },
    useSyncExternalStore() { throw new Error('React render is outside this service harness') },
  }
  browser.window.__ModuleLoader__ = {
    load(module) {
      assert.equal(module.id, 'dsh-remote-sessions-wrapper')
      wrapper = module.factory(name => {
        if (name === 'react') return React
        if (name === 'react-dom') return { createPortal: (node, target) => ({ node, target }) }
        throw new Error(`Unexpected browser dependency: ${name}`)
      })
    },
  }
  vm.runInContext(readFileSync(uiFile, 'utf8'), browser.context, { filename: uiFile.pathname })
  assert.equal(typeof wrapper?.apply, 'function')
  return wrapper
}

function makeUi({ requested = '/remote/work', phase = 'loading', items = [], create, open } = {}) {
  const query = requested === null ? '?keep=1#section' : `?workspace=${encodeURIComponent(requested)}&keep=1#section`
  const browser = makeBrowser({ search: query })
  const wrapper = loadUi(browser)
  let snapshot = { phase, items }
  const subscriptions = new Set()
  const creates = [], opens = [], registrations = []
  const list = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      subscriptions.add(listener)
      return () => subscriptions.delete(listener)
    },
  }
  const services = {
    workspaces: {
      list,
      create(options) {
        creates.push(options)
        browser.calls.order.push('create')
        return create ? create(options, browser) : Promise.resolve({ workspaceId: 'new-remote-workspace', path: options.path })
      },
    },
    uiWorkspace: {
      openWorkspace(workspaceId) {
        opens.push(workspaceId)
        browser.calls.order.push('openWorkspace')
        return open ? open(workspaceId, browser) : Promise.resolve()
      },
    },
    slots: {
      inject(name, callback) { return callback() },
      register(descriptor, component) { registrations.push({ descriptor, component }); return () => {} },
    },
    connection: {
      state: { subscribe: () => () => {}, getSnapshot: () => 'connected' },
      generation: { subscribe: () => () => {}, getSnapshot: () => 1 },
      reconnect() {},
    },
  }
  function context() {
    const injections = []
    function deactivate(record) {
      const activation = record.activation
      if (!activation) return
      activation.active = false
      for (const cleanup of [...activation.cleanups].reverse()) cleanup()
      record.activation = null
    }
    function activate(record) {
      assert.equal(record.activation, null, 'dispose a previous service activation first')
      const activation = { active: true, cleanups: [], effectKeys: [] }
      record.activation = activation
      record.callback({
        get(name) {
          assert.ok(record.dependencies.includes(name), `cannot get uninjected service ${name}`)
          assert.ok(Object.hasOwn(services, name), `unknown service ${name}`)
          return services[name]
        },
        effect(factory, key) {
          assert.equal(activation.active, true)
          const cleanup = factory()
          assert.equal(typeof cleanup, 'function', 'this source effect must return cleanup')
          activation.cleanups.push(cleanup)
          activation.effectKeys.push(key)
          return cleanup
        },
      })
    }
    const ctx = {
      injections,
      inject(dependencies, callback) {
        const record = { dependencies: Array.from(dependencies), callback, activation: null }
        injections.push(record)
        activate(record)
      },
      reactivate(record) { deactivate(record); activate(record) },
      dispose() { for (const record of injections) deactivate(record) },
    }
    return ctx
  }
  return {
    browser, wrapper, creates, opens, registrations, subscriptions, context,
    alerts: () => browser.document.body.children.filter(child => child.getAttribute('role') === 'alert'),
    workspaceInjection: ctx => ctx.injections.find(record => record.dependencies.includes('workspaces')),
    setSnapshot(phase, items = []) { snapshot = { phase, items } },
    notify() { return Promise.all([...subscriptions].map(listener => listener())) },
  }
}

test('workspace services wait for the actual phase: ready list and open an existing exact-path workspace', async () => {
  const existing = { workspaceId: 'remote-existing', path: '/remote/work' }
  const env = makeUi({ phase: 'loading', items: [existing] })
  const ctx = env.context()
  env.wrapper.apply(ctx)
  assert.equal(env.registrations.length, 3, 'remote connection and both directory-flow slots stay native')
  assert.deepEqual(env.registrations.map(entry => entry.descriptor.name), [
    'shell.overlay', 'conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow',
  ])
  assert.equal(env.subscriptions.size, 1)
  assert.equal(env.creates.length, 0)
  assert.equal(env.opens.length, 0)
  env.setSnapshot('error', [existing])
  await env.notify()
  assert.equal(env.opens.length, 0)
  env.setSnapshot('ready', [existing])
  await env.notify()
  assert.deepEqual(env.opens, ['remote-existing'])
  assert.equal(env.creates.length, 0)
  await env.notify()
  assert.equal(env.opens.length, 1, 'repeated ready notification is not a second navigation')
  ctx.dispose()
  assert.equal(env.subscriptions.size, 0)
})

test('workspace query is consumed and removed BEFORE create; other query/hash are retained', async () => {
  const requested = '/remote/work space'
  const env = makeUi({
    requested, phase: 'ready', items: [{ workspaceId: 'not-the-requested-path', path: requested + '-other' }],
    create(options, browser) {
      assert.equal(options.path, requested)
      assert.equal(browser.window.__DSH_REMOTE_WORKSPACE_INTENT_CONSUMED__, true)
      const clean = new URL(browser.window.location.href)
      assert.equal(clean.searchParams.has('workspace'), false)
      assert.equal(clean.searchParams.get('keep'), '1')
      assert.equal(clean.hash, '#section')
      assert.deepEqual(browser.calls.order.slice(0, 2), ['replaceState', 'create'])
      return Promise.resolve({ workspaceId: 'created-on-remote', path: requested })
    },
  })
  const ctx = env.context()
  env.wrapper.apply(ctx)
  await tick()
  assert.equal(env.creates.length, 1)
  assert.deepEqual(env.opens, ['created-on-remote'])
  assert.equal(env.browser.calls.history.length, 1)
  assert.equal(env.browser.calls.navigation.length, 0, 'consuming query is not a page navigation')
  ctx.dispose()
})

test('an uncertain create rejection is never replayed by apply, graph reload or repeated ready state', async () => {
  const pending = deferred()
  const env = makeUi({ phase: 'ready', create: () => pending.promise })
  const first = env.context()
  env.wrapper.apply(first)
  assert.equal(env.creates.length, 1)
  const second = env.context()
  env.wrapper.apply(second)
  assert.equal(env.workspaceInjection(second), undefined, 'cleaned query creates no second intent injection')
  // Even a restored query must not defeat the page-lifetime consumption flag.
  env.browser.window.history.replaceState(null, '', mounted('conversation/thread') + '?workspace=%2Fremote%2Fwork&keep=2')
  const reloadedWrapper = loadUi(env.browser)
  const reloaded = env.context()
  reloadedWrapper.apply(reloaded)
  assert.equal(env.workspaceInjection(reloaded), undefined)
  pending.reject(new Error('connection lost after create may have committed'))
  await tick()
  assert.equal(env.alerts().length, 1)
  assert.match(env.alerts()[0].textContent, /connection lost after create may have committed/)
  assert.match(env.alerts()[0].textContent, /No local workspace was created; retry explicitly/)
  assert.equal(env.opens.length, 0)
  env.setSnapshot('loading')
  await env.notify()
  env.setSnapshot('ready')
  await env.notify()
  assert.equal(env.creates.length, 1)
  assert.equal(env.opens.length, 0)
  first.dispose()
  second.dispose()
  reloaded.dispose()
  assert.equal(env.alerts().length, 0, 'disposing its effect removes an already-shown alert')
})

for (const timing of ['while create is pending', 'after create rejects']) {
  test(`the SAME workspace injection callback cannot replay uncertain create ${timing}`, async () => {
    const pending = deferred()
    const env = makeUi({ phase: 'ready', create: () => pending.promise })
    const ctx = env.context()
    env.wrapper.apply(ctx)
    const record = env.workspaceInjection(ctx)
    const sameCallback = record.callback
    assert.equal(env.creates.length, 1)
    if (timing === 'after create rejects') {
      pending.reject(new Error('uncertain remote commit'))
      await tick()
      assert.equal(env.alerts().length, 1)
    }
    ctx.reactivate(record)
    assert.equal(record.callback, sameCallback, 'reactivation must not replace callback or call apply anew')
    assert.equal(env.subscriptions.size, 1)
    assert.equal(env.alerts().length, 0)
    env.setSnapshot('loading')
    await env.notify()
    env.setSnapshot('ready')
    await env.notify()
    if (timing === 'while create is pending') {
      pending.reject(new Error('uncertain remote commit'))
      await tick()
    }
    assert.equal(env.creates.length, 1)
    assert.equal(env.opens.length, 0)
    assert.equal(env.alerts().length, 0, 'old inactive effect cannot append a late alert')
    ctx.reactivate(record)
    await env.notify()
    assert.equal(env.creates.length, 1)
    ctx.dispose()
  })
}

for (const outcome of ['resolve', 'reject']) {
  test(`disposal suppresses late create ${outcome}, alerts and openWorkspace navigation`, async () => {
    const pending = deferred()
    const env = makeUi({ phase: 'ready', create: () => pending.promise })
    const ctx = env.context()
    env.wrapper.apply(ctx)
    const queuedNotification = [...env.subscriptions][0]
    assert.equal(env.creates.length, 1)
    ctx.dispose()
    assert.equal(env.subscriptions.size, 0)
    if (outcome === 'resolve') pending.resolve({ workspaceId: 'late-remote-workspace', path: '/remote/work' })
    else pending.reject(new Error('late create failure'))
    await tick()
    // A notification already captured by a scheduler is also harmless.
    await queuedNotification()
    assert.equal(env.creates.length, 1)
    assert.equal(env.opens.length, 0)
    assert.equal(env.alerts().length, 0)
    assert.equal(env.browser.calls.navigation.length, 0)
  })
}

test('disposal suppresses late openWorkspace rejection without pretending to cancel an already-issued service operation', async () => {
  const pending = deferred()
  const env = makeUi({ phase: 'ready', items: [{ workspaceId: 'existing-remote', path: '/remote/work' }], open: () => pending.promise })
  const ctx = env.context()
  env.wrapper.apply(ctx)
  assert.deepEqual(env.opens, ['existing-remote'], 'open was issued while the effect was still active')
  ctx.dispose()
  pending.reject(new Error('late open failure'))
  await tick()
  assert.equal(env.alerts().length, 0)
  assert.equal(env.opens.length, 1)
  assert.equal(env.browser.calls.navigation.length, 0)
})

test('disposal before ready unsubscribes and blocks captured late notifications', async () => {
  const env = makeUi({ phase: 'loading' })
  const ctx = env.context()
  env.wrapper.apply(ctx)
  const queuedNotification = [...env.subscriptions][0]
  ctx.dispose()
  env.setSnapshot('ready')
  await queuedNotification()
  await env.notify()
  assert.equal(env.creates.length, 0)
  assert.equal(env.opens.length, 0)
  assert.equal(env.alerts().length, 0)
})

for (const requested of ['relative/workspace', '/remote/\0invalid']) {
  test(`invalid workspace intent ${JSON.stringify(requested)} is consumed without mutation`, async () => {
    const env = makeUi({ requested, phase: 'ready' })
    const ctx = env.context()
    env.wrapper.apply(ctx)
    await tick()
    assert.equal(env.browser.window.__DSH_REMOTE_WORKSPACE_INTENT_CONSUMED__, true)
    assert.equal(new URL(env.browser.window.location.href).searchParams.has('workspace'), false)
    assert.equal(env.creates.length, 0)
    assert.equal(env.opens.length, 0)
    assert.equal(env.subscriptions.size, 0)
    ctx.dispose()
  })
}

test('without a workspace query only native remote controls are registered', () => {
  const env = makeUi({ requested: null, phase: 'ready' })
  const ctx = env.context()
  env.wrapper.apply(ctx)
  assert.equal(env.registrations.length, 3)
  assert.equal(env.workspaceInjection(ctx), undefined)
  assert.equal(env.browser.calls.history.length, 0)
  assert.equal(env.browser.window.__DSH_REMOTE_WORKSPACE_INTENT_CONSUMED__, undefined)
  assert.equal(env.creates.length, 0)
  assert.equal(env.opens.length, 0)
  ctx.dispose()
})
