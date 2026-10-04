// Shared opt-in boot harness for installed-DSH integration tests. Boots an
// isolated real DSH runtime (deterministic models, no network, no browser),
// optionally composing the native host proxy against another runtime.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcPeer } from '../lib/protocol.js';

export async function startRuntime(t, { delayDescriptors = false, proxyRuntime } = {}) {
  const parent = await fs.realpath('/tmp');
  const root = await fs.realpath(await fs.mkdtemp(join(parent, 'dsh-rte-')));
  const peers = new Set();
  let child;
  let exited;
  let stderr = '';
  const messages = [];
  async function stop() {
    for (const peer of peers) peer.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'stop' });
      let timer;
      const result = await Promise.race([exited.then(() => true), new Promise(done => { timer = setTimeout(() => done(false), 4000); })]);
      clearTimeout(timer);
      if (!result) { child.kill('SIGKILL'); await exited; } // only this test's owned PID
    }
    return exited;
  }
  t.after(async () => {
    await stop();
    assert.equal(await fs.realpath(root), root);
    assert.ok(root.startsWith(parent + sep + 'dsh-rte-'), 'refuse unsafe temp cleanup');
    assert.notEqual(root, parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const name of ['home', 'workspace', 'run', 'tmp', 'os-home', 'config', 'cache']) {
    await fs.mkdir(join(root, name), { mode: 0o700 });
  }
  const env = {
    // Deliberate whitelist: no real provider credentials, NODE_OPTIONS, user
    // profile, proxies or ambient DSH settings can leak into this runtime.
    PATH: process.env.PATH,
    HOME: join(root, 'os-home'), USERPROFILE: join(root, 'os-home'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    DSH_HOME: join(root, 'home'), DSH_TEST_ROOT: root,
    DSH_TEST_RUNTIME_ANCHOR: resolve(process.env.DSH_TEST_RUNTIME_ANCHOR), DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1', ...(delayDescriptors ? { DSH_TEST_DELAY_DESCRIPTORS: '1' } : {}),
    ...(proxyRuntime ? { DSH_TEST_PROXY_SOCKET: join(proxyRuntime.root, 'run', 'agent.sock'), DSH_TEST_PROXY_CWD: join(proxyRuntime.root, 'workspace') } : {}),
  };
  function launch() {
    child = spawn(process.execPath, [
      '--import', fileURLToPath(new URL('./load-dsh.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/runtime-child.mjs', import.meta.url)),
    ], { cwd: join(root, 'workspace'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', data => { stderr += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('message', message => { messages.push(message); });
    exited = new Promise((done, fail) => { child.once('exit', (code, signal) => done({ code, signal })); child.once('error', fail); });
  }
  launch();
  async function message(type, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const index = messages.findIndex(item => item.type === type);
      if (index >= 0) return messages.splice(index, 1)[0];
      const fatal = messages.find(item => item.type === 'fatal');
      if (fatal || child.exitCode !== null || child.signalCode !== null) throw new Error(`Runtime failed awaiting ${type}: ${fatal?.error ?? ''}\n${stderr}`);
      await delay(10);
    }
    throw new Error(`Runtime timed out awaiting ${type}:\n${stderr}\nIPC: ${JSON.stringify(messages)}`);
  }
  await message('booted');
  async function connect() {
    const socketPath = join(root, 'run', 'agent.sock');
    const end = Date.now() + 5000;
    while (true) {
      try { await fs.stat(socketPath); break; } catch (error) {
        if (error.code !== 'ENOENT' || Date.now() >= end) throw new Error(`Companion did not become ready after real boot: ${stderr}`, { cause: error });
        await delay(10);
      }
    }
    const socket = net.createConnection(socketPath);
    await new Promise((done, fail) => { socket.once('connect', done); socket.once('error', fail); });
    const peer = new RpcPeer(socket);
    peers.add(peer);
    return peer;
  }
  return { root, get child() { return child; }, messages, message, connect, stop,
    async restart() { await stop(); messages.length = 0; stderr = ''; launch(); await message('booted'); },
  };
}

/** Minimal request helper over the companion protocol. `request` may be a
 * single value or the positional values array for multi-parameter endpoints. */
export async function call(peer, endpoint, request) {
  const values = Array.isArray(request) ? request : request === undefined ? [] : [request];
  const result = await peer.request('call', { endpoint, values });
  if (!result.ok) {
    const error = new Error(`${endpoint}: ${result.error?.code}`);
    error.code = result.error?.code; error.remote = result.error;
    throw error;
  }
  return result.value;
}

/** Open a pull stream and collect frames until a predicate matches. */
export async function streamUntil(peer, endpoint, request, predicate, { timeoutMs = 20000, idleWaitMs = 1000, onFrame } = {}) {
  const values = Array.isArray(request) ? request : request === undefined ? [] : [request];
  const { streamId } = await peer.request('open', { endpoint, values });
  const frames = [];
  const end = Date.now() + timeoutMs;
  try {
    while (Date.now() < end) {
      const batch = await peer.request('next', { streamId, waitMs: Math.min(idleWaitMs, Math.max(1, end - Date.now())) });
      for (const frame of batch.items) {
        frames.push(frame);
        onFrame?.(frame);
        if (predicate(frame)) return { frames, frame };
      }
      if (batch.done) return { frames, done: true };
    }
    throw new Error(`Expected ${endpoint} frame did not arrive: ${JSON.stringify(frames).slice(0, 2000)}`);
  } finally {
    await peer.request('close', { streamId }, { timeoutMs: 2000 }).catch(() => {});
  }
}

