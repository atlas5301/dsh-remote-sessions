// Dev-only harness: exercise the remote-setup provisioning path without the
// DSH app, so Windows path bugs can be reproduced from a terminal.
// Usage: node scripts/win-harness.mjs [machine-name] [ssh-target]
import { spawn as nodeSpawn } from 'node:child_process';
import { createRemoteExec, createRemoteSetup } from '../lib/remote-setup.js';
import { createRemoteWeb } from '../lib/remote-web.js';
import { syncModelsToRemote } from '../lib/model-sync.js';

function adapter({ argv, cwd, env }) {
  const child = nodeSpawn(argv[0], argv.slice(1), {
    cwd, env: { ...process.env, ...env }, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const done = new Promise(resolve => {
    child.on('exit', (code, signal) => resolve({ exitCode: code ?? -1, signal }));
    child.on('error', () => resolve({ exitCode: -1 }));
  });
  return { stdout: child.stdout, stderr: child.stderr, stdin: child.stdin, done, terminate: () => child.kill() };
}

const name = process.argv[2] ?? 'e5';
const sshTarget = process.argv[3] ?? 'e5';
const exec = createRemoteExec(null, { spawn: { spawn: adapter } });
const setup = createRemoteSetup({
  exec,
  spawn: adapter,
  readEnvironment: async () => ({ providers: null, defaultModel: null, credentials: [] }),
  listRunning: async () => [],
});

const machine = {
  name,
  ssh: [sshTarget],
  command: 'ssh',
  env: {},
  remoteNode: '/home/zhainan/.local/share/mise/shims/node',
  remoteCli: process.env.DSH_RS_CLI ?? undefined,
  socketPath: `/home/zhainan/.dsh/rs-runtime/${name}/agent.sock`,
  runtimeDirectory: `/home/zhainan/.dsh/rs-runtime/${name}`,
  remoteCwd: '/home/zhainan',
  residentProfile: `rs-${name}`,
  autoSetup: true,
  npmInstall: true,
  authorityRevision: '1',
};

try {
  if (process.argv.includes('--probe')) {
    const probe = await setup.probe(machine, new AbortController().signal);
    console.log('PROBE', JSON.stringify(probe, null, 2));
  } else if (process.argv.includes('--sync')) {
    const result = await setup.sync(machine, new AbortController().signal);
    console.log('SYNC', JSON.stringify(result, null, 2));
  } else if (process.argv.includes('--models')) {
    const signal = new AbortController().signal;
    const probe = await setup.probe(machine, signal);
    const result = await syncModelsToRemote({
      exec, machine, probe,
      profileDir: `/home/zhainan/.dsh/profiles/${process.env.DSH_RS_PROFILE ?? 'remote-resident'}`,
      localProfileDir: `${process.env.USERPROFILE}\\.dsh\\profiles\\desktop`,
      signal,
    });
    console.log('MODELS', JSON.stringify(result));
  } else if (process.argv.includes('--web')) {
    const web = createRemoteWeb({ exec });
    const result = await web.open(machine, new AbortController().signal, null);
    console.log('WEB', JSON.stringify(result, null, 2));
    await web.dispose();
  } else {
    const result = await setup.ensure(machine, new AbortController().signal);
    console.log('OK', JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error('FAIL', error?.code ?? '', error?.message ?? error);
  process.exitCode = 1;
}
