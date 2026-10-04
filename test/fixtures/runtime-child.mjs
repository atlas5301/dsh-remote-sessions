// An owned, isolated process hosting the ACTUAL installed DSH plugin runtime.
// No GUI/webserver, credentials inherited from the host, dependency installs,
// private DSH imports or edits to the installed runtime are involved.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';
import net from 'node:net';
import { once } from 'node:events';
import { RpcPeer } from '../../lib/protocol.js';
import { installNativeHost, inject as nativeInject } from '../../lib/native-host.js';
import { scopeTarget } from '@deepseek-ai/dsh-scope';

const root = await fs.realpath(process.env.DSH_TEST_ROOT);
assert.equal(root, resolve(process.env.DSH_TEST_ROOT));
assert.equal(process.cwd(), join(root, 'workspace'));
assert.equal(process.env.DSH_HOME, join(root, 'home'));
assert.ok(root.startsWith((await fs.realpath('/tmp')) + sep + 'dsh-rte-'));
const require = createRequire(process.env.DSH_TEST_RUNTIME_ANCHOR);
// The public typert-loader also uses CJS require.resolve relative to the
// composition root. The test-only ESM hook cannot redirect that lookup. This
// temp-local link is used only for resolving existing dependencies; no installed
// dependency files are written and nothing is installed.
try { await fs.symlink(join(dirname(process.env.DSH_TEST_RUNTIME_ANCHOR), 'node_modules'), join(root, 'node_modules'), 'dir'); }
catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await fs.readlink(join(root, 'node_modules')), join(dirname(process.env.DSH_TEST_RUNTIME_ANCHOR), 'node_modules')); }
const base = loadOverlayPatches('runtime-e2e', join(dirname(require.resolve('@deepseek-ai/dsh-base/package.json')), 'cordis.patch.yml'));
// Keep the actual base composition, disabling nonessential product/model/tool
// startup. In particular no real provider, title model, telemetry or session-log
// exporter may run, even if future defaults enable them in the installed base.
const enabled = new Set([
  'timer', 'llm', 'session', 'typert', 'typert-loader', 'typert-gateway',
  'session-title', 'agent', 'agent-default-model', 'credentials',
  'session-persistence-jsonl', 'attachment-local', 'session-query-sqlite',
  'session-projection', 'storage', 'storage-json', 'storage-domain',
  'session-projection-cache', 'approval', 'commands', 'sandbox-policy', 'user-questions',
  'tools', 'system-prompt', 'agent-loop', 'fs-sandbox', 'session-checkpoint-policy',
  'subprocess', 'fs-observation-policy',
]);
const patches = [
  ...base,
  ...base.flatMap(patch => patch.insert ?? []).filter(entry => !enabled.has(entry.id)).map(entry => ({ id: entry.id, disabled: true })),
  { id: 'agent-default-model', config: { provider: 'runtime-e2e', model: 'deterministic' } },
  { id: 'session-persistence-jsonl', config: { root: join(root, 'home', 'sessions'), compression: 'none' } },
  { id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'first-search' } },
  { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: process.cwd() } },
  { id: 'approval', config: { policy: 'ask' } },
  ...(process.env.DSH_TEST_DELAY_DESCRIPTORS ? [{ id: 'typert-loader', inject: ['runtimeE2eDescriptorGate'] }] : []),
  { insert: [
    { id: 'runtime-e2e-model', name: fileURLToPath(new URL('./mock-model.js', import.meta.url)) },
    { id: 'connection', name: '@deepseek-ai/dsh-client-connection' },
    { id: 'file-upload', name: '@deepseek-ai/dsh-client-file-upload' },
    { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
    { id: 'file-reference-local', name: '@deepseek-ai/dsh-file-reference-local' },
    { id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller', config: { nativeOpen: false } },
    { id: 'workspace-controller', name: '@deepseek-ai/dsh-api-workspace-controller' },
    { id: 'workspace-files', name: '@deepseek-ai/dsh-api-workspace-files' },
    { id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller', config: { unattendedTimeoutMs: 0, activityPollIntervalMs: 30000, cleanupRetryMs: 1000 } },
    { id: 'api-remotes', name: '@deepseek-ai/dsh-api-remotes' },
    { id: 'remote-sessions-companion', name: fileURLToPath(new URL('../../lib/companion.js', import.meta.url)), config: { runtimeDirectory: join(root, 'run') } },
  ] },
];
const configPath = join(root, 'cordis.json');
try { await fs.writeFile(configPath, '[]\n', { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await fs.readFile(configPath, 'utf8'), '[]\n'); }
// Fails closed if a supposedly offline composition attempts model/telemetry HTTP.
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network fetch forbidden in runtime-e2e'); };
let ctx;
let stopping;
async function stop() {
  return stopping ??= (async () => {
    await ctx?.fiber.dispose();
    assert.equal(networkAttempts, 0, 'offline runtime must never attempt HTTP fetch');
    process.exit(0);
  })();
}
process.on('message', message => { if (message?.type === 'stop') stop().catch(fail); });
process.on('SIGTERM', () => { stop().catch(fail); });
process.on('disconnect', () => { stop().catch(fail); });
function fail(error) {
  process.send?.({ type: 'fatal', error: inspect(error, { depth: 8 }) });
  process.stderr.write(inspect(error, { depth: 8 }) + '\n');
  process.exit(1);
}
try {
  ctx = await boot('runtime-e2e', configPath, patches, context => {
    context.logger.exporter({ levels: { default: 2 }, export: record => {
      if (record.type === 'error' || record.type === 'warn') process.stderr.write(inspect(record.args) + '\n');
    } });
  }, pathToFileURL(process.env.DSH_TEST_RUNTIME_ANCHOR).href);
  if (process.env.DSH_TEST_DELAY_DESCRIPTORS) {
    assert.ok(ctx.sessionController, 'controller service must precede delayed descriptors');
    assert.equal(ctx.typert.local.get('session/create'), undefined);
    await assert.rejects(fs.stat(join(root, 'run', 'agent.sock')), { code: 'ENOENT' });
    ctx.provide('runtimeE2eDescriptorGate', true);
    await ctx.loader.await();
    process.send?.({ type: 'descriptors-released' });
  }
  ctx.on('agent/error', ({ error }) => { process.send?.({ type: 'agent-error', error: inspect(error, { depth: 8 }) }); });
  assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), ['runtime-e2e']);
  assert.ok(ctx.agentLoop, 'installed AgentLoop service is required');
  assert.ok(!ctx.get('webServer'), 'the companion must not boot a browser server');
  const endpoints = ['session/create', 'session/list', 'session/prompt', 'session/follow', 'session/page', 'session/control',
    'workspaceFiles/list', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/stat', 'workspaceFiles/changes',
    'terminal/environment', 'terminal/shells', 'terminal/list', 'terminal/create', 'terminal/follow', 'terminal/retain', 'terminal/write', 'terminal/resize', 'terminal/rename', 'terminal/close'];
  const deadline = Date.now() + 5000;
  while (!endpoints.every(endpoint => ctx.typert.local.get(endpoint)) && Date.now() < deadline) await delay(10);
  assert.ok(endpoints.every(endpoint => ctx.typert.local.get(endpoint)), 'async Typert descriptors must bind: ' + endpoints.filter(endpoint => !ctx.typert.local.get(endpoint)).join(','));
  if (process.env.DSH_TEST_PROXY_SOCKET) {
    const remoteCwd = process.env.DSH_TEST_PROXY_CWD;
    const localPath = join(root, 'remote-workspace');
    await fs.mkdir(localPath, { recursive: true, mode: 0o700 });
    assert.deepEqual(await fs.readdir(localPath), [], 'standalone fixture has no dsh-remote metadata');
    const config = { workspaces: [{ localPath, target: 'resident-fixture', remotePath: remoteCwd }] };
    const relayPeers = new Set();
    const options = { selectedActions: false, registry: { machines: [{ name: 'resident-fixture', ssh: ['fixture.invalid'], socketPath: process.env.DSH_TEST_PROXY_SOCKET }] },
      transport: { async connect() {
        const socket = net.connect(process.env.DSH_TEST_PROXY_SOCKET); await once(socket, 'connect');
        const peer = new RpcPeer(socket), hello = await peer.request('hello', { protocol: 'dsh-remote-sessions/1' });
        relayPeers.add(peer); peer.done.finally(() => relayPeers.delete(peer)).catch(() => {});
        return { peer, hello, close: () => peer.close() };
      } } };
    // Cordis enforces declared injections; do not let root-context tests hide
    // undeclared service reads in the production plugin. subprocess is the
    // setup facade's exec seam. settings stays excluded: this composition has
    // no profileContext, the base row disables it, and persistence must degrade
    // gracefully (SETTINGS_UNAVAILABLE) exactly like any minimal profile.
    const dependencies = nativeInject.filter(key => !['settings'].includes(key));
    let resolveInstallation, rejectInstallation;
    const installed = new Promise((resolve, reject) => { resolveInstallation = resolve; rejectInstallation = reject; });
    ctx.plugin({ name: 'native-host-fixture', inject: dependencies, async apply(owner) {
      try { resolveInstallation({ owner, host: await installNativeHost(owner, config, options) }); }
      catch (error) { rejectInstallation(error); throw error; }
    } });
    const installation = await installed; let host = installation.host;
    process.on('message', async message => {
      if (message.type !== 'reload-native-proxy') return;
      try {
        await host.dispose(); host = await installNativeHost(installation.owner, config, options);
        process.send?.({ type: 'native-proxy-reloaded', count: host.bindings.size });
      } catch (error) { fail(error); }
    });
    process.on('message', message => {
      if (message.type === 'drop-native-relay') {
        for (const peer of relayPeers) peer.close();
        setImmediate(() => process.send?.({ type: 'native-relay-dropped' }));
      }
      if (message.type === 'native-binary-upload') {
        const fetcher = ctx.connection.createSharedFetchHandler('/api');
        fetcher.fetch(new Request('http://fixture/api/session/uploadFileBinary?sessionId=' + encodeURIComponent(message.sessionId) + '&name=native-binary.dat', {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(500003, 0x6b),
        })).then(response => response.json()).then(result => process.send?.({ type: 'native-binary-uploaded', result })).catch(fail);
      }
      if (message.type === 'assert-no-local-agent') {
        try { assert.equal(ctx.agents.list().length, 0); assert.equal(ctx.sessions.list().length, host.bindings.size); for (const s of ctx.sessions.list()) assert.equal(s.snapshotEvents().length, 0); process.send?.({ type: 'no-local-agent' }); }
        catch (error) { fail(error); }
      }
    });
  }
  process.on('message', message => {
    if (message.type === 'native-timed-question') {
      const agent = ctx.agents.get(message.sessionId);
      ctx.userQuestions.askTimed({ agent, questions: [{ id: 'timed', question: 'Timed fixture?', options: [{ label: 'Yes' }] }] }, 'native-timed-call', 10000)
        .then(answer => process.send?.({ type: 'native-timed-answered', answer })).catch(fail);
      return;
    }
    if (message.type === 'native-question') {
      const agent = ctx.agents.get(message.sessionId);
      ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', { agent, questions: [{ id: 'choice', question: 'Fixture choice?', options: [{ label: 'Yes' }] }] }, () => Promise.reject(new Error('No answerer')))
        .then(answer => process.send?.({ type: 'native-question-answered', answer })).catch(fail);
      return;
    }
    if (message.type !== 'assert-upload-bytes') return;
    (async () => {
      const chunks = [];
      for await (const part of ctx.attachments.readFileStream(message.file)) chunks.push(Buffer.from(part));
      assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(500003, 0x6b));
      process.send?.({ type: 'upload-bytes-verified' });
    })().catch(fail);
  });
  process.send?.({ type: 'booted', pid: process.pid, endpoints });
} catch (error) { fail(error); }
