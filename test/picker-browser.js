import { testRuntime } from './frontend-runtime.js'

// Real React/DOM fixture with mocked HTTP only. Never replace immutable browser
// window.location: prepare always fails here; successful assign is covered by
// client-actions.test.js's VM seam. No SSH, runtime start or real model executes.
const React = testRuntime.react
const ReactDOM = testRuntime['react-dom']
const { createRoot } = testRuntime['react-dom/client']
const results = []
const assert = (condition, message) => { if (!condition) throw new Error(message); results.push('PASS ' + message) }
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
const until = async (condition, message) => {
  for (let attempt = 0; attempt < 100; attempt++) { if (condition()) return; await tick() }
  throw new Error('Timed out: ' + message)
}
const button = (text) => [...document.querySelectorAll('button')].find((node) => node.textContent === text)
const setInput = (label, value) => {
  const input = document.querySelector('input[aria-label="' + label + '"]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const deferred = () => {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}
let mod, slots = [], picked = [], cancellations = 0, nativeMode = 'success', busy = false
let nativePending, preparePending, prepareMode = 'failure'
const requests = []
const initialHref = location.href
window.__ModuleLoader__ = { load: ({ factory }) => { mod = factory((name) => testRuntime[name]) } }
window.fetch = async (path, opts = {}) => {
  const url = new URL(path, location.href)
  const request = { path: url.pathname, search: url.search, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined, signal: opts.signal }
  requests.push(request)
  if (url.pathname === '/remote-sessions/machines') return Response.json({ machines: [{ name: 'test', remoteCwd: '/remote/home', web: { remotePort: 8420 } }] })
  if (url.pathname === '/remote-sessions/ws-ls') return Response.json({ path: url.searchParams.get('path'), entries: [{ name: 'a-very-long-directory-' + 'x'.repeat(200), path: '/remote/home/sub' }] })
  if (url.pathname === '/remote-sessions/local-pick') {
    if (nativeMode === 'cancel') return Response.json({ cancelled: true })
    if (nativeMode === 'failure') return Response.json({ error: 'Test native chooser error' }, { status: 500 })
    // Deliberately ignore abort while deferred: the component's generation guard
    // must suppress late responses even when a transport cannot honor cancellation.
    if (nativeMode === 'pending') { nativePending = { ...deferred(), request }; return nativePending.promise }
    return Response.json({ path: '/local/native' })
  }
  if (url.pathname === '/remote-sessions/prepare') {
    if (prepareMode === 'pending') { preparePending = { ...deferred(), request }; return preparePending.promise }
    return Response.json({ error: 'Test prepare failed — existing runtime unavailable' }, { status: 503 })
  }
  throw new Error('Unexpected request: ' + path)
}
try {
  await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = '../lib/client.js'; script.onload = resolve; script.onerror = reject; document.head.append(script) })
  const slotService = { inject: (_name, fn) => fn(), register: (options, component) => { slots.push({ name: options.name, component, options }); return () => {} } }
  mod.apply({ inject: (names, fn) => { assert(names.length === 1 && names[0] === 'slots', 'Client requires only slots, not legacy right-sidebar services'); return fn({ get: (name) => { if (name !== 'slots') throw new Error('Unexpected service ' + name); return slotService } }) } })
  const flows = slots.filter((slot) => slot.name.endsWith('.directoryFlow'))
  assert(flows.length === 2 && flows[0].component === flows[1].component, 'Both picker slots use one component')
  assert(slots.some((slot) => slot.name === 'settings.section'), 'Settings component is registered through the settings slot')
  const Picker = flows[0].component
  const root = createRoot(document.getElementById('slot'))
  let open = false
  const render = () => ReactDOM.flushSync(() => root.render(React.createElement(Picker, { open, busy, onPicked: (path) => { picked.push(path) }, onCancel: () => { cancellations++; open = false; render() } })))
  const launch = () => { document.getElementById('trigger').focus(); open = true; render() }
  launch(); await tick()
  let overlay = document.querySelector('[data-remote-sessions-picker]')
  let dialog = document.querySelector('[role=dialog]')
  const bounds = dialog.getBoundingClientRect(), sidebar = document.getElementById('sidebar').getBoundingClientRect()
  assert(overlay.parentElement === document.body, 'Portal mounts directly under body')
  assert(!document.getElementById('sidebar').contains(dialog) && bounds.bottom > sidebar.bottom, 'Dialog escapes transformed overflow-hidden sidebar')
  assert(bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight, 'Dialog fits viewport ' + innerWidth + 'x' + innerHeight)
  assert(Math.abs((bounds.left + bounds.right) / 2 - innerWidth / 2) < 2, 'Dialog is centered')
  assert(dialog.contains(document.activeElement), 'Opening moves focus inside dialog')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
  assert(dialog.contains(document.activeElement), 'Tab wraps focus inside dialog')
  setInput('Local directory', '/local/typed'); await tick(); button('Use this local path').click(); await tick()
  assert(picked.at(-1) === '/local/typed', 'Typed local path calls native adoption callback')
  button('Browse…').click(); await tick()
  assert(picked.at(-1) === '/local/native', 'Native local result calls adoption callback')
  const pickedCount = picked.length
  nativeMode = 'cancel'; button('Browse…').click(); await tick()
  assert(picked.length === pickedCount, 'Native cancel does not adopt a workspace')
  nativeMode = 'failure'; button('Browse…').click(); await tick()
  assert(document.querySelector('[role=alert]').textContent.includes('Test native chooser error'), 'Native error is visible and picker stays open')
  nativeMode = 'pending'; button('Browse…').click(); await until(() => nativePending, 'pending local chooser')
  const cancelCount = cancellations
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  overlay.click(); await tick()
  assert(cancellations === cancelCount && button('Close').disabled, 'Busy native picking blocks Escape, backdrop, and Close')
  nativePending.resolve(Response.json({ path: '/local/native' })); await tick()
  assert(picked.length === pickedCount + 1, 'Active native chooser completion adopts exactly once')

  button('Remote machines').click()
  await until(() => button('Open remote runtime here') && !button('Open remote runtime here').disabled && document.querySelector('[aria-label="Remote subdirectories"] button'), 'remote listing')
  assert(!button('Add remote workspace — not available yet'), 'Remote picker offers native runtime instead of unavailable registration')
  assert(document.querySelector('[role=note]').textContent.includes('native DSH') && document.querySelector('[role=note]').textContent.includes('No local placeholder'), 'Remote picker explains native execution and no local placeholder')
  assert(dialog.scrollWidth <= dialog.clientWidth + 1, 'Long remote names cannot overflow dialog horizontally')
  setInput('Remote directory', '/remote/work space'); await tick()
  const remotePickedCount = picked.length
  button('Open remote runtime here').click()
  await until(() => document.querySelector('[role=alert]')?.textContent.includes('Test prepare failed'), 'prepare failure')
  const prepare = requests.filter((request) => request.path === '/remote-sessions/prepare').at(-1)
  assert(prepare.method === 'POST' && prepare.search === '?machine=test' && JSON.stringify(prepare.body) === '{}' && prepare.signal instanceof AbortSignal, 'Native picker posts prepare with the selected machine and cancellable empty body')
  assert(document.querySelector('[role=dialog]') && !button('Open remote runtime here').disabled, 'Failed prepare keeps dialog open and restores controls')
  assert(picked.length === remotePickedCount && location.href === initialHref, 'Failed prepare never adopts locally or changes browser URL')

  prepareMode = 'pending'; button('Open remote runtime here').click(); await until(() => preparePending, 'pending prepare')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  overlay.click(); await tick()
  assert(cancellations === cancelCount && button('Close').disabled && button('Connecting…').disabled, 'Pending prepare blocks duplicate connect and ordinary dismissal')
  // Model parent-driven closure/reopening, which is still possible while locked.
  open = false; render(); await tick()
  assert(preparePending.request.signal.aborted, 'Closing picker aborts the current prepare request')
  launch(); await tick()
  overlay = document.querySelector('[data-remote-sessions-picker]'); dialog = document.querySelector('[role=dialog]')
  await until(() => button('Open remote runtime here') && !button('Open remote runtime here').disabled, 'reopened picker')
  preparePending.resolve(Response.json({ error: 'Stale prepare must not replace the new generation' }, { status: 503 })); await tick()
  assert(!document.querySelector('[role=alert]') && picked.length === remotePickedCount && location.href === initialHref, 'Late aborted prepare error cannot mutate the reopened generation or adopt locally')

  // The analogous late native chooser success must not adopt into a new opening.
  button('Local').click(); await tick(); nativePending = null; button('Browse…').click(); await until(() => nativePending, 'second pending local chooser')
  open = false; render(); await tick()
  assert(nativePending.request.signal.aborted, 'Closing picker aborts the current native chooser request')
  launch(); await tick(); nativePending.resolve(Response.json({ path: '/local/stale' })); await tick()
  assert(picked.length === remotePickedCount, 'Late native chooser result cannot adopt into a reopened picker')
  assert(!requests.some((request) => /ws-register|ws-mirror|\/url$|\/(?:sync|sync-status|selected-sync|selected-transfer)(?:\/|$)/.test(request.path)), 'Picker never registers mirrors, calls legacy URL/start routes, or performs any synchronization')
  assert(picked.every((path) => path.startsWith('/local/')) && location.href === initialHref, 'All adoption is local-only and fixture never navigates')
  busy = true; render(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick()
  assert(cancellations === cancelCount, 'Parent workspace-adoption busy state also blocks dismissal')
  busy = false; render(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick()
  assert(!document.querySelector('[role=dialog]') && document.activeElement.id === 'trigger', 'Escape closes and restores trigger focus')
  launch(); await tick(); button('Close').click(); await tick()
  assert(!document.querySelector('[role=dialog]'), 'Repeated open and Close leave no orphaned overlay')
  launch(); await tick(); document.querySelector('[data-remote-sessions-picker]').click(); await tick()
  assert(!document.querySelector('[role=dialog]'), 'Backdrop closes only when not busy')
  if (new URLSearchParams(location.search).has('visual')) { launch(); await tick(); button('Remote machines').click(); await tick() }
  document.getElementById('results').textContent = results.join('\n') + '\nALL PASSED (' + results.length + ')'
  document.documentElement.dataset.testResult = 'passed'
} catch (e) {
  document.getElementById('results').textContent = results.join('\n') + '\nFAIL ' + (e.stack || e)
  document.documentElement.dataset.testResult = 'failed'
}
