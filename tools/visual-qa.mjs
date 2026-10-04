#!/usr/bin/env node
// Render-only QA: no dependencies, webserver, live GUI, SSH or transport runtime.
// Usage: node tools/visual-qa.mjs [--strict-layout]
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(root, 'test/artifacts')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const fixture = pathToFileURL(join(root, 'test/resident-browser.html')).href
const clientPath = join(root, 'lib/client.js')
const hash = value => createHash('sha256').update(value).digest('hex')
const initialClientHash = hash(await readFile(clientPath))
await mkdir(artifacts, { recursive: true })
const profile = await mkdtemp(join(artifacts, '.resident-chrome-'))
// Resolve and verify once; cleanup below refuses anything other than this profile.
const verifiedProfile = await realpath(profile)
const verifiedArtifacts = await realpath(artifacts)
if (!verifiedProfile.startsWith(verifiedArtifacts + sep + '.resident-chrome-')) throw new Error('Unexpected Chrome profile path')
const flags = ['--headless', '--allow-file-access-from-files', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--disable-extensions',
  '--metrics-recording-only', '--safebrowsing-disable-auto-update', '--host-resolver-rules=MAP * ~NOTFOUND',
  '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication,CertificateTransparencyComponentUpdater',
  '--force-device-scale-factor=1', '--user-data-dir=' + profile, 'about:blank']
const child = spawn(chrome, flags, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] })
let stderr = '', stdout = '', nextId = 0, buffer = Buffer.alloc(0)
const pending = new Map(), handlers = new Set()
const report = { schema: 1, generatedAt: new Date().toISOString(), fixtureURL: fixture, clientPath, initialClientHash,
  mode: 'file://, real React, actual classic client, CDP pipe, mocked bridge only', captures: [], diagnostics: [], failures: [] }
