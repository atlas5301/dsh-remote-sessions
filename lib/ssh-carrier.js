import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { RpcPeer, PROTOCOL, fault } from './protocol.js';
import { validateTransport, STRICT_SSH_OPTIONS } from './machine-registry.js';

export function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
// Static relay code; it opens an EXISTING socket and never starts/stops DSH.
export const RELAY = `const net=require('node:net');const fs=require('node:fs');const p=require('node:path');const s=process.argv[1];let c='/';for(const v of p.dirname(s).split('/').filter(Boolean)){c=p.join(c,v);const t=fs.lstatSync(c);if(t.isSymbolicLink()||!t.isDirectory()||![0,process.getuid()].includes(t.uid)||((t.mode&18)&&!(t.mode&512)))process.exit(71)}const d=fs.statSync(p.dirname(s)),t=fs.lstatSync(s);if(d.uid!==process.getuid()||(d.mode&63)||!t.isSocket()||t.uid!==process.getuid()||(t.mode&63))process.exit(72);const n=net.connect(s);n.on('error',()=>process.exit(73));n.on('connect',()=>{process.stdin.pipe(n);n.pipe(process.stdout)});process.stdin.on('end',()=>n.end());process.stdout.on('error',()=>n.destroy());n.on('close',()=>process.exit(0));`;

export function validateSsh(machine) {
  if (machine.disabled || machine.migrationRequired) throw fault('MIGRATION_REQUIRED');
  const transport = validateTransport(machine);
  const socket = machine.socketPath;
  if (typeof socket !== 'string' || !socket.startsWith('/') || Buffer.byteLength(socket) > 100 || socket.includes('\0') || socket.includes('\n') || socket.split('/').some(p => p === '..' || p === '.')) throw fault('INVALID_SOCKET_PATH');
  if (typeof machine.remoteNode !== 'string' || !machine.remoteNode.startsWith('/') || /[\0\r\n]/.test(machine.remoteNode)) throw fault('INVALID_REMOTE_NODE');
  // OpenSSH options are trusted operator configuration, not agent-supplied argv.
  // Force no PTY, no forwarding and strict host verification ahead of supplied options.
  return [...STRICT_SSH_OPTIONS, ...transport.ssh,
    shellQuote(machine.remoteNode) + ' -e ' + shellQuote(RELAY) + ' ' + shellQuote(socket)];
}

export async function connectSsh(machine, { signal, spawnProcess = spawn } = {}) {
  signal?.throwIfAborted();
  const argv = validateSsh(machine);
  const transport = validateTransport(machine);
  const child = spawnProcess(transport.command, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...transport.env } });
  // SSH stderr is intentionally not forwarded: authentication paths/commands may be private.
  child.stderr.resume();
  const stream = Duplex.from({ writable: child.stdin, readable: child.stdout });
  const peer = new RpcPeer(stream);
  child.on('error', () => peer.close(fault('SSH_FAILED')));
  child.on('exit', () => peer.close(fault('SSH_DISCONNECTED')));
  const close = () => { peer.close(); child.kill('SIGTERM'); };
  const abort = () => close(); signal?.addEventListener('abort', abort, { once: true });
  peer.done.finally(() => { child.kill('SIGTERM'); }).catch(() => {});
  try {
    const hello = await peer.request('hello', { protocol: PROTOCOL }, { signal, timeoutMs: 20000 });
    if (hello?.protocol !== PROTOCOL || typeof hello.runtimeId !== 'string' || typeof hello.instanceId !== 'string' || !Array.isArray(hello.capabilities)) throw fault('INCOMPATIBLE_PROTOCOL');
    return { peer, hello, close };
  } catch (error) { close(); throw error; }
  finally { signal?.removeEventListener('abort', abort); }
}
