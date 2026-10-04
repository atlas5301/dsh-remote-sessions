import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';
import { createMirrorResolver } from '../lib/native-mirror.js';
import { createWorkspaceResolver } from '../lib/native-workspace.js';

async function fixture(t) {
  const parent = await fs.realpath('/tmp'), root = await fs.mkdtemp(join(parent, 'dsh-native-mirror-'));
  t.after(async () => { assert.equal(await fs.realpath(root), root); assert.ok(root.startsWith(parent + sep + 'dsh-native-mirror-')); await fs.rm(root, { recursive: true, force: true }); });
  const mirror = join(root, 'host-user', 'project'); await fs.mkdir(join(mirror, 'nested'), { recursive: true, mode: 0o700 });
  const metadata = join(mirror, '.dsh-remote-meta.json');
  const meta = { host: 'host.example', username: 'user', port: 2222, alias: 'build', remotePath: '/srv/project' };
  await fs.writeFile(metadata, JSON.stringify(meta), { mode: 0o600 });
  let calls = 0;
  const resolver = targets => createMirrorResolver({ root, targets, identify: async target => { calls++; return { target, authority: 'a', runtimeId: 'r', instanceId: 'i' }; } });
  return { root, mirror, metadata, meta, resolver, calls: () => calls };
}

test('standalone mapping uses ordinary directory, longest root and no metadata or compatibility lookup', async t => {
  const f = await fixture(t), localPath = join(f.root, 'standalone');
  await fs.mkdir(join(localPath, 'nested'), { recursive: true });
  const resolver = createWorkspaceResolver({ workspaces: [
    { localPath, target: 'one', remotePath: '/srv/one' },
    { localPath: join(localPath, 'nested'), target: 'two', remotePath: '/srv/two' },
  ], identify: async target => ({ target, runtimeId: 'runtime-' + target }) });
  assert.deepEqual(await resolver(localPath), { target: 'one', runtimeId: 'runtime-one', remoteCwd: '/srv/one' });
  assert.deepEqual(await resolver(join(localPath, 'nested')), { target: 'two', runtimeId: 'runtime-two', remoteCwd: '/srv/two' });
  assert.equal(await resolver(localPath + '-not-this-root'), null);
  await assert.rejects(fs.stat(join(localPath, '.dsh-remote-meta.json')), { code: 'ENOENT' });
  assert.throws(() => createWorkspaceResolver({ workspaces: [{ localPath, target: 'one', remotePath: '/a' }, { localPath, target: 'two', remotePath: '/b' }] }), { code: 'DUPLICATE_WORKSPACE_BINDING' });
});

test('existing dsh-remote alias metadata qualifies native workspace without active-machine fallback', async t => {
  const f = await fixture(t), resolve = f.resolver([{ target: 'resident', alias: 'build' }]);
  assert.deepEqual(await resolve(join(f.mirror, 'nested')), { target: 'resident', authority: 'a', runtimeId: 'r', instanceId: 'i', remoteCwd: '/srv/project/nested' });
  assert.equal(await resolve('/unrelated/local/workspace'), null); assert.equal(f.calls(), 1);
});
test('exact origin matching requires correct username and port; ambiguity fails closed', async t => {
  const f = await fixture(t);
  const match = { target: 'resident', host: f.meta.host, username: f.meta.username, port: 2222 };
  assert.equal((await f.resolver([match])(f.mirror)).target, 'resident');
  await assert.rejects(f.resolver([{ ...match, port: 22 }])(f.mirror), { code: 'REMOTE_MIRROR_NOT_CONFIGURED' });
  await assert.rejects(f.resolver([match, { target: 'other', alias: 'build' }])(f.mirror), { code: 'REMOTE_MIRROR_NOT_CONFIGURED' });
});
test('writable metadata, malformed data and symlink workspace cannot select remote authority', async t => {
  const f = await fixture(t), resolve = f.resolver([{ target: 'resident', alias: 'build' }]);
  await fs.chmod(f.metadata, 0o666); await assert.rejects(resolve(f.mirror), { code: 'UNSAFE_REMOTE_MIRROR' });
  await fs.chmod(f.metadata, 0o600); await fs.writeFile(f.metadata, '{}'); await assert.rejects(resolve(f.mirror), { code: 'INVALID_REMOTE_MIRROR' });
  await fs.writeFile(f.metadata, JSON.stringify(f.meta));
  const link = join(f.root, 'host-user', 'alias'); await fs.symlink(f.mirror, link);
  await assert.rejects(resolve(link), { code: 'UNSAFE_REMOTE_MIRROR' });
  assert.equal(f.calls(), 0);
});
