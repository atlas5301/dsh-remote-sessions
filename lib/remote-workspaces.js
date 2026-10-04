// Managed virtual workspaces: the remote DSH owns the actual workspace (the
// plugin forwards `workspace/create`); the local side links a managed anchor
// directory whose sessions, file tree and terminals all forward to it.
// Anchors are created and owned by the plugin — no manual directory setup.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { failure, normalizeMachine, validateTransport, preserveMachineFields } from './machine-registry.js';
import { shellQuote } from './ssh-carrier.js';

export const WORKSPACE_LIMITS = Object.freeze({ names: 256, pathBytes: 4096, remotePathBytes: 1024 });

/** Managed anchor root: every virtual workspace lives under here. */
export function anchorRoot() { return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'remote-sessions', 'anchors'); }

/** Slug for a managed anchor directory name; stable per target and remote path. */
export function anchorName(target, remotePath) {
  let hash = 0;
  for (const byte of Buffer.from(remotePath, 'utf8')) hash = (hash * 31 + byte) >>> 0;
  const slug = String(remotePath).split('/').filter(Boolean).at(-1)?.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 32) || 'root';
  return `${target}-${slug}-${hash.toString(36)}`.slice(0, 96);
}

function validateRemotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f]/.test(value)
    || Buffer.byteLength(value) > WORKSPACE_LIMITS.remotePathBytes || value.split('/').some(part => part === '..' || part === '.')) throw failure('INVALID_REMOTE_DIRECTORY');
  return value;
}

/** Validate a remote folder name for the browse/new-folder flow. */
export function validateDirectoryName(name) {
  if (typeof name !== 'string' || !name.length || name.length > 128 || name === '.' || name === '..'
    || name.includes('/') || /[\x00-\x1f\x7f]/.test(name)) throw failure('INVALID_DIRECTORY_NAME');
  return name;
}

/** `~`-relative browse targets stay restricted to plain path characters; the
 * remainder composes into a quoted $HOME expansion, never into raw script. */
function homeTarget(path) {
  if (typeof path !== 'string' || !(path === '~' || path.startsWith('~/')) || /[^A-Za-z0-9._\-/~]/.test(path) || Buffer.byteLength(path) > WORKSPACE_LIMITS.remotePathBytes) throw failure('INVALID_DIRECTORY');
  return path === '~' ? '"$HOME"' : '"$HOME"' + shellQuote(path.slice(1));
}

function sshTarget(path) { return path === '~' || path.startsWith('~/') ? homeTarget(path) : shellQuote(validateRemotePath(path)); }

/** List a remote directory over strict SSH (NUL-separated). */
export async function browseRemoteDirectory(sshExchange, ctx, machine, path, signal) {
  const output = await sshExchange(ctx, machine,
    `cd ${sshTarget(path)} && printf '%s\\0' "$PWD" && for entry in ./*/; do [ -d "$entry" ] || continue; printf '%s\\0' "\${entry#./}"; done`, undefined, signal);
  const names = output.split('\0').filter(Boolean), resolved = names.shift();
  if (!resolved?.startsWith('/') || /[\x00-\x1f\x7f]/.test(resolved)) throw failure('INVALID_DIRECTORY_REPLY', 502);
  const entries = names.map(name => name.replace(/\/$/, '')).filter(name => name && !name.includes('/') && !/[\x00-\x1f\x7f]/.test(name)).map(name => ({ name, path: (resolved === '/' ? '' : resolved) + '/' + name }));
  return { path: resolved, entries };
}

/** Create one directory under an existing remote parent (never recursive). */
export async function createRemoteDirectory(sshExchange, ctx, machine, parent, name, signal) {
  const folder = validateDirectoryName(name);
  const output = await sshExchange(ctx, machine, `cd ${sshTarget(parent)} && mkdir ${shellQuote(folder)} && printf '%s\\0' "$PWD"`, undefined, signal);
  const resolved = output.split('\0').filter(Boolean).at(-1);
  if (!resolved?.startsWith('/')) throw failure('INVALID_DIRECTORY_REPLY', 502);
  return { path: resolved + '/' + folder };
}

/**
 * Create the managed virtual-workspace service. `persist` writes the durable
 * config section through the host settings service; runtime tables update
 * immediately so control actions never wait for the config reload.
 */
