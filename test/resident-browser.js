// Isolated real-React render of the *registered* classic client's main Panel.
// All fetches terminate in this in-memory bridge. No server, SSH or runtime starts.
let testRuntime, React, flushSync, createRoot
const target = 'build-host'
const sessionId = 'session-review-resident-ui'
const runtimeId = 'resident-build-host-01'
const assertions = [], requests = [], errors = [], forbidden = []
const registrations = [], selections = [], streams = new Map()
let module, serial = 0, root
const tick = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (condition, label) => {
  const deadline = performance.now() + 10000
  while (performance.now() < deadline) { if (condition()) return; await tick() }
  throw new Error('Timed out: ' + label)
}
const assert = (condition, label) => { if (!condition) throw new Error(label); assertions.push(label) }
const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label)
const byLabel = label => document.querySelector('[aria-label="' + label + '"]')
const visible = node => !!(node && node.getClientRects().length)
const describe = node => ({ tag: node.tagName?.toLowerCase(), label: node.getAttribute?.('aria-label') || node.textContent?.trim().slice(0, 110), width: node.clientWidth, scrollWidth: node.scrollWidth })
const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
const block = api => (...args) => { const message = 'Forbidden browser transport: ' + api; forbidden.push({ api, args: args.map(String) }); throw new Error(message) }
window.XMLHttpRequest = class { constructor(...args) { block('XMLHttpRequest')(...args) } }
window.WebSocket = class { constructor(...args) { block('WebSocket')(...args) } }
window.EventSource = class { constructor(...args) { block('EventSource')(...args) } }
navigator.sendBeacon = block('sendBeacon')
window.addEventListener('error', event => errors.push({ type: 'error', message: event.message || 'Resource load error', source: event.filename || event.target?.src }))
window.addEventListener('unhandledrejection', event => errors.push({ type: 'unhandledrejection', message: String(event.reason?.stack || event.reason) }))
window.addEventListener('securitypolicyviolation', event => errors.push({ type: 'csp', message: event.violatedDirective, blockedURI: event.blockedURI }))
const capabilities = [
  ...['list', 'create', 'prompt', 'page', 'cancel', 'selectModel', 'modelCatalog'].map(name => ({ endpoint: 'session/' + name, stream: false, parameters: name === 'modelCatalog' ? [] : ['request'] })),
  { endpoint: 'session/follow', stream: true, parameters: ['request'] },
]
const binding = { id: 'qa-binding-1', target, runtimeId, instanceId: 'epoch-2026-qa', authority: 'qa-build-host-authority' }
const text = value => [{ type: 'text', text: value }]
const record = (seq, type, data) => ({ type: 'event', event: { seq, type, time: 1759406400000 + seq * 1000, surfaceOp: 'append', data } })
const records = [
  record(0, 'user/message', { content: text('Review the resident session panel. Keep execution on build-host and do not change my local workspace.') }),
  record(1, 'assistant/message', { message: { content: text('The remote resident is connected. I will inspect the selected workspace and report what I find before making changes.') } }),
  record(2, 'tool/call', { name: 'read', arguments: JSON.stringify({ path: '/srv/projects/resident-ui/README.md', offset: 1, limit: 80 }, null, 2) }),
  record(3, 'tool/result', { message: { content: text('Resident session UI\nA plugin-owned panel with explicit execution targets and persistent remote agents.') } }),
  record(4, 'user/message', { content: text('Run the targeted checks next. Ask me before starting a command.') }),
]
const snapshot = { type: 'snapshot', header: { id: sessionId, version: 4 }, cursor: 4, records, hasMore: false,
  projections: { values: { modelSelection: { next: { provider: 'deepseek', model: 'deepseek-chat' } } } },
  assistantStream: { revision: 0, activeAttempt: { attemptId: 'attempt-qa-1', startedAfterSeq: 4, turn: 2, step: 1, nextIndex: 1, stream: [{ type: 'text-chunks', texts: ['The targeted checks are ready. Waiting for your approval before running them on build-host.'] }] } },
}
const approval = { type: 'waterfall', event: 'approval/request', eventId: 'approval-qa-1', agentId: sessionId,
  request: { toolName: 'bash', reason: 'Run the targeted resident session tests on the remote machine.', command: 'node --test test/client-resident.test.js', cwd: '/srv/projects/resident-ui' } }

