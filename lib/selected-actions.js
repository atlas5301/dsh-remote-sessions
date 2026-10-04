/**
 * Explicit selected provider/model/API-key actions. Integration only through
 * installSelectedActions(ctx, registry, {sshExchange, registerRoutes,
 * readSettingsSection}). registerRoutes MUST enforce the host's admission on
 * both HTTP and Connection transports; tokens are not a substitute for cookies.
 * No local store reads, deployment, automatic SSH or UI asset loading occurs.
 * Authority identity is independent of every UI and physical transport.
 *
 * Preview does a public hash-only probe, then a PRIVATE stdin-only merge dry-run
 * using the exact selected-sync module, imported remotely from our own static
 * source in memory. Neither remote operation writes or emits document contents.
 * Apply uses the original in-process plan with pinned hashes, consumes its
 * random authorization BEFORE SSH, and never retries, even on unknown outcome.
 * Caller cancellation can cancel preview, but cannot undo an admitted apply.
 *
 * Only an existing safe ~/.npm-global installation and existing ~/.dsh targets
 * are supported. A managed home llm-pi-ai row is required: no guessing inherited
 * effective config, full-store transport, remote defaults, OAuth, or browser
 * records. Backups/CAS are not a lock or multi-file transaction. No reload,
 * remote start, readiness claim, ACL check, or automatic recovery is performed.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { machineIdentity } from './authority.js';
import { createSelectedSyncPlan, createSelectedSyncPayload, generateRemoteMergeProgram } from './selected-sync.js';

export const SELECTED_ACTION_LIMITS = Object.freeze({
  maxBodyBytes: 64 * 1024, maxSelections: 64, maxCredentialRefs: 64,
  maxTokens: 64, maxConcurrent: 8, tokenTtlMs: 5 * 60 * 1000,
  previewTimeoutMs: 60 * 1000, applyTimeoutMs: 60 * 1000,
  maxPayloadBytes: 4 * 1024 * 1024, maxReplyBytes: 16 * 1024,
});
const CODES = new Set(`INVALID_REQUEST BODY_TOO_LARGE EXPLICIT_SELECTION_REQUIRED INVALID_SELECTION INVALID_IDENTIFIER
DUPLICATE_SELECTION SELECTED_PROVIDER_NOT_FOUND SELECTED_MODEL_NOT_FOUND INVALID_CREDENTIAL_SELECTION
INVALID_CREDENTIAL_REF NON_API_KEY_REF DUPLICATE_CREDENTIAL_REF UNSELECTED_ROUTE_CREDENTIAL
SELECTED_CREDENTIAL_NOT_FOUND INVALID_DEFAULT_PIN UNSELECTED_DEFAULT_PIN INVALID_REASONING_EFFORT
UNSUPPORTED_ROUTE_FIELD UNSUPPORTED_MODEL_FIELD EXPLICIT_MODELS_REQUIRED DUPLICATE_MODEL INVALID_PROFILE_VALUE
UNSUPPORTED_COMPAT_FIELD UNSUPPORTED_RETRY_FIELD INVALID_REASONING_EFFORTS INVALID_MODEL_OVERRIDES
EMBEDDED_AUTH_MATERIAL EMBEDDED_HEADER_MATERIAL INVALID_BASE_URL EMBEDDED_URL_MATERIAL INVALID_JSON UNSAFE_KEY
LOCAL_SETTINGS_UNAVAILABLE CREDENTIAL_RESOLUTION_FAILED UNKNOWN_MACHINE MACHINE_IDENTITY_CHANGED
DISPOSED BUSY TOKEN_NOT_FOUND TOKEN_EXPIRED CONFIRM_REQUIRED REQUEST_CANCELLED PREVIEW_FAILED
INVALID_REMOTE_REPLY REMOTE_IO_FAILED POSIX_PROTECTION_REQUIRED UNSAFE_DIRECTORY UNSAFE_FILE FILE_RACE
REMOTE_FILE_TOO_LARGE INPUT_TOO_LARGE INVALID_REMOTE_INPUT UNSAFE_INSTALLATION YAML_DISCOVERY_FAILED
REMOTE_BASE_CONFIG_REQUIRED INVALID_REMOTE_YAML INVALID_REMOTE_CONFIG_ROOT INVALID_REMOTE_PATCH_ROW
AMBIGUOUS_MANAGED_ROW INVALID_MANAGED_CONFIG INVALID_REMOTE_PROVIDERS INVALID_REMOTE_PROVIDER
INVALID_REMOTE_MODELS INVALID_REMOTE_MODEL_OVERRIDES INVALID_REMOTE_MODEL SHARED_ROUTE_CHANGE_CONFLICT
AUTH_REF_CHANGE_REQUIRES_SELECTED_CREDENTIAL INVALID_REMOTE_CREDENTIAL_ROOT INVALID_REMOTE_CREDENTIAL_FIELDS
VERSIONED_CREDENTIALS_REQUIRED INVALID_REMOTE_CREDENTIAL_SECTION INVALID_REMOTE_CREDENTIAL_VALUE
INVALID_REMOTE_CREDENTIAL_RECORD CONFIG_CHANGED CREDENTIALS_CHANGED CONCURRENT_CHANGE TARGET_CREATION_REQUIRES_OPERATOR
PATH_NOT_ALLOWED INVALID_YAML_MODULE_PATH PLAN_HASH_MISMATCH REMOTE_MERGE_FAILED PAYLOAD_TOO_LARGE
APPLY_OUTCOME_UNKNOWN`.split(/\s+/));
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function code(error, fallback) { return CODES.has(error?.code) ? error.code : fallback; }
function remoteCode(result, fallback) { return CODES.has(result?.error) ? result.error : fallback; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function fields(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_REQUEST'); }
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(JSON.stringify(value));
}
function quote(source) { return "'" + source.replace(/'/g, "'\\''") + "'"; }
function command(source, machine) {
  // Static source ONLY in argv. All refs, selections and private payloads are stdin.
  if (machine.remoteNode) return quote(machine.remoteNode) + ' -e ' + quote(source);
  // Compatibility for isolated helper fixtures; production registry requires remoteNode.
  return 'export PATH="$HOME/opt/node-v22/bin:$HOME/.npm-global/bin:$PATH"; node -e ' + quote(source);
}
function lifetime(req, res, parent) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once?.('aborted', abort); res.once?.('close', abort);
  req.signal?.addEventListener('abort', abort, { once: true });
  parent?.addEventListener('abort', abort, { once: true });
  if (req.aborted || req.signal?.aborted || res.destroyed || parent?.aborted) abort();
  return { signal: controller.signal, dispose() {
    req.off?.('aborted', abort); res.off?.('close', abort);
    req.signal?.removeEventListener('abort', abort); parent?.removeEventListener('abort', abort);
  } };
}
async function until(promise, signal) {
  signal.throwIfAborted(); let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason ?? new Error('REQUEST_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
async function body(req, signal) {
  const chunks = []; let size = 0; const iterator = req[Symbol.asyncIterator]();
  try {
    while (true) {
      const { value, done } = await until(iterator.next(), signal); if (done) break;
      const bytes = Buffer.from(value); size += bytes.length;
      if (size > SELECTED_ACTION_LIMITS.maxBodyBytes) fail('BODY_TOO_LARGE'); chunks.push(bytes);
    }
    signal.throwIfAborted();
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_REQUEST'); }
  } finally { if (signal.aborted) req.destroy?.(); }
}
function reply(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > SELECTED_ACTION_LIMITS.maxReplyBytes) fail('INVALID_REMOTE_REPLY');
  try { const result = JSON.parse(text); if (!object(result)) fail('INVALID_REMOTE_REPLY'); return result; }
  catch { fail('INVALID_REMOTE_REPLY'); }
}
function hash(value) { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value); }
function changed(value) {
  if (!object(value) || Object.keys(value).length !== 2 || typeof value.config !== 'boolean' || typeof value.credentials !== 'boolean') fail('INVALID_REMOTE_REPLY');
  return { config: value.config, credentials: value.credentials };
}
function kinds(value) {
  if (!Array.isArray(value) || value.length > 2 || new Set(value).size !== value.length ||
    value.some(kind => !['config', 'credentials'].includes(kind))) fail('INVALID_REMOTE_REPLY');
  return [...value];
}

// This function's source is shipped, never remote-provided code. There are no
// write operations. The installed YAML loader is admitted only after canonical
// path, ancestry, owner/mode, and installed-bin discovery checks.
async function remoteAccess() {
  const fs = require('node:fs/promises'), { constants } = require('node:fs');
  const path = require('node:path'), os = require('node:os');
  const fail = code => { const error = new Error(code); error.code = code; throw error; };
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || !constants.O_NOFOLLOW) fail('POSIX_PROTECTION_REQUIRED');
  const uid = process.getuid(), home = path.resolve(os.homedir());
  const install = path.join(home, '.npm-global'), dshHome = path.join(home, '.dsh');
  const components = filename => { const result = []; let cursor = filename;
    while (true) { result.unshift(cursor); const parent = path.dirname(cursor); if (parent === cursor) return result; cursor = parent; } };
  async function directories(filename, owned = false) {
    for (const name of components(filename)) {
      const stat = await fs.lstat(name);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || (stat.mode & 0o7000) ||
        ![0, uid].includes(stat.uid) || owned && name === filename && stat.uid !== uid) fail('UNSAFE_DIRECTORY');
    }
  }
  function fileInfo(stat, credentials = false, installed = false) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (installed ? ![uid, 0].includes(stat.uid) : stat.uid !== uid) || (stat.mode & 0o7000) ||
      (stat.mode & (credentials ? 0o077 : 0o022))) fail('UNSAFE_FILE');
  }
  async function read(filename, credentials = false, installed = false, missing = false) {
    let before; try { before = await fs.lstat(filename); }
    catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    fileInfo(before, credentials, installed);
    if (before.size > 4 * 1024 * 1024) fail('REMOTE_FILE_TOO_LARGE');
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat(); fileInfo(opened, credentials, installed);
      if (before.dev !== opened.dev || before.ino !== opened.ino) fail('FILE_RACE');
      const text = await handle.readFile('utf8'), after = await handle.stat();
      if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs || Buffer.byteLength(text) > 4 * 1024 * 1024) fail('FILE_RACE');
      const named = await fs.lstat(filename); fileInfo(named, credentials, installed);
      if (named.dev !== after.dev || named.ino !== after.ino || named.ctimeMs !== after.ctimeMs) fail('FILE_RACE');
      return text;
    } finally { await handle.close(); }
  }
  await directories(install, true); await directories(path.join(install, 'bin'));
  const bin = path.join(install, 'bin', 'dsh'), beforeBin = await fs.lstat(bin);
  if ((!beforeBin.isSymbolicLink() && !beforeBin.isFile()) || ![uid, 0].includes(beforeBin.uid)) fail('UNSAFE_INSTALLATION');
  const entry = await fs.realpath(bin), modules = path.join(install, 'lib', 'node_modules');
  if (!entry.startsWith(modules + '/') || /[\x00-\x1f\x7f]/.test(entry) ||
    entry.split('/').some(part => part === '.' || part === '..') || !/\.(?:c?js|mjs)$/.test(entry)) fail('UNSAFE_INSTALLATION');
  // Only the fixed installed CLI package may serve as createRequire's anchor.
  const relative = entry.slice(modules.length + 1);
  if (!relative.startsWith('@deepseek-ai/dsh/')) fail('UNSAFE_INSTALLATION');
  await directories(path.dirname(entry)); fileInfo(await fs.lstat(entry), false, true);
  const installedRequire = require('node:module').createRequire(entry);
  let yamlModulePath;
  try { yamlModulePath = installedRequire.resolve('yaml'); } catch { fail('YAML_DISCOVERY_FAILED'); }
  if (!yamlModulePath.startsWith(modules + '/') || !/\/node_modules\/yaml\/dist\/index\.js$/.test(yamlModulePath) ||
    /[\x00-\x1f\x7f]/.test(yamlModulePath) || yamlModulePath.split('/').some(part => part === '.' || part === '..')) fail('UNSAFE_INSTALLATION');
  await directories(path.dirname(yamlModulePath)); fileInfo(await fs.lstat(yamlModulePath), false, true);
  if (await fs.realpath(yamlModulePath) !== yamlModulePath || await fs.realpath(bin) !== entry) fail('UNSAFE_INSTALLATION');
  await directories(dshHome, true);
  return { yamlModulePath, dshHome, yaml: () => installedRequire(yamlModulePath),
    config: () => read(path.join(dshHome, 'cordis.patch.yml'), false, false, true),
    credentials: () => read(path.join(dshHome, '.credentials.yaml'), true, false, true), fail };
}
async function remoteReadInput() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += Buffer.byteLength(chunk);
    if (size > 4 * 1024 * 1024) { const error = new Error('INPUT_TOO_LARGE'); error.code = 'INPUT_TOO_LARGE'; throw error; }
    chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('INVALID_REMOTE_INPUT'); error.code = 'INVALID_REMOTE_INPUT'; throw error; }
}
function sourceHeader() {
  return `'use strict';\nconst remoteAccess = ${remoteAccess.toString()};\nconst remoteReadInput = ${remoteReadInput.toString()};\n` +
    `const safeCodes = new Set(${JSON.stringify([...CODES])});\n` +
    `const report = error => process.stdout.write(JSON.stringify({ok:false,error:safeCodes.has(error.code)?error.code:'REMOTE_IO_FAILED'})+'\\n');\n`;
}
/** Static, public-ref-only, read-only probe. Backend receives hashes, NOT YAML. */
export function generateSelectedSyncProbeProgram() {
  return sourceHeader() + `(async()=>{try{const input=await remoteReadInput();
    if(!input || input.version!==1 || Object.keys(input).some(k=>!['version','selections','credentialRefs'].includes(k)) ||
      !Array.isArray(input.selections) || !input.selections.length || input.selections.length>64 ||
      !Array.isArray(input.credentialRefs) || input.credentialRefs.length>64 ||
      input.selections.some(s=>!s || Object.keys(s).length!==2 || typeof s.provider!=='string' || typeof s.model!=='string') ||
      input.credentialRefs.some(r=>typeof r!=='string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r))) throw {code:'INVALID_REMOTE_INPUT'};
    const access=await remoteAccess(), config=await access.config();
    const digest=text=>'sha256:'+require('node:crypto').createHash('sha256').update(text===null?'selected-sync-document-v1\\nabsent':'selected-sync-document-v1\\npresent\\n'+text,'utf8').digest('hex');
    const expectedHashes={config:digest(config)};
    if(input.credentialRefs.length) expectedHashes.credentials=digest(await access.credentials());
    process.stdout.write(JSON.stringify({ok:true,yamlModulePath:access.yamlModulePath,expectedHashes})+'\\n');
  }catch(error){report(error)}})();\n`;
}
/** Loads ONLY our own static module source; no writer-source rewriting. */
export function generateSelectedSyncPreviewProgram() {
  const moduleBase64 = Buffer.from(readFileSync(new URL('./selected-sync.js', import.meta.url), 'utf8')).toString('base64');
  return sourceHeader() + `(async()=>{try{const payload=await remoteReadInput(),access=await remoteAccess();
    if(payload.yamlModulePath!==access.yamlModulePath) access.fail('UNSAFE_INSTALLATION');
    const sync=await import('data:text/javascript;base64,${moduleBase64}');
    const configText=await access.config(), credentialsText=Object.keys(payload.operations.refs).length?await access.credentials():null;
    const result=sync.mergeSelectedSyncDocuments({configText,credentialsText,payload,yaml:access.yaml()});
    if(result.changed.config && configText===null || result.changed.credentials && credentialsText===null) access.fail('TARGET_CREATION_REQUIRES_OPERATOR');
    process.stdout.write(JSON.stringify({ok:true,changed:result.changed})+'\\n');
  }catch(error){report(error)}})();\n`;
}
/** Run unchanged writer with exitCode isolated, preserving partial-commit JSON.
 * sshExchange otherwise discards stdout on a nonzero remote exit. Not a sandbox:
 * this is our own static writer, and the trusted installed YAML is revalidated.
 */
