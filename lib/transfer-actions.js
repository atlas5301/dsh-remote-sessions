/**
 * Authenticated, explicitly selected LOCAL -> REMOTE pushes. No import-time
 * filesystem access, SSH, registration, deployment or GUI effects.
 *
 * Lead API: installTransferActions(ctx, registry, { sshExchange, registerRoutes })
 * registers exact POST /remote-sessions/selected-transfer/{preview,apply} routes
 * through the supplied cookie-authenticated registrar, and a disposal effect.
 * This module deliberately does not add a second/direct admission mechanism.
 *
 * Preview JSON: { machine, kind: 'skills'|'files', localRoot: absolute,
 *   selections: string[], approval: { kind, root, confirmed: true },
 *   direction?: 'push' }. There is NO implicit root or blanket selection.
 * Skills can only originate in (DSH_HOME || homedir() + '/.dsh') + '/skills';
 * their remote approval is exactly '~/.dsh/skills'. Files require explicitly
 * selected ordinary, non-system/non-config workspace roots on both ends.
 * Pull is NOT implemented; direction:'pull' is explicitly refused.
 *
 * Apply JSON: { machine, token, confirm: true, direction?: 'push',
 *   conflictAuthorizations?: [{ path, approveOverwrite: true,
 *     expectedLocalSha256, expectedRemoteSha256 }] }.
 * Every admitted apply attempt with a known token consumes it BEFORE preflight,
 * including missing confirmation, cancellation, retargeting and conflicts. A
 * fresh preview is required after any such rejection. Tokens are random UUIDs,
 * one-use, five-minute capabilities bound to the original helper manifest and
 * preview AND the configured machine authority. They never contain file bytes.
 * Private source bytes remain only in selected-transfer.js's private WeakMap;
 * the bounded token map retains original capability objects, never serializations.
 *
 * sshExchange contract is the existing (ctx, machine, staticCommand, stdin,
 * signal?) -> stdout string. stdin MUST NOT be logged or included in errors.
 * Probe stdin is public hashes; writer base64 bytes travel on private stdin
 * only, never argv/output/UI. There is no retry, fallback, remote start/reload,
 * root creation, deletion, deployment or filesystem evidence here.
 *
 * Request cancellation is opt-in through req.signal, not ordinary stream close.
 * Scanner fs calls cooperatively observe that signal and still close handles;
 * an already pending fs syscall cannot be interrupted. Probe receives the same
 * signal. Apply also receives it, but cancellation/SSH failure after dispatch is
 * an UNKNOWN write outcome, never a replayable request. The existing exchange
 * throws on nonzero remote exits without returning stdout, so those outcomes
 * must also be reported unknown (a remote partial commit remains possible).
 *
 * createTransferActions is a TRUSTED integration/test factory. Its optional
 * scanner(options, capabilities, signal), scanCapabilities, home, dshHome, now,
 * uuid and capacity seams must never be populated from a browser request. Tests
 * can exercise the actual helpers against injected in-memory fs, without touching
 * a real source filesystem. Production install uses the real helper/normal fs.
 * Inherited helper protections/limitations apply: no memories or governance
 * policies, links/special files, blanket overwrite or multi-file transaction;
 * owner-only retained stages/backups and CAS do not eliminate owner-writer races.
 */
import { randomUUID } from 'node:crypto';
import { machineIdentity as identity } from './authority.js';
import { promises as nodeFs } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import {
  scanSelectedTransfer, createSelectedTransferProbePayload,
  mergeSelectedTransferPreview, createSelectedTransferWritePayload,
  generateRemoteSelectedTransferProbeProgram, generateRemoteSelectedTransferWriteProgram,
} from './selected-transfer.js';

export const TRANSFER_ACTION_LIMITS = Object.freeze({
  tokenTtlMs: 5 * 60 * 1000, maxPendingPreviews: 32,
  maxRequestBytes: 512 * 1024, maxResponseBytes: 512 * 1024,
});
const PREFIX = '/remote-sessions/selected-transfer/';
const SYSTEM_ROOTS = new Set(['applications', 'bin', 'boot', 'dev', 'etc', 'lib',
  'lib64', 'library', 'opt', 'private', 'proc', 'root', 'run', 'sbin', 'sys',
  'system', 'usr', 'var', 'windows', 'program files', 'programdata']);
