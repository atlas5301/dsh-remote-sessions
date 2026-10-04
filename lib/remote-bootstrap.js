/* Runs before the native remote boot and every plugin. No local business API
 * is reachable through the supported browser transports while mounted. This is
 * functional authority isolation, not a sandbox for untrusted remote JS. */
(function installRemoteBoundary(host) {
  window.__DSH_REMOTE_HOST__ = host
  const mount = host.mount
  const here = new URL(window.location.href)
  function remoteUrl(value) {
    const url = new URL(String(value), document.baseURI || here.href)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return String(value)
    const sameAuthority = url.host === here.host
    if (!sameAuthority) {
      const hostname = url.hostname.replace(/\.$/, '')
      if (hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\./.test(hostname) || hostname === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:/.test(hostname)) throw new Error('Remote page cannot access another local runtime')
      return String(value)
    }
    if (url.pathname.startsWith(mount)) return url.href
    if (url.pathname.startsWith('/remote-sessions/native/')) throw new Error('Remote page cannot switch authority implicitly')
    url.pathname = mount + url.pathname.replace(/^\//, '')
    return url.href
  }
  const fetchRemote = window.fetch.bind(window)
  window.fetch = function(input, init) {
    try {
      if (input instanceof Request) {
        const mapped = remoteUrl(input.url)
        return fetchRemote(mapped === input.url ? input : new Request(mapped, input), init)
      }
      return fetchRemote(remoteUrl(input), init)
    } catch (error) { return Promise.reject(error) }
  }
  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { return open.call(this, method, remoteUrl(url), ...rest) }
  for (const name of ['WebSocket', 'EventSource']) {
    const Original = window[name]
    if (!Original) continue
    window[name] = new Proxy(Original, { construct(Target, [url, ...args], NewTarget) { return Reflect.construct(Target, [remoteUrl(url), ...args], NewTarget) } })
  }
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator)
    navigator.sendBeacon = (url, body) => beacon(remoteUrl(url), body)
  }
  // Isolate ALL native and third-party plugin storage, including dsh-* tokens.
  // Scope both Storage objects; enumeration/clear must not reveal local keys.
  const prefix = 'remote-dsh.' + host.identity + '.'
  const proto = Storage.prototype
  const original = Object.fromEntries(['getItem', 'setItem', 'removeItem', 'key', 'clear'].map(name => [name, proto[name]]))
  const length = Object.getOwnPropertyDescriptor(proto, 'length')
  const scoped = storage => storage === localStorage || storage === sessionStorage
  const keys = storage => {
    const result = []
    for (let i = 0; i < length.get.call(storage); i++) {
      const key = original.key.call(storage, i)
      if (key?.startsWith(prefix)) result.push(key.slice(prefix.length))
    }
    return result
  }
  proto.getItem = function(key) { return original.getItem.call(this, scoped(this) ? prefix + String(key) : key) }
  proto.setItem = function(key, value) { return original.setItem.call(this, scoped(this) ? prefix + String(key) : key, value) }
  proto.removeItem = function(key) { return original.removeItem.call(this, scoped(this) ? prefix + String(key) : key) }
  proto.key = function(index) { return scoped(this) ? keys(this)[Number(index) >>> 0] ?? null : original.key.call(this, index) }
  proto.clear = function() { if (!scoped(this)) return original.clear.call(this); for (const key of keys(this)) original.removeItem.call(this, prefix + key) }
  if (length?.configurable) Object.defineProperty(proto, 'length', { ...length, get() { return scoped(this) ? keys(this).length : length.get.call(this) } })
  window.addEventListener('storage', event => {
    if (!event.isTrusted || !scoped(event.storageArea)) return
    event.stopImmediatePropagation()
    if (!event.key?.startsWith(prefix)) return
    window.dispatchEvent(new StorageEvent('storage', { key: event.key.slice(prefix.length), oldValue: event.oldValue, newValue: event.newValue, storageArea: event.storageArea, url: event.url }))
  }, true)
  // Root-absolute dynamic resources/downloads/forms also remain remote.
  const attributes = { A: ['href'], FORM: ['action'], SCRIPT: ['src'], LINK: ['href'], IMG: ['src'], IFRAME: ['src'], SOURCE: ['src'], VIDEO: ['src', 'poster'], AUDIO: ['src'] }
  const set = Element.prototype.setAttribute
  Element.prototype.setAttribute = function(name, value) {
    if (attributes[this.tagName]?.includes(String(name).toLowerCase()) && String(value).startsWith('/')) value = remoteUrl(value)
    return set.call(this, name, value)
  }
  for (const [className, names] of Object.entries({ HTMLAnchorElement: ['href'], HTMLFormElement: ['action'], HTMLScriptElement: ['src'], HTMLLinkElement: ['href'], HTMLImageElement: ['src'], HTMLIFrameElement: ['src'], HTMLSourceElement: ['src'], HTMLVideoElement: ['src', 'poster'], HTMLAudioElement: ['src'] })) {
    const p = window[className]?.prototype
    if (!p) continue
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(p, name)
      if (!descriptor?.set || !descriptor.configurable) continue
      Object.defineProperty(p, name, { ...descriptor, set(value) { return descriptor.set.call(this, String(value).startsWith('/') ? remoteUrl(value) : value) } })
    }
  }
  document.addEventListener('click', event => {
    const anchor = event.target.closest?.('a[href]')
    if (!anchor) return
    try { const mapped = remoteUrl(anchor.href); if (mapped !== anchor.href) anchor.href = mapped } catch { event.preventDefault() }
  }, true)
})(__REMOTE_HOST__)
