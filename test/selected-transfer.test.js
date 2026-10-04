/**
 * node --test test/selected-transfer.test.js
 * Node built-ins only; NO SSH, remote, deployment, live filesystem writes or
 * destructive operations. Scanner and EXACT generated programs use an in-memory
 * filesystem. Its exposed fs rejects unlink/rm/rmdir/truncate/chmod and all
 * unexpected methods. These tests prove protocol/validation, not kernel races.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import * as crypto from 'node:crypto';
import path from 'node:path';
import {
  SELECTED_TRANSFER_LIMITS, scanSelectedTransfer,
  createSelectedTransferProbePayload, mergeSelectedTransferPreview,
  createSelectedTransferWritePayload, generateRemoteSelectedTransferProbeProgram,
  generateRemoteSelectedTransferWriteProgram,
} from '../lib/selected-transfer.js';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const privateLocal = 'PRIVATE_SELECTED_DOCUMENT_BYTES';
const privateRemote = 'PRIVATE_REMOTE_DOCUMENT_BYTES';
const workspace = '/home/ubuntu/ws-test';
const approval = { kind: 'files', root: workspace, confirmed: true };
const skillApproval = { kind: 'skills', root: '~/.dsh/skills', confirmed: true };
function failure(code) { const error = new Error(`PRIVATE_FS_DETAIL:${code}`); error.code = code; return error; }
function fails(fn, code) { assert.throws(fn, (error) => error.code === code && error.message === code); }
async function rejects(fn, code) { await assert.rejects(fn, (error) => error.code === code && error.message === code); }

class MemoryFs {
  constructor() {
    this.nodes = new Map(); this.handles = new Map(); this.ops = []; this.nextIno = 1; this.nextFd = 10;
    this.hook = null;
    this.put('/', 'directory', { uid: 0, mode: 0o755 });
    const allowed = {
      lstat: (name) => this.lstat(name),
      open: (name, flags, mode) => this.open(name, flags, mode),
      readdir: (name, options) => this.readdir(name, options),
      mkdir: (name, options) => this.mkdir(name, options),
      link: (source, destination) => this.link(source, destination),
      rename: (source, destination) => this.rename(source, destination),
    };
    this.fs = new Proxy(allowed, { get(target, name) {
      if (Object.prototype.hasOwnProperty.call(target, name)) return target[name];
      throw new Error(`FORBIDDEN_FS_METHOD:${String(name)}`);
    } });
  }
  resolved(name) {
    const match = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(name);
    if (match) {
      const handle = this.handles.get(Number(match[1]));
      if (!handle) throw failure('EBADF');
      name = `${handle.name}/${match[2] ?? ''}`;
    }
    return path.posix.resolve(name);
  }
  event(op, name) {
    this.ops.push({ op, path: name });
    if (this.hook) this.hook(op, name, this);
  }
  put(name, kind, options = {}) {
    const node = { kind, uid: options.uid ?? 1000, mode: options.mode ?? (kind === 'directory' ? 0o700 : 0o600),
      dev: 1, ino: this.nextIno++, nlink: options.nlink ?? 1, mtimeMs: 1, ctimeMs: 1,
      bytes: Buffer.from(options.bytes ?? ''), target: options.target };
    this.nodes.set(name, node); return node;
  }
  directories(name) {
    const parts = name.split('/').filter(Boolean); let current = '';
    for (const component of parts) { current += `/${component}`; if (!this.nodes.has(current)) this.put(current, 'directory'); }
    return this;
  }
  file(name, bytes, options = {}) {
    this.directories(path.posix.dirname(name)); this.put(name, 'file', { ...options, bytes }); return this;
  }
  stat(node) {
    return { dev: node.dev, ino: node.ino, uid: node.uid, mode: node.mode, nlink: node.nlink,
      size: node.bytes.length, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs,
      isDirectory: () => node.kind === 'directory', isFile: () => node.kind === 'file',
      isSymbolicLink: () => node.kind === 'symlink' };
  }
  async lstat(name) {
    const resolved = this.resolved(name); this.event('lstat', resolved);
    const node = this.nodes.get(resolved); if (!node) throw failure('ENOENT'); return this.stat(node);
  }
  async open(name, flags, mode) {
    const resolved = this.resolved(name); this.event('open', resolved);
    let node = this.nodes.get(resolved);
    if (node?.kind === 'symlink' && flags & constants.O_NOFOLLOW) throw failure('ELOOP');
    if (flags & constants.O_CREAT) {
      if (node && flags & constants.O_EXCL) throw failure('EEXIST');
      if (!node) node = this.put(resolved, 'file', { mode });
    }
    if (!node) throw failure('ENOENT');
    if (flags & constants.O_DIRECTORY && node.kind !== 'directory') throw failure('ENOTDIR');
    const fd = this.nextFd++;
    this.handles.set(fd, { name: resolved, node });
    const self = this;
    return {
      fd,
      stat: async () => self.stat(node),
      read: async (buffer, offset, length, position) => {
        self.event('read', resolved);
        const bytesRead = Math.max(0, Math.min(length, node.bytes.length - position));
        node.bytes.copy(buffer, offset, position, position + bytesRead); return { bytesRead, buffer };
      },
      writeFile: async (bytes) => {
        assert.ok(flags & constants.O_WRONLY); assert.ok(flags & constants.O_EXCL);
        assert.ok(resolved.includes('/.dsh-selected-transfer-'), 'never write an existing target inode');
        self.event('writeFile', resolved); node.bytes = Buffer.from(bytes); node.mtimeMs++; node.ctimeMs++;
      },
      sync: async () => self.event('sync', resolved),
      close: async () => { self.event('close', resolved); self.handles.delete(fd); },
    };
  }
  async readdir(name, options) {
    const resolved = this.resolved(name); this.event('readdir', resolved);
    assert.equal(options.withFileTypes, true);
    const prefix = `${resolved}/`;
    return [...this.nodes].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map(([key, node]) => ({ name: key.slice(prefix.length),
        isDirectory: () => node.kind === 'directory', isFile: () => node.kind === 'file',
        isSymbolicLink: () => node.kind === 'symlink' }));
  }
  async mkdir(name, options) {
    const resolved = this.resolved(name); this.event('mkdir', resolved);
    if (this.nodes.has(resolved)) throw failure('EEXIST');
    assert.equal(options.mode, 0o700); this.put(resolved, 'directory', { mode: options.mode });
  }
  async link(source, destination) {
    const from = this.resolved(source); const to = this.resolved(destination); this.event('link', to);
    if (this.nodes.has(to)) throw failure('EEXIST');
    const node = this.nodes.get(from); assert.ok(node); node.nlink++; this.nodes.set(to, node);
  }
  async rename(source, destination) {
    const from = this.resolved(source); const to = this.resolved(destination); this.event('rename', to);
    const node = this.nodes.get(from); assert.ok(node); this.nodes.set(to, node); this.nodes.delete(from);
  }
  bytes(name) { return this.nodes.get(name)?.bytes.toString(); }
  artifacts(suffix) { return [...this.nodes].filter(([name]) => name.includes('/.dsh-selected-transfer-') && (!suffix || name.endsWith(`.${suffix}`))); }
  writes() { return this.ops.filter(({ op }) => ['writeFile', 'mkdir', 'link', 'rename'].includes(op)); }
}
function remoteFs() {
  const fs = new MemoryFs();
  fs.put('/home', 'directory', { uid: 0, mode: 0o755 });
  fs.directories('/home/ubuntu'); fs.directories(workspace); fs.directories('/home/ubuntu/.dsh/skills');
  return fs;
}
async function makeManifest(options = {}, fs = new MemoryFs().file('/local/chosen.txt', privateLocal)) {
  return scanSelectedTransfer({ kind: 'files', localRoot: '/local', selections: ['chosen.txt'], ...options },
    { fs: fs.fs, uid: 1000, fdBase: '/proc/self/fd' });
}
async function run(program, input, fs = remoteFs(), options = {}) {
  const stdin = new EventEmitter(); let text = '';
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const process = { stdin, getuid: () => 1000, platform: options.platform ?? 'linux', exitCode: 0,
    stdout: { write(value) { text += value; if (text.endsWith('\n')) finish(); } } };
  let randomCounter = 0;
  const modules = {
    'node:fs': { promises: fs.fs, constants },
    'node:crypto': { ...crypto, randomBytes: () => Buffer.from((++randomCounter).toString(16).padStart(32, '0'), 'hex') },
    'node:os': { userInfo: () => ({ homedir: '/home/ubuntu' }) },
  };
  vm.runInNewContext(program, { Buffer, process, require: (name) => {
    assert.ok(Object.hasOwn(modules, name), `unexpected dependency ${name}`); return modules[name];
  } }, { timeout: 1000 });
  const bytes = Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  stdin.emit('data', bytes.subarray(0, Math.floor(bytes.length / 2)));
  stdin.emit('data', bytes.subarray(Math.floor(bytes.length / 2)));
  stdin.emit('end');
  await done;
  for (const secret of [privateLocal, privateRemote, 'PRIVATE_FS_DETAIL']) assert.ok(!text.includes(secret));
  assert.equal(fs.handles.size, 0, 'all opened handles close');
  return { result: JSON.parse(text), text, exitCode: process.exitCode, fs };
}
const probeProgram = generateRemoteSelectedTransferProbeProgram();
const writeProgram = generateRemoteSelectedTransferWriteProgram();
async function prepare(manifest, fs = remoteFs(), root = approval) {
  const probe = await run(probeProgram, createSelectedTransferProbePayload(manifest, { approval: root }), fs);
  assert.equal(probe.result.ok, true, probe.text);
  return mergeSelectedTransferPreview(manifest, probe.result, { approval: root });
}
function conflictAuth(preview) {
  return preview.entries.filter((entry) => entry.status === 'conflict').map((entry) => ({ path: entry.path,
    approveOverwrite: true, expectedLocalSha256: entry.localSha256, expectedRemoteSha256: entry.remoteSha256 }));
}

// Local source scan and public/private separation.
test('scan is explicit, deterministic, frozen, selected-only and WeakMap-private', async () => {
  const local = new MemoryFs().file('/local/chosen.txt', privateLocal).file('/local/unselected.txt', 'NOT_SELECTED');
  const manifest = await makeManifest({}, local);
  assert.deepEqual(manifest.files, [{ path: 'chosen.txt', bytes: Buffer.byteLength(privateLocal), sha256: sha(privateLocal) }]);
  assert.ok(Object.isFrozen(manifest)); assert.ok(Object.isFrozen(manifest.files[0]));
  const publicJson = JSON.stringify(manifest);
  assert.ok(!publicJson.includes(privateLocal)); assert.ok(!publicJson.includes('NOT_SELECTED'));
  assert.ok(!publicJson.includes('/local'));
  assert.equal(local.handles.size, 0); assert.equal(local.writes().length, 0);
  assert.ok(!local.ops.some(({ op, path }) => op === 'open' && path.endsWith('/unselected.txt')));
  assert.deepEqual(await makeManifest(), manifest);
  const preview = await prepare(manifest);
  const stdin = createSelectedTransferWritePayload(manifest, preview);
  assert.ok(stdin.includes(Buffer.from(privateLocal).toString('base64')));
  fails(() => createSelectedTransferProbePayload(JSON.parse(publicJson), { approval }), 'UNKNOWN_MANIFEST');
  fails(() => createSelectedTransferWritePayload(manifest, JSON.parse(JSON.stringify(preview))), 'UNKNOWN_PREVIEW');
  const other = await makeManifest();
  fails(() => createSelectedTransferWritePayload(other, preview), 'UNKNOWN_PREVIEW');
  local.nodes.get('/local/chosen.txt').bytes = Buffer.from('LATER_CHANGED');
  assert.equal(JSON.parse(createSelectedTransferWritePayload(manifest, preview)).entries[0].contentBase64,
    Buffer.from(privateLocal).toString('base64'), 'scan captures private immutable bytes');
});

test('files and ancestors reject symlink, hardlink and special source nodes', async () => {
  for (const kind of ['symlink', 'fifo', 'socket']) {
    const local = new MemoryFs().directories('/local'); local.put('/local/chosen.txt', kind);
    await rejects(() => makeManifest({}, local), kind === 'symlink' ? 'SYMLINK_REJECTED' : 'NON_REGULAR_FILE');
    assert.equal(local.writes().length, 0);
  }
  await rejects(() => makeManifest({}, new MemoryFs().file('/local/chosen.txt', 'x', { nlink: 2 })), 'LOCAL_HARDLINK');
  await rejects(() => makeManifest({}, new MemoryFs().file('/local/chosen.txt', 'x', { mode: 0o4600 })), 'UNSAFE_OWNER_MODE');
  const linkedParent = new MemoryFs().file('/local/sub/chosen.txt', 'x');
  linkedParent.put('/local/sub', 'symlink', { target: '/outside' });
  await rejects(() => makeManifest({ selections: ['sub/chosen.txt'] }, linkedParent), 'SYMLINK_REJECTED');
  const linkedRoot = new MemoryFs().file('/local/chosen.txt', 'x'); linkedRoot.put('/local', 'symlink');
  await rejects(() => makeManifest({}, linkedRoot), 'SYMLINK_REJECTED');
});

test('reject traversal, absolute selections, ambiguous paths, memories and governance skills', async () => {
  for (const name of ['../chosen.txt', '/chosen.txt', 'a/../chosen.txt', 'a//b', './chosen.txt', 'a\\b',
    'a\nfile', 'memories/chosen.txt', '.memories/x', 'MEMORY.md', 'memories-backup/x', '.dsh/memory/x',
    '.dsh/credentials.yaml', '.ssh/authorized_keys', '.config/tool-config', 'a /b',
    'cooperation/SKILL.md', 'resource-policy/SKILL.md', 'cooperation-custom.md', '.dsh-selected-transfer-x.stage']) {
    await assert.rejects(() => makeManifest({ selections: [name] }));
  }
  await rejects(() => makeManifest({ selections: [] }), 'EXPLICIT_SELECTION_REQUIRED');
  await rejects(() => makeManifest({ selections: ['chosen.txt', 'chosen.txt'] }), 'DUPLICATE_SELECTION');
  for (const root of ['/', 'relative', '/local/../outside', '/local/']) await assert.rejects(() => makeManifest({ localRoot: root }));
});

test('skills traverse only explicitly selected trees; renamed policy frontmatter and links fail', async () => {
  const local = new MemoryFs().file('/local/chosen/SKILL.md', '---\nname: chosen\n---\nPrivate skill body')
    .file('/local/chosen/assets/a.txt', privateLocal).file('/local/unselected/SKILL.md', 'keep')
    .file('/local/unselected/private.txt', 'NOT_SELECTED');
  const manifest = await makeManifest({ kind: 'skills', selections: ['chosen'] }, local);
  assert.deepEqual(manifest.files.map((file) => file.path), ['chosen/SKILL.md', 'chosen/assets/a.txt']);
  assert.ok(!local.ops.some(({ op, path }) => op === 'open' && path.includes('/unselected/')));
  await rejects(() => makeManifest({ kind: 'skills', selections: ['chosen/assets'] }, local), 'TOP_LEVEL_SKILL_REQUIRED');
  const noDocument = new MemoryFs().file('/local/chosen/a.txt', 'x');
  await rejects(() => makeManifest({ kind: 'skills', selections: ['chosen'] }, noDocument), 'SKILL_DOCUMENT_REQUIRED');
  for (const forbidden of ['cooperation', 'resource-policy', 'memories']) {
    const renamed = new MemoryFs().file('/local/chosen/SKILL.md', `---\nname: '${forbidden}'\n---\nbody`);
    await rejects(() => makeManifest({ kind: 'skills', selections: ['chosen'] }, renamed), 'FORBIDDEN_SELECTION');
  }
  const individual = new MemoryFs().file('/local/renamed/SKILL.md', '---\nname: cooperation\n---\nbody');
  await rejects(() => makeManifest({ selections: ['renamed/SKILL.md'] }, individual), 'FORBIDDEN_SELECTION');
  const escaped = new MemoryFs().file('/local/chosen/SKILL.md', '---\nname: "coo\\u0070eration"\n---\nbody');
  await rejects(() => makeManifest({ kind: 'skills', selections: ['chosen'] }, escaped), 'INVALID_SKILL_HEADER');
  local.put('/local/chosen/link', 'symlink');
  await rejects(() => makeManifest({ kind: 'skills', selections: ['chosen'] }, local), 'SYMLINK_REJECTED');
});

test('skill roots can be local DSH directories without allowing selected protected stores', async () => {
  const local = new MemoryFs().file('/home/local/.dsh/skills/chosen/SKILL.md', '---\nname: chosen\n---\nbody');
  const manifest = await makeManifest({ kind: 'skills', localRoot: '/home/local/.dsh/skills', selections: ['chosen'] }, local);
  assert.deepEqual(manifest.files.map((file) => file.path), ['chosen/SKILL.md']);
  local.file('/home/local/.dsh/skills/chosen/.dsh/credentials.yaml', 'DO_NOT_SELECT');
  await rejects(() => makeManifest({ kind: 'skills', localRoot: '/home/local/.dsh/skills', selections: ['chosen'] }, local), 'FORBIDDEN_SELECTION');
  assert.equal(local.writes().length, 0);
});

test('scanner enforces lowered hard ceilings, totals, file count and traversal depth', async () => {
  await rejects(() => makeManifest({ limits: { maxFileBytes: 2 } }), 'FILE_SIZE_LIMIT');
  await rejects(() => makeManifest({ limits: { maxTotalBytes: 2 } }), 'TOTAL_SIZE_LIMIT');
  await rejects(() => makeManifest({ limits: { maxFileBytes: SELECTED_TRANSFER_LIMITS.maxFileBytes + 1 } }), 'INVALID_LIMITS');
  const local = new MemoryFs().file('/local/chosen/SKILL.md', 'x').file('/local/chosen/two', 'x');
  await rejects(() => makeManifest({ kind: 'skills', selections: ['chosen'], limits: { maxFiles: 1 } }, local), 'FILE_COUNT_LIMIT');
  await rejects(() => makeManifest({ kind: 'skills', selections: ['chosen'], limits: { maxNodes: 1 } }, local), 'NODE_LIMIT');
  await rejects(() => makeManifest({ selections: ['a/b/c'], limits: { maxDepth: 2 } }), 'DEPTH_LIMIT');
});

test('ancestry and file mutation during scan are detected, not returned as bytes', async () => {
  const local = new MemoryFs().file('/local/chosen.txt', privateLocal);
  let changed = false;
  local.hook = (op, name, fs) => {
    if (op === 'read' && !changed) { changed = true; fs.nodes.get(name).mtimeMs++; }
  };
  await rejects(() => makeManifest({}, local), 'FILE_CHANGED');
  assert.equal(local.handles.size, 0);
  const ancestors = new MemoryFs().file('/local/chosen.txt', privateLocal);
  ancestors.hook = (op, name, fs) => { if (op === 'read') fs.put('/local', 'symlink'); };
  await rejects(() => makeManifest({}, ancestors), 'ANCESTRY_CHANGED');
});

// Pure merge/authorization contract and stdin-only protocol.
test('pure preview distinguishes absent, same and differing hashes, including empty files', async () => {
  const local = new MemoryFs().file('/local/a', '').file('/local/b', 'same').file('/local/c', 'new');
  const manifest = await makeManifest({ selections: ['c', 'a', 'b'] }, local);
  const remote = remoteFs().file(`${workspace}/b`, 'same').file(`${workspace}/c`, 'old');
  const preview = await prepare(manifest, remote);
  assert.deepEqual(preview.entries.map((entry) => entry.status), ['create', 'unchanged', 'conflict']);
  assert.equal(preview.entries[0].localSha256, sha('')); assert.equal(preview.entries[0].remoteSha256, null);
  assert.equal(preview.entries[2].remoteSha256, sha('old')); assert.equal(preview.conflicts, 1);
  assert.ok(Object.isFrozen(preview.entries[0]));
  const probe = (await run(probeProgram, createSelectedTransferProbePayload(manifest, { approval }), remote)).result;
  assert.deepEqual(mergeSelectedTransferPreview(JSON.parse(JSON.stringify(manifest)), probe, { approval }), preview);
  fails(() => createSelectedTransferWritePayload(manifest, preview), 'REMOTE_CONFLICT');
});

test('root approval is explicit and fixed; static source contains no root or content values', async () => {
  const manifest = await makeManifest();
  for (const root of [{ ...approval, confirmed: false }, { ...approval, root: '/' },
    { ...approval, root: '~/ws' }, { ...approval, root: '/home/ubuntu/../other' },
    { ...approval, root: '/home/ubuntu/.dsh' }, { ...approval, root: '/home/ubuntu/memories' },
    { ...approval, root: '/etc/example' }, { ...approval, root: '/home' },
    { ...approval, root: '/home/ubuntu/.config' }]) {
    assert.throws(() => createSelectedTransferProbePayload(manifest, { approval: root }));
  }
  fails(() => createSelectedTransferProbePayload(manifest, {}), 'ROOT_APPROVAL_REQUIRED');
  const skill = await makeManifest({ kind: 'skills', selections: ['chosen'] }, new MemoryFs().file('/local/chosen/SKILL.md', 'x'));
  fails(() => createSelectedTransferProbePayload(skill, { approval: { ...skillApproval, root: '/home/ubuntu/.dsh/skills' } }), 'INVALID_SKILLS_ROOT');
  for (const source of [probeProgram, writeProgram]) {
    assert.ok(!source.includes(workspace)); assert.ok(!source.includes(privateLocal)); assert.ok(!source.includes(privateRemote));
    assert.ok(!/\b(?:fs\.(?:unlink|rm|rmdir|truncate)|(?:execFile|spawn|execSync))\s*\(/.test(source));
    assert.ok(!/require\(['"](?:node:)?(?:child_process|tar|yaml)['"]\)/.test(source));
  }
});

test('probe result must match manifest, root, exact paths and hash/status schema', async () => {
  const manifest = await makeManifest();
  const probe = (await run(probeProgram, createSelectedTransferProbePayload(manifest, { approval }))).result;
  const mutations = [
    (p) => { p.root = '/other'; }, (p) => { p.manifestHash = sha('wrong'); },
    (p) => { p.entries[0].path = 'unselected'; }, (p) => { p.entries.push(p.entries[0]); },
    (p) => { p.entries[0].remoteSha256 = sha('x'); }, (p) => { p.entries[0].content = privateRemote; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(probe); mutate(changed);
    fails(() => mergeSelectedTransferPreview(manifest, changed, { approval }), 'INVALID_PROBE');
  }
});

test('conflicts need exact per-path explicit SHA authorizations; blanket overwrite is rejected', async () => {
  const manifest = await makeManifest(); const remote = remoteFs().file(`${workspace}/chosen.txt`, privateRemote);
  const preview = await prepare(manifest, remote);
  fails(() => createSelectedTransferWritePayload(manifest, preview, { overwrite: true }), 'INVALID_WRITE_OPTIONS');
  for (const item of [{ path: 'chosen.txt', approveOverwrite: true },
    { ...conflictAuth(preview)[0], expectedRemoteSha256: sha('stale') },
    { ...conflictAuth(preview)[0], expectedLocalSha256: sha('wrong') },
    { ...conflictAuth(preview)[0], approveOverwrite: false }]) {
    fails(() => createSelectedTransferWritePayload(manifest, preview, { conflictAuthorizations: [item] }), 'INVALID_CONFLICT_AUTHORIZATION');
  }
  fails(() => createSelectedTransferWritePayload(manifest, preview, { conflictAuthorizations: [...conflictAuth(preview), ...conflictAuth(preview)] }), 'INVALID_CONFLICT_AUTHORIZATION');
  const stdin = JSON.parse(createSelectedTransferWritePayload(manifest, preview, { conflictAuthorizations: conflictAuth(preview) }));
  assert.equal(stdin.entries[0].expectedRemoteSha256, sha(privateRemote));
  assert.equal(stdin.entries[0].expectedLocalSha256, sha(privateLocal)); assert.equal(stdin.entries[0].approveOverwrite, true);
});

// Exact generated node code, executed only against the isolated memory mock.
test('probe is strictly read-only and outputs only selected hashes/status; missing root stays absent', async () => {
  const manifest = await makeManifest(); const remote = remoteFs().file(`${workspace}/chosen.txt`, privateRemote)
    .file(`${workspace}/remote-only.txt`, 'KEEP');
  const before = [...remote.nodes.keys()];
  const output = await run(probeProgram, createSelectedTransferProbePayload(manifest, { approval }), remote);
  assert.equal(output.exitCode, 0); assert.equal(output.result.entries[0].remoteSha256, sha(privateRemote));
  assert.deepEqual([...remote.nodes.keys()], before); assert.equal(remote.writes().length, 0);
  assert.ok(!output.text.includes('remote-only'));
  const absent = await run(probeProgram, createSelectedTransferProbePayload(manifest,
    { approval: { ...approval, root: '/home/ubuntu/missing' } }), remote);
  assert.equal(absent.result.error, 'ENOENT'); assert.equal(remote.writes().length, 0);
});

test('new selected files publish atomically without clobber; stages retained; unrelated remote content survives', async () => {
  const local = new MemoryFs().file('/local/sub/chosen.txt', privateLocal);
  const manifest = await makeManifest({ selections: ['sub/chosen.txt'] }, local);
  const remote = remoteFs().file(`${workspace}/remote-only.txt`, 'KEEP');
  const preview = await prepare(manifest, remote);
  const output = await run(writeProgram, createSelectedTransferWritePayload(manifest, preview), remote);
  assert.equal(output.result.ok, true, output.text); assert.equal(output.result.entries[0].status, 'created');
  assert.equal(remote.bytes(`${workspace}/sub/chosen.txt`), privateLocal);
  assert.equal(remote.bytes(`${workspace}/remote-only.txt`), 'KEEP');
  assert.equal(remote.nodes.get(`${workspace}/sub`).mode, 0o700);
  assert.equal(remote.nodes.get(`${workspace}/sub/chosen.txt`).mode, 0o600);
  assert.equal(remote.artifacts('stage').length, 1); assert.equal(remote.artifacts('backup').length, 0);
  assert.equal(remote.nodes.get(`${workspace}/sub/chosen.txt`).nlink, 2, 'retained stage is a publication hardlink');
  assert.equal(remote.ops.filter(({ op }) => op === 'rename').length, 0);
  assert.ok(remote.artifacts().every(([, node]) => node.mode === 0o600));
  const again = await prepare(manifest, remote);
  assert.equal(again.entries[0].status, 'unchanged', 'safe remote publication hardlinks can be probed');
  const previousWrites = remote.writes().length;
  const unchanged = await run(writeProgram, createSelectedTransferWritePayload(manifest, again), remote);
  assert.equal(unchanged.result.entries[0].status, 'unchanged'); assert.equal(remote.writes().length, previousWrites);
});

test('authorized overwrite backs up old bytes owner-only before atomic rename, never mutates old inode', async () => {
  const manifest = await makeManifest(); const remote = remoteFs().file(`${workspace}/chosen.txt`, privateRemote)
    .file(`${workspace}/unselected.txt`, 'KEEP');
  const original = remote.nodes.get(`${workspace}/chosen.txt`);
  original.nlink = 2; remote.nodes.set(`${workspace}/unselected-hardlink`, original);
  const preview = await prepare(manifest, remote);
  const output = await run(writeProgram, createSelectedTransferWritePayload(manifest, preview,
    { conflictAuthorizations: conflictAuth(preview) }), remote);
  assert.equal(output.result.ok, true, output.text); assert.equal(output.result.entries[0].status, 'replaced');
  assert.equal(remote.bytes(`${workspace}/chosen.txt`), privateLocal);
  assert.equal(remote.bytes(`${workspace}/unselected-hardlink`), privateRemote);
  assert.equal(remote.bytes(`${workspace}/unselected.txt`), 'KEEP');
  assert.equal(remote.artifacts('backup').length, 1); assert.equal(remote.artifacts('backup')[0][1].bytes.toString(), privateRemote);
  assert.equal(remote.artifacts('backup')[0][1].mode, 0o600);
  assert.equal(remote.artifacts('stage').length, 0, 'stage moved into selected target, not deleted');
  const renameAt = remote.ops.findIndex(({ op }) => op === 'rename');
  assert.ok(remote.ops.slice(0, renameAt).some(({ op, path }) => op === 'sync' && path.endsWith('.backup')));
});

test('skill write touches only selected entries, preserving remote extra files and other skills', async () => {
  const manifest = await makeManifest({ kind: 'skills', selections: ['chosen'] },
    new MemoryFs().file('/local/chosen/SKILL.md', '---\nname: chosen\n---\nnew body').file('/local/chosen/data/a', 'a'));
  const root = '/home/ubuntu/.dsh/skills';
  const remote = remoteFs().file(`${root}/chosen/remote-extra`, 'KEEP_EXTRA').file(`${root}/other/SKILL.md`, 'KEEP_OTHER');
  const preview = await prepare(manifest, remote, skillApproval);
  const output = await run(writeProgram, createSelectedTransferWritePayload(manifest, preview), remote);
  assert.equal(output.result.ok, true, output.text); assert.equal(remote.bytes(`${root}/chosen/remote-extra`), 'KEEP_EXTRA');
  assert.equal(remote.bytes(`${root}/other/SKILL.md`), 'KEEP_OTHER');
  assert.equal(remote.bytes(`${root}/chosen/data/a`), 'a');
  assert.ok(remote.writes().every(({ path }) => path.startsWith(`${root}/chosen/`)));
});

test('remote rejects symlink ancestors/targets, special files, unsafe modes/owners and oversized files', async () => {
  const manifest = await makeManifest();
  const setups = [
    [(fs) => fs.put(`${workspace}/chosen.txt`, 'symlink'), 'SYMLINK_REJECTED'],
    [(fs) => fs.put(workspace, 'symlink'), 'SYMLINK_REJECTED'],
    [(fs) => fs.put('/home/ubuntu', 'symlink'), 'SYMLINK_REJECTED'],
    [(fs) => fs.put(`${workspace}/chosen.txt`, 'fifo'), 'NON_REGULAR_FILE'],
    [(fs) => fs.put(workspace, 'directory', { mode: 0o777 }), 'UNSAFE_OWNER_MODE'],
    [(fs) => fs.put(workspace, 'directory', { uid: 0 }), 'UNSAFE_OWNER_MODE'],
    [(fs) => fs.put(`${workspace}/chosen.txt`, 'file', { uid: 0 }), 'UNSAFE_OWNER_MODE'],
    [(fs) => fs.put(`${workspace}/chosen.txt`, 'file', { mode: 0o666 }), 'UNSAFE_OWNER_MODE'],
    [(fs) => fs.put(`${workspace}/chosen.txt`, 'file', { mode: 0o4600 }), 'UNSAFE_OWNER_MODE'],
    [(fs) => fs.put(`${workspace}/chosen.txt`, 'file', { bytes: Buffer.alloc(SELECTED_TRANSFER_LIMITS.maxFileBytes + 1) }), 'FILE_SIZE_LIMIT'],
  ];
  for (const [setup, code] of setups) {
    const remote = remoteFs(); setup(remote);
    const output = await run(probeProgram, createSelectedTransferProbePayload(manifest, { approval }), remote);
    assert.equal(output.result.error, code, output.text); assert.equal(output.exitCode, 1); assert.equal(remote.writes().length, 0);
  }
  const unsupported = await run(probeProgram, createSelectedTransferProbePayload(manifest, { approval }), remoteFs(), { platform: 'darwin' });
  assert.equal(unsupported.result.error, 'REMOTE_PLATFORM_UNSUPPORTED');
});

test('remote independently validates hashes, traversal, root approval and conflict authorization before writes', async () => {
  const manifest = await makeManifest(); const preview = await prepare(manifest);
  const input = JSON.parse(createSelectedTransferWritePayload(manifest, preview));
  const mutations = [
    [(p) => { p.entries[0].contentBase64 = Buffer.from('bad bytes').toString('base64'); }, 'CONTENT_HASH_MISMATCH'],
    [(p) => { p.entries[0].approveOverwrite = true; }, 'CONFLICT_AUTHORIZATION_REQUIRED'],
    [(p) => { p.approval.confirmed = false; }, 'ROOT_APPROVAL_REQUIRED'],
    [(p) => { p.approval.root = '/home/ubuntu/../outside'; }, 'UNSAFE_PATH'],
    [(p) => { p.manifest.files[0].path = '../escape'; }, 'UNSAFE_PATH'],
    [(p) => { p.manifest.files[0].path = 'memories/escape'; }, 'FORBIDDEN_SELECTION'],
    [(p) => { p.entries.push(p.entries[0]); }, 'INVALID_REQUEST'],
    [(p) => { p.manifest.files[0].sha256 = sha('wrong'); }, 'MANIFEST_HASH_MISMATCH'],
    [(p) => { p.entries[0].contentBase64 += '\n'; }, 'INVALID_REQUEST'],
  ];
  for (const [mutate, code] of mutations) {
    const remote = remoteFs(); const changed = structuredClone(input); mutate(changed);
    const output = await run(writeProgram, changed, remote);
    assert.equal(output.result.error, code, output.text); assert.equal(remote.writes().length, 0);
  }
  const conflictRemote = remoteFs().file(`${workspace}/chosen.txt`, privateRemote);
  const conflictPreview = await prepare(manifest, conflictRemote);
  const authorized = JSON.parse(createSelectedTransferWritePayload(manifest, conflictPreview,
    { conflictAuthorizations: conflictAuth(conflictPreview) }));
  authorized.entries[0].approveOverwrite = false;
  const rejected = await run(writeProgram, authorized, conflictRemote);
  assert.equal(rejected.result.error, 'CONFLICT_AUTHORIZATION_REQUIRED'); assert.equal(conflictRemote.writes().length, 0);
});

test('CAS drift aborts whole preflight before writes, including a newly appeared absent target', async () => {
  const local = new MemoryFs().file('/local/a', 'a').file('/local/b', 'b');
  const manifest = await makeManifest({ selections: ['a', 'b'] }, local);
  const remote = remoteFs().file(`${workspace}/b`, 'old');
  const preview = await prepare(manifest, remote);
  const stdin = createSelectedTransferWritePayload(manifest, preview, { conflictAuthorizations: conflictAuth(preview) });
  remote.nodes.get(`${workspace}/b`).bytes = Buffer.from('changed');
  const output = await run(writeProgram, stdin, remote);
  assert.equal(output.result.error, 'REMOTE_CAS_MISMATCH'); assert.equal(remote.writes().length, 0);
  assert.equal(remote.bytes(`${workspace}/a`), undefined); assert.equal(remote.bytes(`${workspace}/b`), 'changed');
  const absentRemote = remoteFs(); const simple = await makeManifest(); const absentPreview = await prepare(simple, absentRemote);
  absentRemote.file(`${workspace}/chosen.txt`, 'appeared');
  const appeared = await run(writeProgram, createSelectedTransferWritePayload(simple, absentPreview), absentRemote);
  assert.equal(appeared.result.error, 'REMOTE_CAS_MISMATCH'); assert.equal(absentRemote.writes().length, 0);
});

test('post-stage CAS drift retains artifacts without overwriting new remote content', async () => {
  const manifest = await makeManifest(); const remote = remoteFs().file(`${workspace}/chosen.txt`, privateRemote);
  const preview = await prepare(manifest, remote);
  const input = createSelectedTransferWritePayload(manifest, preview, { conflictAuthorizations: conflictAuth(preview) });
  remote.hook = (op, name, fs) => {
    if (op === 'sync' && name.endsWith('.backup')) fs.nodes.get(`${workspace}/chosen.txt`).bytes = Buffer.from('EXTERNAL_CHANGED');
  };
  const output = await run(writeProgram, input, remote);
  assert.equal(output.result.error, 'REMOTE_CAS_MISMATCH'); assert.equal(remote.bytes(`${workspace}/chosen.txt`), 'EXTERNAL_CHANGED');
  assert.equal(remote.artifacts('backup').length, 1); assert.equal(remote.artifacts('stage').length, 1);
  assert.equal(remote.ops.filter(({ op }) => op === 'rename').length, 0);
});

test('stage content tampering is rehashed before publication', async () => {
  const manifest = await makeManifest(); const remote = remoteFs(); const preview = await prepare(manifest, remote);
  remote.hook = (op, name, fs) => {
    if (op === 'sync' && name === workspace) {
      for (const [, node] of fs.artifacts('stage')) node.bytes = Buffer.from('TAMPERED_STAGE');
    }
  };
  const output = await run(writeProgram, createSelectedTransferWritePayload(manifest, preview), remote);
  assert.equal(output.result.error, 'ARTIFACT_HASH_MISMATCH'); assert.equal(remote.bytes(`${workspace}/chosen.txt`), undefined);
  assert.equal(remote.artifacts('stage').length, 1); assert.equal(remote.ops.filter(({ op }) => op === 'link').length, 0);
});

test('atomic no-clobber publication protects file appearing after final absent check', async () => {
  const manifest = await makeManifest(); const remote = remoteFs(); const preview = await prepare(manifest, remote);
  remote.hook = (op, name, fs) => {
    if (op === 'link') fs.file(name, 'APPEARED_AFTER_CHECK');
  };
  const output = await run(writeProgram, createSelectedTransferWritePayload(manifest, preview), remote);
  assert.equal(output.result.error, 'EEXIST'); assert.equal(remote.bytes(`${workspace}/chosen.txt`), 'APPEARED_AFTER_CHECK');
  assert.equal(remote.artifacts('stage').length, 1);
});

test('partial failure reports completed hashes/status only and retains recovery stages', async () => {
  const local = new MemoryFs().file('/local/a', 'a').file('/local/b', 'b');
  const manifest = await makeManifest({ selections: ['a', 'b'] }, local); const remote = remoteFs();
  const preview = await prepare(manifest, remote);
  remote.hook = (op, name) => { if (op === 'link' && name.endsWith('/b')) throw failure('EACCES'); };
  const output = await run(writeProgram, createSelectedTransferWritePayload(manifest, preview), remote);
  assert.equal(output.result.error, 'EACCES'); assert.equal(output.result.entries.length, 1);
  assert.deepEqual(output.result.entries[0], { path: 'a', localSha256: sha('a'), remoteSha256: sha('a'), status: 'created' });
  assert.equal(remote.bytes(`${workspace}/a`), 'a'); assert.equal(remote.bytes(`${workspace}/b`), undefined);
  assert.equal(remote.artifacts('stage').length, 2);
});

test('malformed/oversized stdin yields secret-free errors without filesystem operations', async () => {
  const invalid = await run(writeProgram, `{"PRIVATE_SECRET":"${privateLocal}"`);
  assert.equal(invalid.result.error, 'INVALID_STDIN'); assert.equal(invalid.fs.ops.length, 0);
  const tooLarge = await run(writeProgram, 'x'.repeat(16 * 1024 * 1024 + 1));
  assert.equal(tooLarge.result.error, 'STDIN_SIZE_LIMIT'); assert.equal(tooLarge.fs.ops.length, 0);
});
