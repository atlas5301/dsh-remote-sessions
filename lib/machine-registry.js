/** Host-private machine configuration. No import-time I/O and no transport side effects. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const STORE_LIMITS = Object.freeze({ bytes: 1024 * 1024, machines: 128 });
export function failure(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clean = (value, cap = 4096) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= cap && !/[\x00-\x1f\x7f]/.test(value);
export function absolutePath(value, cap = 4096) {
  return clean(value, cap) && value.startsWith('/') && !value.includes('\\') && value.split('/').slice(1).every(part => part && part !== '.' && part !== '..');
}
function text(value, code, cap) { if (!clean(value, cap)) throw failure(code); return value; }

/** Exactly one final destination; no remote argv, forwarding, shell hooks or bypasses. */
export function validateSshArgs(ssh) {
  if (!Array.isArray(ssh) || !ssh.length || ssh.length > 64 || ssh.some(value => !clean(value, 4096))) throw failure('INVALID_SSH');
  let i = 0;
  const safeOption = value => {
    const match = /^([A-Za-z]+)(?:=|\s+)(.+)$/.exec(value);
    if (!match) throw failure('INVALID_SSH_OPTION');
    const key = match[1].toLowerCase(), option = match[2];
    if (['batchmode', 'stricthostkeychecking', 'identitiesonly'].includes(key)) { if (option !== 'yes') throw failure('INVALID_SSH_OPTION'); }
    else if (key === 'clearallforwardings') { if (option !== 'yes') throw failure('INVALID_SSH_OPTION'); }
    else if (['permitlocalcommand', 'forwardagent', 'forwardx11', 'requesttty'].includes(key)) { if (option !== 'no') throw failure('INVALID_SSH_OPTION'); }
    else if (['userknownhostsfile', 'globalknownhostsfile', 'identityfile', 'identityagent'].includes(key)) {
      if (!absolutePath(option) || option.startsWith('/dev/')) throw failure('INVALID_SSH_OPTION');
    } else if (['port', 'connecttimeout', 'serveraliveinterval', 'serveralivecountmax'].includes(key)) {
      if (!/^\d{1,5}$/.test(option) || Number(option) < 1 || Number(option) > 65535) throw failure('INVALID_SSH_OPTION');
    } else if (['hostname', 'user', 'proxyjump', 'addressfamily', 'loglevel'].includes(key)) {
      if (!/^[A-Za-z0-9_@.,:[\]-]+$/.test(option)) throw failure('INVALID_SSH_OPTION');
    } else throw failure('INVALID_SSH_OPTION');
  };
  while (i < ssh.length - 1) {
    const arg = ssh[i++];
    if (arg === '-T' || arg === '-4' || arg === '-6') continue;
    if (!['-p', '-i', '-F', '-l', '-J', '-o'].includes(arg) || i >= ssh.length - 1) throw failure('INVALID_SSH_OPTION');
    const value = ssh[i++];
    if (arg === '-o') safeOption(value);
    else if (arg === '-p' && (!/^\d{1,5}$/.test(value) || +value < 1 || +value > 65535)) throw failure('INVALID_SSH_OPTION');
    else if (['-i', '-F'].includes(arg) && (!absolutePath(value) || value.startsWith('/dev/'))) throw failure('INVALID_SSH_OPTION');
    else if (['-l', '-J'].includes(arg) && !/^[A-Za-z0-9_@.,:[\]-]+$/.test(value)) throw failure('INVALID_SSH_OPTION');
  }
  if (i !== ssh.length - 1 || !/^[A-Za-z0-9_\[][A-Za-z0-9_.@:[\]-]*$/.test(ssh[i])) throw failure('INVALID_SSH_TARGET');
  return [...ssh];
}
export const STRICT_SSH_OPTIONS = Object.freeze(['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ConnectTimeout=15']);
export function validateTransport(machine) {
  if (!object(machine)) throw failure('INVALID_MACHINE');
  const command = machine.command ?? 'ssh';
  if (command !== 'ssh' && !absolutePath(command)) throw failure('INVALID_SSH_COMMAND');
  const ssh = validateSshArgs(machine.ssh);
  const env = machine.env ?? {};
  if (!object(env) || Object.keys(env).length > 128 || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || Buffer.byteLength(value) > 16384 || value.includes('\0'))) throw failure('INVALID_MACHINE_ENV');
  return { command, ssh, env: { ...env } };
}
const PUBLIC_FIELDS = ['name', 'runtimeMode', 'ssh', 'remoteNode', 'socketPath', 'remoteCwd', 'modelProvider', 'modelId', 'effort', 'authorityRevision',
  'autoSetup', 'remoteCli', 'remoteHome', 'residentProfile', 'runtimeDirectory', 'dshVersion', 'npmInstall', 'plugins', 'syncModels', 'syncPluginStates'];
