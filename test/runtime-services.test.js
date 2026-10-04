// Opt-in integration suite for remote file-tree and terminal forwarding.
// Boots two isolated real DSH runtimes (remote + host proxy) and drives the
// full forwarding stack: test peer → host adapter → wrapped native service →
// transport → remote adapter → remote gateway → real remote files and PTYs.
// No browser, no network model calls, no dsh-remote.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { startRuntime, call, streamUntil } from './runtime-harness.mjs';
import { BYTES_TAG } from '../lib/native-services.js';

const anchor = process.env.DSH_TEST_RUNTIME_ANCHOR;
const skip = !anchor && 'Set DSH_TEST_RUNTIME_ANCHOR to an existing installed @deepseek-ai/dsh/package.json (Node 22+)';

async function createProxiedSession(host) {
  const native = await host.connect();
  const { workspace } = await call(native, 'workspace/create', { path: join(host.root, 'remote-workspace') });
  const { sessionId } = await call(native, 'session/create', { workspaceId: workspace.workspaceId });
  return { native, sessionId };
}

test('remote file tree: list, read, stat and readBytes forward to the remote workspace', { skip, timeout: 30000 }, async t => {
  const remote = await startRuntime(t), host = await startRuntime(t, { proxyRuntime: remote });
  const { native, sessionId } = await createProxiedSession(host);
  await fs.mkdir(join(remote.root, 'workspace', 'tree'), { recursive: true });
  await fs.writeFile(join(remote.root, 'workspace', 'tree', 'notes.txt'), 'first line\nsecond line\n');
  await fs.writeFile(join(remote.root, 'workspace', 'tree', 'blob.bin'), Buffer.from([0, 1, 2, 250, 251]));

  const listing = await call(native, 'workspaceFiles/list', [sessionId, 'tree']);
  assert.deepEqual(listing.entries.map(entry => entry.name).sort(), ['blob.bin', 'notes.txt']);
  assert.equal(listing.path, 'tree');

  const page = await call(native, 'workspaceFiles/read', [sessionId, 'tree/notes.txt', { offset: 2, limit: 1 }]);
  assert.equal(page.text, 'second line');
  assert.equal(page.eof, true);
  assert.ok(page.absolutePath.startsWith(remote.root), 'the stat addresses the remote filesystem');

  const stat = await call(native, 'workspaceFiles/stat', [sessionId, 'tree/blob.bin']);
  assert.equal(stat.bytes, 5);
  assert.ok(stat.absolutePath.startsWith(remote.root));

  const bytes = await call(native, 'workspaceFiles/readBytes', [sessionId, 'tree/blob.bin', {}]);
  // The adapter tags binary payloads for the JSON relay; decode and compare.
  assert.equal(typeof bytes.data[BYTES_TAG], 'string');
  assert.deepEqual(Buffer.from(bytes.data[BYTES_TAG], 'base64'), Buffer.from([0, 1, 2, 250, 251]));
});

test('remote file tree: anchor-absolute paths map onto the remote workspace root', { skip, timeout: 30000 }, async t => {
  const remote = await startRuntime(t), host = await startRuntime(t, { proxyRuntime: remote });
  const { native, sessionId } = await createProxiedSession(host);
  await fs.writeFile(join(remote.root, 'workspace', 'anchor.txt'), 'via anchor\n');
  // A local-anchor absolute path (what the native UI would resolve) must list
  // the same remote directory, not the local shell.
  const listing = await call(native, 'workspaceFiles/list', [sessionId, join(host.root, 'remote-workspace')]);
  assert.ok(listing.entries.some(entry => entry.name === 'anchor.txt'), 'anchor-relative listing reaches the remote root');
});

test('remote file tree: change feed observes remote writes', { skip, timeout: 30000 }, async t => {
  const remote = await startRuntime(t), host = await startRuntime(t, { proxyRuntime: remote });
  const { native, sessionId } = await createProxiedSession(host);
  await fs.mkdir(join(remote.root, 'workspace', 'watched'), { recursive: true });
  // One persistent watch generation: the stream must already be active when
  // the remote write happens, exactly like the sidebar's live tree.
  const watchId = (await native.request('open', { endpoint: 'workspaceFiles/changes', values: [sessionId, 'watched'] })).streamId;
  const pull = async predicate => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const batch = await native.request('next', { streamId: watchId, waitMs: 1000 });
      for (const frame of batch.items) if (predicate(frame)) return frame;
      if (batch.done) throw new Error('workspace watch stream ended early');
    }
    throw new Error('expected workspace watch frame did not arrive');
  };
  const ready = await pull(frame => frame.kind === 'ready');
  assert.equal(ready.kind, 'ready');
  await fs.writeFile(join(remote.root, 'workspace', 'watched', 'late.txt'), 'appeared\n');
  const change = await pull(frame => frame.kind === 'change' && frame.change.absolutePath.endsWith('watched'));
  assert.ok(change.change.version, 'the remote watcher reports a version');
  await native.request('close', { streamId: watchId }, { timeoutMs: 2000 }).catch(() => {});
});

