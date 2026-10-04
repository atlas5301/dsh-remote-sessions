/** Plugin-only resident session host. Nothing connects, spawns agents or syncs at boot. */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import z from '@deepseek-ai/schemastery';
import { createSessionBroker } from './session-broker.js';
import { installSelectedActions } from './selected-actions.js';
import { installTransferActions } from './transfer-actions.js';
import { createMachineRegistry, publicMachine, validateTransport, STRICT_SSH_OPTIONS, failure } from './machine-registry.js';

// Legacy records are quarantined by machine-registry through their missing
// socketPath / mismatched runtimeMode; the schema itself stays clean so the
// native plugin-config form renders real fields only.
export const Machine = z.object({
  name: z.string().required(), runtimeMode: z.string().default('remote-runtime'),
  ssh: z.array(z.string()).default([]), remoteNode: z.string(), socketPath: z.string(),
  remoteCwd: z.string(), modelProvider: z.string(), modelId: z.string(), effort: z.string(),
  authorityRevision: z.string().default(''), command: z.string().default('ssh'), env: z.dict(z.string().role('secret')).default({}),
  autoSetup: z.boolean(), npmInstall: z.boolean(), remoteCli: z.string(), remoteHome: z.string(),
  residentProfile: z.string(), runtimeDirectory: z.string(), dshVersion: z.string(),
  plugins: z.array(z.object({ package: z.string().required(), version: z.string(), config: z.any() })),
  syncModels: z.boolean(), syncPluginStates: z.boolean(),
});
export const Config = z.object({ machines: z.array(Machine).default([]), syncAtStartup: z.boolean().default(false), connectAtStartup: z.boolean().default(false) });
export const HOST_LIMITS = Object.freeze({ bodyBytes: 1024 * 1024, responseBytes: 8 * 1024 * 1024, requestMs: 300000, concurrent: 64, sshMs: 60000, sshOutputBytes: 8 * 1024 * 1024, sshInputBytes: 16 * 1024 * 1024 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw failure('INVALID_REQUEST'); }
function until(promise, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? failure('REQUEST_CANCELLED', 499));
  if (!signal) return Promise.resolve(promise);
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason ?? failure('REQUEST_CANCELLED', 499)); signal.addEventListener('abort', abort, { once: true }); });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}
/** Request EOF/normal req.close is NOT a disconnect. Only aborted or unfinished response close is. */
export function requestLifetime(req, res, { timeoutMs = HOST_LIMITS.requestMs, parent } = {}) {
  const controller = new AbortController(), sourceSignal = req.signal;
  const abort = () => controller.abort(failure('REQUEST_CANCELLED', 499));
  const closed = () => { if (!res.writableEnded) abort(); };
  req.once?.('aborted', abort); res.once?.('close', closed);
  sourceSignal?.addEventListener('abort', abort, { once: true }); parent?.addEventListener('abort', abort, { once: true });
  if (req.aborted || sourceSignal?.aborted || res.destroyed || parent?.aborted) abort();
  const timer = setTimeout(() => controller.abort(failure('REQUEST_TIMEOUT', 504)), timeoutMs);
  return { signal: controller.signal, dispose() { clearTimeout(timer); req.off?.('aborted', abort); res.off?.('close', closed); sourceSignal?.removeEventListener('abort', abort); parent?.removeEventListener('abort', abort); } };
}
export function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  let body = JSON.stringify(value ?? null);
  if (Buffer.byteLength(body) > HOST_LIMITS.responseBytes) { status = 502; body = '{"error":"RESPONSE_TOO_LARGE"}'; }
  res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.end(body);
}
function errorReply(res, error) {
  const code = typeof error?.code === 'string' && /^[A-Z_]{2,64}$/.test(error.code) ? error.code : error?.name === 'AbortError' ? 'REQUEST_CANCELLED' : 'HOST_OPERATION_FAILED';
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status :
    code === 'BODY_TOO_LARGE' ? 413 : code === 'BUSY' ? 429 : code === 'REQUEST_CANCELLED' || code === 'CANCELLED' ? 499 :
      code.startsWith('INVALID_') || code === 'UNSUPPORTED_OPERATION' ? 400 : ['UNKNOWN_MACHINE', 'TARGET_NOT_FOUND'].includes(code) ? 404 :
        ['BINDING_GONE', 'BINDING_EXPIRED', 'BINDING_MISMATCH', 'AUTHORITY_CHANGED', 'MACHINE_CHANGED', 'RUNTIME_CHANGED', 'INSTANCE_CHANGED', 'MACHINE_DISABLED', 'UNSUPPORTED_RUNTIME'].includes(code) ? 409 : 502;
  sendJson(res, status, { error: code });
}
export async function readJsonBody(req, cap = HOST_LIMITS.bodyBytes, signal = req.signal) {
  if (req.headers?.['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > cap)) throw failure('BODY_TOO_LARGE', 413);
  const chunks = []; let size = 0;
  const iterator = req[Symbol.asyncIterator]();
  while (true) {
    const { value, done } = await until(iterator.next(), signal); if (done) break;
    const chunk = Buffer.from(value); size += chunk.length;
    if (size > cap) throw failure('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  signal?.throwIfAborted();
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('INVALID_JSON'); }
}
/** Complete EventEmitter response shim for installer lifetimes; Fetch abort survives body EOF. */
export function connectionRoute(route, { timeoutMs = HOST_LIMITS.requestMs } = {}) {
  if (!route.path.startsWith('/remote-sessions/')) throw failure('INVALID_ROUTE');
  // Buffered bodies with an explicit cap: the Desktop IPC carrier rejects
  // streaming-mode requests (an empty 400 before any handler runs), and one
  // bounded buffer keeps UTF-8 sequences split by the carrier intact.
  return {
    path: '/api' + route.path, methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      const headers = new Headers(); let response;
      const res = {
        statusCode: 200, writableEnded: false, destroyed: false,
        setHeader(key, value) { headers.set(key, value); },
        end(body) { if (this.writableEnded || this.destroyed) return; this.writableEnded = true; response = new Response(body, { status: this.statusCode, headers }); },
      };
      let req;
      try {
        const chunks = []; let size = 0;
        const reader = request.body?.getReader();
        let readTimer;
        try {
          if (reader) {
            while (true) {
              request.signal.throwIfAborted();
              // A stalled carrier read stays bounded: without this deadline a
              // wedged request would hold its handler slot open forever.
              const step = Promise.race([reader.read(), new Promise((_, reject) => {
                readTimer = setTimeout(() => reject(failure('REQUEST_TIMEOUT', 504)), timeoutMs);
              })]);
              const { done, value } = await step.finally(() => clearTimeout(readTimer));
              if (done) break;
              size += value.byteLength;
              if (size > HOST_LIMITS.bodyBytes) { await reader.cancel().catch(() => {}); throw failure('BODY_TOO_LARGE', 413); }
              chunks.push(Buffer.from(value));
            }
          }
        } catch (error) { reader?.cancel().catch(() => {}); throw error; }
        finally { reader?.releaseLock(); clearTimeout(readTimer); }
        request.signal.throwIfAborted();
        const url = new URL(request.url);
        req = Readable.from(size ? [Buffer.concat(chunks, size)] : []);
        req.method = request.method; req.url = route.path + url.search; req.headers = Object.fromEntries(request.headers);
        // The carrier's signal rides on the request: registerRoutes' lifetime
        // races handler execution against it, so a browser abort cancels work
        // in flight instead of waiting for its completion.
        req.signal = request.signal;
        await route.handler(req, res);
        if (!response) throw request.signal.aborted ? failure('REQUEST_CANCELLED', 499) : failure('INCOMPLETE_RESPONSE', 500);
        return response;
      } catch (error) {
        if (request.signal.aborted && !response) { errorReply(res, failure('REQUEST_CANCELLED', 499)); }
        else errorReply(res, error);
        return response ?? Response.json({ error: 'HOST_OPERATION_FAILED' }, { status: 502 });
      } finally { req?.destroy(); }
    },
  };
}
/** Both registrars are trusted DSH carriers. Legacy HTTP explicitly uses admission. */
export function registerRoutes(ctx, routes) {
  const controller = new AbortController(); let active = 0;
  const wrapped = routes.map(route => ({ ...route, handler: async (req, res) => {
    if (active >= HOST_LIMITS.concurrent) return sendJson(res, 429, { error: 'BUSY' });
    const originalSignal = req.signal, life = requestLifetime(req, res, { parent: controller.signal }); req.signal = life.signal; active++;
    try { life.signal.throwIfAborted(); await until(Promise.resolve().then(() => { life.signal.throwIfAborted(); return route.handler(req, res); }), life.signal); }
    catch (error) { errorReply(res, error); }
    finally { active--; life.dispose(); req.signal = originalSignal; }
  } }));
  ctx.effect(() => () => controller.abort(), 'remote-sessions.request-lifetime');
  ctx.inject(['connection'], inner => {
    const connection = inner.get('connection');
    if (typeof connection?.fetch?.register !== 'function') throw failure('CONNECTION_UNAVAILABLE', 503);
    const disposers = [];
    try { for (const route of wrapped) disposers.push(connection.fetch.register(connectionRoute(route))); }
    catch (error) { for (const dispose of disposers) dispose(); throw error; }
    inner.effect(() => () => Promise.all(disposers.map(dispose => dispose())), 'remote-sessions.fetch-routes');
  });
  ctx.inject(['webServer', 'connection'], inner => {
    const connection = inner.get('connection'), server = inner.get('webServer');
    const disposers = wrapped.map(route => server.register({ ...route, handler: async (req, res) => {
      if (typeof connection?.admit !== 'function') return sendJson(res, 503, { error: 'AUTHENTICATION_UNAVAILABLE' });
      let admission; try { admission = connection.admit(req); } catch { return sendJson(res, 403, { error: 'REQUEST_NOT_ADMITTED' }); }
      if (!admission || 'rejection' in admission || !('peer' in admission)) return sendJson(res, [401, 403, 421].includes(admission?.rejection) ? admission.rejection : 403, { error: 'REQUEST_NOT_ADMITTED' });
      await route.handler(req, res);
    } }));
    inner.effect(() => () => Promise.all(disposers.map(dispose => dispose())), 'remote-sessions.web-routes');
  });
}
export function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
/** Explicit selected transfers use private stdin; never expose command, stderr or keys. */
export async function sshExchange(ctx, machine, remoteCommand, input, signal, limits = HOST_LIMITS) {
  if (machine.disabled) throw failure('MACHINE_DISABLED', 409);
  const transport = validateTransport(machine);
  if (typeof remoteCommand !== 'string' || remoteCommand.includes('\0') || Buffer.byteLength(remoteCommand) > 512 * 1024) throw failure('INVALID_REMOTE_COMMAND');
  if (input !== undefined && !(typeof input === 'string' || Buffer.isBuffer(input))) throw failure('INVALID_SSH_INPUT');
  if (input !== undefined && Buffer.byteLength(input) > limits.sshInputBytes) throw failure('SSH_INPUT_TOO_LARGE');
  const controller = new AbortController(); const abort = () => controller.abort(failure('REQUEST_CANCELLED', 499));
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(failure('SSH_TIMEOUT', 504)), limits.sshMs);
  let child, onAbort;
  try {
    controller.signal.throwIfAborted();
    child = ctx.subprocess.spawn({ argv: [transport.command, ...STRICT_SSH_OPTIONS, ...transport.ssh, remoteCommand], cwd: process.cwd(), stdio: { stdin: input === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'ignore' }, graceMs: 1000, env: transport.env });
    onAbort = () => { try { child.terminate(); child.stdin?.destroy?.(); child.stdout?.destroy?.(); } catch {} }; controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    if (!child.stdout || input !== undefined && !child.stdin) throw failure('SSH_FAILED', 502);
    const collecting = (async () => {
      const chunks = []; let size = 0;
      for await (const chunk of child.stdout) {
        size += Buffer.byteLength(chunk); if (size > limits.sshOutputBytes) throw failure('SSH_OUTPUT_TOO_LARGE', 502);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    })();
    const writing = input === undefined ? Promise.resolve() : new Promise((resolve, reject) => {
      const error = () => reject(failure('SSH_FAILED', 502)); child.stdin.once('error', error);
      child.stdin.end(input, () => resolve());
      // Keep the error listener until completion: a late EPIPE must not crash host.
    });
    const [outcome, output] = await until(Promise.all([child.done, collecting, writing]), controller.signal);
    if (outcome.exitCode !== 0) throw failure('SSH_FAILED', 502);
    return output;
  } catch (error) {
    try { child?.terminate(); child?.stdin?.destroy?.(); child?.stdout?.destroy?.(); } catch {}
    if (['REQUEST_CANCELLED', 'SSH_TIMEOUT', 'SSH_OUTPUT_TOO_LARGE'].includes(error?.code)) throw error;
    throw failure('SSH_FAILED', 502);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (onAbort) controller.signal.removeEventListener('abort', onAbort); }
}
export function readSettingsSection(settings, namespace) {
  try { const value = settings?.get?.(namespace); if (value !== undefined) return value; } catch {}
  try { return settings?.describe?.().find(item => item && String(item.ns) === namespace)?.value; } catch { return undefined; }
}
function post(path, action) {
  return { kind: 'exact', path, methods: ['POST'], handler: async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    try { sendJson(res, 200, await action(await readJsonBody(req), req.signal)); } catch (error) { errorReply(res, error); }
  } };
}
export function buildRoutes(ctx, registry, broker) {
  return [
    { kind: 'exact', path: '/remote-sessions/machines', methods: ['GET', 'POST'], handler: async (req, res) => {
      if (req.method === 'GET') return sendJson(res, 200, { machines: registry.machines.map(publicMachine) });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      try {
        const body = await readJsonBody(req); fields(body, ['machines']);
        registry.save(body.machines); await broker.reconcile();
        return sendJson(res, 200, { ok: true, machines: registry.machines.length });
      } catch (error) { errorReply(res, error); }
    } },
    post('/remote-sessions/session/attach', (body, signal) => { fields(body, ['target', 'expectedRuntimeId', 'expectedInstanceId']); return broker.attach(body, signal); }),
    post('/remote-sessions/session/execute', (body, signal) => { fields(body, ['binding', 'method', 'params']); return broker.execute(body, signal); }),
    post('/remote-sessions/session/detach', async body => { fields(body, ['binding']); return await broker.detach(body) ?? { detached: true }; }),
    ...[['url', 'GET'], ['sync', 'POST'], ['prepare', 'POST'], ['disconnect', 'POST'], ['skills', 'GET'], ['skills-sync', 'POST'], ['ws-mirror', 'POST'], ['ws-register', 'POST']].map(([suffix, method]) => ({ kind: 'exact', path: '/remote-sessions/' + suffix, methods: [method], handler: (req, res) => sendJson(res, req.method === method ? 410 : 405, { error: req.method === method ? 'LEGACY_ENDPOINT_DISABLED' : 'METHOD_NOT_ALLOWED' }) })),
  ];
}
export function buildWorkspaceRoutes(ctx, registry) {
  return [
    { kind: 'exact', path: '/remote-sessions/local-pick', methods: ['POST'], handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      const life = requestLifetime(req, res);
      try {
        const picker = ctx.get?.('directoryPicker'); const capability = await until(Promise.resolve(picker?.capability?.()), life.signal);
        if (capability?.kind !== 'native' || typeof capability.pick !== 'function') return sendJson(res, 501, { error: 'NATIVE_PICKER_UNAVAILABLE' });
        const outcome = await until(capability.pick(life.signal), life.signal);
        sendJson(res, 200, typeof outcome === 'string' && outcome.startsWith('/') && !outcome.includes('\0') ? { path: outcome } : { cancelled: true });
      } catch (error) { errorReply(res, error); } finally { life.dispose(); }
    } },
    { kind: 'exact', path: '/remote-sessions/ws-ls', methods: ['GET'], handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      try {
        const url = new URL(req.url, 'http://plugin.invalid'), machine = registry.machines.find(item => item.name === url.searchParams.get('machine'));
        if (!machine) throw failure('UNKNOWN_MACHINE', 404);
        const path = url.searchParams.get('path') || '~';
        if (Buffer.byteLength(path) > 4096 || /[\x00-\x1f\x7f]/.test(path) || !(path === '~' || path.startsWith('~/') || path.startsWith('/'))) throw failure('INVALID_DIRECTORY');
        const target = path === '~' ? '"$HOME"' : path.startsWith('~/') ? '"$HOME"/' + shellQuote(path.slice(2)) : shellQuote(path);
        const output = await sshExchange(ctx, machine, `cd ${target} && printf '%s\\0' "$PWD" && for entry in ./*/; do [ -d "$entry" ] || continue; printf '%s\\0' "\${entry#./}"; done`, undefined, req.signal);
        const names = output.split('\0').filter(Boolean), resolved = names.shift();
        if (!resolved?.startsWith('/') || /[\x00-\x1f\x7f]/.test(resolved)) throw failure('INVALID_DIRECTORY_REPLY', 502);
        const entries = names.map(name => name.replace(/\/$/, '')).filter(name => name && !name.includes('/') && !/[\x00-\x1f\x7f]/.test(name)).map(name => ({ name, path: (resolved === '/' ? '' : resolved) + '/' + name }));
        sendJson(res, 200, { path: resolved, entries });
      } catch (error) { errorReply(res, error); }
    } },
  ];
}
/** Trusted factory seams are for direct tests/host integration, never browser input. */
export function installHost(ctx, config = {}, options = {}) {
  const registry = options.registry ?? createMachineRegistry({ machines: config.machines ?? [], ...(options.file ? { file: options.file } : {}) });
  const broker = (options.createBroker ?? createSessionBroker)(ctx, registry, options.brokerOptions ?? {});
  registerRoutes(ctx, [...buildRoutes(ctx, registry, broker), ...buildWorkspaceRoutes(ctx, registry)]);
  (options.installSelected ?? installSelectedActions)(ctx, registry, { sshExchange, registerRoutes, readSettingsSection });
  (options.installTransfers ?? installTransferActions)(ctx, registry, { sshExchange, registerRoutes });
  ctx.effect(() => () => broker.dispose(), 'remote-sessions.broker');
  return { registry, broker };
}
export function apply(ctx, config) { installHost(ctx, config); }
export const name = 'remote-sessions';
export const inject = ['connection', 'subprocess', 'settings'];
