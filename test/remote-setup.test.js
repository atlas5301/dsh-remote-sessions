// Pure lifecycle tests for automatic remote setup. No SSH, no network, no
// filesystem effects: the strict-SSH executor is scripted per call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMachine } from '../lib/machine-registry.js';
import { machineIdentity } from '../lib/authority.js';
import {
  compatibleDshVersion, probeScript, parseProbe, startScript, stopScript,
  createRemoteSetup, realDshHome, homeSegment, resolveCliScript,
} from '../lib/remote-setup.js';
import { mapWorkspacePath, decodeTagged } from '../lib/native-services.js';

function machine(overrides = {}) {
  return normalizeMachine({ name: 'build-host', ssh: ['user@build-host'],
    remoteNode: '/usr/bin/node', socketPath: '/home/user/.dsh/rs-runtime/agent.sock',
    remoteCwd: '/srv/project', ...overrides });
}
function bundleInfo(version = '0.7.0') {
  return { archive: Buffer.from('tarball'), version, sha256: 'deadbeef' };
}
/** Scripted executor: routes by matching distinctive script fragments. */
function scriptedExec(script = []) {
  const calls = [];
  const usage = new Map();
  const exec = async (target, text, { input } = {}) => {
    calls.push({ script: text, input });
    for (const entry of script) {
      const used = usage.get(entry) ?? 0;
      if (used >= (entry.times ?? 1) || !entry.match.test(text)) continue;
      usage.set(entry, used + 1);
      if (typeof entry.reply === 'function') return entry.reply(text, input);
      return { code: entry.code ?? 0, stdout: entry.stdout ?? '' };
    }
    throw new Error('unexpected remote script: ' + text.slice(0, 200));
  };
  return { exec, calls };
}
const probeReply = ({ home = '/home/user/.dsh', node = 'v22.3.0', socket = false, marker = null, pid, cliBin = null, npm = true } = {}) =>
  ['HOME:' + home, 'NODE:' + node, 'SOCKET:' + (socket ? 'yes' : 'no'), marker ? 'MARKER:' + JSON.stringify(marker) : 'MARKER:none',
    pid ? 'PID:' + pid : '', cliBin ? 'CLIBIN:' + cliBin + '\nCLIROOT:' + cliBin.replace(/\/lib\/bin\.js$/, '') : 'CLIBIN:none',
    'NPM:' + (npm === false || npm === 'no' ? 'none' : typeof npm === 'string' ? npm : '/usr/bin/npm'), 'END'].filter(Boolean).join('\n') + '\n';

test('dsh runtime compatibility follows the tested 0.2 line', () => {
  assert.equal(compatibleDshVersion('0.2.0-rc.2'), true);
  assert.equal(compatibleDshVersion('0.2.0-rc.5'), true);
  assert.equal(compatibleDshVersion('0.2.0'), true);
  assert.equal(compatibleDshVersion('0.2.3'), true);
  assert.equal(compatibleDshVersion('0.2.0-rc.1'), false);
  assert.equal(compatibleDshVersion('0.1.9'), false);
  assert.equal(compatibleDshVersion('0.3.0'), false);
  assert.equal(compatibleDshVersion(undefined), false);
});

test('machine setup fields stay outside the execution authority', () => {
  const base = machine();
  const withSetup = machine({ autoSetup: false, remoteCli: '/usr/local/bin/dsh', dshVersion: '0.2.0-rc.2', npmInstall: false, residentProfile: 'other-name' });
  assert.equal(machineIdentity(base), machineIdentity(withSetup), 'setup-only fields must not change authority');
  assert.equal(withSetup.autoSetup, false);
  assert.equal(withSetup.npmInstall, false);
  assert.equal(withSetup.residentProfile, 'other-name');
  assert.equal(withSetup.runtimeDirectory, '/home/user/.dsh/rs-runtime');
  assert.equal(withSetup.dshVersion, '0.2.0-rc.2');
  assert.throws(() => machine({ residentProfile: 'Desktop' }), /INVALID_RESIDENT_PROFILE/);
  assert.throws(() => machine({ remoteCli: 'dsh' }), /INVALID_REMOTE_CLI/);
  assert.throws(() => machine({ autoSetup: 'yes' }), /INVALID_AUTO_SETUP/);
});

