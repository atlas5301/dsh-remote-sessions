// Pure tests for managed virtual workspaces: anchor naming, remote path
// validation, browse quoting and live mapping refresh. No SSH, no filesystem
// side effects beyond temporary anchor directories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { anchorName, validateDirectoryName, createRemoteWorkspaces } from '../lib/remote-workspaces.js';
import { normalizeWorkspaceMappings, createWorkspaceResolver } from '../lib/native-workspace.js';

test('anchor names are stable, filesystem-safe and bounded', () => {
  const first = anchorName('dl1', '/home/ubuntu/dsh-workspaces/main');
  assert.equal(first, anchorName('dl1', '/home/ubuntu/dsh-workspaces/main'), 'identical inputs produce identical anchors');
  assert.notEqual(first, anchorName('dl1', '/home/ubuntu/dsh-workspaces/other'), 'different remote paths produce different anchors');
  assert.notEqual(anchorName('dl1', '/srv/x'), anchorName('dl2', '/srv/x'), 'targets never share an anchor');
  assert.match(first, /^[A-Za-z0-9._-]+$/);
  assert.ok(first.length <= 96);
  assert.ok(anchorName('m', '/' + 'x'.repeat(500)).length <= 96, 'huge remote paths are truncated safely');
});

test('remote folder names reject traversal and control characters', () => {
  assert.equal(validateDirectoryName('workspace'), 'workspace');
  assert.throws(() => validateDirectoryName('..'), /INVALID_DIRECTORY_NAME/);
  assert.throws(() => validateDirectoryName('a/b'), /INVALID_DIRECTORY_NAME/);
  assert.throws(() => validateDirectoryName('a\nb'), /INVALID_DIRECTORY_NAME/);
  assert.throws(() => validateDirectoryName(''), /INVALID_DIRECTORY_NAME/);
});

test('browse targets compose into quoted shell words only', async () => {
  // The browse path is embedded into a strict SSH command; anything outside
  // plain absolute paths or restricted ~ aliases must be refused.
  const ctx = null;
  const machine = { name: 'm', ssh: ['host'], remoteNode: '/usr/bin/node', socketPath: '/x.sock', remoteCwd: '/', env: {}, disabled: false, migrationRequired: false };
  const calls = [];
  const fake = async (ctxArg, machineArg, script) => { calls.push(script); return '/home/u\0one\0two deep\0'; };
  const { browseRemoteDirectory } = await import('../lib/remote-workspaces.js');
  const listing = await browseRemoteDirectory(fake, ctx, machine, '/home/u', null);
  assert.deepEqual(listing, { path: '/home/u', entries: [{ name: 'one', path: '/home/u/one' }, { name: 'two deep', path: '/home/u/two deep' }] });
  assert.ok(calls[0].includes(`cd '/home/u'`), 'absolute paths are single-quoted');
  // Injection-shaped absolute paths are inert: they only ever compose as
  // quoted shell words, so the remote `cd` fails instead of executing anything.
  await browseRemoteDirectory(fake, ctx, machine, '/home/u; rm -rf /', null);
  assert.ok(calls.at(-1).includes(`cd '/home/u; rm -rf /'`), 'absolute paths compose as quoted words');
  await assert.rejects(browseRemoteDirectory(fake, ctx, machine, '~; rm -rf /', null), /INVALID_(REMOTE_)?DIRECTORY/);
  await assert.rejects(browseRemoteDirectory(fake, ctx, machine, '~/$HOME', null), /INVALID_DIRECTORY/);
  await assert.rejects(browseRemoteDirectory(fake, ctx, machine, 'relative/path', null), /INVALID_REMOTE_DIRECTORY/);
  const homeListing = await browseRemoteDirectory(fake, ctx, machine, '~/projects', null);
  assert.equal(homeListing.path, '/home/u');
  assert.ok(calls.at(-1).includes('cd "$HOME"\'/projects\''), 'home aliases expand through quoted composition');
});

test('mapping refresh swaps the live table without a plugin reload', async () => {
  const root = await fs.mkdtemp(join(await fs.realpath('/tmp'), 'dsh-ws-'));
  const anchorA = join(root, 'a'), anchorB = join(root, 'b');
  await fs.mkdir(anchorA, { recursive: true }); await fs.mkdir(anchorB, { recursive: true });
  const identify = async target => ({ target, authority: 'auth', runtimeId: 'r', instanceId: 'i' });
  const resolver = createWorkspaceResolver({ workspaces: [{ localPath: anchorA, target: 'dl1', remotePath: '/srv/a' }], identify });
  assert.deepEqual(resolver.snapshot().map(m => m.remotePath), ['/srv/a']);
  resolver.refresh([{ localPath: anchorB, target: 'dl2', remotePath: '/srv/b' }]);
  assert.deepEqual(resolver.snapshot().map(m => m.remotePath), ['/srv/b'], 'refresh replaces the whole table');
  const resolved = await resolver(anchorB);
  assert.equal(resolved.target, 'dl2');
  assert.equal(resolved.remoteCwd, '/srv/b', 'refreshed anchors resolve immediately');
  assert.equal(await resolver(anchorA), null, 'stale mappings stop routing');
  assert.throws(() => resolver.refresh([{ localPath: anchorB, target: 'dl2', remotePath: '/srv/b' }, { localPath: anchorB, target: 'x', remotePath: '/y' }]), /DUPLICATE_WORKSPACE_BINDING/);
  await fs.rm(root, { recursive: true, force: true });
});