test('remote terminal: create, write, follow, resize, list and close over the remote PTY', { skip, timeout: 45000 }, async t => {
  const remote = await startRuntime(t), host = await startRuntime(t, { proxyRuntime: remote });
  const { native, sessionId } = await createProxiedSession(host);

  const environment = await call(native, 'terminal/environment', [sessionId]);
  assert.ok(environment.cwd.startsWith(remote.root), 'the terminal cwd is the remote workspace');
  const shells = await call(native, 'terminal/shells', [sessionId]);
  assert.ok(shells.length >= 1, 'the remote host discovers its own shells');

  const terminalId = 'svc-e2e';
  const info = await call(native, 'terminal/create', [sessionId, { id: terminalId, cols: 80, rows: 24 }]);
  assert.equal(info.id, terminalId);
  assert.equal(info.state, 'running');
  assert.ok(info.cwd.startsWith(remote.root));

  const attachmentId = 'attach-1';
  const followId = (await native.request('open', { endpoint: 'terminal/follow', values: [sessionId, terminalId, attachmentId] })).streamId;
  const pull = async predicate => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const batch = await native.request('next', { streamId: followId, waitMs: 1000 });
      for (const frame of batch.items) if (predicate(frame)) return frame;
      if (batch.done) throw new Error('terminal follow stream ended early');
    }
    throw new Error('expected terminal frame did not arrive');
  };
  const snapshot = await pull(frame => frame.type === 'snapshot');
  assert.equal(snapshot.info.id, terminalId);
  assert.equal(snapshot.info.controllerId, attachmentId);

  // The follow stream stays open: the attachment keeps exclusive input control.
  await call(native, 'terminal/write', [sessionId, terminalId, attachmentId, "printf 'REMOTE_MARK\\n'\r"]);
  const output = await pull(frame => frame.type === 'output' && frame.data.includes('REMOTE_MARK'));
  assert.ok(output.data.includes('REMOTE_MARK'), 'remote PTY output reaches the local follow stream');

  await call(native, 'terminal/resize', [sessionId, terminalId, attachmentId, 100, 30]);
  await call(native, 'terminal/rename', [sessionId, terminalId, 'svc renamed']);
  const listed = await call(native, 'terminal/list', [sessionId]);
  const row = listed.find(item => item.id === terminalId);
  assert.ok(row, 'the remote terminal is listed through the proxy');
  assert.equal(row.cols, 100);
  assert.equal(row.title, 'svc renamed');
  const renamed = await pull(frame => frame.type === 'state' && frame.info.title === 'svc renamed');
  assert.equal(renamed.info.cols, 100, 'state frames carry the remote terminal metadata');

  await native.request('close', { streamId: followId }, { timeoutMs: 2000 }).catch(() => {});
  await call(native, 'terminal/close', [sessionId, terminalId]);
  const after = await call(native, 'terminal/list', [sessionId]);
  assert.ok(!after.some(item => item.id === terminalId), 'closing releases the remote terminal');
});

test('remote terminal: input control is exclusive and read-only attachments cannot write', { skip, timeout: 45000 }, async t => {
  const remote = await startRuntime(t), host = await startRuntime(t, { proxyRuntime: remote });
  const { native, sessionId } = await createProxiedSession(host);
  const terminalId = 'svc-exclusive';
  await call(native, 'terminal/create', [sessionId, { id: terminalId, cols: 80, rows: 24 }]);
  await streamUntil(native, 'terminal/follow', [sessionId, terminalId, 'first'], frame => frame.type === 'snapshot');
  await assert.rejects(call(native, 'terminal/write', [sessionId, terminalId, 'second', 'x']),
    error => /terminal\/control-unavailable/.test(error.remote?.code ?? error.code ?? ''), 'a foreign attachment cannot write');
  await call(native, 'terminal/close', [sessionId, terminalId]);
});

test('local sessions keep fully local files and terminals after the overlay is installed', { skip, timeout: 45000 }, async t => {
  const remote = await startRuntime(t), host = await startRuntime(t, { proxyRuntime: remote });
  const native = await host.connect();
  // A session outside every mapped anchor stays local even while the overlay is live.
  const { workspace } = await call(native, 'workspace/create', { path: join(host.root, 'workspace') });
  const { sessionId } = await call(native, 'session/create', { workspaceId: workspace.workspaceId });
  await fs.writeFile(join(host.root, 'workspace', 'local-only.txt'), 'local\n');
  const listing = await call(native, 'workspaceFiles/list', [sessionId, '.']);
  assert.ok(listing.entries.some(entry => entry.name === 'local-only.txt'), 'unmapped sessions read the local filesystem');
  const environment = await call(native, 'terminal/environment', [sessionId]);
  assert.ok(environment.cwd.startsWith(host.root), 'unmapped sessions keep the local terminal cwd');
});