export function createRemoteWorkspaces(ctx, { registry, transport, resolveWorkspace, sshExchange, namespace = 'remote-sessions', persist = true }) {
  // The settings service may be absent in minimal compositions; control
  // actions then stay runtime-only and persistence reports SETTINGS_UNAVAILABLE.
  let settings = null;
  try { settings = ctx.get?.('settings') ?? null; } catch { settings = null; }
  async function persistSection(patch) {
    if (!persist) return;
    if (!settings || typeof settings.update !== 'function') throw failure('SETTINGS_UNAVAILABLE', 503);
    await settings.update(namespace, patch).catch(error => {
      // The settings service refuses non-volatile fields and reports the exact
      // reason; log it for diagnosis, never leak the raw message to the wire.
      ctx.logger?.error?.('remote-sessions: settings write failed: ' + (error?.message ?? String(error)));
      throw failure('SETTINGS_WRITE_FAILED', 502);
    });
  }
  async function ensureAnchor(target, remotePath) {
    const root = anchorRoot();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (await fs.realpath(root) !== resolve(root)) throw failure('UNSAFE_ANCHOR_ROOT', 503);
    const anchor = resolve(join(root, anchorName(target, remotePath)));
    await fs.mkdir(anchor, { recursive: true, mode: 0o700 });
    if (await fs.realpath(anchor) !== anchor) throw failure('UNSAFE_ANCHOR', 503);
    return anchor;
  }
  return {
    anchorRoot,
    currentWorkspaces: () => resolveWorkspace.snapshot(),
    /** Open (or re-link) a remote workspace: the remote DSH owns the actual
     * workspace record; the local side gains a managed anchor + mapping. */
    async open({ target, remotePath, create }, signal) {
      const machine = registry.machines.find(item => item.name === target && !item.disabled && !item.migrationRequired);
      if (!machine) throw failure('UNKNOWN_MACHINE', 404);
      let remote = validateRemotePath(remotePath);
      if (create) {
        const output = await sshExchange(ctx, machine, `mkdir -p ${shellQuote(dirname(remote))} && mkdir ${shellQuote(remote)} 2>/dev/null; cd ${shellQuote(remote)} && printf '%s\\0' "$PWD"`, undefined, signal);
        const resolved = output.split('\0').filter(Boolean).at(-1);
        if (!resolved?.startsWith('/')) throw failure('INVALID_DIRECTORY_REPLY', 502);
        remote = resolved;
      } else {
        const output = await sshExchange(ctx, machine, `cd ${shellQuote(remote)} && printf '%s\\0' "$PWD"`, undefined, signal);
        const resolved = output.split('\0').filter(Boolean).at(-1);
        if (!resolved?.startsWith('/')) throw failure('REMOTE_DIRECTORY_MISSING', 404);
        remote = resolved;
      }
      // The remote runtime owns the actual workspace; creation is idempotent.
      const identity = await transport.identify(target);
      const result = await transport.call(identity, 'workspace/create', [{ path: remote }], signal);
      const anchor = await ensureAnchor(target, remote);
      const next = resolveWorkspace.snapshot().filter(value => value.localPath !== anchor && !(value.target === target && value.remotePath === remote));
      next.push({ localPath: anchor, target, remotePath: remote });
      resolveWorkspace.refresh(next);
      await persistSection({ workspaces: next.map(value => ({ localPath: value.localPath, target: value.target, remotePath: value.remotePath })) });
      return { localPath: anchor, target, remotePath: remote, remoteWorkspaceId: result?.workspace?.workspaceId };
    },
    /** Unlink a virtual workspace; the anchor and the remote workspace stay. */
    async remove({ localPath }) {
      const anchor = resolve(String(localPath ?? ''));
      const before = resolveWorkspace.snapshot();
      const next = before.filter(value => value.localPath !== anchor);
      if (next.length === before.length) throw failure('UNKNOWN_WORKSPACE', 404);
      resolveWorkspace.refresh(next);
      await persistSection({ workspaces: next.map(value => ({ localPath: value.localPath, target: value.target, remotePath: value.remotePath })) });
      return { removed: anchor };
    },
    /** Machines CRUD: validated; private command/env survive unchanged names.
     * Renames and delete-plus-re-add cascade: when a workspace's machine
     * disappears but exactly one saved machine owns the same private socket,
     * the workspace follows it (the machine identity is its socket, not its
     * display name). Only genuinely orphaned workspaces refuse the save. */
    async saveMachines(raw) {
      if (!Array.isArray(raw) || raw.length > 256) throw failure('INVALID_MACHINES');
      const merged = raw.map(value => {
        if (!value || typeof value !== 'object') throw failure('INVALID_MACHINE');
        const previous = registry.machines.find(item => item.name === value.name);
        // Fields the settings panel does not edit survive an edit untouched;
        // omission means "unchanged", never "reset to default".
        const candidate = preserveMachineFields(value, previous);
        return normalizeMachine({ ...candidate, command: previous?.command ?? 'ssh', env: previous?.env ?? {} }, { allowLegacy: true });
      });
      const live = name => merged.some(item => item.name === name && !item.disabled && !item.migrationRequired);
      let next = resolveWorkspace.snapshot();
      for (const workspace of next) {
        if (live(workspace.target)) continue;
        const previous = registry.machines.find(item => item.name === workspace.target && !item.disabled && !item.migrationRequired);
        const heirs = merged.filter(item => !item.disabled && !item.migrationRequired && previous && item.socketPath === previous.socketPath);
        if (heirs.length !== 1) throw failure('MACHINE_IN_USE', 409);
        next = next.map(item => item.target === workspace.target ? { ...item, target: heirs[0].name } : item);
      }
      registry.replace(merged);
      resolveWorkspace.refresh(next);
      await persistSection({ machines: merged, workspaces: next.map(value => ({ localPath: value.localPath, target: value.target, remotePath: value.remotePath })) });
      return merged;
    },
    /** One read-only SSH probe for the add-machine form: node/npm/CLI discovery. */
    async discover({ ssh }, signal) {
      if (!Array.isArray(ssh) || !ssh.length || ssh.length > 64 || ssh.some(value => typeof value !== 'string' || !value.length || value.length > 1024 || /[\x00-\x1f]/.test(value))) throw failure('INVALID_SSH');
      const probeMachine = { name: 'discovery', ssh, remoteNode: '/usr/bin/env', socketPath: '/nonexistent/agent.sock', remoteCwd: '/', env: {} };
      validateTransport(probeMachine);
      const script = [
        'printf \'HOME:%s\\n\' "$HOME"',
        'node=$(command -v node 2>/dev/null); [ -n "$node" ] || node=$(ls -d "$HOME"/opt/node-*/bin/node /usr/local/bin/node /usr/bin/node 2>/dev/null | head -1)',
        'if [ -n "$node" ]; then printf \'NODE:%s\\n\' "$node"; "$node" --version 2>/dev/null | sed \'s/^/NODEVER:/\'; else printf \'NODE:none\\n\'; fi',
        'npm=$(command -v npm 2>/dev/null)',
        '[ -n "$npm" ] || npm=$(ls -d "$HOME"/.npm-global/bin/npm "$HOME"/.local/bin/npm /usr/local/bin/npm /usr/bin/npm 2>/dev/null | head -1)',
        '[ -n "$npm" ] || [ -z "$node" ] || npm=$(dirname "$node")/npm',
        'if [ -n "$npm" ] && [ -x "$npm" ]; then printf \'NPM:yes\\n\'; else printf \'NPM:no\\n\'; fi',
        'cli=$(command -v dsh 2>/dev/null)',
        '[ -n "$cli" ] || cli=$(ls -d "$HOME"/.npm-global/bin/dsh "$HOME"/.local/bin/dsh /usr/local/bin/dsh /usr/bin/dsh 2>/dev/null | head -1)',
        '[ -n "$cli" ] || [ -z "$node" ] || cli=$(ls -d "$(dirname "$node")/../lib/node_modules/@deepseek-ai/dsh/lib/bin.js" 2>/dev/null | head -1)',
        'if [ -n "$cli" ]; then cli=$(readlink -f "$cli" 2>/dev/null || printf \'%s\' "$cli"); printf \'CLIBIN:%s\\n\' "$cli"; fi',
        'printf \'END\\n\'',
      ].join('\n');
      const output = await sshExchange(ctx, probeMachine, script, undefined, signal);
      const parsed = { home: null, node: null, nodeVersion: null, npm: false, cliBin: null };
      let sawEnd = false;
      for (const line of String(output).split('\n')) {
        if (line === 'END') { sawEnd = true; continue; }
        const at = line.indexOf(':');
        if (at <= 0) continue;
        const key = line.slice(0, at), value = line.slice(at + 1);
        if (key === 'HOME') parsed.home = value;
        else if (key === 'NODE' && value !== 'none') parsed.node = value;
        else if (key === 'NODEVER') parsed.nodeVersion = value;
        else if (key === 'NPM') parsed.npm = value === 'yes';
        else if (key === 'CLIBIN') parsed.cliBin = value;
      }
      if (!sawEnd || parsed.home === null) throw failure('PROBE_FAILED', 502);
      return parsed;
    },
  };
}
