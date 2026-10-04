import net from 'node:net';
import { promises as fs } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RpcPeer, fault } from './protocol.js';

// The OS user is the remote operator. A private Unix socket avoids any TCP or
// browser credential dependency; SSH authenticates the relay as that same user.
export async function privateDirectory(path) {
  const absolute = resolve(path);
  let current = '/';
  for (const part of absolute.split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid?.()].includes(stat.uid) || ((stat.mode & 0o022) && !(stat.mode & 0o1000))) throw fault('UNSAFE_RUNTIME_DIRECTORY');
  }
  const stat = await fs.lstat(absolute);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw fault('UNSAFE_RUNTIME_DIRECTORY');
  return absolute;
}

export async function runtimeIdentity(directory) {
  const root = await privateDirectory(directory), file = join(root, 'runtime-id');
  try {
    const h = await fs.open(file, 'wx', 0o600);
    try { await h.writeFile(randomUUID() + '\n'); await h.sync(); } finally { await h.close(); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 128) throw fault('UNSAFE_RUNTIME_ID');
  // Same-uid malicious writers are outside the Unix-user trust boundary.
  const id = (await fs.readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw fault('UNSAFE_RUNTIME_ID');
  return id;
}

export async function listenCompanion({ socketPath, adapter, maxClients = 16, idleMs = 120000 }) {
  const path = resolve(socketPath);
  if (Buffer.byteLength(path) > 100) throw fault('SOCKET_PATH_TOO_LONG');
  await privateDirectory(dirname(path));
  // Never unlink an existing socket: it may own a running agent runtime.
  try { await fs.lstat(path); throw fault('SOCKET_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const peers = new Set();
  const server = net.createServer(socket => {
    if (peers.size >= maxClients) { socket.destroy(); return; }
    const client = adapter.client();
    // A black-holed SSH connection may never deliver EOF. Reclaim its observer
    // capacity after silence; normal 25s polls keep the transport alive.
    socket.setTimeout(idleMs, () => socket.destroy());
    const peer = new RpcPeer(socket, { handle: client.handle.bind(client) });
    peers.add(peer);
    peer.done.finally(async () => { peers.delete(peer); await client.dispose(); }).catch(() => {});
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(path, () => { server.off('error', fail); ok(); }); });
  await fs.chmod(path, 0o600);
  server.on('error', () => { for (const peer of peers) peer.close(fault('LISTENER_FAILED')); });
  let closing;
  return { path, close() {
    return closing ??= (async () => {
      for (const peer of peers) peer.close();
      await new Promise(resolveClose => server.close(resolveClose));
      // Node removes its own Unix socket on close. No computed-path deletion.
    })();
  } };
}