const MIGRATION_FIELDS = ['disabled', 'migrationRequired'];
/** Setup-only fields never enter the authority hash: they configure local
 * lifecycle behavior, not the remote execution identity of a pinned binding. */
export const SETUP_FIELDS = Object.freeze(['autoSetup', 'remoteCli', 'remoteHome', 'residentProfile', 'runtimeDirectory', 'dshVersion', 'npmInstall', 'plugins', 'syncModels', 'syncPluginStates']);
const PROFILE_NAME = /^[a-z][a-z0-9-]{1,50}$/;
function machineName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value) || value.toLowerCase() === 'local') throw failure('INVALID_MACHINE_NAME');
  return value;
}
/** Machine names allow [A-Za-z0-9_-]; profile names must be ^[a-z][a-z0-9-]{1,50}$. */
function slugProfileName(name) {
  const slug = String(name).toLowerCase().replace(/[_]+/g, '-').replace(/-+/g, '-');
  if (!/^[a-z][a-z0-9-]{1,50}$/.test(slug)) throw failure('INVALID_RESIDENT_PROFILE');
  return slug;
}
function optionalSetupText(raw, key, code, { absolute = false, profile = false } = {}) {
  if (raw[key] === undefined || raw[key] === '') return undefined;
  const value = raw[key];
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw failure(code);
  if (profile) { if (!PROFILE_NAME.test(value) || ['desktop', 'web', 'headless', 'acp', 'sdk', 'sdk-minimal'].includes(value)) throw failure(code); return value; }
  if (absolute && (!absolutePath(value) || value.startsWith('/dev/'))) throw failure(code);
  return value;
}
export function normalizeMachine(raw, { allowLegacy = false } = {}) {
  if (!object(raw)) throw failure('INVALID_MACHINE');
  const name = machineName(raw.name);
  // Legacy records are quarantined, never interpreted as runnable configurations.
  // Keep their private fields for operator migration, without honoring old flags.
  if (allowLegacy && (raw.socketPath === undefined || raw.runtimeMode && raw.runtimeMode !== 'remote-runtime')) {
    return Object.freeze({ ...raw, name, disabled: true, migrationRequired: true });
  }
  if (raw.runtimeMode !== undefined && raw.runtimeMode !== 'remote-runtime') throw failure('UNSUPPORTED_RUNTIME_MODE');
  const transport = validateTransport(raw);
  if (!absolutePath(raw.remoteNode)) throw failure('INVALID_REMOTE_NODE');
  if (!absolutePath(raw.socketPath, 100)) throw failure('INVALID_SOCKET_PATH');
  if (raw.remoteCwd !== '/' && !absolutePath(raw.remoteCwd)) throw failure('INVALID_REMOTE_CWD');
  const machine = { name, runtimeMode: 'remote-runtime', ...transport, remoteNode: raw.remoteNode, socketPath: raw.socketPath, remoteCwd: raw.remoteCwd, authorityRevision: raw.authorityRevision ?? '' };
  if (typeof machine.authorityRevision !== 'string' || Buffer.byteLength(machine.authorityRevision) > 256 || /[\x00-\x1f\x7f]/.test(machine.authorityRevision)) throw failure('INVALID_AUTHORITY_REVISION');
  for (const key of ['modelProvider', 'modelId', 'effort']) if (raw[key] !== undefined) machine[key] = text(raw[key], 'INVALID_MODEL_DEFAULT', 256);
  if ((machine.modelProvider === undefined) !== (machine.modelId === undefined)) throw failure('INVALID_MODEL_DEFAULT');
  // Automatic lifecycle fields. They qualify provisioning behavior only; the
  // runtime identity remains command/argv/env/socket/node in machineIdentity.
  if (raw.autoSetup !== undefined && typeof raw.autoSetup !== 'boolean') throw failure('INVALID_AUTO_SETUP');
  if (raw.npmInstall !== undefined && typeof raw.npmInstall !== 'boolean') throw failure('INVALID_NPM_INSTALL');
  machine.autoSetup = raw.autoSetup ?? true;
  machine.npmInstall = raw.npmInstall ?? true;
  machine.remoteCli = optionalSetupText(raw, 'remoteCli', 'INVALID_REMOTE_CLI', { absolute: true });
  machine.remoteHome = optionalSetupText(raw, 'remoteHome', 'INVALID_REMOTE_HOME', { absolute: true });
  // The resident profile defaults to a per-machine name: two machines sharing
  // one SSH host (a fresh target for the same box) get separate profiles,
  // runtimes and markers instead of overwriting each other.
  machine.residentProfile = optionalSetupText(raw, 'residentProfile', 'INVALID_RESIDENT_PROFILE', { profile: true }) ?? 'rs-' + slugProfileName(name);
  machine.runtimeDirectory = optionalSetupText(raw, 'runtimeDirectory', 'INVALID_RUNTIME_DIRECTORY', { absolute: true }) ?? dirname(machine.socketPath);
  if (Buffer.byteLength(machine.runtimeDirectory + '/agent.sock') > 100) throw failure('INVALID_SOCKET_PATH');
  machine.dshVersion = optionalSetupText(raw, 'dshVersion', 'INVALID_DSH_VERSION');
  // Environment sync flags: mirror the local model selection and plugin
  // enable/disable states to the remote resident.
  if (raw.syncModels !== undefined && typeof raw.syncModels !== 'boolean') throw failure('INVALID_SYNC_MODELS');
  if (raw.syncPluginStates !== undefined && typeof raw.syncPluginStates !== 'boolean') throw failure('INVALID_SYNC_PLUGIN_STATES');
  machine.syncModels = raw.syncModels ?? false;
  machine.syncPluginStates = raw.syncPluginStates ?? false;
  // Pinned remote plugins: exact registry versions, installed into the resident
  // profile by the sync operation. Config rows are optional plain objects. An
  // explicitly empty list clears the pins; omission keeps the previous value.
  if (raw.plugins !== undefined && raw.plugins !== null) {
    if (!Array.isArray(raw.plugins) || raw.plugins.length > 32) throw failure('INVALID_PLUGINS');
    if (raw.plugins.length) machine.plugins = Object.freeze(raw.plugins.map(entry => {
      if (!object(entry) || Object.keys(entry).some(key => !['package', 'version', 'config'].includes(key))) throw failure('INVALID_PLUGIN_ENTRY');
      if (typeof entry.package !== 'string' || !/^(?:@[A-Za-z0-9-*~]+\/)?[A-Za-z0-9._~-]{1,214}$/.test(entry.package)) throw failure('INVALID_PLUGIN_ENTRY');
      if (entry.version !== undefined && (typeof entry.version !== 'string' || !/^\d+[.]\d+[.]\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(entry.version))) throw failure('INVALID_PLUGIN_VERSION');
      if (entry.config !== undefined && (!object(entry) || JSON.stringify(entry.config).length > 4096)) throw failure('INVALID_PLUGIN_CONFIG');
      return Object.freeze({ package: entry.package, ...(entry.version !== undefined ? { version: entry.version } : {}), ...(entry.config !== undefined ? { config: entry.config } : {}) });
    }));
  }
  machine.ssh = Object.freeze(machine.ssh); machine.env = Object.freeze(machine.env);
  return Object.freeze(machine);
}
export function normalizeMachines(raw, options) {
  if (!Array.isArray(raw) || raw.length > STORE_LIMITS.machines) throw failure('INVALID_MACHINES');
  const seen = new Set();
  return Object.freeze(raw.map(value => {
    const machine = normalizeMachine(value, options);
    if (seen.has(machine.name.toLowerCase())) throw failure('DUPLICATE_MACHINE');
    seen.add(machine.name.toLowerCase()); return machine;
  }));
}
/** Explicit projection: command/env/old ACP commands never leave the host. */
export function publicMachine(machine) {
  if (machine.disabled) {
    // Legacy SSH argv may itself contain old shell commands: do not expose it.
    let ssh = []; try { ssh = validateSshArgs(machine.ssh); } catch {}
    const result = { name: machine.name, runtimeMode: 'remote-runtime', ssh };
    for (const key of PUBLIC_FIELDS.filter(key => !['name', 'runtimeMode', 'ssh'].includes(key))) if (typeof machine[key] === 'string' && !/[\x00-\x1f\x7f]/.test(machine[key]) && Buffer.byteLength(machine[key]) <= 4096) result[key] = machine[key];
    return { ...result, disabled: true, migrationRequired: true };
  }
  return Object.fromEntries(PUBLIC_FIELDS.filter(key => machine[key] !== undefined).map(key => [key, machine[key]]));
}
export function browserMachines(raw, previous) {
  if (!Array.isArray(raw)) throw failure('INVALID_MACHINES');
  const previousByName = new Map(previous.map(machine => [machine.name, machine]));
  const expanded = raw.map(value => {
    if (!object(value) || Object.keys(value).some(key => ![...PUBLIC_FIELDS, ...MIGRATION_FIELDS].includes(key))) throw failure('INVALID_MACHINE_FIELDS');
    const old = previousByName.get(value.name);
    if (value.disabled === true || value.migrationRequired === true) {
      // Only an unchanged, preexisting quarantined record can remain disabled.
      if (!old?.disabled || JSON.stringify(publicMachine(old)) !== JSON.stringify(Object.fromEntries(Object.keys(publicMachine(old)).map(key => [key, value[key]]))) || Object.keys(value).some(key => !(key in publicMachine(old)))) throw failure('INVALID_LEGACY_MACHINE');
      return old;
    }
    return normalizeMachine({ ...preserveMachineFields(value, old), command: old?.command ?? 'ssh', env: old?.env ?? {} });
  });
  return normalizeMachines(expanded, { allowLegacy: true });
}
/** Merge protected fields from `previous` into a posted machine record when
 * the post omits them. The settings panel edits a subset of the record;
 * omission means "unchanged", never "reset to default" — dropping these
 * fields re-defaulted runtime directories and silently orphaned residents.
 * Values that would fail the same validation an explicit post faces (e.g. a
 * degenerate dirname fallback) are left to re-default instead of poisoning
 * the save; quarantined legacy records never donate fields. */