window.fetch = async (path, opts = {}) => {
  const url = new URL(path, location.href)
  const body = opts.body ? JSON.parse(opts.body) : undefined
  requests.push({ path: url.pathname, method: opts.method || 'GET', body })
  if (url.pathname === '/remote-sessions/machines' && opts.method === 'GET') return Response.json({ machines: [{ name: target, remoteCwd: '/srv/projects/resident-ui' }] })
  if (opts.method !== 'POST') throw new Error('Unexpected mock request: ' + path)
  if (url.pathname === '/remote-sessions/session/attach') {
    assert(body.target === target, 'Bridge attach pins the remote execution target')
    return Response.json({ binding, hello: { protocol: 'dsh-remote-sessions/1', capabilities } })
  }
  if (url.pathname === '/remote-sessions/session/detach') return Response.json({ detached: true })
  if (url.pathname !== '/remote-sessions/session/execute') throw new Error('Unexpected mock request: ' + path)
  assert(body.binding.runtimeId === runtimeId && body.binding.target === target, 'Bridge request retains the exact runtime and target')
  const { method, params } = body
  if (method === 'open') {
    assert(['$events', 'session/follow'].includes(params.endpoint), 'Only approval and selected-session observation streams open')
    const streamId = 'qa-stream-' + ++serial
    streams.set(streamId, { endpoint: params.endpoint, first: true })
    return Response.json({ streamId })
  }
  if (method === 'close') return Response.json({ closed: true })
  if (method === 'next') {
    const stream = streams.get(params.streamId)
    if (!stream) throw new Error('Unknown mock stream')
    if (stream.first) {
      stream.first = false
      return Response.json({ items: stream.endpoint === '$events' ? [{ type: 'ready', clientId: 'qa-observer-1', host: { home: '/home/qa' } }, approval] : [snapshot], done: false })
    }
    // Park the long poll without timers/network; honor unmount/detach cancellation.
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('Mock observation aborted', 'AbortError'))
      if (opts.signal?.aborted) abort()
      else opts.signal?.addEventListener('abort', abort, { once: true })
    })
  }
  if (method === 'call') {
    if (params.endpoint === 'session/list') return Response.json({ ok: true, value: [
      { sessionId, title: 'Review resident session UI', cwd: '/srv/projects/resident-ui', running: true },
      { sessionId: 'session-regression-checks', title: 'Regression checks', cwd: '/srv/projects/agent-tools', running: false },
      { sessionId: 'session-notes', title: 'Release notes', cwd: '/srv/projects/resident-ui', running: false },
    ] })
    if (params.endpoint === 'session/modelCatalog') return Response.json({ ok: true, value: { groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }] } })
    throw new Error('Visual QA must not mutate a session: ' + params.endpoint)
  }
  throw new Error('Visual QA must not answer approvals or execute mutations: ' + method)
}

function measure() {
  const panel = document.querySelector('[data-remote-sessions-panel]')
  const content = [...panel.querySelectorAll('*')].filter(visible)
  const horizontalOverflow = content.filter(node => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1 && !['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)).map(node => ({ ...describe(node), overflowX: getComputedStyle(node).overflowX, bounds: rect(node) }))
  const controls = [...panel.querySelectorAll('button,input,textarea,select,summary')].filter(visible)
  const clippedControls = []
  for (const control of controls) {
    const bounds = control.getBoundingClientRect()
    for (let parent = control.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent), p = parent.getBoundingClientRect()
      if (style.overflowX !== 'visible' && (bounds.left < p.left - 1 || bounds.right > p.right + 1)) {
        clippedControls.push({ ...describe(control), bounds: rect(control), clippingAncestor: describe(parent), clippingBounds: rect(parent) }); break
      }
    }
  }
  const scrollRegions = content.filter(node => node.clientHeight && node.scrollHeight > node.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)).map(node => ({ ...describe(node), height: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, bounds: rect(node) }))
  return { viewport: { width: innerWidth, height: innerHeight }, panelBounds: rect(panel),
    document: { width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, height: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight },
    sidebarVisible: visible(byLabel('Bound sessions')), horizontalOverflow, clippedControls, scrollRegions,
    controls: controls.map(node => ({ ...describe(node), disabled: !!node.disabled, bounds: rect(node) })),
    alerts: [...document.querySelectorAll('[role=alert]')].map(node => node.textContent),
    connected: module.testing.resident.connections.get(target)?.status, transcriptEvents: byLabel('Session transcript')?.querySelectorAll('article,details').length,
    pendingApproval: !!button('Allow once'), assertions: [...new Set(assertions)], errors: [...errors], forbidden: [...forbidden], requests: [...requests],
    reactVersion: React.version, clientScriptURL: new URL('../lib/client.js', location.href).href,
    registrations: registrations.map(item => item.options), selections: [...selections] }
}
window.__residentQA = { ready: false, measure, async toggleSessions() { button('Sessions').click(); await tick(); await tick(); return measure() },
  async scrollConversation() { const transcript = byLabel('Session transcript'); transcript.parentElement.scrollTop = transcript.offsetTop - transcript.parentElement.offsetTop; await tick(); return measure() },
  async expandModel() { const summary = [...document.querySelectorAll('summary')].find(node => node.textContent.startsWith('Model ·')); summary.click(); await tick(); return measure() },
  async dispose() { flushSync(() => root.unmount()); await module.testing.resident.close() } }