child.stderr.on('data', data => { stderr += data })
child.stdout.on('data', data => { stdout += data })
const exited = new Promise(resolve => child.once('exit', (code, signal) => {
  report.chromeExit = { code, signal }; resolve()
  for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error('Chrome exited before CDP reply')) }
  pending.clear()
}))
child.once('error', error => { for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(error) }; pending.clear() })
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 20000)
    pending.set(id, { resolve, reject, timeout })
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => {
      if (error) { clearTimeout(timeout); pending.delete(id); reject(error) }
    })
  })
}
child.stdio[4].on('data', data => {
  buffer = Buffer.concat([buffer, data])
  let end
  while ((end = buffer.indexOf(0)) !== -1) {
    const raw = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 1)
    if (!raw) continue
    const message = JSON.parse(raw)
    if (message.id) {
      const item = pending.get(message.id)
      if (!item) continue
      pending.delete(message.id); clearTimeout(item.timeout)
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result)
    } else for (const handler of handlers) handler(message)
  }
})
async function evaluate(sessionId, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function capture(sessionId, label, loadedClientHash, diagnostics) {
  const metrics = await evaluate(sessionId, 'window.__residentQA.measure()')
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true }, sessionId)
  const screenshot = join(artifacts, label + '.png')
  await writeFile(screenshot, Buffer.from(data, 'base64'))
  const result = { label, screenshot, loadedClientHash, ...metrics, diagnostics: structuredClone(diagnostics) }
  report.captures.push(result)
  if (metrics.errors.length || metrics.forbidden.length || metrics.alerts.length || diagnostics.exceptions.length || diagnostics.consoleErrors.length || diagnostics.externalRequests.length || diagnostics.loadingFailures.length || diagnostics.logErrors.length) report.failures.push(label + ': browser/runtime/network diagnostic failure')
  if (metrics.connected !== 'connected' || !metrics.pendingApproval || !metrics.transcriptEvents) report.failures.push(label + ': required resident content missing')
  await writeFile(join(artifacts, label + '.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ label, size: metrics.viewport, clientHash: loadedClientHash, overflowCount: metrics.horizontalOverflow.length, clippedControls: metrics.clippedControls.map(c => c.label), browserErrors: metrics.errors.length + diagnostics.exceptions.length + diagnostics.consoleErrors.length, screenshot }))
}
try {
  report.browser = await send('Browser.getVersion')
  for (const viewport of [{ label: 'resident-desktop-1440x900', width: 1440, height: 900 }, { label: 'resident-narrow-390x844', width: 390, height: 844 }]) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const diagnostics = { exceptions: [], consoleErrors: [], externalRequests: [], loadingFailures: [], logErrors: [] }
    let clientScriptId
    const handler = message => {
      if (message.sessionId !== sessionId) return
      if (message.method === 'Debugger.scriptParsed' && message.params.url === pathToFileURL(clientPath).href) clientScriptId = message.params.scriptId
      if (message.method === 'Runtime.exceptionThrown') diagnostics.exceptions.push(message.params.exceptionDetails)
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) diagnostics.consoleErrors.push(message.params)
      if (message.method === 'Network.requestWillBeSent' && !message.params.request.url.startsWith('file:') && !message.params.request.url.startsWith('data:')) diagnostics.externalRequests.push(message.params.request.url)
      if (message.method === 'Network.loadingFailed') diagnostics.loadingFailures.push(message.params)
      if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params.entry.level)) diagnostics.logErrors.push(message.params.entry)
    }
    handlers.add(handler)
    await send('Runtime.enable', {}, sessionId)
    await send('Debugger.enable', {}, sessionId)
    await send('Page.enable', {}, sessionId)
    await send('Log.enable', {}, sessionId)
    await send('Network.enable', {}, sessionId)
    await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] }, sessionId)
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId)
    const navigation = await send('Page.navigate', { url: fixture }, sessionId)
    if (navigation.errorText) throw new Error('Fixture navigation failed: ' + navigation.errorText)
    const ready = await evaluate(sessionId, `new Promise(resolve => {
      const deadline = performance.now() + 12000;
      const check = () => {
        const status = document.documentElement.dataset.testResult;
        if (status || performance.now() > deadline) resolve({status, results: document.getElementById('results')?.textContent});
        else setTimeout(check, 25);
      }; check();
    })`)
    if (ready.status !== 'passed') throw new Error('Fixture failed at ' + viewport.label + ': ' + JSON.stringify({ ready, diagnostics }))
    if (!clientScriptId) throw new Error('Did not observe actual classic client script')
    const { scriptSource } = await send('Debugger.getScriptSource', { scriptId: clientScriptId }, sessionId)
    const loadedClientHash = hash(scriptSource)
    if (loadedClientHash !== initialClientHash) throw new Error('Client changed or browser loaded different source: ' + loadedClientHash)
    await capture(sessionId, viewport.label, loadedClientHash, diagnostics)
    if (viewport.width === 390) {
      await evaluate(sessionId, 'window.__residentQA.measure().sidebarVisible ? null : window.__residentQA.toggleSessions()')
      await capture(sessionId, 'resident-narrow-sessions-visible', loadedClientHash, diagnostics)
      await evaluate(sessionId, 'window.__residentQA.measure().sidebarVisible ? window.__residentQA.toggleSessions() : null')
      await capture(sessionId, 'resident-narrow-sessions-hidden', loadedClientHash, diagnostics)
      await evaluate(sessionId, 'window.__residentQA.scrollConversation()')
      await capture(sessionId, 'resident-narrow-conversation', loadedClientHash, diagnostics)
      await evaluate(sessionId, 'window.__residentQA.expandModel()')
      await capture(sessionId, 'resident-narrow-model-expanded', loadedClientHash, diagnostics)
    }
    await evaluate(sessionId, 'window.__residentQA.dispose()')
    handlers.delete(handler)
    report.diagnostics.push({ viewport: viewport.label, ...diagnostics })
    await send('Target.closeTarget', { targetId })
  }
} catch (error) {
  report.failures.push(String(error.stack || error))
  console.error(error)
} finally {
  report.finalClientHash = hash(await readFile(clientPath))
  report.clientUnchanged = initialClientHash === report.finalClientHash
  if (!report.clientUnchanged) report.failures.push('Client hash changed during QA; rerun on a stable source')
  try { await send('Browser.close') } catch { child.kill('SIGTERM') }
  const killTimeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(killTimeout)
  await writeFile(join(artifacts, 'resident-chrome.log'), stderr + '\nSTDOUT\n' + stdout)
  // Reverify the exact resolved path immediately before the only deletion.
  if (await realpath(profile) !== verifiedProfile || !verifiedProfile.startsWith(verifiedArtifacts + sep + '.resident-chrome-')) throw new Error('Refusing unexpected profile cleanup target')
  await rm(verifiedProfile, { recursive: true, force: true })
  report.layoutFindings = report.captures.filter(c => c.horizontalOverflow.length || c.clippedControls.length).map(c => ({ label: c.label, overflowCount: c.horizontalOverflow.length, clippedControls: c.clippedControls.map(item => item.label) }))
  report.result = report.failures.length ? 'failed' : report.layoutFindings.length ? 'rendered-with-layout-findings' : 'passed'
  await writeFile(join(artifacts, 'resident-visual-qa.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ result: report.result, clientHash: initialClientHash, clientUnchanged: report.clientUnchanged, captures: report.captures.length, layoutFindings: report.layoutFindings, failures: report.failures, report: join(artifacts, 'resident-visual-qa.json') }, null, 2))
if (report.failures.length || (process.argv.includes('--strict-layout') && report.layoutFindings.length)) process.exitCode = 1