const HELPER_CODES = new Set([
  'INVALID_SCAN_OPTIONS', 'INVALID_CAPABILITIES', 'INVALID_LIMITS',
  'EXPLICIT_SELECTION_REQUIRED', 'INVALID_ROOT', 'INVALID_SKILLS_ROOT',
  'ROOT_APPROVAL_REQUIRED', 'UNSAFE_PATH', 'DEPTH_LIMIT', 'FORBIDDEN_SELECTION',
  'DUPLICATE_SELECTION', 'TOP_LEVEL_SKILL_REQUIRED', 'NOFOLLOW_UNAVAILABLE',
  'UNSAFE_DIRECTORY', 'NON_REGULAR_FILE', 'UNSAFE_OWNER_MODE', 'SYMLINK_REJECTED',
  'ANCESTRY_CHANGED', 'LOCAL_HARDLINK', 'FILE_SIZE_LIMIT', 'FILE_CHANGED',
  'NODE_LIMIT', 'TOTAL_SIZE_LIMIT', 'FILE_COUNT_LIMIT', 'SELECTION_NOT_FOUND',
  'SKILL_DOCUMENT_REQUIRED', 'INVALID_SKILL_HEADER', 'SOURCE_IO_ERROR',
  'UNKNOWN_MANIFEST', 'INVALID_PROBE_OPTIONS', 'INVALID_PREVIEW_OPTIONS',
  'INVALID_MANIFEST', 'PATH_COLLISION', 'MANIFEST_HASH_MISMATCH', 'INVALID_PROBE',
  'INVALID_WRITE_OPTIONS', 'UNKNOWN_PREVIEW', 'INVALID_CONFLICT_AUTHORIZATION',
  'REMOTE_CONFLICT', 'INVALID_REQUEST', 'CONTENT_HASH_MISMATCH',
  'CONFLICT_AUTHORIZATION_REQUIRED',
]);
const REMOTE_CODES = new Set([...HELPER_CODES, 'REMOTE_PLATFORM_UNSUPPORTED',
  'INVALID_RANDOM_ID', 'UNSAFE_ARTIFACT', 'ARTIFACT_HASH_MISMATCH',
  'REMOTE_CAS_MISMATCH', 'STDIN_SIZE_LIMIT', 'INVALID_STDIN', 'TRANSFER_IO_ERROR',
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EEXIST']);
const MESSAGES = Object.freeze({
  UNSUPPORTED_PULL: 'Pull is not supported. This API supports only explicitly selected local-to-remote pushes.',
  APPLY_OUTCOME_UNKNOWN: 'Remote write outcome is unknown. The one-use token was consumed; do not replay this apply. Inspect remote state and create a new preview.',
  INVALID_OR_EXPIRED_TOKEN: 'The preview token is unknown, expired or already consumed. Create a new preview.',
  MACHINE_IDENTITY_CHANGED: 'The configured SSH authority changed. Explicitly select the target and create a new preview.',
  APPLY_CONFIRMATION_REQUIRED: 'Applying requires confirm:true. The token was consumed; create a new preview.',
  APPLY_CANCELLED: 'Apply was cancelled before SSH dispatch. The token was consumed; create a new preview.',
  REMOTE_CONFLICT: 'Differing remote files require exact per-path hash authorizations. The token was consumed; create a new preview.',
});
class ActionFailure extends Error {
  constructor(code, status = 400, entries) {
    super(code); this.code = code; this.status = status; this.entries = entries;
  }
}
const fail = (code, status = 400) => { throw new ActionFailure(code, status); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value, allowed, code = 'INVALID_REQUEST') {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
}
function checkSignal(signal, apply = false) {
  if (signal?.aborted) fail(apply ? 'APPLY_CANCELLED' : 'PREVIEW_CANCELLED', 499);
}
function direction(body) {
  if (body.direction === 'pull') fail('UNSUPPORTED_PULL', 501);
  if (body.direction !== undefined && body.direction !== 'push') fail('INVALID_DIRECTION');
}
function absolute(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' ||
    Buffer.byteLength(value) > 1024 || /[\\\x00-\x1f\x7f]/.test(value)) fail('INVALID_ROOT');
  const parts = value.slice(1).split('/');
  if (parts.length > 64 || parts.some((part) => !part || part === '.' || part === '..' ||
    part.startsWith(' ') || part.endsWith(' ') || Buffer.byteLength(part) > 255 ||
    !/^[A-Za-z0-9._ -]+$/.test(part))) fail('INVALID_ROOT');
  return parts;
}
function ordinaryRoot(value, localHome, dshHome) {
  const parts = absolute(value);
  if (parts.length < 2 || SYSTEM_ROOTS.has(parts[0].toLowerCase()) ||
    parts.some((part) => part.startsWith('.') ||
      ['library', 'appdata', 'application support', 'system32', 'syswow64'].includes(part.toLowerCase())) ||
    ['home', 'users'].includes(parts[0].toLowerCase()) && parts.length <= 2 ||
    value === localHome || value === dshHome || value.startsWith(`${dshHome}/`) ||
    dshHome.startsWith(`${value}/`)) fail('INVALID_ROOT');
}
function shellQuote(source) { return `'${source.replace(/'/g, "'\\''")}'`; }
function command(source, machine) {
  if (machine.remoteNode) return `${shellQuote(machine.remoteNode)} -e ${shellQuote(source)}`;
  return `PATH="$HOME/bin:$HOME/.npm-global/bin:$PATH" node -e ${shellQuote(source)}`;
}
function snapshot(machine) {
  if (typeof machine?.command !== 'string' || !machine.command ||
    !Array.isArray(machine.ssh) || !machine.ssh.length ||
    machine.ssh.some((item) => typeof item !== 'string') ||
    machine.env !== undefined && !object(machine.env)) fail('SSH_MACHINE_UNAVAILABLE', 409);
  return Object.freeze({ ...machine, ssh: Object.freeze([...machine.ssh]),
    ...(machine.env === undefined ? {} : { env: Object.freeze({ ...machine.env }) }),
    ...(machine.web === undefined ? {} : { web: Object.freeze({ ...machine.web }) }) });
}
// The helper does not accept a signal capability. Wrap the trusted fs instead,
// checking before/after read-only calls but NEVER interrupting handle cleanup.
function cancellableFs(fs, signal) {
  const invoke = async (target, name, args) => {
    checkSignal(signal);
    const result = await target[name](...args);
    if (name === 'open') {
      if (signal.aborted) { await result.close(); checkSignal(signal); }
      return new Proxy(result, { get(handle, property) {
        const member = Reflect.get(handle, property, handle);
        if (typeof member !== 'function') return member;
        if (property === 'close') return member.bind(handle);
        return (...values) => invoke(handle, property, values);
      } });
    }
    checkSignal(signal); return result;
  };
  return new Proxy(fs, { get(target, property) {
    const member = Reflect.get(target, property, target);
    return typeof member === 'function' ? (...args) => invoke(target, property, args) : member;
  } });
}
async function readRequest(req, signal) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of req) {
      checkSignal(signal);
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > TRANSFER_ACTION_LIMITS.maxRequestBytes) fail('REQUEST_TOO_LARGE', 413);
      chunks.push(bytes);
    }
    checkSignal(signal);
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    if (signal?.aborted) fail('PREVIEW_CANCELLED', 499);
    fail('INVALID_REQUEST');
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { fail('INVALID_REQUEST'); }
}
function parseOutput(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > TRANSFER_ACTION_LIMITS.maxResponseBytes) fail('INVALID_REMOTE_RESULT');
  try { return JSON.parse(text); } catch { fail('INVALID_REMOTE_RESULT'); }
}
function writeResult(result, retained) {
  const { manifest, preview } = retained;
  fields(result, result?.ok === true ? ['ok', 'version', 'manifestHash', 'entries'] :
    ['ok', 'error', 'entries'], 'INVALID_REMOTE_RESULT');
  if (result.ok !== true && result.ok !== false || !Array.isArray(result.entries) ||
    result.entries.length > preview.entries.length || result.ok &&
    (result.version !== 1 || result.manifestHash !== manifest.manifestHash ||
      result.entries.length !== preview.entries.length) || !result.ok &&
    !REMOTE_CODES.has(result.error)) fail('INVALID_REMOTE_RESULT');
  const entries = result.entries.map((row, index) => {
    fields(row, ['path', 'localSha256', 'remoteSha256', 'status'], 'INVALID_REMOTE_RESULT');
    const expected = preview.entries[index];
    const status = { create: 'created', unchanged: 'unchanged', conflict: 'replaced' }[expected.status];
    if (row.path !== expected.path || row.localSha256 !== expected.localSha256 ||
      row.remoteSha256 !== expected.localSha256 || row.status !== status) fail('INVALID_REMOTE_RESULT');
    return { path: expected.path, localSha256: expected.localSha256,
      remoteSha256: expected.localSha256, status };
  });
  return { ok: result.ok, ...(result.ok ? { version: 1, manifestHash: manifest.manifestHash } :
    { error: result.error }), entries };
}
function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}
function safeFailure(error, fallback) {
  if (error instanceof ActionFailure) return error;
  if (HELPER_CODES.has(error?.code)) return new ActionFailure(error.code,
    ['REMOTE_CONFLICT', 'INVALID_CONFLICT_AUTHORIZATION'].includes(error.code) ? 409 : 400);
  return new ActionFailure(fallback, 500);
}

