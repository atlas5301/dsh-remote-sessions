/**
 * node --test test/transfer-actions.test.js
 * Node built-ins only. Actual selected-transfer exports run against a read-only
 * in-memory fs capability. No real source fs, SSH, deployment, GUI or config IO.
 * Route transport and registrar are mocks; cookie admission remains the supplied
 * authenticated registerRoutes responsibility, not a second module boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { Readable } from 'node:stream';
import { posix } from 'node:path';
import {
  createTransferActions, installTransferActions, TRANSFER_ACTION_LIMITS,
} from '../lib/transfer-actions.js';
import {
  scanSelectedTransfer, generateRemoteSelectedTransferProbeProgram,
  generateRemoteSelectedTransferWriteProgram,
} from '../lib/selected-transfer.js';

const LOCAL = '/home/local/workspace';
const SKILLS = '/home/local/.dsh/skills';
const REMOTE = '/home/remote/workspace';
const PRIVATE = 'SELECTED_PRIVATE_CREDENTIAL_BYTES_not_for_ui';
const UNSELECTED = 'UNSELECTED_CREDENTIAL_BYTES';
const MEMORY = 'UNSELECTED_MEMORY_BYTES';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const authorization = (entry) => ({ path: entry.path, approveOverwrite: true,
  expectedLocalSha256: entry.localSha256, expectedRemoteSha256: entry.remoteSha256 });
const quote = (text) => `'${text.replace(/'/g, "'\\''")}'`;
const expectedCommand = (source) => `PATH="$HOME/bin:$HOME/.npm-global/bin:$PATH" node -e ${quote(source)}`;
function ioError() { const error = new Error(`PRIVATE_IO_DETAIL:${PRIVATE}`); error.code = 'ENOENT'; return error; }

// Read-only mock: EVERY mutating fs method is absent and unexpected methods fail.
// It provides enough nofollow/fd and inode semantics for the actual scanner.
class ReadOnlyFs {
  constructor() {
    this.nodes = new Map(); this.handles = new Map(); this.ops = []; this.nextFd = 10;
    this.hook = undefined; this.put('/', 'directory');
    const methods = { lstat: (name) => this.lstat(name), open: (name, flags) => this.open(name, flags),
      readdir: (name, options) => this.readdir(name, options) };
    this.fs = new Proxy(methods, { get(target, property) {
      assert.ok(Object.hasOwn(target, property), `Unexpected fs operation: ${String(property)}`);
      return target[property];
    } });
  }
  put(name, kind, bytes = '') {
    this.nodes.set(name, { kind, bytes: Buffer.from(bytes), ino: this.nodes.size + 1 });
  }
  dirs(name) {
    let current = '';
    for (const part of name.slice(1).split('/')) {
      current += `/${part}`; if (!this.nodes.has(current)) this.put(current, 'directory');
    }
    return this;
  }
  file(name, bytes) { this.dirs(posix.dirname(name)); this.put(name, 'file', bytes); return this; }
  resolve(name) {
    const fd = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(name);
    return posix.resolve(fd ? `${this.handles.get(Number(fd[1])).name}/${fd[2] ?? ''}` : name);
  }
  event(op, name) { this.ops.push({ op, name }); this.hook?.(op, name); }
  stat(node) {
    return { dev: 1, ino: node.ino, uid: 1000, mode: node.kind === 'directory' ? 0o700 : 0o600,
      size: node.bytes.length, nlink: 1, mtimeMs: 1, ctimeMs: 1,
      isDirectory: () => node.kind === 'directory', isFile: () => node.kind === 'file',
      isSymbolicLink: () => node.kind === 'symlink' };
  }
  async lstat(name) {
    name = this.resolve(name); this.event('lstat', name);
    const node = this.nodes.get(name); if (!node) throw ioError(); return this.stat(node);
  }
  async open(name, flags) {
    name = this.resolve(name); this.event('open', name);
    assert.equal(flags & (constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC), 0);
    assert.ok(flags & constants.O_NOFOLLOW);
    const node = this.nodes.get(name); if (!node) throw ioError();
    const fd = this.nextFd++; this.handles.set(fd, { name });
    return { fd, stat: async () => this.stat(node),
      read: async (buffer, offset, length, position) => {
        this.event('read', name);
        const bytesRead = Math.max(0, Math.min(length, node.bytes.length - position));
        node.bytes.copy(buffer, offset, position, position + bytesRead); return { bytesRead };
      }, close: async () => { this.event('close', name); this.handles.delete(fd); } };
  }
  async readdir(name, options) {
    name = this.resolve(name); this.event('readdir', name); assert.equal(options.withFileTypes, true);
    const prefix = `${name}/`;
    return [...this.nodes].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, node]) => ({ name: path.slice(prefix.length),
        isDirectory: () => node.kind === 'directory', isFile: () => node.kind === 'file',
        isSymbolicLink: () => node.kind === 'symlink' }));
  }
}
function localFs() {
  return new ReadOnlyFs().file(`${LOCAL}/chosen.txt`, PRIVATE)
    .file(`${LOCAL}/unselected.txt`, UNSELECTED).file(`${LOCAL}/memories/secret.md`, MEMORY)
    .file(`${SKILLS}/ordinary/SKILL.md`, '---\nname: ordinary\n---\nSelected instructions')
    .file(`${SKILLS}/ordinary/helper.txt`, PRIVATE)
    .file(`${SKILLS}/resource-policy/SKILL.md`, MEMORY)
    .file(`${SKILLS}/innocent/SKILL.md`, '---\nname: cooperation\n---\nForbidden policy')
    .file(`${LOCAL}/SKILL.md`, '---\nname: memory\n---\nForbidden renamed memory');
}
const request = (overrides = {}) => ({ machine: 'alpha', kind: 'files', localRoot: LOCAL,
  selections: ['chosen.txt'], approval: { kind: 'files', root: REMOTE, confirmed: true }, ...overrides });
const skillRequest = (overrides = {}) => request({ kind: 'skills', localRoot: SKILLS,
  selections: ['ordinary'], approval: { kind: 'skills', root: '~/.dsh/skills', confirmed: true }, ...overrides });
const machine = () => ({ name: 'alpha', command: 'ssh', ssh: ['-i', '/credential/key', 'operator@host'],
  env: { PRIVATE_AUTH_ENV: 'PRIVATE_TRANSPORT_CREDENTIAL' }, web: { remotePort: 8420 }, authorityRevision: '1' });

async function invoke(actions, operation, body, options = {}) {
  const route = actions.routes.find((entry) => entry.path.endsWith('/' + operation));
  const req = Readable.from(options.raw === undefined ? [JSON.stringify(body)] : [options.raw]);
  req.method = options.method ?? 'POST'; req.signal = options.signal;
  const headers = {};
  const res = { statusCode: 200, setHeader(key, value) { headers[key] = value; },
    end(text) { this.text = text; this.writableEnded = true; } };
  await route.handler(req, res);
  assert.equal(headers['cache-control'], 'no-store');
  for (const secret of [PRIVATE, UNSELECTED, MEMORY, 'PRIVATE_IO_DETAIL', 'PRIVATE_TRANSPORT_CREDENTIAL',
    Buffer.from(PRIVATE).toString('base64')]) assert.ok(!res.text.includes(secret), 'no private bytes in response');
  return { status: res.statusCode, body: JSON.parse(res.text), text: res.text };
}
function fixture(t, options = {}) {
  const fs = options.fs ?? localFs();
  const registry = { machines: [machine()] }; const calls = []; let clock = 1000; let serial = 0;
  const remote = new Map(options.remote ?? []);
  const sshExchange = async (ctx, target, command, input, signal) => {
    calls.push({ ctx, machine: target, command, input, signal });
    if (options.exchange) return options.exchange({ target, command, input, signal, remote, calls });
    const payload = JSON.parse(input);
    if (Object.hasOwn(payload, 'entries')) {
      return JSON.stringify({ ok: true, version: 1, manifestHash: payload.manifest.manifestHash,
        entries: payload.entries.map((row) => ({ path: row.path, localSha256: row.expectedLocalSha256,
          remoteSha256: row.expectedLocalSha256,
          status: row.approveOverwrite ? 'replaced' : row.expectedRemoteSha256 === row.expectedLocalSha256 ? 'unchanged' : 'created' })) });
    }
    return JSON.stringify({ ok: true, version: 1, kind: payload.manifest.kind,
      root: payload.approval.root, manifestHash: payload.manifest.manifestHash,
      entries: payload.manifest.files.map((row) => ({ path: row.path,
        remoteSha256: remote.has(row.path) ? sha(remote.get(row.path)) : null,
        remoteBytes: remote.has(row.path) ? Buffer.byteLength(remote.get(row.path)) : 0,
        status: remote.has(row.path) ? 'file' : 'absent' })) });
  };
  const ctx = { marker: 'trusted-context' };
  const actions = createTransferActions(ctx, registry, { sshExchange,
    scanCapabilities: { fs: fs.fs, uid: 1000, fdBase: '/proc/self/fd' },
    home: '/home/local', dshHome: '/home/local/.dsh', now: () => clock,
    uuid: () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`,
    ...options.factory });
  t.after(() => actions.dispose());
  return { actions, fs, registry, calls, remote, ctx, advance(ms) { clock += ms; } };
}
async function preview(f, body = request(), options) {
  const result = await invoke(f.actions, 'preview', body, options); assert.equal(result.status, 200, result.text);
  return result.body;
}
const applyBody = (plan, overrides = {}) => ({ machine: 'alpha', token: plan.token, confirm: true, ...overrides });

// Actual manifests and bound previews, not mock substitutes or deserialized bytes.
test('public preview uses actual helper and only explicit selection; private apply stdin only', async (t) => {
  const f = fixture(t), plan = await preview(f);
  assert.deepEqual(f.actions.routes.map(({ kind, path }) => ({ kind, path })), [
    { kind: 'exact', path: '/remote-sessions/selected-transfer/preview' },
    { kind: 'exact', path: '/remote-sessions/selected-transfer/apply' }]);
  assert.equal(plan.direction, 'push'); assert.equal(plan.count, 1); assert.equal(plan.conflicts, 0);
  assert.equal(plan.expiresAt, 1000 + 300000);
  assert.deepEqual(plan.entries, [{ path: 'chosen.txt', bytes: Buffer.byteLength(PRIVATE),
    localSha256: sha(PRIVATE), remoteSha256: null, remoteBytes: 0, status: 'create' }]);
  assert.ok(!JSON.stringify(plan).includes(LOCAL));
  assert.deepEqual(Object.keys(f.actions).sort(), ['dispose', 'routes']);
  assert.equal(f.calls[0].ctx, f.ctx);
  assert.equal(f.calls[0].command, expectedCommand(generateRemoteSelectedTransferProbeProgram()));
  assert.equal(f.calls[0].signal, undefined);
  const probeInput = JSON.parse(f.calls[0].input);
  assert.equal(probeInput.approval.root, REMOTE);
  assert.deepEqual(probeInput.manifest.files.map((row) => row.path), ['chosen.txt']);
  assert.ok(!f.calls[0].input.includes(Buffer.from(PRIVATE).toString('base64')));
  assert.ok(!f.fs.ops.some(({ op, name }) => op === 'read' && /unselected|memories/.test(name)));
  const result = await invoke(f.actions, 'apply', applyBody(plan));
  assert.equal(result.status, 200); assert.equal(result.body.entries[0].status, 'created');
  assert.equal(f.calls[1].command, expectedCommand(generateRemoteSelectedTransferWriteProgram()));
  const writeInput = JSON.parse(f.calls[1].input);
  assert.equal(writeInput.entries[0].contentBase64, Buffer.from(PRIVATE).toString('base64'));
  assert.ok(!f.calls[1].command.includes(REMOTE)); assert.ok(!f.calls[1].command.includes(LOCAL));
  for (const call of f.calls) for (const secret of [PRIVATE, UNSELECTED, MEMORY, 'PRIVATE_TRANSPORT_CREDENTIAL']) {
    assert.ok(!call.command.includes(secret)); assert.ok(!call.input.includes(secret));
  }
  assert.equal(f.fs.handles.size, 0);
  assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).body.error, 'INVALID_OR_EXPIRED_TOKEN');
  assert.equal(f.calls.length, 2, 'no replay/retry');
});

test('skills source restricted to canonical default or explicit trusted DSH_HOME', async (t) => {
  const f = fixture(t), plan = await preview(f, skillRequest());
  assert.equal(plan.count, 2); assert.equal(plan.root, '~/.dsh/skills');
  const applied = await invoke(f.actions, 'apply', applyBody(plan)); assert.equal(applied.status, 200);
  for (const localRoot of [`${SKILLS}/`, '/home/local/workspace', '/home/local/.dsh/skills/ordinary', '/home/local/.dsh/x/../skills']) {
    const result = await invoke(f.actions, 'preview', skillRequest({ localRoot }));
    assert.notEqual(result.status, 200);
  }
  for (const root of ['/home/remote/.dsh/skills', '~/.dsh/skills/', '~/elsewhere']) {
    assert.equal((await invoke(f.actions, 'preview', skillRequest({ approval: { kind: 'skills', root, confirmed: true } }))).body.error, 'INVALID_SKILLS_ROOT');
  }
  const custom = '/tmp/custom-dsh-home';
  const customFs = localFs().file(`${custom}/skills/ordinary/SKILL.md`, '---\nname: ordinary\n---\nInstructions');
  const g = fixture(t, { fs: customFs, factory: { dshHome: `${custom}/` } });
  assert.equal((await preview(g, skillRequest({ localRoot: `${custom}/skills` }))).count, 1);
  assert.equal((await invoke(g.actions, 'preview', skillRequest())).body.error, 'INVALID_LOCAL_SKILLS_ROOT');
});

test('ordinary explicit workspace roots only; no config/system/home roots or implicit approval', async (t) => {
  const f = fixture(t);
  for (const root of ['/', '/home', '/home/local', '/etc/project', '/usr/local', '/opt/project', '/private/tmp/project',
    '/System/project', '/Library/project', '/Applications/project', '/home/local/Library/project',
    '/home/local/AppData/project', '/home/local/.config/project',
    '/home/local/.dsh', '/home/local/workspace/', '/home/local/workspace/../workspace', '/home/local/workspace//sub']) {
    const source = await invoke(f.actions, 'preview', request({ localRoot: root }));
    assert.equal(source.body.error, 'INVALID_ROOT', root);
    const dest = await invoke(f.actions, 'preview', request({ approval: { kind: 'files', root, confirmed: true } }));
    assert.equal(dest.body.error, 'INVALID_ROOT', root);
  }
  for (const approval of [undefined, null, { kind: 'files', root: REMOTE }, { kind: 'files', root: REMOTE, confirmed: false },
    { kind: 'skills', root: REMOTE, confirmed: true }, { kind: 'files', root: REMOTE, confirmed: true, bytes: PRIVATE }]) {
    assert.equal((await invoke(f.actions, 'preview', request({ approval }))).body.error, 'ROOT_APPROVAL_REQUIRED');
  }
  assert.equal(f.calls.length, 0); assert.equal(f.fs.ops.length, 0);
});

test('refuse pull clearly, unwanted protocol fields, directories, blanket selections, memories and policies', async (t) => {
  const f = fixture(t);
  const pull = await invoke(f.actions, 'preview', request({ direction: 'pull' }));
  assert.equal(pull.status, 501); assert.equal(pull.body.error, 'UNSUPPORTED_PULL');
  assert.match(pull.body.message, /only.*local-to-remote pushes/);
  for (const extra of [{ root: REMOTE }, { all: true }, { credentials: PRIVATE }, { limits: {} }, { scanner: {} }, { signal: {} }]) {
    assert.equal((await invoke(f.actions, 'preview', request(extra))).body.error, 'INVALID_REQUEST');
  }
  for (const selections of [[], ['.'], ['*'], ['../chosen.txt'], ['/chosen.txt'], ['chosen.txt', 'chosen.txt'],
    ['memories/secret.md'], ['memory.md'], ['cooperation/SKILL.md'], ['.dsh/.credentials.yaml'], ['memories']]) {
    assert.notEqual((await invoke(f.actions, 'preview', request({ selections }))).status, 200);
  }
  assert.equal((await invoke(f.actions, 'preview', request({ selections: ['SKILL.md'] }))).body.error, 'FORBIDDEN_SELECTION');
  for (const selections of [['resource-policy'], ['innocent'], ['ordinary/helper.txt']]) {
    assert.notEqual((await invoke(f.actions, 'preview', skillRequest({ selections }))).status, 200);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.fs.handles.size, 0);
});

test('differing remote files refused by default; exact optional conflict authorizations only', async (t) => {
  const f = fixture(t, { remote: [['chosen.txt', 'different remote bytes']] });
  const plan = await preview(f); assert.equal(plan.conflicts, 1);
  const refused = await invoke(f.actions, 'apply', applyBody(plan));
  assert.equal(refused.status, 409); assert.equal(refused.body.error, 'REMOTE_CONFLICT');
  assert.equal(f.calls.length, 1); assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).status, 410);
  for (const authorizationList of [[{ ...authorization(plan.entries[0]), expectedRemoteSha256: sha('wrong') }],
    [{ ...authorization(plan.entries[0]), expectedLocalSha256: sha('wrong') }],
    [{ ...authorization(plan.entries[0]), path: 'unselected.txt' }],
    [{ ...authorization(plan.entries[0]), approveOverwrite: false }],
    [{ ...authorization(plan.entries[0]), extra: PRIVATE }],
    [authorization(plan.entries[0]), authorization(plan.entries[0])], {}, null]) {
    const next = await preview(f);
    assert.notEqual((await invoke(f.actions, 'apply', applyBody(next, { conflictAuthorizations: authorizationList }))).status, 200);
  }
  const approved = await preview(f);
  const written = await invoke(f.actions, 'apply', applyBody(approved, { conflictAuthorizations: approved.entries.map(authorization) }));
  assert.equal(written.status, 200); assert.equal(written.body.entries[0].status, 'replaced');
  const stdin = JSON.parse(f.calls.at(-1).input); assert.equal(stdin.entries[0].approveOverwrite, true);
});

test('unsupported pull apply consumes its token without any write', async (t) => {
  const f = fixture(t), plan = await preview(f);
  const result = await invoke(f.actions, 'apply', applyBody(plan, { direction: 'pull' }));
  assert.equal(result.status, 501); assert.equal(result.body.error, 'UNSUPPORTED_PULL');
  assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).status, 410);
  assert.equal(f.calls.length, 1);
});

test('unchanged remote files permitted but unsolicited conflict approval refused', async (t) => {
  const f = fixture(t, { remote: [['chosen.txt', PRIVATE]] }), plan = await preview(f);
  assert.equal(plan.entries[0].status, 'unchanged');
  const rejected = await invoke(f.actions, 'apply', applyBody(plan, { conflictAuthorizations: plan.entries.map(authorization) }));
  assert.equal(rejected.body.error, 'INVALID_CONFLICT_AUTHORIZATION');
  const second = await preview(f), result = await invoke(f.actions, 'apply', applyBody(second, { conflictAuthorizations: [] }));
  assert.equal(result.status, 200); assert.equal(result.body.entries[0].status, 'unchanged');
});

test('missing explicit apply confirmation consumes token; no direct manifest/write payload admission', async (t) => {
  const f = fixture(t);
  for (const confirm of [undefined, false, 'true', 1]) {
    const plan = await preview(f), result = await invoke(f.actions, 'apply', applyBody(plan, { confirm }));
    assert.equal(result.body.error, 'APPLY_CONFIRMATION_REQUIRED');
    assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).body.error, 'INVALID_OR_EXPIRED_TOKEN');
  }
  const plan = await preview(f);
  assert.equal((await invoke(f.actions, 'apply', applyBody(plan, { manifest: {} }))).body.error, 'INVALID_REQUEST');
  assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).body.error, 'INVALID_OR_EXPIRED_TOKEN');
  assert.equal(f.calls.length, 5, 'only probes ran');
});

test('retargeted authority, removed machine and different apply machine consumed without write', async (t) => {
  const f = fixture(t);
  for (const alter of [
    (m) => { m.command = 'different-ssh'; }, (m) => { m.ssh = ['operator@different-host']; },
    (m) => { m.env.PRIVATE_AUTH_ENV = 'different'; }, (m) => { m.socketPath = '/different/runtime/agent.sock'; },
    (m) => { m.authorityRevision = '2'; },
  ]) {
    f.registry.machines = [machine()]; const plan = await preview(f); alter(f.registry.machines[0]);
    assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).body.error, 'MACHINE_IDENTITY_CHANGED');
    assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).status, 410);
  }
  f.registry.machines = [machine()]; let plan = await preview(f); f.registry.machines = [];
  assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).body.error, 'MACHINE_IDENTITY_CHANGED');
  f.registry.machines = [machine()]; plan = await preview(f);
  assert.equal((await invoke(f.actions, 'apply', applyBody(plan, { machine: 'different' }))).body.error, 'MACHINE_IDENTITY_CHANGED');
  assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).status, 410);
  assert.equal(f.calls.length, 7);
});

test('identity is rechecked after scanning and probing, no token or retarget fallback', async (t) => {
  let f;
  f = fixture(t, { factory: { scanner: async (options, caps) => {
    const manifest = await scanSelectedTransfer(options, caps);
    f.registry.machines[0].authorityRevision = '2'; return manifest;
  } } });
  assert.equal((await invoke(f.actions, 'preview', request())).body.error, 'MACHINE_IDENTITY_CHANGED');
  assert.equal(f.calls.length, 0);
  const g = fixture(t, { exchange: ({ input }) => {
    g.registry.machines[0].authorityRevision = '2';
    const payload = JSON.parse(input);
    return JSON.stringify({ ok: true, version: 1, kind: 'files', root: REMOTE,
      manifestHash: payload.manifest.manifestHash, entries: [] });
  } });
  assert.equal((await invoke(g.actions, 'preview', request())).body.error, 'MACHINE_IDENTITY_CHANGED');
  assert.equal(g.calls.length, 1);
});

test('five-minute expiry, bounded capacity and disposal release retained capabilities without actions', async (t) => {
  const f = fixture(t, { factory: { capacity: 2 } });
  const first = await preview(f), second = await preview(f);
  assert.equal((await invoke(f.actions, 'preview', request())).body.error, 'PREVIEW_CAPACITY');
  assert.equal(f.calls.length, 2);
  f.advance(TRANSFER_ACTION_LIMITS.tokenTtlMs);
  assert.equal((await invoke(f.actions, 'apply', applyBody(first))).status, 410);
  assert.equal((await invoke(f.actions, 'apply', applyBody(second))).status, 410);
  const third = await preview(f); assert.ok(third.token !== first.token);
  f.actions.dispose(); f.actions.dispose();
  assert.equal((await invoke(f.actions, 'apply', applyBody(third))).body.error, 'TRANSFER_ACTIONS_DISPOSED');
  assert.equal((await invoke(f.actions, 'preview', request())).body.error, 'TRANSFER_ACTIONS_DISPOSED');
  assert.equal(f.calls.length, 3, 'dispose never executes SSH');
});

test('pending previews count against capacity and disposal blocks their later SSH probe', async (t) => {
  let release; const waiting = new Promise((resolve) => { release = resolve; });
  let scannerStarted; const started = new Promise((resolve) => { scannerStarted = resolve; });
  const f = fixture(t, { factory: { capacity: 1, scanner: async (options, caps) => {
    const manifest = await scanSelectedTransfer(options, caps);
    scannerStarted(); await waiting; return manifest;
  } } });
  const pending = invoke(f.actions, 'preview', request()); await started;
  assert.equal((await invoke(f.actions, 'preview', request())).body.error, 'PREVIEW_CAPACITY');
  f.actions.dispose(); release();
  assert.equal((await pending).body.error, 'TRANSFER_ACTIONS_DISPOSED');
  assert.equal(f.calls.length, 0); assert.equal(f.fs.handles.size, 0);
});

test('preflight cancellation stops real scanner cooperatively and closes handles; signal opt-in only', async (t) => {
  const f = fixture(t), controller = new AbortController();
  controller.abort(PRIVATE);
  assert.equal((await invoke(f.actions, 'preview', request(), { signal: controller.signal })).body.error, 'PREVIEW_CANCELLED');
  assert.equal(f.fs.ops.length, 0); assert.equal(f.calls.length, 0);
  const during = new AbortController();
  f.fs.hook = (op) => { if (op === 'read') during.abort(PRIVATE); };
  const result = await invoke(f.actions, 'preview', request(), { signal: during.signal });
  assert.equal(result.body.error, 'PREVIEW_CANCELLED'); assert.equal(f.fs.handles.size, 0);
  assert.equal(f.calls.length, 0);
  f.fs.hook = undefined;
  const explicit = new AbortController(); await preview(f, request(), { signal: explicit.signal });
  assert.equal(f.calls[0].signal, explicit.signal);
});

test('trusted injected scanner can observe request signal; AbortError text is never returned', async (t) => {
  const controller = new AbortController();
  const f = fixture(t, { factory: { scanner: async (options, caps, signal) => {
    assert.equal(signal, controller.signal); controller.abort(PRIVATE);
    throw new DOMException(PRIVATE, 'AbortError');
  } } });
  const result = await invoke(f.actions, 'preview', request(), { signal: controller.signal });
  assert.equal(result.body.error, 'PREVIEW_CANCELLED'); assert.equal(f.calls.length, 0);
});

test('probe cancellation uses the passed signal and issues no token', async (t) => {
  const controller = new AbortController();
  const f = fixture(t, { exchange: ({ signal }) => {
    assert.equal(signal, controller.signal); controller.abort(PRIVATE); throw new Error(PRIVATE);
  } });
  const result = await invoke(f.actions, 'preview', request(), { signal: controller.signal });
  assert.equal(result.body.error, 'PREVIEW_CANCELLED'); assert.equal(result.body.token, undefined);
  assert.equal(f.calls.length, 1); assert.equal(f.fs.handles.size, 0);
});

test('cancelled apply tokens are one-use even before SSH; disposal is not a replay', async (t) => {
  const f = fixture(t), plan = await preview(f), controller = new AbortController(); controller.abort(PRIVATE);
  const cancelled = await invoke(f.actions, 'apply', applyBody(plan), { signal: controller.signal });
  assert.equal(cancelled.body.error, 'APPLY_CANCELLED'); assert.equal(f.calls.length, 1);
  assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).status, 410);
});

test('cancellation during write and unknown SSH failure are explicit unreplayable outcomes, never retry/fallback', async (t) => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const f = fixture(t, { exchange: ({ input, signal }) => {
      const payload = JSON.parse(input);
      if (!payload.entries) return JSON.stringify({ ok: true, version: 1, kind: 'files', root: REMOTE,
        manifestHash: payload.manifest.manifestHash,
        entries: [{ path: 'chosen.txt', remoteSha256: null, remoteBytes: 0, status: 'absent' }] });
      if (cancel) { assert.equal(signal, controller.signal); controller.abort(PRIVATE); }
      throw new Error(`SSH argv/secret diagnostic: ${PRIVATE}`);
    } });
    const plan = await preview(f), result = await invoke(f.actions, 'apply', applyBody(plan), { signal: controller.signal });
    assert.equal(result.status, 502); assert.equal(result.body.error, 'APPLY_OUTCOME_UNKNOWN');
    assert.equal(result.body.replayable, false); assert.match(result.body.message, /do not replay/);
    assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).status, 410);
    assert.equal(f.calls.length, 2);
  }
});

test('concurrent apply consumes synchronously before one SSH write completes', async (t) => {
  let release; const waiting = new Promise((resolve) => { release = resolve; });
  let writerStarted; const started = new Promise((resolve) => { writerStarted = resolve; });
  const f = fixture(t, { exchange: async ({ input }) => {
    const payload = JSON.parse(input);
    if (!payload.entries) return JSON.stringify({ ok: true, version: 1, kind: 'files', root: REMOTE,
      manifestHash: payload.manifest.manifestHash,
      entries: [{ path: 'chosen.txt', remoteSha256: null, remoteBytes: 0, status: 'absent' }] });
    writerStarted(); await waiting;
    return JSON.stringify({ ok: true, version: 1, manifestHash: payload.manifest.manifestHash,
      entries: [{ path: 'chosen.txt', localSha256: sha(PRIVATE), remoteSha256: sha(PRIVATE), status: 'created' }] });
  } });
  const plan = await preview(f), writing = invoke(f.actions, 'apply', applyBody(plan)); await started;
  const second = await invoke(f.actions, 'apply', applyBody(plan)); assert.equal(second.status, 410);
  release(); assert.equal((await writing).status, 200); assert.equal(f.calls.length, 2);
});

test('writer outputs strictly sanitize manifest-bound statuses and reject arbitrary fields, paths and hashes', async (t) => {
  const mutations = [
    (r) => { r.credentials = PRIVATE; }, (r) => { r.entries[0].path = '/etc/secret'; },
    (r) => { r.entries[0].localSha256 = sha('wrong'); }, (r) => { r.entries[0].remoteSha256 = sha('wrong'); },
    (r) => { r.entries[0].status = 'replaced'; }, (r) => { r.entries[0].contentBase64 = Buffer.from(PRIVATE).toString('base64'); },
    (r) => { r.entries.push(r.entries[0]); }, (r) => { r.manifestHash = sha('wrong'); },
    (r) => { r.entries = []; }, (r) => { r.version = 2; },
  ];
  for (const mutate of mutations) {
    const f = fixture(t, { exchange: ({ input }) => {
      const payload = JSON.parse(input);
      if (!payload.entries) return JSON.stringify({ ok: true, version: 1, kind: 'files', root: REMOTE,
        manifestHash: payload.manifest.manifestHash,
        entries: [{ path: 'chosen.txt', remoteSha256: null, remoteBytes: 0, status: 'absent' }] });
      const result = { ok: true, version: 1, manifestHash: payload.manifest.manifestHash,
        entries: [{ path: 'chosen.txt', localSha256: sha(PRIVATE), remoteSha256: sha(PRIVATE), status: 'created' }] };
      mutate(result); return JSON.stringify(result);
    } });
    const plan = await preview(f), result = await invoke(f.actions, 'apply', applyBody(plan));
    assert.equal(result.body.error, 'APPLY_OUTCOME_UNKNOWN');
    assert.equal((await invoke(f.actions, 'apply', applyBody(plan))).status, 410);
  }
});

test('validated remote partial failure entries expose only known manifest paths/hashes/statuses', async (t) => {
  const fs = localFs().file(`${LOCAL}/second.txt`, 'second selected');
  for (const error of ['REMOTE_CAS_MISMATCH', PRIVATE]) {
    const f = fixture(t, { fs, exchange: ({ input }) => {
      const payload = JSON.parse(input);
      if (!payload.entries) return JSON.stringify({ ok: true, version: 1, kind: 'files', root: REMOTE,
        manifestHash: payload.manifest.manifestHash,
        entries: payload.manifest.files.map(({ path }) => ({ path, remoteSha256: null, remoteBytes: 0, status: 'absent' })) });
      return JSON.stringify({ ok: false, error,
        entries: [{ path: 'chosen.txt', localSha256: sha(PRIVATE), remoteSha256: sha(PRIVATE), status: 'created' }] });
    } });
    const plan = await preview(f, request({ selections: ['chosen.txt', 'second.txt'] }));
    const result = await invoke(f.actions, 'apply', applyBody(plan));
    if (error === 'REMOTE_CAS_MISMATCH') {
      assert.equal(result.status, 409); assert.equal(result.body.error, error);
      assert.deepEqual(result.body.entries.map((row) => row.path), ['chosen.txt']);
    } else assert.equal(result.body.error, 'APPLY_OUTCOME_UNKNOWN');
  }
});

test('invalid probe/SSH/source/parser errors are fixed safe codes; never private bytes or raw diagnostics', async (t) => {
  for (const probe of [PRIVATE, JSON.stringify({ ok: false, error: PRIVATE, entries: [] }),
    JSON.stringify({ ok: true, version: 1, kind: 'files', root: REMOTE, manifestHash: sha(PRIVATE), entries: [] }),
    JSON.stringify({ ok: true, credentials: PRIVATE }), 'x'.repeat(TRANSFER_ACTION_LIMITS.maxResponseBytes + 1)]) {
    const f = fixture(t, { exchange: () => probe });
    assert.equal((await invoke(f.actions, 'preview', request())).body.error, 'INVALID_REMOTE_PROBE');
  }
  const g = fixture(t, { exchange: () => { throw ioError(); } });
  assert.equal((await invoke(g.actions, 'preview', request())).body.error, 'REMOTE_PROBE_FAILED');
  const h = fixture(t); assert.equal((await invoke(h.actions, 'preview', request({ selections: ['missing.txt'] }))).body.error, 'SOURCE_IO_ERROR');
  assert.equal((await invoke(h.actions, 'preview', {}, { raw: PRIVATE })).body.error, 'INVALID_REQUEST');
  assert.equal((await invoke(h.actions, 'preview', request(), { method: 'GET' })).status, 405);
  assert.equal((await invoke(h.actions, 'preview', {}, { raw: 'x'.repeat(TRANSFER_ACTION_LIMITS.maxRequestBytes + 1) })).status, 413);
  assert.equal((await invoke(h.actions, 'preview', request({ machine: 'unknown' }))).status, 404);
});

test('production installer delegates registration and auth without IO; disposal adds no actions', (t) => {
  const effects = []; let registrations = 0; let sshCalls = 0; let actions;
  const ctx = { effect(factory, label) { effects.push({ dispose: factory(), label }); } };
  const registry = { machines: [machine()] };
  actions = installTransferActions(ctx, registry, {
    sshExchange: () => { sshCalls++; throw new Error('must never run at installation'); },
    registerRoutes(context, routes) {
      assert.equal(context, ctx); registrations++;
      assert.equal(routes.length, 2); assert.ok(routes.every((row) => row.kind === 'exact'));
    },
  });
  t.after(() => actions.dispose());
  assert.equal(registrations, 1); assert.equal(sshCalls, 0); assert.equal(effects.length, 1);
  assert.equal(effects[0].label, 'remote-sessions.selected-transfer-actions');
  effects[0].dispose(); assert.equal(sshCalls, 0);
  assert.throws(() => installTransferActions(ctx, registry, { sshExchange() {} }), /INVALID_INTEGRATION/);
});