export function generateSelectedSyncApplyProgram() {
  const writer = Buffer.from(generateRemoteMergeProgram()).toString('base64');
  return sourceHeader() + `(async()=>{try{const payload=await remoteReadInput(),access=await remoteAccess();
    if(payload.yamlModulePath!==access.yamlModulePath) access.fail('UNSAFE_INSTALLATION');
    const {Readable}=require('node:stream'), shadow=Object.create(process);
    Object.defineProperty(shadow,'stdin',{value:Readable.from([JSON.stringify(payload)])});
    Object.defineProperty(shadow,'exitCode',{value:0,writable:true});
    Function('require','process','Buffer','URL',Buffer.from('${writer}','base64').toString('utf8'))(require,shadow,Buffer,URL);
  }catch(error){report(error)}})();\n`;
}

export function installSelectedActions(ctx, registry, { sshExchange, registerRoutes, readSettingsSection }) {
  if (typeof sshExchange !== 'function' || typeof registerRoutes !== 'function' || typeof readSettingsSection !== 'function') fail('INVALID_REQUEST');
  const tokens = new Map(), operations = new Set(); let disposed = false;
  // Lazy construction avoids reading selected-sync's own static source at import.
  let probeSource, previewSource, applySource;
  const find = name => registry.machines.find(machine => machine.name === name && !machine.disabled && !machine.migrationRequired);
  function current(name, identity) { const machine = find(name);
    if (!machine || machineIdentity(machine) !== identity) fail('MACHINE_IDENTITY_CHANGED'); return machine; }
  function sweep() { const now = Date.now(); for (const [token, entry] of tokens) {
    const machine = find(entry.machine); if (now >= entry.expiresAt || !machine || machineIdentity(machine) !== entry.identity) tokens.delete(token);
  } }
  function begin(timeout) {
    if (disposed) fail('DISPOSED');
    if (operations.size >= SELECTED_ACTION_LIMITS.maxConcurrent) fail('BUSY');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
    operations.add(controller);
    return { signal: controller.signal, end() { clearTimeout(timer); operations.delete(controller); } };
  }
  function dispose() { if (disposed) return; disposed = true; clearInterval(cleanup); tokens.clear();
    for (const controller of operations) controller.abort(); operations.clear(); }
  const cleanup = setInterval(sweep, 30 * 1000); cleanup.unref?.();
  ctx.effect(() => dispose, 'remote-sessions.selected-actions');
  async function preview(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    let operation, caller;
    try {
      operation = begin(SELECTED_ACTION_LIMITS.previewTimeoutMs); caller = lifetime(req, res, operation.signal);
      const input = await body(req, caller.signal);
      fields(input, ['machine', 'selections', 'credentialRefs', 'defaultPin']);
      if (typeof input.machine !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.machine) ||
        !Array.isArray(input.selections) || !input.selections.length || input.selections.length > SELECTED_ACTION_LIMITS.maxSelections ||
        !Array.isArray(input.credentialRefs) || input.credentialRefs.length > SELECTED_ACTION_LIMITS.maxCredentialRefs) fail('INVALID_REQUEST');
      const machine = find(input.machine); if (!machine || !Array.isArray(machine.ssh) || !machine.ssh.length) fail('UNKNOWN_MACHINE');
      const identity = machineIdentity(machine);
      let providers; try { providers = readSettingsSection(ctx.settings, 'llm-pi-ai')?.providers; }
      catch { fail('LOCAL_SETTINGS_UNAVAILABLE'); }
      // Validate ALL selections/refs/pin before requesting any credential value.
      const dummyRefs = Object.fromEntries(input.credentialRefs.filter(ref => typeof ref === 'string').map(ref => [ref, 'validation-only']));
      createSelectedSyncPlan({ providers, selections: input.selections, credentialRefs: input.credentialRefs,
        defaultPin: input.defaultPin, credentials: { version: 1, refs: dummyRefs } });
      const refs = {};
      if (input.credentialRefs.length) {
        let credentials; try { credentials = ctx.get('credentials'); } catch { fail('CREDENTIAL_RESOLUTION_FAILED'); }
        if (typeof credentials?.resolve !== 'function') fail('CREDENTIAL_RESOLUTION_FAILED');
        for (const ref of input.credentialRefs) {
          caller.signal.throwIfAborted(); let result;
          try { result = await until(Promise.resolve(credentials.resolve(ref)), caller.signal); } catch { fail('CREDENTIAL_RESOLUTION_FAILED'); }
          if (typeof result?.value !== 'string' || !result.value.length) fail('SELECTED_CREDENTIAL_NOT_FOUND'); refs[ref] = result.value;
        }
      }
      caller.signal.throwIfAborted();
      const plan = createSelectedSyncPlan({ providers, selections: input.selections, credentialRefs: input.credentialRefs,
        defaultPin: input.defaultPin, credentials: { version: 1, refs } });
      current(input.machine, identity);
      probeSource ??= generateSelectedSyncProbeProgram();
      const probe = reply(await until(sshExchange(ctx, machine, command(probeSource, machine),
        JSON.stringify({ version: 1, selections: input.selections, credentialRefs: plan.credentialRefs }), caller.signal), caller.signal));
      if (probe.ok !== true) fail(remoteCode(probe, 'PREVIEW_FAILED'));
      fields(probe, ['ok', 'yamlModulePath', 'expectedHashes']); fields(probe.expectedHashes, ['config', 'credentials']);
      if (!hash(probe.expectedHashes.config) || (plan.credentialRefs.length ? !hash(probe.expectedHashes.credentials) : probe.expectedHashes.credentials !== undefined)) fail('INVALID_REMOTE_REPLY');
      const payloadOptions = { yamlModulePath: probe.yamlModulePath, expectedHashes: probe.expectedHashes };
      const payload = createSelectedSyncPayload(plan, payloadOptions);
      if (Buffer.byteLength(payload) > SELECTED_ACTION_LIMITS.maxPayloadBytes) fail('PAYLOAD_TOO_LARGE');
      caller.signal.throwIfAborted(); current(input.machine, identity);
      previewSource ??= generateSelectedSyncPreviewProgram();
      const dryrun = reply(await until(sshExchange(ctx, machine, command(previewSource, machine), payload, caller.signal), caller.signal));
      caller.signal.throwIfAborted(); current(input.machine, identity);
      if (dryrun.ok !== true) fail(remoteCode(dryrun, 'PREVIEW_FAILED'));
      fields(dryrun, ['ok', 'changed']); const changes = changed(dryrun.changed);
      if (!plan.credentialRefs.length && changes.credentials) fail('INVALID_REMOTE_REPLY');
      if (disposed) fail('DISPOSED'); sweep(); if (tokens.size >= SELECTED_ACTION_LIMITS.maxTokens) fail('BUSY');
      const token = randomUUID(), expiresAt = Date.now() + SELECTED_ACTION_LIMITS.tokenTtlMs;
      tokens.set(token, { plan, payloadOptions, machine: input.machine, identity, expiresAt });
      const profiles = JSON.parse(payload).operations.routes;
      json(res, 200, { ok: true, token, expiresAt, preview: { version: 1, machine: input.machine, identity,
        routes: plan.routes.map(route => ({ provider: route.provider, models: [...route.models],
          ...(route.apiKeyEnv === undefined ? {} : { apiKeyEnv: route.apiKeyEnv }),
          sharedFields: Object.keys(profiles.find(profile => profile.provider === route.provider).profile).filter(key => !['models', 'modelOverrides'].includes(key)).sort() })),
        credentialRefs: [...plan.credentialRefs], defaultPin: plan.defaultPin, changed: changes,
        warnings: [...plan.warnings, 'Selected values travel only on private SSH stdin. No runtime reload is performed.',
          'The home managed provider row and every changed target must already exist.',
          'Apply is one-use. After disconnect or partial failure, inspect the remote and preview anew; never replay.'] } });
    } catch (error) {
      const errorCode = caller?.signal.aborted ? 'REQUEST_CANCELLED' : code(error, 'PREVIEW_FAILED');
      json(res, errorCode === 'BODY_TOO_LARGE' ? 413 : ['BUSY', 'DISPOSED'].includes(errorCode) ? 503 : errorCode === 'UNKNOWN_MACHINE' ? 404 : errorCode === 'MACHINE_IDENTITY_CHANGED' ? 409 : 400,
        { ok: false, error: errorCode });
    } finally { caller?.dispose(); operation?.end(); }
  }
  async function apply(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    let operation, caller, started = false;
    try {
      operation = begin(SELECTED_ACTION_LIMITS.applyTimeoutMs); caller = lifetime(req, res, operation.signal);
      const input = await body(req, caller.signal); fields(input, ['token', 'confirm']);
      if (input.confirm !== true) fail('CONFIRM_REQUIRED');
      if (typeof input.token !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.token)) fail('TOKEN_NOT_FOUND');
      const entry = tokens.get(input.token); if (!entry) fail('TOKEN_NOT_FOUND');
      tokens.delete(input.token); // irrevocably consume BEFORE any execution
      if (Date.now() >= entry.expiresAt) fail('TOKEN_EXPIRED');
      const machine = current(entry.machine, entry.identity);
      const payload = createSelectedSyncPayload(entry.plan, entry.payloadOptions);
      caller.signal.throwIfAborted(); if (disposed) fail('DISPOSED');
      applySource ??= generateSelectedSyncApplyProgram();
      started = true;
      // Deliberately NOT caller.signal: disconnect cannot imply rollback. Timeout
      // or disposal can interrupt SSH, but always yields unknown and no replay.
      const result = reply(await until(sshExchange(ctx, machine, command(applySource, machine), payload, operation.signal), operation.signal));
      if (result.ok === true) {
        fields(result, ['ok', 'changed', 'backups']); const committed = kinds(result.changed);
        if (!entry.plan.credentialRefs.length && committed.includes('credentials')) fail('INVALID_REMOTE_REPLY');
        if (!Array.isArray(result.backups) || result.backups.length > 2 || result.backups.some(name => typeof name !== 'string')) fail('INVALID_REMOTE_REPLY');
        return json(res, 200, { ok: true, changed: committed, backupCount: result.backups.length,
          reloadRequired: committed.length > 0, tokenConsumed: true });
      }
      fields(result, ['ok', 'error', 'committed']);
      if (result.ok !== false) fail('INVALID_REMOTE_REPLY');
      const committed = result.committed === undefined ? [] : kinds(result.committed);
      if (!entry.plan.credentialRefs.length && committed.includes('credentials')) fail('INVALID_REMOTE_REPLY');
      json(res, 409, { ok: false, error: remoteCode(result, 'REMOTE_MERGE_FAILED'), committed,
        outcome: committed.length ? 'partial' : 'not-committed', tokenConsumed: true, previewRequired: true });
    } catch (error) {
      json(res, started ? 502 : ['BUSY', 'DISPOSED'].includes(error?.code) ? 503 : 409,
        started ? { ok: false, error: 'APPLY_OUTCOME_UNKNOWN', outcome: 'unknown', tokenConsumed: true, previewRequired: true } :
          { ok: false, error: caller?.signal.aborted ? 'REQUEST_CANCELLED' : code(error, 'INVALID_REQUEST'), previewRequired: true });
    } finally { caller?.dispose(); operation?.end(); }
  }
  registerRoutes(ctx, [{ kind: 'exact', path: '/remote-sessions/selected-sync/preview', handler: preview },
    { kind: 'exact', path: '/remote-sessions/selected-sync/apply', handler: apply }]);
  return Object.freeze({ dispose });
}
