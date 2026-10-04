// The forwarded remote web interface: a backup configuration surface, opened
// on demand. The local UI remains the primary experience; this launches (or
// reuses) a standard `dsh web` instance on the remote machine — bound to its
// loopback — and forwards it over the same strict SSH connection as a plain
// local link. No remote TCP listener is exposed beyond the operator's SSH.
import { createConnection, createServer } from 'node:net';
import { failure, validateTransport, STRICT_SSH_OPTIONS } from './machine-registry.js';
import { shellQuote } from './ssh-carrier.js';

const WEB_LIMITS = Object.freeze({ logWaitMs: 45000, probeIntervalMs: 1000, freePortTries: 16, remotePortRange: [25000, 65000], tunnelWaitMs: 10000 });

// Tunnel SSH options: the relay options include ClearAllForwardings which
// kills -L; the tunnel needs exactly one local forward.
// Rebuild without ClearAllForwardings: filter pairs (-o, value), not items.
const TUNNEL_SSH_OPTIONS = [];
for (let i = 0; i < STRICT_SSH_OPTIONS.length; i++) {
  if (STRICT_SSH_OPTIONS[i] === '-o' && STRICT_SSH_OPTIONS[i + 1] === 'ClearAllForwardings=yes') { i++; continue; }
  TUNNEL_SSH_OPTIONS.push(STRICT_SSH_OPTIONS[i]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/** Parse the `dsh web` announcement line from a log body. */
export function parseWebAnnouncement(text) {
  const match = /dsh web: (https?:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+))/.exec(String(text ?? ''));
  if (!match) return undefined;
  return { url: match[1], port: Number(match[2]), token: match[3] };
}

/**
 * Create the web-forward facade. `exec` is the strict-SSH executor (used for
 * BOTH the remote commands AND the tunnel: ssh -f forks to background after
 * auth, so the exec returns and the tunnel persists).
 */
export function createRemoteWeb({ exec }) {
  if (typeof exec !== 'function') throw failure('SUBPROCESS_UNAVAILABLE', 503);
  const tunnels = new Map();

  async function alive(machine, port, signal) {
    const result = await exec(machine, `curl -s -o /dev/null http://127.0.0.1:${port}/ 2>/dev/null && printf ALIVE || printf DEAD`, { signal }).catch(() => ({ code: 1, stdout: 'DEAD' }));
    return result.stdout.trim() === 'ALIVE';
  }

  async function cliPath(machine, signal) {
    if (machine.remoteCli) {
      const resolved = await exec(machine, `if [ -x ${shellQuote(machine.remoteCli)} ]; then printf '%s' ${shellQuote(machine.remoteCli)}; fi`, { signal });
      const found = resolved.stdout.trim();
      if (found) return found;
    }
    // The setup facade's probe is not passed here; the explicit config is enough.
    return '';
  }

  async function remoteFreePort(machine, signal) {
    const [min, max] = WEB_LIMITS.remotePortRange;
    for (let attempt = 0; attempt < 8; attempt++) {
      const port = min + Math.floor(Math.random() * (max - min));
      if (!(await alive(machine, port, signal))) return port;
    }
    throw failure('REMOTE_PORT_UNAVAILABLE', 502);
  }

  function tunnelAlive(localPort) {
    return new Promise(resolve => {
      const probe = createConnection({ host: '127.0.0.1', port: localPort, timeout: 1000 }, () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
      probe.once('timeout', () => { probe.destroy(); resolve(false); });
    });
  }

  return {
    tunnels,
    /** Open (or reuse) the remote web interface and return a local URL. */
    async open(machine, signal) {
      // Reuse an existing tunnel.
      const existing = tunnels.get(machine.name);
      if (existing && await tunnelAlive(existing.port)) return { url: existing.url, reused: true };

      const transport = validateTransport(machine);
      const log = machine.runtimeDirectory ? `${machine.runtimeDirectory}/web.log` : `${machine.remoteHome ?? '"$HOME"/.dsh'}/web.log`;

      // Reuse a still-alive web instance; otherwise kill stale and start one.
      const prior = await exec(machine, `tail -5 ${shellQuote(log)} 2>/dev/null`, { signal }).catch(() => ({ code: 1, stdout: '' }));
      let announcement = parseWebAnnouncement(prior.stdout);
      if (announcement && !(await alive(machine, announcement.port, signal))) announcement = undefined;

      if (!announcement) {
        // Kill every existing dsh web process: duplicates drain ports.
        await exec(machine, `pkill -f 'lib/bin.js web' 2>/dev/null || true; sleep 1`, { signal }).catch(() => {});
        const cli = await cliPath(machine, signal);
        if (!cli) throw failure('REMOTE_CLI_MISSING', 502);
        const remotePort = await remoteFreePort(machine, signal);
        const inner = `exec env DSH_HOME=${machine.remoteHome ? shellQuote(machine.remoteHome) : '"$HOME"/.dsh'} ${shellQuote(machine.remoteNode)} ${shellQuote(cli)} web --no-open --port ${remotePort}`;
        const launcher = `> ${shellQuote(log)}; setsid sh -c ${shellQuote(inner)} </dev/null >>${shellQuote(log)} 2>&1 &`;
        await exec(machine, launcher, { signal, timeoutMs: 30000 });
        const end = Date.now() + WEB_LIMITS.logWaitMs;
        while (Date.now() < end) {
          signal?.throwIfAborted();
          const result = await exec(machine, `cat ${shellQuote(log)} 2>/dev/null`, { signal }).catch(() => ({ code: 1, stdout: '' }));
          announcement = parseWebAnnouncement(result.stdout);
          if (announcement) break;
          await new Promise(done => setTimeout(done, WEB_LIMITS.probeIntervalMs));
        }
        if (!announcement) throw failure('WEB_START_TIMEOUT', 504);
      }

      // Local forward: raw child_process spawn (the DSH subprocess service is
      // for managed remote exec, not for persistent local SSH tunnels).
      let localPort;
      for (let attempt = 0; attempt < WEB_LIMITS.freePortTries; attempt++) {
        try { localPort = await freePort(); break; } catch (error) { if (attempt === WEB_LIMITS.freePortTries - 1) throw failure('LOCAL_PORT_UNAVAILABLE', 502); }
      }
      const tunnelArgs = [...TUNNEL_SSH_OPTIONS, ...transport.ssh, '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:${announcement.port}`];
      const { spawn: rawSpawn } = await import('node:child_process');
      let tunnelErr = '';
      console.error('WEB-TUNNEL-SPAWN:', transport.command, tunnelArgs.join(' '));
      const child = rawSpawn(transport.command, tunnelArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
      child.once('exit', (code, sig) => console.error('WEB-TUNNEL-EXIT:', code, sig));
      child.once('error', err => console.error('WEB-TUNNEL-ERROR:', err.message));
      child.stderr?.on('data', chunk => { tunnelErr += chunk.toString(); });
      const tunnelDone = new Promise(resolve => { child.once('exit', code => resolve(code)); child.once('error', () => resolve(-1)); });
      child.killRef = () => { try { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000).unref(); } catch {} };

      // Wait for the tunnel to accept connections or the child to die.
      const deadline = Date.now() + WEB_LIMITS.tunnelWaitMs;
      let ready = false;
      while (Date.now() < deadline) {
        const exited = await Promise.race([tunnelAlive(localPort).then(ok => ok ? 'ready' : 'wait'), tunnelDone.then(code => `exited:${code}`)]);
        if (exited === 'ready') { ready = true; break; }
        if (exited.startsWith('exited:')) {
          const error = failure('WEB_FORWARD_FAILED', 502);
          if (tunnelErr) error.message = tunnelErr.slice(0, 200);
          throw error;
        }
        await new Promise(done => setTimeout(done, 300));
      }
      if (!ready) {
        child.killRef();
        const error = failure('WEB_FORWARD_FAILED', 502);
        if (tunnelErr) error.message = tunnelErr.slice(0, 200);
        throw error;
      }

      const url = `http://127.0.0.1:${localPort}/?token=${announcement.token}`;
      tunnels.set(machine.name, { url, port: localPort, child: { killRef: child.killRef, done: tunnelDone } });
      return { url, reused: false };
    },
    /** Close the local tunnel for one machine; the remote instance keeps serving. */
    async close(machine) {
      const entry = tunnels.get(machine.name);
      if (!entry) return { closed: false };
      tunnels.delete(machine.name);
      // The -f tunnel runs as a background SSH process; kill it by port.
      entry.child?.killRef?.();
      return { closed: true };
    },
    async dispose() {
      for (const [name, entry] of tunnels) await this.close({ name });
      tunnels.clear();
    },
  };
}