try {
  // Import after installing transport guards so even bundle initialization is isolated.
  // Keep initialization inside the error boundary to report runtime-import failures.
  ;({ testRuntime } = await import('./react-only-runtime.js'))
  React = testRuntime.react
  ;({ flushSync } = testRuntime['react-dom'])
  ;({ createRoot } = testRuntime['react-dom/client'])
  window.__ModuleLoader__ = { load(entry) {
    assert(entry.id === 'dsh-remote-sessions', 'Loaded the actual classic client factory')
    module = entry.factory(name => { if (!(name in testRuntime)) throw new Error('Unknown React runtime module: ' + name); return testRuntime[name] })
  } }
  await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = '../lib/client.js'; script.onload = resolve; script.onerror = () => reject(new Error('Actual client failed to load')); document.head.append(script) })
  const slots = { inject(name, fn) { return fn() }, register(options, component) { registrations.push({ options, component }); return () => {} } }
  const layout = { selectPanel(id) { selections.push(id) } }
  module.apply({ inject(names, fn) { assert(JSON.stringify(names) === '["slots","layout"]', 'Client uses public slots and layout only'); fn({ slots, layout, get(name) { if (name === 'slots') return slots; if (name === 'layout') return layout; throw new Error('Unexpected service: ' + name) } }) } })
  const registration = registrations.find(item => item.options.name === 'main' && item.options.key === 'remote-sessions')
  assert(registration && registration.component === module.testing.Panel, 'Rendered component is the actual registered main remote-sessions Panel')
  module.testing.openPanel(target, '/srv/projects/resident-ui')
  root = createRoot(document.getElementById('slot'))
  flushSync(() => root.render(React.createElement(registration.component)))
  await until(() => byLabel('Execution target')?.value === target, 'remote machine option')
  button('Connect').click()
  await until(() => module.testing.resident.connections.get(target)?.status === 'connected' && [...document.querySelectorAll('aside button')].some(node => node.textContent.includes('Review resident session UI')), 'connected remote session list')
  const sessionButton = [...document.querySelectorAll('aside button')].find(node => node.textContent.includes('Review resident session UI'))
  sessionButton.click()
  await until(() => byLabel('Session transcript') && button('Allow once') && !byLabel('Message to ' + target)?.disabled, 'connected transcript and approval')
  const session = module.testing.resident.selected
  assert(session.sessionId === sessionId && session.runtimeId === runtimeId, 'Selected conversation is bound to the remote runtime')
  session.draft = 'After the checks finish, summarize the results.'
  module.testing.resident.notify()
  await until(() => byLabel('Message to ' + target)?.value === session.draft && !button('Send').disabled, 'composer draft')
  assert(byLabel('Session transcript').textContent.includes('Assistant · streaming'), 'Actual transcript renders the active assistant stream')
  assert(document.querySelectorAll('iframe').length === 0, 'No remote page or iframe is rendered')
  assert(requests.every(request => request.path.startsWith('/remote-sessions/')), 'All requests terminate in the mocked plugin bridge')
  assert(!requests.some(request => request.body?.method === 'event-result' || ['session/create', 'session/prompt', 'session/cancel', 'session/selectModel'].includes(request.body?.params?.endpoint)), 'Rendered QA performs no session mutation or approval answer')
  assert(errors.length === 0 && forbidden.length === 0, 'No browser exceptions, CSP violations, or transport attempts')
  window.__residentQA.ready = true
  document.getElementById('results').textContent = JSON.stringify(measure(), null, 2)
  document.documentElement.dataset.testResult = 'passed'
} catch (error) {
  errors.push({ type: 'fixture', message: String(error.stack || error) })
  document.getElementById('results').textContent = JSON.stringify({ assertions, errors, requests }, null, 2)
  document.documentElement.dataset.testResult = 'failed'
}