export function createTransferActions(ctx, registry, {
  sshExchange, scanner = scanSelectedTransfer, scanCapabilities = {},
  home = homedir(), dshHome = process.env.DSH_HOME, now = Date.now,
  uuid = randomUUID, capacity = TRANSFER_ACTION_LIMITS.maxPendingPreviews,
} = {}) {
  if (typeof sshExchange !== 'function' || typeof scanner !== 'function' ||
    typeof now !== 'function' || typeof uuid !== 'function' || !object(scanCapabilities) ||
    Object.keys(scanCapabilities).some((key) => !['fs', 'uid', 'fdBase'].includes(key)) ||
    !Number.isSafeInteger(capacity) || capacity < 1 || capacity > TRANSFER_ACTION_LIMITS.maxPendingPreviews) fail('INVALID_INTEGRATION');
  absolute(home);
  const sourceHome = dshHome === undefined || dshHome === '' ? posix.join(home, '.dsh') : dshHome;
  // Trusted environment values may have a harmless trailing separator, but a
  // request's root must itself be canonical (no normalization of user input).
  if (typeof sourceHome !== 'string' || !sourceHome.startsWith('/')) fail('INVALID_DSH_HOME');
  const configuredHome = posix.resolve(sourceHome);
  absolute(configuredHome);
  const skillsRoot = posix.join(configuredHome, 'skills');
  const probeSource = generateRemoteSelectedTransferProbeProgram();
  const writeSource = generateRemoteSelectedTransferWriteProgram();
  const tokens = new Map(); let pending = 0; let disposed = false;
  const drop = (token) => {
    const retained = tokens.get(token);
    if (retained) clearTimeout(retained.timer);
    tokens.delete(token); return retained;
  };
  const reap = () => { for (const [token, entry] of tokens) if (entry.expiresAt <= now()) drop(token); };
  const active = () => { if (disposed) fail('TRANSFER_ACTIONS_DISPOSED', 503); };
  const current = (name) => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) fail('INVALID_MACHINE');
    const machine = registry?.machines?.find((candidate) => candidate.name === name && !candidate.disabled && !candidate.migrationRequired);
    if (!machine) fail('UNKNOWN_MACHINE', 404);
    return snapshot(machine);
  };
  const unchanged = (name, fingerprint) => {
    active();
    let machine;
    try { machine = current(name); } catch { fail('MACHINE_IDENTITY_CHANGED', 409); }
    if (identity(machine) !== fingerprint) fail('MACHINE_IDENTITY_CHANGED', 409);
    return machine;
  };
  const preview = async (body, signal) => {
    active();
    fields(body, ['machine', 'kind', 'localRoot', 'selections', 'approval', 'direction']);
    direction(body);
    if (!['skills', 'files'].includes(body.kind)) fail('INVALID_KIND');
    if (!Array.isArray(body.selections) || !body.selections.length) fail('EXPLICIT_SELECTION_REQUIRED');
    fields(body.approval, ['kind', 'root', 'confirmed'], 'ROOT_APPROVAL_REQUIRED');
    if (body.approval.kind !== body.kind || body.approval.confirmed !== true) fail('ROOT_APPROVAL_REQUIRED');
    absolute(body.localRoot);
    if (body.kind === 'skills') {
      if (body.localRoot !== skillsRoot) fail('INVALID_LOCAL_SKILLS_ROOT');
      if (body.approval.root !== '~/.dsh/skills') fail('INVALID_SKILLS_ROOT');
    } else {
      ordinaryRoot(body.localRoot, home, configuredHome);
      // Remote workspace validation is independent of the LOCAL configured home.
      ordinaryRoot(body.approval.root, '', '/.dsh');
    }
    checkSignal(signal);
    const machine = current(body.machine), fingerprint = identity(machine);
    reap();
    if (tokens.size + pending >= capacity) fail('PREVIEW_CAPACITY', 429);
    pending++;
    try {
      const capabilities = signal ? { ...scanCapabilities,
        fs: cancellableFs(scanCapabilities.fs ?? nodeFs, signal) } : scanCapabilities;
      const manifest = await scanner({ kind: body.kind, localRoot: body.localRoot,
        selections: [...body.selections] }, capabilities, signal);
      checkSignal(signal); unchanged(body.machine, fingerprint);
      const approval = { kind: body.kind, root: body.approval.root, confirmed: true };
      const input = createSelectedTransferProbePayload(manifest, { approval });
      let output;
      try { output = await sshExchange(ctx, machine, command(probeSource, machine), input, signal); }
      catch { checkSignal(signal); fail('REMOTE_PROBE_FAILED', 502); }
      checkSignal(signal); unchanged(body.machine, fingerprint);
      let bound;
      try { bound = mergeSelectedTransferPreview(manifest, parseOutput(output), { approval }); }
      catch { fail('INVALID_REMOTE_PROBE', 502); }
      reap();
      const token = uuid();
      if (typeof token !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(token) ||
        tokens.has(token)) fail('TOKEN_GENERATION_FAILED', 500);
      const expiresAt = now() + TRANSFER_ACTION_LIMITS.tokenTtlMs;
      const retained = { manifest, preview: bound, machineName: body.machine,
        machineIdentity: fingerprint, expiresAt, timer: undefined };
      retained.timer = setTimeout(() => drop(token), TRANSFER_ACTION_LIMITS.tokenTtlMs);
      retained.timer.unref?.(); tokens.set(token, retained);
      return { ok: true, direction: 'push', machine: body.machine, kind: bound.kind,
        root: bound.root, manifestHash: bound.manifestHash,
        entries: bound.entries.map((entry) => ({ ...entry })), count: bound.entries.length,
        conflicts: bound.conflicts, token, expiresAt };
    } catch (error) {
      checkSignal(signal); throw error;
    } finally { pending--; }
  };
  const apply = async (body, signal) => {
    active();
    if (!object(body)) fail('INVALID_REQUEST');
    reap();
    if (typeof body.token !== 'string') fail('INVALID_OR_EXPIRED_TOKEN', 410);
    const retained = drop(body.token); // synchronous, BEFORE every write preflight
    if (!retained) fail('INVALID_OR_EXPIRED_TOKEN', 410);
    fields(body, ['machine', 'token', 'confirm', 'conflictAuthorizations', 'direction']);
    direction(body);
    if (body.confirm !== true) fail('APPLY_CONFIRMATION_REQUIRED');
    checkSignal(signal, true);
    if (body.machine !== retained.machineName) fail('MACHINE_IDENTITY_CHANGED', 409);
    const machine = unchanged(retained.machineName, retained.machineIdentity);
    // Helper authorizations are exact hashes and paths; default denies conflicts.
    const input = createSelectedTransferWritePayload(retained.manifest, retained.preview,
      body.conflictAuthorizations === undefined ? {} : { conflictAuthorizations: body.conflictAuthorizations });
    active(); checkSignal(signal, true);
    let result;
    try {
      const output = await sshExchange(ctx, machine, command(writeSource, machine), input, signal);
      if (signal?.aborted) fail('APPLY_OUTCOME_UNKNOWN', 502);
      result = writeResult(parseOutput(output), retained);
    } catch { fail('APPLY_OUTCOME_UNKNOWN', 502); }
    if (!result.ok) throw new ActionFailure(result.error,
      result.error === 'REMOTE_CAS_MISMATCH' ? 409 : 502, result.entries);
    return { ok: true, direction: 'push', machine: retained.machineName,
      manifestHash: retained.manifest.manifestHash, count: result.entries.length, entries: result.entries };
  };
  const route = (operation, action) => Object.freeze({ kind: 'exact', path: PREFIX + operation,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
      try {
        // Apply must recover/consume a buffered token even on an already-aborted
        // signal; preview has no mutation capability and may stop body preflight.
        const body = await readRequest(req, operation === 'preview' ? req.signal : undefined);
        return sendJson(res, 200, await action(body, req.signal));
      } catch (error) {
        const safe = safeFailure(error, operation === 'preview' ? 'TRANSFER_PREVIEW_FAILED' : 'TRANSFER_APPLY_REJECTED');
        return sendJson(res, safe.status, { ok: false, error: safe.code,
          ...(MESSAGES[safe.code] ? { message: MESSAGES[safe.code] } : {}),
          ...(safe.entries ? { entries: safe.entries } : {}),
          ...(safe.code === 'APPLY_OUTCOME_UNKNOWN' ? { replayable: false } : {}) });
      }
    } });
  return Object.freeze({ routes: Object.freeze([route('preview', preview), route('apply', apply)]),
    dispose() { if (disposed) return; disposed = true; for (const token of tokens.keys()) drop(token); } });
}

export function installTransferActions(ctx, registry, { sshExchange, registerRoutes } = {}) {
  if (typeof registerRoutes !== 'function' || typeof ctx?.effect !== 'function') fail('INVALID_INTEGRATION');
  const actions = createTransferActions(ctx, registry, { sshExchange });
  try {
    ctx.effect(() => () => actions.dispose(), 'remote-sessions.selected-transfer-actions');
    registerRoutes(ctx, actions.routes);
  } catch (error) { actions.dispose(); throw error; }
  return actions;
}