test('workspace CRUD persists through settings and refuses machines in use', async () => {
  const written = [];
  const resolver = createWorkspaceResolver({ workspaces: [], identify: async () => ({ target: 'dl1', authority: 'a', runtimeId: 'r', instanceId: 'i' }) });
  const registry = {
    machines: [{ name: 'dl1', ssh: ['host'], remoteNode: '/usr/bin/node', socketPath: '/x.sock', remoteCwd: '/', env: {}, command: 'ssh', disabled: false, migrationRequired: false, autoSetup: true, npmInstall: true, residentProfile: 'remote-resident', runtimeDirectory: '/x', authorityRevision: '' }],
    replace(next) { this.machines = next; },
  };
  const settings = { async update(ns, patch) { written.push({ ns, patch }); } };
  const transport = { identify: async () => ({}), call: async () => ({ workspace: { workspaceId: 'rw-1' } }) };
  const service = createRemoteWorkspaces(
    { get: key => key === 'settings' ? settings : undefined },
    { registry, transport, resolveWorkspace: resolver, sshExchange: async () => { throw new Error('no ssh in this test'); }, persist: true });
  resolver.refresh([{ localPath: '/anchors/a', target: 'dl1', remotePath: '/srv/a' }]);
  // Removing the machine while a workspace uses it must refuse.
  await assert.rejects(service.saveMachines([]), /MACHINE_IN_USE/);
  // Saving with the machine kept persists the full validated machine list.
  const saved = await service.saveMachines([{ name: 'dl1', ssh: ['host'], remoteNode: '/usr/bin/node', socketPath: '/x.sock', remoteCwd: '/' }]);
  assert.equal(saved.length, 1);
  assert.equal(written.at(-1).ns, 'remote-sessions');
  assert.ok(written.at(-1).patch.machines[0].remoteNode === '/usr/bin/node');
  // Unlink the workspace, then the machine can be removed.
  await service.remove({ localPath: '/anchors/a' });
  assert.deepEqual(resolver.snapshot(), []);
  await service.saveMachines([]);
  assert.equal(registry.machines.length, 0);
});

test('open links a managed anchor and forwards workspace creation to the remote', async () => {
  const root = await fs.mkdtemp(join(await fs.realpath('/tmp'), 'dsh-open-'));
  process.env.DSH_HOME = root;
  try {
    const resolver = createWorkspaceResolver({ workspaces: [], identify: async () => ({ target: 'dl1', authority: 'a', runtimeId: 'r', instanceId: 'i' }) });
    const registry = { machines: [{ name: 'dl1', ssh: ['host'], remoteNode: '/usr/bin/node', socketPath: '/x.sock', remoteCwd: '/', env: {}, disabled: false, migrationRequired: false }] };
    const calls = [];
    const transport = { identify: async target => ({ target }), call: async (binding, endpoint, values) => { calls.push([endpoint, values]); return { workspace: { workspaceId: 'rw-9' } }; } };
    const settings = { async update() {} };
    const service = createRemoteWorkspaces({ get: key => key === 'settings' ? settings : undefined },
      { registry, transport, resolveWorkspace: resolver, sshExchange: async () => '/home/ubuntu/dsh-workspaces/main\0', persist: true });
    const result = await service.open({ target: 'dl1', remotePath: '/home/ubuntu/dsh-workspaces/main' });
    assert.equal(result.remoteWorkspaceId, 'rw-9');
    assert.deepEqual(calls.at(-1), ['workspace/create', [{ path: '/home/ubuntu/dsh-workspaces/main' }]], 'the remote DSH owns the actual workspace');
    assert.ok(result.localPath.startsWith(join(root, 'remote-sessions', 'anchors')), 'the anchor is plugin-managed');
    assert.equal((await fs.stat(result.localPath)).isDirectory(), true, 'the anchor directory exists');
    assert.deepEqual(resolver.snapshot().map(m => ({ target: m.target, remotePath: m.remotePath })), [{ target: 'dl1', remotePath: '/home/ubuntu/dsh-workspaces/main' }]);
    // Re-opening the same remote path is idempotent and keeps one mapping.
    const again = await service.open({ target: 'dl1', remotePath: '/home/ubuntu/dsh-workspaces/main' });
    assert.equal(again.localPath, result.localPath);
    assert.equal(resolver.snapshot().length, 1);
  } finally { delete process.env.DSH_HOME; await fs.rm(root, { recursive: true, force: true }); }
});