export function preserveMachineFields(candidate, previous) {
  if (!object(candidate) || !previous || previous.disabled || previous.migrationRequired) return candidate;
  const merged = { ...candidate };
  for (const key of ['authorityRevision', 'dshVersion', 'modelProvider', 'modelId', 'effort',
    'autoSetup', 'npmInstall', 'syncModels', 'syncPluginStates'])
    if (!(key in merged) && previous[key] !== undefined) merged[key] = previous[key];
  for (const key of ['remoteNode', 'socketPath', 'remoteHome', 'runtimeDirectory'])
    if (!(key in merged) && previous[key] !== undefined && absolutePath(previous[key])) merged[key] = previous[key];
  if (!('remoteCwd' in merged) && previous.remoteCwd !== undefined && (absolutePath(previous.remoteCwd) || previous.remoteCwd === '/')) merged.remoteCwd = previous.remoteCwd;
  if (!('residentProfile' in merged) && typeof previous.residentProfile === 'string' && /^[a-z][a-z0-9-]{1,50}$/.test(previous.residentProfile)) merged.residentProfile = previous.residentProfile;
  if (!('plugins' in merged) && previous.plugins !== undefined) merged.plugins = previous.plugins;
  return merged;
}
export function machinesFilePath(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) { return join(home, 'remote-sessions', 'machines.json'); }
function owner(stat) { return typeof process.getuid === 'function' && stat.uid === process.getuid(); }
function inspectDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owner(stat)) throw failure('UNSAFE_MACHINE_STORE', 503);
  return stat;
}
function inspectFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !owner(stat) || stat.nlink !== 1 || stat.mode & 0o7000) throw failure('UNSAFE_MACHINE_STORE', 503);
  return stat;
}
function checkAncestors(directory, missing = false) {
  for (let cursor = resolve(directory); ; cursor = dirname(cursor)) {
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (!missing || error.code !== 'ENOENT') throw error; }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid?.()].includes(stat.uid) || (stat.mode & 0o022) && !(stat.mode & 0o1000))) throw failure('UNSAFE_MACHINE_STORE', 503);
    if (dirname(cursor) === cursor) break;
  }
}
/** Missing is distinct from malformed. Corruption must never fall back to seeds. */
export function loadMachinesFile(file = machinesFilePath()) {
  file = resolve(file); checkAncestors(dirname(file), true);
  let stat;
  try { stat = inspectFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw failure('UNSAFE_MACHINE_STORE', 503); }
  const directory = dirname(file); checkAncestors(directory); inspectDirectory(directory);
  if (stat.size > STORE_LIMITS.bytes) throw failure('MALFORMED_MACHINE_STORE', 503);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw failure('UNSAFE_MACHINE_STORE', 503);
    const text = fs.readFileSync(fd, 'utf8');
    if (Buffer.byteLength(text) > STORE_LIMITS.bytes) throw failure('MALFORMED_MACHINE_STORE', 503);
    const after = fs.fstatSync(fd), named = inspectFile(file);
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs || named.ctimeMs !== after.ctimeMs) throw failure('UNSAFE_MACHINE_STORE', 503);
    let machines;
    try { machines = normalizeMachines(JSON.parse(text), { allowLegacy: true }); } catch { throw failure('MALFORMED_MACHINE_STORE', 503); }
    // Upgrade permissions of old owner-controlled stores only after validation.
    fs.fchmodSync(fd, 0o600); fs.chmodSync(directory, 0o700);
    return machines;
  } finally { fs.closeSync(fd); }
}
export function saveMachinesFile(machines, file = machinesFilePath()) {
  const normalized = normalizeMachines(machines, { allowLegacy: true });
  const content = JSON.stringify(normalized, null, 2) + '\n';
  if (Buffer.byteLength(content) > STORE_LIMITS.bytes) throw failure('MACHINE_STORE_TOO_LARGE');
  file = resolve(file); const directory = dirname(file);
  // A store corrupted since activation is not silently repaired by a stale save.
  loadMachinesFile(file);
  checkAncestors(directory, true);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkAncestors(directory); inspectDirectory(directory); fs.chmodSync(directory, 0o700);
  try { inspectFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.machines-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, content); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    const dirfd = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
  } catch { throw failure('MACHINE_STORE_WRITE_FAILED', 503); }
  finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
  return normalized;
}
export function createMachineRegistry({ machines = [], file = machinesFilePath() } = {}) {
  let current = loadMachinesFile(file) ?? normalizeMachines(machines, { allowLegacy: true });
  return {
    get machines() { return current; },
    save(raw) {
      const next = browserMachines(raw, current); // All validation precedes persistence.
      saveMachinesFile(next, file); current = next; return current;
    },
  };
}
