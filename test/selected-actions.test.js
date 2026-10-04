/**
 * node --test dsh-remote-sessions/test/selected-actions.test.js
 * No SSH, sockets, GUI, deploy, config writes or real child processes. Exact
 * generated Node sources run with an in-memory POSIX filesystem/installed-module
 * resolver. YAML uses the already-installed DSH library, never an install.
 * The fake route registrar models authenticated admission, not carrier security.
 * These tests do not prove OS race resistance or real SSH/runtime readiness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  installSelectedActions, SELECTED_ACTION_LIMITS, generateSelectedSyncProbeProgram,
  generateSelectedSyncPreviewProgram, generateSelectedSyncApplyProgram,
} from '../lib/selected-actions.js';
import { createSelectedSyncPlan, createSelectedSyncPayload, hashDocumentText } from '../lib/selected-sync.js';
import { machineIdentity } from '../lib/authority.js';
import { installedAnchor } from './anchor.mjs';

const require = createRequire(import.meta.url);
const anchorRequire = createRequire(installedAnchor());
const yaml = anchorRequire(process.env.DSH_SELECTED_SYNC_YAML_PATH ?? 'yaml');
const SELECTED = 'PRIVATE_SELECTED_API_VALUE', OTHER = 'PRIVATE_OTHER_API_VALUE';
const REMOTE = 'PRIVATE_REMOTE_UNSELECTED_VALUE', OAUTH = 'PRIVATE_REMOTE_OAUTH_VALUE';
const home = '/isolated-owner', uid = 1000;
const install = `${home}/.npm-global`, cli = `${install}/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js`;
const yamlPath = `${install}/lib/node_modules/@deepseek-ai/dsh/node_modules/yaml/dist/index.js`;
const configPath = `${home}/.dsh/cordis.patch.yml`, credentialsPath = `${home}/.dsh/.credentials.yaml`;
const selection = [{ provider: 'chosen', model: 'selected/model' }];
function providers() { return {
  chosen: { apiKeyEnv: 'CHOSEN_API_KEY', baseURL: 'https://api.example.test/v1', api: 'openai-completions',
    models: [{ id: 'selected/model', maxTokens: 8192 }, { id: 'not-selected/model', maxTokens: 4096 }],
    modelOverrides: { 'selected/model': { maxTokens: 2048 }, 'not-selected/model': { maxTokens: 1 } } },
  other: { apiKey: OTHER, models: [{ id: 'local-default-not-selected' }] },
}; }
function remoteConfig() { return yaml.stringify([
  { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
    chosen: { ...providers().chosen, models: [{ id: 'selected/model', maxTokens: 1 }, { id: 'remote-only/model', maxTokens: 7 }],
      modelOverrides: { 'remote-only/model': { maxTokens: 3 } } },
    untouched: { apiKey: REMOTE, models: [{ id: 'remote-unselected' }] },
  }, preserve: REMOTE } },
  { id: 'agent-default-model', config: { provider: 'untouched', model: 'remote-default' } },
  { id: 'memories', config: { opaque: REMOTE } },
]); }
function remoteCredentials() { return yaml.stringify({ version: 1, refs: { CHOSEN_API_KEY: 'OLD_PRIVATE_KEY', OTHER_API_KEY: REMOTE },
  records: { 'codex/default': { kind: 'grant', payload: { accessToken: OAUTH } } } }); }
function noSecrets(value) { const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [SELECTED, OTHER, REMOTE, OAUTH]) assert.ok(!text.includes(secret), 'public secret leak'); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function memory(options = {}) {
  const files = new Map(), operations = []; let inode = 10, tick = 100;
  const info = (type, mode, extra = {}) => ({ type, mode, uid, dev: 1, ino: inode++, nlink: 1, mtimeMs: tick++, ctimeMs: tick++, size: 0,
    isFile() { return this.type === 'file'; }, isDirectory() { return this.type === 'directory'; }, isSymbolicLink() { return this.type === 'symlink'; }, ...extra });
  function directories(filename) { const parent = path.dirname(filename); if (parent !== filename) directories(parent);
    if (!files.has(filename)) files.set(filename, { text: '', info: info('directory', 0o755, filename === '/' ? { uid: 0 } : {}) }); }
  function add(filename, text, mode = 0o600) { directories(path.dirname(filename)); files.set(filename, { text, info: info('file', mode, { size: Buffer.byteLength(text) }) }); }
  add(cli, '// installed CLI fixture', 0o755); add(yamlPath, '// installed YAML fixture', 0o644);
  directories(`${install}/bin`); files.set(`${install}/bin/dsh`, { text: '', target: cli, info: info('symlink', 0o777) });
  add(configPath, options.configText ?? remoteConfig(), 0o644); add(credentialsPath, options.credentialsText ?? remoteCredentials());
  const fsError = code => Object.assign(new Error('PRIVATE_FS_MESSAGE_' + SELECTED), { code });
  const fs = {
    async lstat(filename) { operations.push(['lstat', filename]); options.beforeLstat?.({ filename, files });
      if (!files.has(filename)) throw fsError('ENOENT'); return { ...files.get(filename).info }; },
    async realpath(filename) { operations.push(['realpath', filename]); if (!files.has(filename)) throw fsError('ENOENT'); return files.get(filename).target ?? filename; },
    async open(filename, flags, mode) { operations.push(['open', filename, flags, mode]); assert.ok(flags & constants.O_NOFOLLOW);
      if (flags & constants.O_CREAT) { assert.ok(flags & constants.O_EXCL); if (files.has(filename)) throw fsError('EEXIST'); add(filename, '', mode); }
      if (!files.has(filename)) throw fsError('ENOENT'); const item = files.get(filename);
      if (item.info.type === 'symlink') throw fsError('ELOOP');
      return { async stat() { return { ...item.info }; }, async readFile() { operations.push(['readFile', filename]); return item.text; },
        async writeFile(text) { operations.push(['writeFile', filename]); assert.ok(flags & constants.O_CREAT, 'no direct overwrite');
          item.text = text; item.info.size = Buffer.byteLength(text); item.info.mtimeMs = tick++; item.info.ctimeMs = tick++; },
        async sync() { operations.push(['sync', filename]); }, async close() { operations.push(['close', filename]); } };
    },
    async rename(source, target) { operations.push(['rename', source, target]); options.beforeRename?.({ source, target, files });
      assert.ok(files.has(source)); files.set(target, files.get(source)); files.delete(source); },
  };
  const installedRequire = id => { assert.equal(id, yamlPath); return yaml; };
  installedRequire.resolve = id => { assert.equal(id, 'yaml'); return options.yamlResolution ?? yamlPath; };
  const mockRequire = id => {
    if (id === 'node:fs/promises') return new Proxy(fs, { get(target, key) { if (key in target) return target[key];
      return () => { throw new Error('Forbidden operation: ' + String(key)); }; } });
    if (id === 'node:fs') return { constants };
    if (id === 'node:path') return path;
    if (id === 'node:os') return { homedir: () => home };
    if (id === 'node:crypto') return { createHash, randomBytes };
    if (id === 'node:module') return { createRequire(entry) { assert.equal(entry, cli); return installedRequire; } };
    if (id === 'node:stream') return { Readable };
    if (id === yamlPath) return yaml;
    throw new Error('Forbidden module: ' + id);
  };
  options.mutate?.({ files, add });
  return { files, operations, mockRequire };
}
async function generated(source, input, mem = memory()) {
  const done = deferred(), output = [];
  const process = { platform: 'linux', getuid: () => uid, exitCode: 0,
    stdin: Readable.from([typeof input === 'string' ? input : JSON.stringify(input)]),
    stdout: { write(text) { output.push(text); done.resolve(); } } };
  Function('require', 'process', 'Buffer', 'URL', source)(mem.mockRequire, process, Buffer, URL);
  let timer; try { await Promise.race([done.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Generated program did not report')), 3000); })]); }
  finally { clearTimeout(timer); }
  return { ...mem, result: JSON.parse(output.join('')), output: output.join(''), exitCode: process.exitCode };
}
function probeInput(refs = ['CHOSEN_API_KEY']) { return { version: 1, selections: selection, credentialRefs: refs }; }
function payload(mem, refs = ['CHOSEN_API_KEY'], pin) { const plan = createSelectedSyncPlan({ providers: providers(), selections: selection, credentialRefs: refs,
  defaultPin: pin, credentials: { version: 1, refs: { CHOSEN_API_KEY: SELECTED } } });
  return createSelectedSyncPayload(plan, { yamlModulePath: yamlPath, expectedHashes: { config: hashDocumentText(mem.files.get(configPath)?.text ?? null),
    ...(refs.length ? { credentials: hashDocumentText(mem.files.get(credentialsPath)?.text ?? null) } : {}) } }); }
function fromCommand(command) { const quoted = command.slice(command.indexOf('node -e ') + 8);
  assert.equal(quoted[0], "'"); assert.equal(quoted.at(-1), "'"); return quoted.slice(1, -1).replace(/'\\''/g, "'"); }
function fixture(t, options = {}) {
  const routes = new Map(), effects = [], exchanges = [], resolved = [], logs = [], mem = memory(options.remote);
  const registry = { machines: [{ name: 'fixture', command: 'mock-ssh', ssh: ['fixture@invalid.example'], env: {}, web: { remotePort: 8420 } }] };
  let localProviders = providers(), secret = SELECTED;
  const ctx = { settings: { opaque: 'not-a-file' }, effect(factory) { effects.push(factory()); },
    get(name) { assert.equal(name, 'credentials', 'never query unrelated/full stores'); return { async resolve(ref) { resolved.push(ref);
      if (options.resolve) return options.resolve(ref); return { value: secret, source: 'private-unexposed-metadata' }; } }; },
    logger: { info(...args) { logs.push(args); }, error(...args) { logs.push(args); }, warn(...args) { logs.push(args); } } };
  const api = installSelectedActions(ctx, registry, {
    readSettingsSection(settings, section) { assert.equal(settings, ctx.settings); assert.equal(section, 'llm-pi-ai'); return { providers: localProviders }; },
    registerRoutes(owner, entries) { assert.equal(owner, ctx); for (const route of entries) routes.set(route.path, async (req, res) => {
      // The production capability admits via cookies before handlers. Tokens alone
      // are NEVER sufficient. No real carrier implementation is copied here.
      if (req.headers.cookie !== 'host_session=admitted') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'not admitted' })); }
      return route.handler(req, res);
    }); },
    async sshExchange(owner, machine, command, input, signal) {
      assert.equal(owner, ctx); exchanges.push({ machine: structuredClone(machine), command, input, signal });
      noSecrets(command); signal?.throwIfAborted();
      const hook = await options.exchange?.({ index: exchanges.length, machine, command, input, signal, mem });
      if (hook !== undefined) return hook;
      const result = await generated(fromCommand(command), input, mem); noSecrets(result.output); return result.output;
    },
  });
  t.after(() => api.dispose());
  async function request(which, input, options = {}) {
    const req = Readable.from([Buffer.from(options.raw ?? JSON.stringify(input))]); req.method = options.method ?? 'POST';
    req.url = '/remote-sessions/selected-sync/' + which; req.headers = { cookie: options.cookie ?? 'host_session=admitted' };
    if (options.signal) req.signal = options.signal;
    const res = new EventEmitter(), headers = {};
    Object.assign(res, { statusCode: 200, setHeader(key, value) { headers[key.toLowerCase()] = value; }, end(text) { this.text = text; this.writableEnded = true; } });
    options.started?.(req, res);
    await routes.get(req.url)(req, res);
    return { status: res.statusCode, body: res.text ? JSON.parse(res.text) : undefined, headers, req, res };
  }
  return { api, ctx, registry, routes, effects, exchanges, resolved, logs, mem, request,
    preview: (changes = {}, reqOptions) => request('preview', { machine: 'fixture', selections: selection, credentialRefs: ['CHOSEN_API_KEY'], ...changes }, reqOptions),
    setProviders(value) { localProviders = value; }, setSecret(value) { secret = value; } };
}

test('install is inert; routes rely on authenticated registrar, tokens cannot bypass admission', async t => {
  const f = fixture(t); assert.deepEqual([...f.routes.keys()], ['/remote-sessions/selected-sync/preview', '/remote-sessions/selected-sync/apply']);
  assert.equal(f.exchanges.length, 0); assert.equal(f.resolved.length, 0);
  assert.equal((await f.preview({}, { cookie: '' })).status, 403);
  assert.equal((await f.request('apply', { token: 'not-a-cookie', confirm: true }, { cookie: '' })).status, 403);
  assert.equal((await f.preview({}, { method: 'GET' })).status, 405);
  assert.equal(f.exchanges.length, 0); assert.equal(f.resolved.length, 0);
});

test('preview resolves only selected API-key refs, dry-runs exact remote merge, emits no secrets or document hashes', async t => {
  const f = fixture(t), before = f.mem.files.get(configPath).text;
  const pin = { provider: 'chosen', model: 'selected/model', reasoningEffort: 'high' };
  const response = await f.preview({ defaultPin: pin }); assert.equal(response.status, 200); noSecrets(response.body);
  assert.deepEqual(f.resolved, ['CHOSEN_API_KEY']); assert.equal(f.exchanges.length, 2);
  const [probe, dryrun] = f.exchanges;
  noSecrets(probe.input); assert.deepEqual(JSON.parse(probe.input), probeInput());
  const privatePayload = JSON.parse(dryrun.input);
  assert.equal(privatePayload.operations.refs.CHOSEN_API_KEY, SELECTED);
  assert.deepEqual(privatePayload.operations.routes[0].profile.models, [{ id: 'selected/model', maxTokens: 8192 }]);
  assert.ok(!dryrun.input.includes(OTHER)); assert.ok(!dryrun.input.includes(REMOTE)); assert.ok(!dryrun.input.includes(OAUTH));
  assert.ok(!dryrun.input.includes('not-selected/model')); assert.ok(!dryrun.input.includes('records'));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.body.preview.changed, { config: true, credentials: true });
  assert.deepEqual(response.body.preview.defaultPin, pin);
  assert.deepEqual(response.body.preview.routes, [{ provider: 'chosen', models: ['selected/model'], apiKeyEnv: 'CHOSEN_API_KEY', sharedFields: ['api', 'apiKeyEnv', 'baseURL'] }]);
  assert.equal(response.body.preview.identity, machineIdentity(f.registry.machines[0]));
  assert.ok(!JSON.stringify(response.body).includes('sha256:')); assert.ok(!JSON.stringify(response.body).includes('yamlModulePath'));
  assert.equal(f.mem.files.get(configPath).text, before);
  assert.equal(f.mem.operations.filter(([op]) => ['writeFile', 'rename'].includes(op)).length, 0);
  assert.equal(f.logs.length, 0);
});

test('apply preserves original private plan and pinned hashes, selected defaults only; one-use before SSH', async t => {
  const f = fixture(t), beforeConfig = yaml.parse(f.mem.files.get(configPath).text), beforeCreds = yaml.parse(f.mem.files.get(credentialsPath).text);
  const pin = { provider: 'chosen', model: 'selected/model' }, response = await f.preview({ defaultPin: pin });
  f.setSecret('CHANGED_LOCAL_SECRET'); f.setProviders({});
  const applied = await f.request('apply', { token: response.body.token, confirm: true });
  assert.equal(applied.status, 200); assert.deepEqual(applied.body.changed, ['config', 'credentials']);
  assert.equal(applied.body.backupCount, 2); noSecrets(applied.body);
  assert.equal(JSON.parse(f.exchanges[2].input).operations.refs.CHOSEN_API_KEY, SELECTED);
  const nextConfig = yaml.parse(f.mem.files.get(configPath).text), nextCreds = yaml.parse(f.mem.files.get(credentialsPath).text);
  assert.deepEqual(nextConfig[0].config.providers.untouched, beforeConfig[0].config.providers.untouched);
  assert.deepEqual(nextConfig[0].config.providers.chosen.models.map(m => m.id), ['selected/model', 'remote-only/model']);
  assert.deepEqual(nextConfig[2], beforeConfig[2]); assert.deepEqual(nextConfig[1].config, pin);
  assert.equal(nextCreds.refs.CHOSEN_API_KEY, SELECTED); assert.equal(nextCreds.refs.OTHER_API_KEY, beforeCreds.refs.OTHER_API_KEY);
  assert.deepEqual(nextCreds.records, beforeCreds.records);
  const replay = await f.request('apply', { token: response.body.token, confirm: true });
  assert.equal(replay.body.error, 'TOKEN_NOT_FOUND'); assert.equal(f.exchanges.length, 3);
  assert.deepEqual(f.resolved, ['CHOSEN_API_KEY']);
});

test('credential opt-out neither resolves nor reads/stats credential files or chooses a local default', async t => {
  const f = fixture(t, { remote: { credentialsText: 'INVALID SECRET YAML' } });
  const preview = await f.preview({ credentialRefs: [] }); assert.equal(preview.status, 200);
  assert.equal(preview.body.preview.defaultPin, null); assert.equal(preview.body.preview.changed.credentials, false);
  assert.equal(f.resolved.length, 0);
  const apply = await f.request('apply', { token: preview.body.token, confirm: true }); assert.equal(apply.status, 200);
  assert.deepEqual(apply.body.changed, ['config']);
  assert.ok(!f.mem.operations.some(([, filename]) => filename === credentialsPath));
});

test('reject full-store/legacy/options, invalid/unselected refs and default before resolving credentials or SSH', async t => {
  const f = fixture(t);
  for (const change of [
    { providers: {} }, { sync: { credentials: true } }, { credentials: { version: 1, refs: { CHOSEN_API_KEY: SELECTED } } },
    { selections: [] }, { selections: [{ provider: 'chosen', model: 'selected/model', fullStore: true }] },
    { credentialRefs: ['OTHER_API_KEY'] }, { credentialRefs: ['BROWSER_API_KEY'] }, { credentialRefs: ['OAUTH_API_KEY'] },
    { credentialRefs: ['CHOSEN_API_KEY', 'CHOSEN_API_KEY'] }, { defaultPin: { provider: 'other', model: 'local-default-not-selected' } },
  ]) { const result = await f.preview(change); assert.notEqual(result.status, 200); noSecrets(result.body); }
  assert.equal(f.resolved.length, 0); assert.equal(f.exchanges.length, 0);
});

test('credential API failure and arbitrary errors are sanitized without logs or SSH', async t => {
  const f = fixture(t, { resolve() { throw new Error(SELECTED); } });
  const result = await f.preview(); assert.equal(result.body.error, 'CREDENTIAL_RESOLUTION_FAILED'); noSecrets(result.body);
  assert.equal(f.exchanges.length, 0); assert.equal(f.logs.length, 0);
});

test('body/request/reply limits, explicit true confirmation, no payload supplied by browser', async t => {
  const f = fixture(t);
  assert.equal((await f.preview({}, { raw: 'x'.repeat(SELECTED_ACTION_LIMITS.maxBodyBytes + 1) })).status, 413);
  assert.equal((await f.preview({}, { raw: '{' + SELECTED })).body.error, 'INVALID_REQUEST');
  assert.notEqual((await f.preview({ selections: Array.from({ length: 65 }, () => selection[0]) })).status, 200);
  const preview = await f.preview();
  assert.equal((await f.request('apply', { token: preview.body.token, confirm: 'true' })).body.error, 'CONFIRM_REQUIRED');
  assert.equal((await f.request('apply', { token: preview.body.token, confirm: true, payload: SELECTED })).body.error, 'INVALID_REQUEST');
  assert.equal(f.exchanges.length, 2);
  assert.equal((await f.request('apply', { token: preview.body.token, confirm: true })).status, 200);
});

test('identity change and deletion rejects pinned token without SSH; expiry and dispose release capabilities', async t => {
  const f = fixture(t); const first = await f.preview(); f.registry.machines[0].ssh = ['changed@invalid.example'];
  assert.equal((await f.request('apply', { token: first.body.token, confirm: true })).body.error, 'MACHINE_IDENTITY_CHANGED');
  assert.equal(f.exchanges.length, 2);
  const second = await f.preview(); const oldNow = Date.now;
  try { Date.now = () => second.body.expiresAt + 1;
    assert.equal((await f.request('apply', { token: second.body.token, confirm: true })).body.error, 'TOKEN_EXPIRED');
  } finally { Date.now = oldNow; }
  const third = await f.preview(); f.registry.machines = [];
  assert.equal((await f.request('apply', { token: third.body.token, confirm: true })).body.error, 'MACHINE_IDENTITY_CHANGED');
  f.api.dispose(); assert.equal((await f.preview()).body.error, 'DISPOSED');
  assert.equal(f.exchanges.length, 6);
});

test('remote drift is rejected before writes; shared-route conflict denies preview authorization', async t => {
  const f = fixture(t); const response = await f.preview();
  const entry = f.mem.files.get(configPath); entry.text += '# changed\n'; entry.info.size = Buffer.byteLength(entry.text); entry.info.ctimeMs++;
  const result = await f.request('apply', { token: response.body.token, confirm: true });
  assert.equal(result.body.error, 'CONFIG_CHANGED'); assert.equal(result.body.outcome, 'not-committed');
  assert.deepEqual(result.body.committed, []); assert.equal(f.mem.operations.filter(([op]) => op === 'writeFile').length, 0);
  const conflict = fixture(t); const rows = yaml.parse(conflict.mem.files.get(configPath).text);
  rows[0].config.providers.chosen.baseURL = 'https://remote-different.test/v1';
  conflict.mem.files.get(configPath).text = yaml.stringify(rows); conflict.mem.files.get(configPath).info.size = Buffer.byteLength(yaml.stringify(rows));
  const blocked = await conflict.preview(); assert.equal(blocked.body.error, 'SHARED_ROUTE_CHANGE_CONFLICT');
  assert.equal(blocked.body.token, undefined); assert.equal(conflict.exchanges.length, 2);
});

test('partial commit is reported accurately through unchanged writer with zero SSH exit; token is consumed', async t => {
  const f = fixture(t, { remote: { beforeRename({ target }) { if (target === credentialsPath) throw Object.assign(new Error(SELECTED), { code: 'EACCES' }); } } });
  const preview = await f.preview(), result = await f.request('apply', { token: preview.body.token, confirm: true });
  assert.equal(result.status, 409); assert.deepEqual(result.body.committed, ['config']); assert.equal(result.body.outcome, 'partial');
  assert.equal(result.body.error, 'REMOTE_MERGE_FAILED'); noSecrets(result.body);
  assert.equal((await f.request('apply', { token: preview.body.token, confirm: true })).body.error, 'TOKEN_NOT_FOUND');
  assert.equal(f.exchanges.length, 3);
});

test('transport/malformed response failures after apply are outcome unknown, never retry or reuse token', async t => {
  for (const behavior of ['throw', 'oversize', 'garbage']) {
    const f = fixture(t, { exchange({ index }) { if (index === 3) { if (behavior === 'throw') throw new Error(SELECTED);
      return behavior === 'oversize' ? SELECTED.repeat(2000) : SELECTED; } } });
    const preview = await f.preview(), result = await f.request('apply', { token: preview.body.token, confirm: true });
    assert.equal(result.status, 502); assert.equal(result.body.outcome, 'unknown'); noSecrets(result.body);
    assert.equal((await f.request('apply', { token: preview.body.token, confirm: true })).body.error, 'TOKEN_NOT_FOUND');
    assert.equal(f.exchanges.length, 3); assert.equal(f.logs.length, 0);
  }
});

test('caller cancellation cancels preview but admitted apply ignores caller cancellation, never replaying', async t => {
  const started = deferred(), release = deferred(); let applySignal;
  const f = fixture(t, { async exchange({ index, signal }) { if (index === 1) { started.resolve(); await release.promise; signal.throwIfAborted(); } } });
  const abort = new AbortController(), pending = f.preview({}, { signal: abort.signal }); await started.promise; abort.abort(); release.resolve();
  assert.equal((await pending).body.error, 'REQUEST_CANCELLED'); assert.equal(f.exchanges.length, 1);
  const entered = deferred(), proceed = deferred();
  const g = fixture(t, { async exchange({ index, signal }) { if (index === 3) { applySignal = signal; entered.resolve(); await proceed.promise; } } });
  const preview = await g.preview(), caller = new AbortController();
  const applying = g.request('apply', { token: preview.body.token, confirm: true }, { signal: caller.signal });
  await entered.promise; caller.abort(); assert.equal(applySignal.aborted, false); proceed.resolve();
  assert.equal((await applying).status, 200); assert.equal(g.exchanges.length, 3);
});

test('token bounded map and dispose cancellation never authorize new work', async t => {
  const f = fixture(t, { exchange({ index }) { return index % 2 ? JSON.stringify({ ok: true, yamlModulePath: yamlPath,
    expectedHashes: { config: hashDocumentText(remoteConfig()), credentials: hashDocumentText(remoteCredentials()) } }) :
    JSON.stringify({ ok: true, changed: { config: true, credentials: true } }); } });
  for (let i = 0; i < SELECTED_ACTION_LIMITS.maxTokens; i++) assert.equal((await f.preview()).status, 200);
  assert.equal((await f.preview()).body.error, 'BUSY');
  const ready = deferred(), release = deferred();
  const g = fixture(t, { async exchange({ signal }) { ready.resolve(); await release.promise; signal.throwIfAborted(); } });
  const pending = g.preview(); await ready.promise; g.api.dispose(); release.resolve();
  assert.equal((await pending).body.token, undefined); assert.equal((await g.preview()).body.error, 'DISPOSED');
});

test('concurrent operation ceiling rejects ninth preview, disposal aborts all pending probes', async t => {
  const entered = deferred(), gate = deferred(); let count = 0;
  const f = fixture(t, { async exchange({ signal }) { if (++count === SELECTED_ACTION_LIMITS.maxConcurrent) entered.resolve();
    await gate.promise; signal.throwIfAborted(); } });
  const pending = Array.from({ length: SELECTED_ACTION_LIMITS.maxConcurrent }, () => f.preview());
  await entered.promise; assert.equal((await f.preview()).body.error, 'BUSY');
  f.api.dispose(); gate.resolve(); const results = await Promise.all(pending);
  assert.ok(results.every(result => !result.body.token)); assert.equal(f.exchanges.length, SELECTED_ACTION_LIMITS.maxConcurrent);
});

test('identity change during remote preview refuses authorization; malformed remote replies are secret-free', async t => {
  const entered = deferred(), gate = deferred();
  const f = fixture(t, { async exchange({ index }) { if (index === 2) { entered.resolve(); await gate.promise; } } });
  const pending = f.preview(); await entered.promise; f.registry.machines[0].authorityRevision = 'new-authority'; gate.resolve();
  const result = await pending; assert.equal(result.body.error, 'MACHINE_IDENTITY_CHANGED'); assert.equal(result.body.token, undefined);
  for (const response of [SELECTED, SELECTED.repeat(2000), JSON.stringify({ ok: true, yamlModulePath: yamlPath,
    expectedHashes: { config: SELECTED, credentials: hashDocumentText(remoteCredentials()) } }), JSON.stringify({ ok: false, error: SELECTED })]) {
    const g = fixture(t, { exchange() { return response; } });
    const result = await g.preview(); assert.notEqual(result.status, 200); noSecrets(result.body); assert.equal(result.body.token, undefined);
  }
});

test('cancellation bounds stalled body and credential resolution before any probe; no late authorization', async t => {
  const held = deferred(), entered = deferred();
  const f = fixture(t, { resolve() { entered.resolve(); return held.promise; } });
  const controller = new AbortController(), pending = f.preview({}, { signal: controller.signal });
  await entered.promise; controller.abort(); const response = await pending;
  assert.equal(response.body.error, 'REQUEST_CANCELLED'); assert.equal(f.exchanges.length, 0);
  held.resolve({ value: SELECTED });
  const bodyGate = deferred(), abort = new AbortController();
  const req = Readable.from((async function* () { await bodyGate.promise; yield Buffer.from('{}'); })());
  req.method = 'POST'; req.headers = { cookie: 'host_session=admitted' }; req.signal = abort.signal;
  const res = { statusCode: 200, setHeader() {}, end(value) { this.value = JSON.parse(value); } };
  const reading = f.routes.get('/remote-sessions/selected-sync/preview')(req, res);
  abort.abort(); await reading; assert.equal(res.value.error, 'REQUEST_CANCELLED'); bodyGate.resolve();
  assert.equal(f.exchanges.length, 0);
});

test('dispose interrupts admitted apply as unknown, does not replay or leave authorization', async t => {
  const entered = deferred(), gate = deferred();
  const f = fixture(t, { async exchange({ index, signal }) { if (index === 3) { entered.resolve(); await gate.promise; signal.throwIfAborted(); } } });
  const preview = await f.preview(), pending = f.request('apply', { token: preview.body.token, confirm: true });
  await entered.promise; f.api.dispose(); const result = await pending;
  assert.equal(result.status, 502); assert.equal(result.body.outcome, 'unknown'); assert.equal(result.body.tokenConsumed, true);
  gate.resolve(); assert.equal((await f.request('apply', { token: preview.body.token, confirm: true })).body.error, 'DISPOSED');
  assert.equal(f.exchanges.length, 3);
});

test('simultaneous token application admits one writer only', async t => {
  const entered = deferred(), gate = deferred();
  const f = fixture(t, { async exchange({ index }) { if (index === 3) { entered.resolve(); await gate.promise; } } });
  const preview = await f.preview(), pending = f.request('apply', { token: preview.body.token, confirm: true });
  await entered.promise; const replay = await f.request('apply', { token: preview.body.token, confirm: true });
  assert.equal(replay.body.error, 'TOKEN_NOT_FOUND'); gate.resolve(); assert.equal((await pending).status, 200);
  assert.equal(f.exchanges.length, 3);
});

test('generated public probe emits exact hashDocumentText domain; credentials opt-out stays unread and code is static', async () => {
  const mem = memory(), source = generateSelectedSyncProbeProgram(), result = await generated(source, probeInput(), mem);
  assert.equal(result.result.ok, true); assert.deepEqual(result.result.expectedHashes, {
    config: hashDocumentText(mem.files.get(configPath).text), credentials: hashDocumentText(mem.files.get(credentialsPath).text),
  }); noSecrets(result.output); noSecrets(source);
  assert.equal(mem.operations.filter(([op]) => ['writeFile', 'rename'].includes(op)).length, 0);
  const optOut = await generated(source, probeInput([])); assert.equal(optOut.result.expectedHashes.credentials, undefined);
  assert.ok(!optOut.operations.some(([, filename]) => filename === credentialsPath));
  const absentMem = memory({ mutate({ files }) { files.delete(configPath); } });
  const absent = await generated(source, probeInput([]), absentMem); assert.equal(absent.result.expectedHashes.config, hashDocumentText(null));
  const empty = await generated(source, probeInput([]), memory({ configText: '' })); assert.equal(empty.result.expectedHashes.config, hashDocumentText(''));
  assert.notEqual(absent.result.expectedHashes.config, empty.result.expectedHashes.config);
});

test('generated probe/preview refuse symlinks, owner/mode, hardlinks, module escapes and directory ancestry', async () => {
  const mutations = [
    ({ files }) => { files.get(configPath).info.type = 'symlink'; },
    ({ files }) => { files.get(configPath).info.uid = 999; },
    ({ files }) => { files.get(configPath).info.nlink = 2; },
    ({ files }) => { files.get(configPath).info.mode = 0o666; },
    ({ files }) => { files.get(credentialsPath).info.mode = 0o644; },
    ({ files }) => { files.get(`${home}/.dsh`).info.type = 'symlink'; },
    ({ files }) => { files.get(`${install}/lib`).info.mode = 0o777; },
    ({ files }) => { files.get(`${install}/bin/dsh`).target = '/tmp/arbitrary.js'; },
    ({ files }) => { files.get(`${install}/bin/dsh`).target = `${install}/lib/node_modules/arbitrary/bin.js`; },
    ({ files }) => { files.get(yamlPath).info.type = 'symlink'; },
    ({ files }) => { files.get(yamlPath).info.mode = 0o666; },
  ];
  for (const mutate of mutations) {
    const mem = memory({ mutate }), result = await generated(generateSelectedSyncProbeProgram(), probeInput(), mem);
    assert.equal(result.result.ok, false); noSecrets(result.output);
    assert.equal(mem.operations.filter(([op]) => ['writeFile', 'rename'].includes(op)).length, 0);
  }
  for (const yamlResolution of ['/tmp/node_modules/yaml/dist/index.js', `${install}/lib/node_modules/yaml/../evil.js`, `${install}/lib/node_modules/not-yaml/dist/index.js`]) {
    const result = await generated(generateSelectedSyncProbeProgram(), probeInput(), memory({ yamlResolution }));
    assert.equal(result.result.error, 'UNSAFE_INSTALLATION');
  }
});

test('generated preview validates full remote schema privately and prevents missing-target authorization', async () => {
  const source = generateSelectedSyncPreviewProgram(); noSecrets(source);
  for (const configText of ['SECRET: [bad yaml', '- id: llm-pi-ai\n  config: {providers: [], providers: {}}\n', '- id: memories\n  config: {}\n']) {
    const mem = memory({ configText }), result = await generated(source, payload(mem), mem);
    assert.equal(result.result.ok, false); noSecrets(result.output);
    assert.equal(mem.operations.filter(([op]) => ['writeFile', 'rename'].includes(op)).length, 0);
  }
  const mem = memory({ mutate({ files }) { files.delete(credentialsPath); } });
  const result = await generated(source, payload(mem), mem); assert.equal(result.result.error, 'TARGET_CREATION_REQUIRES_OPERATOR');
  assert.equal(mem.files.has(credentialsPath), false);
});

test('generated apply rediscovers installed YAML, rejects changed module before writer and retains partial-commit status', async () => {
  const source = generateSelectedSyncApplyProgram(); noSecrets(source);
  const mem = memory(), request = JSON.parse(payload(mem)); request.yamlModulePath = '/tmp/node_modules/yaml/dist/index.js';
  const unsafe = await generated(source, request, mem); assert.equal(unsafe.result.error, 'UNSAFE_INSTALLATION');
  assert.equal(mem.operations.filter(([op]) => ['writeFile', 'rename'].includes(op)).length, 0);
  const partial = memory({ beforeRename({ target }) { if (target === credentialsPath) throw Object.assign(new Error(SELECTED), { code: 'EACCES' }); } });
  const result = await generated(source, payload(partial), partial);
  assert.deepEqual(result.result.committed, ['config']); assert.equal(result.exitCode, 0); noSecrets(result.output);
});