test('normalizeWorkspaceMappings keeps the longest-root rule and rejects duplicates', () => {
  const mappings = normalizeWorkspaceMappings([
    { localPath: '/a', target: 'm', remotePath: '/r' },
    { localPath: '/a/b', target: 'm', remotePath: '/r/b' },
  ]);
  assert.deepEqual(mappings.map(m => m.localPath), ['/a/b', '/a'], 'longest root wins');
  assert.throws(() => normalizeWorkspaceMappings([{ localPath: '/a', target: 'm', remotePath: '/r' }, { localPath: '/a', target: 'm', remotePath: '/r2' }]), /DUPLICATE_WORKSPACE_BINDING/);
  assert.throws(() => normalizeWorkspaceMappings([{ localPath: 'relative', target: 'm', remotePath: '/r' }]), /INVALID_WORKSPACE_BINDING/);
});

test('machine renames cascade workspaces by socket identity; orphans still refuse', async () => {
  const writes = [];
  const resolver = createWorkspaceResolver({ workspaces: [], identify: async () => ({ target: 'dl1', authority: 'a', runtimeId: 'r', instanceId: 'i' }) });
  const machine = { name: 'dl1', ssh: ['host'], remoteNode: '/usr/bin/node', socketPath: '/home/u/.dsh/rs-runtime/agent.sock', remoteCwd: '/', env: {}, command: 'ssh', disabled: false, migrationRequired: false };
  const registry = { machines: [machine], replace(next) { this.machines = next; } };
  const settings = { async update(ns, patch) { writes.push(patch); } };
  const service = createRemoteWorkspaces({ get: key => key === 'settings' ? settings : undefined },
    { registry, transport: {}, resolveWorkspace: resolver, sshExchange: async () => { throw new Error('unused'); }, persist: true });
  resolver.refresh([{ localPath: '/anchors/a', target: 'dl1', remotePath: '/srv/a' }]);
  // Rename with the same socket: the workspace follows the new name.
  await service.saveMachines([{ name: 'ssh-dl1', ssh: ['host'], remoteNode: '/usr/bin/node', socketPath: '/home/u/.dsh/rs-runtime/agent.sock', remoteCwd: '/' }]);
  assert.deepEqual(resolver.snapshot().map(m => m.target), ['ssh-dl1'], 'rename cascades the workspace target');
  assert.ok(writes.at(-1).workspaces.some(w => w.target === 'ssh-dl1'), 'the retarget is persisted');
  // Removing without an heir keeps refusing: mappings never dangle silently.
  await assert.rejects(service.saveMachines([]), /MACHINE_IN_USE/);
  assert.deepEqual(resolver.snapshot().map(m => m.target), ['ssh-dl1'], 'refused saves change nothing');
  // After unlinking, removal succeeds.
  await service.remove({ localPath: '/anchors/a' });
  await service.saveMachines([]);
  assert.equal(registry.machines.length, 0);
});

test('quarantined legacy machines stay visible in saves until replaced or deleted', async () => {
  const resolver = createWorkspaceResolver({ workspaces: [], identify: async () => ({}) });
  const legacy = { name: 'old-acp', ssh: ['legacy.invalid'], acpCommand: '/bin/old', remoteCwd: '/' };
  const registry = { machines: [legacy, { name: 'dl1', ssh: ['host'], remoteNode: '/n', socketPath: '/s.sock', remoteCwd: '/', env: {}, command: 'ssh', disabled: false, migrationRequired: false }], replace(next) { this.machines = next; } };
  const settings = { async update() {} };
  const service = createRemoteWorkspaces({ get: key => key === 'settings' ? settings : undefined },
    { registry, transport: {}, resolveWorkspace: resolver, sshExchange: async () => { throw new Error('unused'); }, persist: true });
  // Saving the live machine list round-trips the quarantined record untouched.
  await service.saveMachines([
    { name: 'dl1', ssh: ['host'], remoteNode: '/n', socketPath: '/s.sock', remoteCwd: '/' },
    legacy,
  ]);
  assert.equal(registry.machines.length, 2);
  assert.ok(registry.machines.some(m => m.name === 'old-acp' && m.migrationRequired), 'legacy records survive a save');
  // Deleting it removes it; a same-name new-schema save replaces (migrates) it.
  await service.saveMachines([{ name: 'dl1', ssh: ['host'], remoteNode: '/n', socketPath: '/s.sock', remoteCwd: '/' }]);
  assert.equal(registry.machines.filter(m => m.migrationRequired).length, 0, 'legacy records are deletable');
});