test('probe round-trips the resident marker and CLI discovery', () => {
  const target = machine();
  const script = probeScript(target);
  assert.ok(script.includes(`printf 'HOME:%s\\n' "$HOME"/.dsh`), 'default home expands remotely');
  const probe = parseProbe(probeReply({ home: '/home/o', node: 'v24.1.0', socket: true, pid: 4242, cliBin: '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    marker: { version: 1, bundleVersion: '0.6.0' } }));
  assert.equal(probe.home, '/home/o');
  assert.equal(probe.node, 'v24.1.0');
  assert.equal(probe.socket, true);
  assert.equal(probe.pid, 4242);
  assert.equal(probe.cliBin, '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
  assert.equal(probe.cliRoot, '/usr/lib/node_modules/@deepseek-ai/dsh');
  assert.equal(probe.marker.bundleVersion, '0.6.0');
  assert.equal(probe.npm, '/usr/bin/npm', 'the probe reports the npm path for the sync operation');
  assert.throws(() => parseProbe('garbage'), /PROBE_FAILED/);
});

import { execFileSync } from 'node:child_process';
test('start and stop scripts quote every configured path and never rm the socket', () => {
  const target = machine({ remoteHome: '/srv/dsh-data' });
  const start = startScript(target, '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
  // Every generated script must be syntactically valid POSIX sh; `&;` style
  // mistakes abort the entire remote script before any line runs.
  for (const script of [start, stopScript(machine()), probeScript(machine())]) {
    assert.doesNotThrow(() => execFileSync('sh', ['-n'], { input: script }), 'generated script must pass sh -n');
  }
  assert.ok(start.includes('setsid'), 'detached start preferred');
  assert.ok(start.includes('nohup'), 'nohup fallback present');
  assert.ok(start.includes('DSH_HOME='), 'the resident home is explicit');
  assert.ok(start.includes('/srv/dsh-data') && start.includes('/usr/bin/node'), 'configured paths are carried');
  assert.ok(start.includes('--profile'), 'the profile switch is present');
  assert.ok(!start.includes('rm '), 'the start script never removes anything');
  const stopped = stopScript(machine());
  assert.ok(stopped.includes(`kill "$p"`) && !stopped.includes('kill -9 $(cat'), 'stops only the recorded pid');
  assert.ok(!stopped.includes('rm -rf'), 'stop only removes the pid file via rm -f');
});

test('ensure reuses a serving resident and reports bundle upgrades', async () => {
  const { exec } = scriptedExec([
    { match: /printf 'HOME/, reply: () => ({ code: 0, stdout: probeReply({ socket: true, marker: { bundleVersion: '0.6.0' } }) }) },
  ]);
  const setup = createRemoteSetup({ exec, bundle: async () => bundleInfo('0.7.0') });
  const outcome = await setup.ensure(machine(), null);
  assert.equal(outcome.outcome, 'reused');
  assert.equal(outcome.upgradeAvailable, true);
});

test('ensure starts a provisioned-but-stopped resident without rewriting files', async () => {
  const cliBin = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const { exec, calls } = scriptedExec([
    { match: /printf 'HOME/, reply: () => ({ code: 0, stdout: probeReply({ marker: { bundleVersion: '0.7.0', cliBin } }) }) },
    { match: /kill "\$p"/, code: 0 },
    { match: /if \[ -x/, stdout: cliBin },
    // The drift check reads the resident profile patch: a consistent resident
    // (its remote-resident runtimeDirectory matches the machine config) starts
    // without re-provisioning.
    { match: /cat .*profiles.*cordis\.patch\.yml' 2>\/dev\/null/, stdout: '- id: remote-resident\n  config:\n    runtimeDirectory: "/home/user/.dsh/rs-runtime"\n' },
    { match: /setsid|nohup/, code: 0 },
  ]);
  const setup = createRemoteSetup({ exec, bundle: async () => bundleInfo('0.7.0') });
  const outcome = await setup.ensure(machine(), null);
  assert.equal(outcome.outcome, 'started');
  assert.ok(calls.some(call => call.script.includes('kill "$p"')), 'a recorded but hung prior PID is stopped before restart');
  assert.equal(calls.filter(call => call.script.includes('cat >')).length, 0, 'no files are rewritten when reusing a resident');
  assert.equal(calls.filter(call => call.script.includes('tar -xzf')).length, 0, 'no bundle upload when reusing a resident');
});

test('ensure provisions a missing resident end to end', async () => {
  const cliBin = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const { exec, calls } = scriptedExec([
    { match: /printf 'HOME/, reply: () => ({ code: 0, stdout: probeReply({ cliBin }) }) },
    { match: /tar -xzf/, code: 0 },
    { match: /ln -s/, code: 0 },
    { match: /cat >/, times: 3 },
    { match: /setsid|nohup/, code: 0 },
  ]);
  const setup = createRemoteSetup({ exec, bundle: async () => bundleInfo('0.7.0'), version: async () => '0.2.0-rc.2' });
  const outcome = await setup.ensure(machine({ dshVersion: '0.2.0-rc.2' }), null);
  assert.equal(outcome.outcome, 'provisioned');
  const writes = calls.filter(call => call.script.startsWith('cat >'));
  assert.equal(writes.length, 3, 'profile manifest, patch and marker are written');
  const manifest = JSON.parse(writes.find(call => call.script.endsWith('package.json\'')).input);
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-remote-sessions-resident']);
  const patch = writes.find(call => call.script.endsWith('cordis.patch.yml\'')).input;
  assert.ok(patch.includes('runtimeDirectory: "/home/user/.dsh/rs-runtime"'));
  const marker = JSON.parse(writes.find(call => call.script.endsWith('resident.json\'')).input);
  assert.equal(marker.bundleVersion, '0.7.0');
  assert.equal(marker.cliBin, cliBin);
  assert.ok(calls.some(call => call.script.includes('mkdir -m 700')), 'created directories are private');
  assert.ok(calls.some(call => call.script.includes("chmod go-w '/home/user/.dsh/rs-runtime'")), 'every created ancestor loses group/other write');
  const profilePatch = writes.find(call => call.script.endsWith("cordis.patch.yml'")).input;
  assert.ok(profilePatch.includes('storage-json') && profilePatch.includes('session-persistence-jsonl') && profilePatch.includes('attachment-local'), 'the resident profile isolates storages, sessions and attachments');
  assert.ok(profilePatch.includes('dshHome: ' + JSON.stringify('/home/user/.dsh/rs-runtime')), 'the attachment store home is pinned under the runtime directory');
  assert.ok(calls.some(call => call.script.includes('/tmp/dsh-remote-sessions')), 'transient upload scratch lives under /tmp, never in $HOME');
});

test('ensure installs the CLI when the remote has none', async () => {
  const cliBin = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const probeCount = { n: 0 };
  const { exec, calls } = scriptedExec([
    { match: /printf 'HOME/, times: 2, reply: () => ({ code: 0, stdout: probeReply(probeCount.n++ ? { cliBin } : { cliBin: null }) }) },
    { match: /npm install -g/, code: 0 },
    { match: /tar -xzf/, code: 0 },
    { match: /ln -s/, code: 0 },
    { match: /cat >/, times: 3 },
    { match: /setsid|nohup/, code: 0 },
  ]);
  const setup = createRemoteSetup({ exec, bundle: async () => bundleInfo(), version: async () => '0.2.0-rc.2' });
  const outcome = await setup.ensure(machine(), null);
  assert.equal(outcome.outcome, 'provisioned');
  const install = calls.find(call => call.script.includes('npm install -g'));
  assert.ok(install.script.includes("'@deepseek-ai/dsh@0.2.0-rc.2'"), 'installs the pinned local runtime version');
});

test('ensure respects npmInstall=false and autoSetup=false', async () => {
  const { exec, calls } = scriptedExec([
    { match: /printf 'HOME/, reply: () => ({ code: 0, stdout: probeReply({ cliBin: null }) }) },
  ]);
  const setup = createRemoteSetup({ exec, bundle: async () => bundleInfo(), version: async () => '0.2.0-rc.2' });
  await assert.rejects(setup.ensure(machine({ npmInstall: false }), null), /REMOTE_CLI_MISSING/);
  assert.equal(calls.filter(call => call.script.includes('npm install')).length, 0);
  await assert.rejects(setup.ensure(machine({ autoSetup: false }), null), /AUTO_SETUP_DISABLED/);
});

test('failed ensure enters a cooldown so connect storms cannot hammer ssh', async () => {
  let attempts = 0;
  const { exec } = scriptedExec([
    { match: /printf 'HOME/, reply: () => { attempts++; return { code: 255, stdout: '' }; } },
  ]);
  const setup = createRemoteSetup({ exec, bundle: async () => bundleInfo() });
  await assert.rejects(setup.ensure(machine(), null), /SSH_UNAVAILABLE/);
  await assert.rejects(setup.ensure(machine(), null), /SETUP_COOLDOWN/, 'a recent failure short-circuits further attempts');
  assert.equal(attempts, 1, 'no second SSH probe inside the cooldown window');
});

test('upgrade refuses active remote work and unsupervised residents', async () => {
  const cliBin = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const serving = { match: /printf 'HOME/, reply: () => ({ code: 0, stdout: probeReply({ socket: true, pid: 99, marker: { bundleVersion: '0.6.0', cliBin } }) }) };
  const busy = createRemoteSetup({ exec: scriptedExec([serving]).exec, bundle: async () => bundleInfo(),
    listRunning: async () => [{ sessionId: 's1' }] });
  await assert.rejects(busy.upgrade(machine(), null), /ACTIVE_WORK_PRESENT/);

  const unverifiable = createRemoteSetup({ exec: scriptedExec([serving]).exec, bundle: async () => bundleInfo(),
    listRunning: async () => { throw new Error('transport down'); } });
  await assert.rejects(unverifiable.upgrade(machine(), null), /ACTIVE_WORK_UNVERIFIABLE/);

  const unsupervised = createRemoteSetup({ exec: scriptedExec([{ match: /printf 'HOME/, reply: () => ({ code: 0, stdout: probeReply({ socket: true, marker: { bundleVersion: '0.6.0' } }) }) }]).exec, bundle: async () => bundleInfo() });
  await assert.rejects(unsupervised.upgrade(machine(), null), /RESIDENT_UNSUPERVISED/);
});

test('upgrade stops the recorded pid, re-provisions and restarts when idle', async () => {
  const cliBin = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const { exec, calls } = scriptedExec([
    { match: /printf 'HOME/, reply: () => ({ code: 0, stdout: probeReply({ socket: true, pid: 99, cliBin, marker: { bundleVersion: '0.6.0', cliBin } }) }) },
    { match: /kill "\$p"/, code: 0 },
    { match: /tar -xzf/, code: 0 },
    { match: /ln -s/, code: 0 },
    { match: /cat >/, times: 3 },
    { match: /setsid|nohup/, code: 0 },
  ]);
  const setup = createRemoteSetup({ exec, bundle: async () => bundleInfo('0.7.0'), listRunning: async () => [] });
  const outcome = await setup.upgrade(machine(), null);
  assert.equal(outcome.outcome, 'upgraded');
  assert.equal(outcome.from, '0.6.0');
  assert.equal(outcome.to, '0.7.0');
  const stop = calls.find(call => call.script.includes('kill "$p"'));
  assert.ok(stop, 'the recorded pid is stopped before any file is replaced');
});

test('status reports state, versions and upgrade availability', async () => {
  const cliBin = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const { exec } = scriptedExec([
    { match: /printf 'HOME/, reply: () => ({ code: 0, stdout: probeReply({ socket: true, pid: 7, marker: { bundleVersion: '0.6.0' }, cliBin }) }) },
    { match: /require\(process\.argv/, stdout: '0.2.0-rc.3\n' },
  ]);
  const setup = createRemoteSetup({ exec, bundle: async () => bundleInfo('0.7.0') });
  const state = await setup.status(machine(), null);
  assert.equal(state.state, 'running');
  assert.equal(state.dshVersion, '0.2.0-rc.3');
  assert.equal(state.dshCompatible, true);
  assert.equal(state.bundleVersion, '0.6.0');
  assert.equal(state.availableBundleVersion, '0.7.0');
  assert.equal(state.upgradeAvailable, true);
  assert.equal(state.processAlive, true);
});

test('workspace path mapping and byte decoding are pure', () => {
  const binding = { cwd: '/local/anchor', remoteSessionId: 'r1' };
  assert.equal(mapWorkspacePath(binding, 'src/main.js'), 'src/main.js');
  assert.equal(mapWorkspacePath(binding, '/local/anchor'), '.');
  assert.equal(mapWorkspacePath(binding, '/local/anchor/src/a.js'), 'src/a.js');
  assert.equal(mapWorkspacePath(binding, '/etc/hostname'), '/etc/hostname', 'outside paths pass through');
  const decoded = decodeTagged({ offset: 0, data: { $dshBytes: Buffer.from('hi').toString('base64') }, eof: true });
  assert.ok(decoded.data instanceof Uint8Array);
  assert.equal(Buffer.from(decoded.data).toString(), 'hi');
});

test('configured homes compose without nested quoting surprises', () => {
  const target = machine({ remoteHome: '/srv/dsh-data' });
  assert.equal(homeSegment(target), `'/srv/dsh-data'`);
  assert.equal(realDshHome(target, { home: '/home/user/.dsh' }), '/srv/dsh-data');
  assert.equal(realDshHome(machine(), { home: '/home/user/.dsh' }), '/home/user/.dsh', 'the probe HOME line already names the DSH home');
  const cli = resolveCliScript(machine({ remoteCli: '/opt/dsh' }));
  assert.ok(cli.includes("[ -f '/opt/dsh/lib/bin.js' ]"), 'a package-root remoteCli resolves to its bin');
});

test('plugin manifests pin versions, config rows land in the patch, sync is guarded', async () => {
  const { profileManifestText, profilePatchText, pluginsSignature } = await import('../lib/remote-setup.js');
  const machine = { runtimeDirectory: '/home/user/.dsh/rs-runtime' };
  const plugins = [
    { package: '@hytime/dsh-thinking-effort', version: '0.3.6', config: { subagentEffort: 'xhigh' } },
    { package: 'dsh-plugin-tool-management', version: '0.18.0' },
  ];
  const manifest = JSON.parse(profileManifestText(machine, plugins));
  assert.equal(manifest.dependencies['@hytime/dsh-thinking-effort'], '0.3.6', 'versions pin exactly');
  assert.equal(manifest.dependencies['dsh-plugin-tool-management'], '0.18.0');
  assert.deepEqual(manifest.dsh.profile.bundles.slice(2), ['@hytime/dsh-thinking-effort', 'dsh-plugin-tool-management'], 'plugins join the bundle list');
  const patch = profilePatchText(machine, plugins);
  assert.ok(patch.includes('name: "@hytime/dsh-thinking-effort"') && patch.includes('subagentEffort: "xhigh"'), 'config rows are written');
  assert.ok(!pluginsSignature(plugins).includes('xhigh'), 'the signature hashes, never embeds, config values');
  assert.notEqual(pluginsSignature(plugins), pluginsSignature(plugins.slice(0, 1)), 'plugin changes change the signature');

  // The sync operation refuses when active remote work exists on a live socket.
  const { normalizeMachine } = await import('../lib/machine-registry.js');
  const target = normalizeMachine({ name: 'build-host', ssh: ['user@build-host'], remoteNode: '/usr/bin/node', socketPath: '/home/user/.dsh/rs-runtime/agent.sock', remoteCwd: '/srv/project', plugins: [{ package: 'other', version: '1.0.0' }] });
  const cliBin = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const serving = { match: /printf 'HOME/, reply: () => ({ code: 0, stdout: probeReply({ socket: true, pid: 7, cliBin, marker: { bundleVersion: '0.7.0', cliBin, plugins: pluginsSignature([{ package: 'x' }]) } }) }) };
  const busySetup = createRemoteSetup({ exec: scriptedExec([serving]).exec, bundle: async () => bundleInfo(), listRunning: async () => [{ sessionId: 's1' }] });
  await assert.rejects(busySetup.sync(target, null), /ACTIVE_WORK_PRESENT/);
  // An idle resident re-syncs: stop, re-provision (with pinned plugins), start.
  const { exec, calls } = scriptedExec([
    { match: /printf 'HOME/, reply: () => ({ code: 0, stdout: probeReply({ socket: true, pid: 7, cliBin, marker: { bundleVersion: '0.7.0', cliBin, plugins: 'stale' } }) }) },
    { match: /kill "\$p"/, code: 0 },
    { match: /tar -xzf/, code: 0 },
    { match: /ln -s/, code: 0 },
    { match: /cat >/, times: 3 },
    { match: /install --omit=dev/, code: 0 },
    { match: /setsid|nohup/, code: 0 },
  ]);
  const idleSetup = createRemoteSetup({ exec, bundle: async () => bundleInfo(), listRunning: async () => [] });
  const syncedMachine = normalizeMachine({ name: 'build-host', ssh: ['user@build-host'], remoteNode: '/usr/bin/node', socketPath: '/home/user/.dsh/rs-runtime/agent.sock', remoteCwd: '/srv/project', plugins: [{ package: 'dsh-plugin-tool-management', version: '0.18.0' }] });
  const synced = await idleSetup.sync(syncedMachine, null);
  assert.equal(synced.outcome, 'synced');
  const manifestCall = calls.find(call => call.script.endsWith("package.json'"));
  assert.equal(JSON.parse(manifestCall.input).dependencies['dsh-plugin-tool-management'], '0.18.0', 'the sync writes the pinned dependency');
  assert.ok(calls.some(call => call.script.includes("install --omit=dev")), 'plugins install through the discovered npm');
});
