// Automatic remote runtime lifecycle over strict SSH: detection, provisioning,
// startup, and guarded version management. Local plugin configuration is the
// sole source of machine settings; nothing here runs at install time.
//
// Safety boundaries:
// - Detection is read-only. Provisioning only creates; it never stops, deletes
//   or replaces a running resident. Upgrades are explicit actions that first
//   verify no active remote work, and stop only the PID recorded in the
//   runtime directory's owner-only pid file.
// - All remote paths come from validated machine configuration and are
//   shell-quoted. The resident itself re-validates its directories at boot and
//   fails closed, and the SSH relay re-validates the socket chain on connect.
// - Provisioning never installs a service unit or opens listeners; it starts
//   one detached process bound to the configured private Unix socket.
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failure } from './machine-registry.js';
import { validateTransport, STRICT_SSH_OPTIONS } from './machine-registry.js';
import { readLocalModelConfig } from './model-sync.js';

export const SETUP_LIMITS = Object.freeze({
  outputBytes: 4 * 1024 * 1024, inputBytes: 16 * 1024 * 1024,
  execMs: 120000, installMs: 300000, startMs: 120000, stopMs: 90000,
  retryCooldownMs: 30000,
});

/** Determine the installed DSH runtime version for install pinning. */
export async function localDshVersion() {
  try { const { getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot'); const value = getDshRuntimeVersion?.(); if (typeof value === 'string' && value) return value; } catch {}
  try { const anchor = process.env.DSH_TEST_RUNTIME_ANCHOR ?? process.env.DSH_TEST_DEPENDENCY_ANCHOR; if (anchor) return JSON.parse(await fs.readFile(anchor, 'utf8')).version; } catch {}
  return undefined;
}

/** The CLI's optional bundle list: what a profile may switch on. Resolved
 * from the running installation (production) or the test anchor. */
async function optionalBundles() {
  try { const module = await import('@deepseek-ai/dsh-app-boot'); if (Array.isArray(module.OPTIONAL_BUNDLES)) return module.OPTIONAL_BUNDLES; } catch {}
  try {
    const anchor = process.env.DSH_TEST_RUNTIME_ANCHOR ?? process.env.DSH_TEST_DEPENDENCY_ANCHOR;
    if (anchor) {
      const require = createRequire(anchor);
      const module = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
      if (Array.isArray(module.OPTIONAL_BUNDLES)) return module.OPTIONAL_BUNDLES;
    }
  } catch {}
  return [];
}

/** The plugin's own package root: the resident bundle and lib are shipped from here. */
export function pluginRoot() { return resolve(dirname(fileURLToPath(new URL('.', import.meta.url)))); }

/** Accept 0.2.* runtimes at or above the tested 0.2.0-rc.2 build (rc.N sorts below the final). */
export function compatibleDshVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(String(version ?? ''));
  if (!match) return false;
  const major = +match[1], minor = +match[2], patch = +match[3], rc = match[4] === undefined ? undefined : +match[4];
  if (major !== 0 || minor !== 2) return false;
  if (patch > 0) return true;
  if (rc === undefined) return true;
  return rc >= 2;
}

export function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }

/** Shell segment naming the remote DSH home: a configured literal path, or the
 * login shell's expanded $HOME with the default .dsh suffix. Never re-quoted. */
export function homeSegment(machine) { return machine.remoteHome ? shellQuote(machine.remoteHome) : '"$HOME"/.dsh'; }
/** Real (expanded) DSH home for file contents. The probe's HOME line already
 * names the DSH home ("$HOME"/.dsh or the configured remoteHome); never append. */
export function realDshHome(machine, probe) {
  if (machine.remoteHome) return machine.remoteHome;
  if (typeof probe?.home === 'string' && probe.home.startsWith('/')) return probe.home.replace(/\/+$/, '');
  return null;
}
export function remoteProfileDirectory(machine) { return homeSegment(machine) + '/profiles/' + shellFreeSegment(machine.residentProfile ?? 'remote-resident'); }
function shellFreeSegment(value) {
  // Config-validated profile names are ^[a-z][a-z0-9-]{1,50}$; assert so the
  // composed path never needs nested quoting.
  if (!/^[a-z][a-z0-9-]{1,50}$/.test(value)) throw failure('INVALID_RESIDENT_PROFILE');
  return value;
}
/** Every directory segment from `from` down to `to` (inclusive), for
 * permission hygiene on freshly created intermediates. */
function chainSegments(from, to) {
  const base = resolve(from), target = resolve(to);
  if (target === base || !target.startsWith(base + '/')) return [target];
  const segments = [];
  let cursor = target;
  while (cursor !== base) { segments.push(cursor); const parent = dirname(cursor); if (parent === cursor) break; cursor = parent; }
  return segments.reverse();
}
function runtimePaths(machine) {
  const runtimeDirectory = machine.runtimeDirectory ?? dirname(machine.socketPath);
  if (!runtimeDirectory.startsWith('/') || runtimeDirectory.includes('\0')) throw failure('INVALID_RUNTIME_DIRECTORY');
  return {
    runtimeDirectory,
    marker: join(runtimeDirectory, 'resident.json'),
    pid: join(runtimeDirectory, 'resident.pid'),
    log: join(runtimeDirectory, 'resident.log'),
    bundle: join(runtimeDirectory, 'bundle'),
    socket: machine.socketPath,
    profile: remoteProfileDirectory(machine),
    home: homeSegment(machine),
  };
}
/** Quote a composed path whose validated segments contain no quote characters. */
function q(value) { return shellQuote(value); }

/**
 * Build a strict-SSH executor bound to the DSH subprocess service. Each call
 * runs one script as the machine's remote user and returns { code, stdout };
 * exit 255 is the ssh client itself (host unreachable / auth refused).
 */
export function createRemoteExec(ctx, { spawn } = {}) {
  const subprocess = spawn ?? ctx?.subprocess;
  if (!subprocess || typeof subprocess.spawn !== 'function') throw failure('SUBPROCESS_UNAVAILABLE', 503);
  return async function exec(machine, script, { input, signal, timeoutMs = SETUP_LIMITS.execMs } = {}) {
    if (machine.disabled || machine.migrationRequired) throw failure('MACHINE_DISABLED', 409);
    const transport = validateTransport(machine);
    if (typeof script !== 'string' || script.includes('\0') || Buffer.byteLength(script) > 512 * 1024) throw failure('INVALID_REMOTE_COMMAND');
    if (input !== undefined && !(typeof input === 'string' || Buffer.isBuffer(input))) throw failure('INVALID_SSH_INPUT');
    if (input !== undefined && Buffer.byteLength(input) > SETUP_LIMITS.inputBytes) throw failure('SSH_INPUT_TOO_LARGE');
    const controller = new AbortController(); const abort = () => controller.abort(failure('REQUEST_CANCELLED', 499));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(failure('SSH_TIMEOUT', 504)), timeoutMs);
    let child;
    const onAbort = () => { try { child?.terminate?.(); child?.stdin?.destroy?.(); child?.stdout?.destroy?.(); } catch {} };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      controller.signal.throwIfAborted();
      child = subprocess.spawn({ argv: [transport.command, ...STRICT_SSH_OPTIONS, ...transport.ssh, script], cwd: process.cwd(),
        stdio: { stdin: input === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'ignore' }, graceMs: 1000, env: transport.env });
      if (!child.stdout || input !== undefined && !child.stdin) throw failure('SSH_FAILED', 502);
      const collecting = (async () => {
        const chunks = []; let size = 0;
        for await (const chunk of child.stdout) {
          size += Buffer.byteLength(chunk); if (size > SETUP_LIMITS.outputBytes) throw failure('SSH_OUTPUT_TOO_LARGE', 502);
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString('utf8');
      })();
      const writing = input === undefined ? Promise.resolve() : new Promise((done, fail) => {
        child.stdin.once('error', () => fail(failure('SSH_FAILED', 502)));
        child.stdin.end(input, () => done());
      });
      const [outcome, stdout] = await Promise.all([child.done, collecting, writing]);
      if (controller.signal.aborted) throw failure('REQUEST_CANCELLED', 499);
      return { code: outcome.exitCode, stdout };
    } catch (error) {
      onAbort();
      if (['REQUEST_CANCELLED', 'SSH_TIMEOUT', 'SSH_OUTPUT_TOO_LARGE', 'SSH_INPUT_TOO_LARGE', 'MACHINE_DISABLED',
        'INVALID_REMOTE_COMMAND', 'INVALID_SSH_INPUT', 'SUBPROCESS_UNAVAILABLE'].includes(error?.code)) throw error;
      throw failure('SSH_FAILED', 502);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  };
}

/** Minimal local tar of the shipped resident payload (lib + resident + manifests). */
export async function createBundleArchive(spawn, { root = pluginRoot() } = {}) {
  if (!spawn || typeof spawn !== 'function') throw failure('SUBPROCESS_UNAVAILABLE', 503);
  const child = spawn({ argv: ['tar', '-czf', '-', '-C', root, 'lib', 'resident', 'package.json', 'cordis.patch.yml'],
    cwd: process.cwd(), stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' }, graceMs: 1000,
    // macOS tar: never emit AppleDouble ._* entries into the uploaded archive.
    env: { COPYFILE_DISABLE: '1' } });
  const chunks = []; let size = 0;
  for await (const chunk of child.stdout) { size += chunk.length; if (size > SETUP_LIMITS.inputBytes) throw failure('BUNDLE_TOO_LARGE', 502); chunks.push(Buffer.from(chunk)); }
  const outcome = await child.done;
  if (outcome.exitCode !== 0) throw failure('BUNDLE_ARCHIVE_FAILED', 502);
  const archive = Buffer.concat(chunks);
  const manifest = JSON.parse(await fs.readFile(join(root, 'resident', 'package.json'), 'utf8'));
  if (typeof manifest.version !== 'string' || !manifest.version) throw failure('BUNDLE_ARCHIVE_FAILED', 502);
  return { archive, version: manifest.version, sha256: createHash('sha256').update(archive).digest('hex') };
}

// ── remote scripts ───────────────────────────────────────────────────────────
// Probe output is line-oriented key:value text so no remote JSON tooling is
// needed; the marker file is a single-line JSON document we wrote ourselves.

export function probeScript(machine) {
  const paths = runtimePaths(machine);
  const node = q(machine.remoteNode);
  return [
    `printf 'HOME:%s\\n' ${paths.home}`,
    `node=$(command -v node 2>/dev/null)`,
    `[ -n "$node" ] || node=$(ls -d "$HOME"/opt/node-*/bin/node /usr/local/bin/node /usr/bin/node 2>/dev/null | head -1)`,
    `if [ -n "$node" ]; then printf 'NODE:%s\\n' "$node"; "$node" --version 2>/dev/null | sed 's/^/NODEVER:/'; else printf 'NODE:none\\n'; fi`,
    `if [ -S ${q(paths.socket)} ]; then printf 'SOCKET:yes\\n'; else printf 'SOCKET:no\\n'; fi`,
    `if [ -f ${q(paths.marker)} ]; then printf 'MARKER:'; cat ${q(paths.marker)}; printf '\\n'; else printf 'MARKER:none\\n'; fi`,
    `if [ -f ${q(paths.pid)} ] && p=$(cat ${q(paths.pid)} 2>/dev/null) && kill -0 "$p" 2>/dev/null; then printf 'PID:%s\\n' "$p"; fi`,
    `cli=$(command -v dsh 2>/dev/null)`,
    `cli=$(printf '%s' "$cli" 2>/dev/null); [ -n "$cli" ] || cli=$(ls -d "$HOME"/.npm-global/bin/dsh "$HOME"/.local/bin/dsh /usr/local/bin/dsh /usr/bin/dsh 2>/dev/null | head -1)`,
    `nodebin=$(printf '%s' "$node" 2>/dev/null); [ -n "$nodebin" ] || nodebin=$(command -v node 2>/dev/null)`,
    `[ -n "$cli" ] || [ -z "$nodebin" ] || cli=$(ls -d "$(dirname "$nodebin")/../lib/node_modules/@deepseek-ai/dsh/lib/bin.js" 2>/dev/null | head -1)`,
    `if [ -n "$cli" ]; then cli=$(readlink -f "$cli" 2>/dev/null || printf '%s' "$cli"); printf 'CLIBIN:%s\\n' "$cli"; root=$(dirname "$cli"); if [ -f "$root/../package.json" ]; then root=$(dirname "$root"); fi; printf 'CLIROOT:%s\\n' "$root"; else printf 'CLIBIN:none\\n'; fi`,
    `npm=$(command -v npm 2>/dev/null)`,
    `[ -n "$npm" ] || npm=$(ls -d "$HOME"/.npm-global/bin/npm "$HOME"/.local/bin/npm /usr/local/bin/npm /usr/bin/npm 2>/dev/null | head -1)`,
    `[ -n "$npm" ] || [ -z "$nodebin" ] || npm=$(dirname "$nodebin")/npm`,
    `if [ -n "$npm" ] && [ -x "$npm" ]; then printf 'NPM:%s\\n' \"$npm\"; else printf 'NPM:none\\n'; fi`,
    `printf 'END\\n'`,
  ].join('\n');
}

export function parseProbe(stdout) {
  const lines = String(stdout ?? '').split('\n');
  const probe = { home: null, node: null, socket: false, marker: null, pid: undefined, cliBin: null, cliRoot: null, npm: false };
  let sawEnd = false;
  for (const line of lines) {
    if (line === 'END') { sawEnd = true; continue; }
    const split = line.indexOf(':');
    if (split <= 0) continue;
    const key = line.slice(0, split), value = line.slice(split + 1);
    if (key === 'HOME') probe.home = value;
    else if (key === 'NODE' && value !== 'none') probe.node = value;
    else if (key === 'SOCKET') probe.socket = value === 'yes';
    else if (key === 'PID') { const pid = Number(value); if (Number.isSafeInteger(pid) && pid > 0) probe.pid = pid; }
    else if (key === 'CLIBIN' && value !== 'none') probe.cliBin = value;
    else if (key === 'CLIROOT') probe.cliRoot = value;
    else if (key === 'NPM') probe.npm = value !== 'none' ? value : false;
    else if (key === 'MARKER' && value !== 'none') {
      try { const marker = JSON.parse(value); if (marker && typeof marker === 'object') probe.marker = marker; } catch {}
    }
  }
  if (!sawEnd || probe.home === null) throw failure('PROBE_FAILED', 502);
  return probe;
}

/** Resolve the CLI's version without embedding any path into evaluated source. */
export function cliVersionScript(machine, cliRoot) {
  const node = q(machine.remoteNode);
  return `${node} -p "require(process.argv[1] + '/package.json').version" ${q(cliRoot)}`;
}

/** Resolve the effective CLI bin path: an explicit path wins over discovery. */
export function resolveCliScript(machine) {
  const configured = machine.remoteCli;
  if (!configured) return null;
  // Accept either the executable or the package root; never trust a bare glob.
  return `if [ -x ${q(configured)} ]; then printf '%s' $(readlink -f ${q(configured)} 2>/dev/null || printf '%s' ${q(configured)});`
    + ` elif [ -f ${q(join(configured, 'lib', 'bin.js'))} ]; then printf '%s' ${q(join(configured, 'lib', 'bin.js'))};`
    + ` else printf 'none'; fi`;
}

export function startScript(machine, cliBin, profile) {
  const paths = runtimePaths(machine);
  const profileName = profile ?? machine.residentProfile ?? 'remote-resident';
  const inner = `echo $$ > ${q(paths.pid)}; exec env DSH_HOME=${homeSegment(machine)} ${q(machine.remoteNode)} ${q(cliBin)} --profile ${q(profileName)}`;
  // The trailing & inside launcher terminates the background job; never append a
  // semicolon after it (`&;` is a shell syntax error and aborts the whole script).
  const launcher = `sh -c ${q(inner)} </dev/null >>${q(paths.log)} 2>&1 &`;
  return [
    `if command -v setsid >/dev/null 2>&1; then setsid ${launcher} else nohup ${launcher}fi`,
    `i=0; while [ "$i" -lt 120 ]; do [ -S ${q(paths.socket)} ] && exit 0; sleep 0.5 2>/dev/null || sleep 1; i=$((i+1)); done; exit 75`,
  ].join('\n');
}

export function stopScript(machine) {
  const paths = runtimePaths(machine);
  const profileName = machine.residentProfile ?? 'remote-resident';
  // Two-phase stop: (1) the recorded PID, (2) every process running this exact
  // profile (stale PID files must not leave duplicate residents alive).
  return [
    `if [ -f ${q(paths.pid)} ] && p=$(cat ${q(paths.pid)} 2>/dev/null) && kill -0 "$p" 2>/dev/null; then`,
    `  kill "$p" 2>/dev/null || true; i=0`,
    `  while [ "$i" -lt 60 ]; do kill -0 "$p" 2>/dev/null || break; sleep 0.5 2>/dev/null || sleep 1; i=$((i+1)); done`,
    `  kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true`,
    `fi`,
    // Anchor the pattern to the node binary: a bare `profile <name>` pattern
    // matches the SSH session's own bash -c cmdline and kills the session
    // itself (exit 255). The resident's cmdline is `node ... --profile <name>`.
    `pkill -f "node .* --profile ${profileName}$" 2>/dev/null || true`,
    `sleep 1`,
    `rm -f ${q(paths.pid)}`,
    `i=0; while [ "$i" -lt 30 ]; do [ -S ${q(paths.socket)} ] || exit 0; sleep 0.5 2>/dev/null || sleep 1; i=$((i+1)); done; exit 76`,
  ].join('\n');
}

/** Stable signature of a machine's plugin list: the resident compares it
 * against the marker to decide whether a plugin sync needs a restart. */
export function pluginsSignature(plugins) {
  return createHash('sha256').update(JSON.stringify((plugins ?? []).map(entry => [entry.package, entry.version ?? null, entry.config ?? null]))).digest('hex').slice(0, 16);
}

/** The full provision signature: pinned plugins PLUS the synced model catalog
 * and plugin states. A resident whose marker records a different signature is
 * out of sync and must be re-provisioned and restarted — a models/sync that
 * changed the provider catalog must never report "in sync" and skip the
 * restart that loads the new config. */
export function setupSignature(machine, environment) {
  return createHash('sha256').update(JSON.stringify([
    // Manifest format: bumps invalidate every pre-existing marker ONCE, so a
    // generated-profile change (e.g. removing npm deps for CLI-shipped bundles)
    // reliably re-provisions instead of reporting in-sync with a stale layout.
    'profile-manifest/2',
    (machine.plugins ?? []).map(entry => [entry.package, entry.version ?? null, entry.config ?? null]),
    machine.syncModels === false ? null : environment?.modelProvidersSection ?? null,
    machine.syncModels === false ? null : environment?.defaultModel ?? null,
    machine.syncPluginStates === false ? null : environment?.pluginStates ?? null,
    environment?.bundlePins ?? null,
    // The resident-owned credential store pin is part of the generated patch:
    // a resident provisioned before the pin must re-provision, not stay in-sync.
    machine.runtimeDirectory ?? dirname(machine.socketPath),
  ])).digest('hex').slice(0, 16);
}

/** The resident profile manifest: pinned plugin dependencies plus the loader
 * bundle list. The resident bundle itself resolves through its node_modules
 * symlink, never through npm. */
export function profileManifestText(machine, plugins, environment) {
  const dependencies = {};
  for (const entry of plugins ?? []) dependencies[entry.package] = entry.version ?? '*';
  const bundles = ['@deepseek-ai/dsh-base', 'dsh-remote-sessions-resident', ...(plugins ?? []).map(entry => entry.package)];
  // CLI-shipped session-behavior bundles compose through the bundles list and
  // resolve from the INSTALLATION (resolveBundleDir checks the install anchor
  // first). They must NEVER become npm dependencies: installing them into the
  // profile node_modules duplicates the whole @deepseek-ai stack and breaks
  // instanceof across the two module copies (operator-reported: every session
  // create failed with SessionQueryError: session not found).
  for (const pin of environment?.bundlePins ?? []) if (!bundles.includes(pin.package)) bundles.push(pin.package);
  return JSON.stringify({
    private: true, type: 'module',
    dependencies,
    dsh: { profile: { bundles } },
  }, null, 2) + '\n';
}

export async function readLocalEnvironment(settings, profileDir) {
  const describe = typeof settings?.describe === 'function' ? settings.describe() : [];
  const environment = { defaultModel: null, pluginStates: [], modelProvidersSection: null };
  for (const row of describe) {
    if (!row || typeof row !== 'object') continue;
    if (row.ns === 'agent-default-model') {
      const value = row.value ?? {};
      if (value.provider && value.model) environment.defaultModel = { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) };
    }
    if (row.id && row.disabled === true) environment.pluginStates.push({ id: row.id });
  }
  // The full provider catalog syncs from the local profile's patch — the same
  // authoritative source the explicit model sync uses — so lifecycle writes
  // (ensure/sync/upgrade) can never silently wipe a model section that an
  // explicit sync wrote before them.
  if (profileDir) {
    try {
      const modelConfig = await readLocalModelConfig(profileDir);
      environment.modelProvidersSection = modelConfig.providers ?? null;
      if (!environment.defaultModel) {
        const section = modelConfig.defaultModel ?? '';
        const provider = /provider:\s*"?([\w.-]+)"?/.exec(section);
        const model = /model:\s*"?([^\n"]+)"?/.exec(section);
        if (provider && model) environment.defaultModel = { provider: provider[1], model: model[1] };
      }
    } catch { /* no local model config: lifecycle writes stay model-neutral */ }
  }
  // Session-behavior bundles the LOCAL profile enabled (the CLI's optional
  // bundle set — e.g. experimental auto-review for the /permission picker)
  // pin onto the resident: a remote session must honor the same permission
  // presets and experimental behaviors the operator runs locally. Client-only
  // bundles (voice input) and arbitrary local plugins never pin — operator
  // pins stay explicit through machine.plugins.
  if (profileDir) {
    try {
      const manifest = JSON.parse(await fs.readFile(join(profileDir, 'package.json'), 'utf8'));
      const enabled = manifest?.dsh?.profile?.bundles;
      if (Array.isArray(enabled)) {
        const optionalBundleList = await optionalBundles();
        const clientOnly = new Set(['@deepseek-ai/dsh-experimental-voice-input-bundle']);
        const version = await localDshVersion();
        environment.bundlePins = enabled
          .filter(name => optionalBundleList.includes(name) && !clientOnly.has(name))
          .map(entry => ({ package: entry, version }))
          .filter(pin => typeof pin.version === 'string' && /^\d+[.]\d+[.]\d+/.test(pin.version));
      }
    } catch { /* no readable profile manifest: nothing pins */ }
  }
  return environment;
}

export function profilePatchText(machine, plugins, environment) {
  const paths = runtimePaths(machine);
  const slug = name => name.replace(/^@[^/]+\//, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'plugin';
  let text = '# Generated by dsh-remote-sessions automatic setup.\n'
    + '# The resident runtime directory is explicit and private; no credentials are copied.\n'
    + '- id: remote-resident\n'
    + '  config:\n'
    + '    runtimeDirectory: ' + JSON.stringify(paths.runtimeDirectory) + '\n';
  // Plugin config rows: one per synced plugin that declares remote settings.
  for (const entry of plugins ?? []) {
    if (entry.config === undefined) continue;
    text += '- id: ' + slug(entry.package) + '\n  name: ' + JSON.stringify(entry.package) + '\n  config:\n'
      + Object.entries(entry.config).map(([key, value]) => '    ' + key + ': ' + JSON.stringify(value) + '\n').join('');
  }
  // Environment sync: mirror the local model selection and plugin states. The
  // full provider catalog (llm-pi-ai section) rides along so a lifecycle write
  // can never WIPE the model config an explicit sync wrote before it.
  if (machine.syncModels !== false && environment?.modelProvidersSection) {
    text += environment.modelProvidersSection.trimEnd() + '\n';
  }
  if (environment?.defaultModel && machine.syncModels !== false) {
    text += '- id: agent-default-model\n'
      + '  name: "@deepseek-ai/dsh-agent-default-model"\n'
      + '  config:\n'
      + '    provider: ' + JSON.stringify(environment.defaultModel.provider) + '\n'
      + '    model: ' + JSON.stringify(environment.defaultModel.model) + '\n'
      + (environment.defaultModel.reasoningEffort ? '    reasoningEffort: ' + JSON.stringify(environment.defaultModel.reasoningEffort) + '\n' : '');
  }
  for (const state of environment?.pluginStates ?? []) {
    if (machine.syncPluginStates === false) continue;
    text += '- id: ' + state.id + '\n  disabled: true\n';
  }
  // Storage and session roots live under the machine's own runtime directory:
  // two machines sharing one SSH host (and one DSH_HOME) never write to the
  // same stores; the shared home contributes only read-only inputs such as
  // credentials and the CLI installation.
  // Credentials pin: the resident reads its OWN store under the runtime
  // directory; the shared home credential file is never written or relied on.
  text += '- id: credentials\n'
    + '  name: "@deepseek-ai/dsh-credentials-local"\n'
    + '  config:\n'
    + '    path: ' + JSON.stringify(paths.runtimeDirectory + '/credentials.yaml') + '\n'
    + '- id: storage-json\n'
    + '  config:\n'
    + '    root: ' + JSON.stringify(paths.runtimeDirectory + '/storages') + '\n'
    + '- id: session-persistence-jsonl\n'
    + '  config:\n'
    + '    root: ' + JSON.stringify(paths.runtimeDirectory + '/sessions') + '\n'
    // Uploaded files stream into the resident's own attachment store: with
    // the store's home pinned to the runtime directory, two machines sharing
    // one SSH host never share attachment bytes, quotas or expiry sweeps.
    + '- id: attachment-local\n'
    + '  config:\n'
    + '    dshHome: ' + JSON.stringify(paths.runtimeDirectory) + '\n';
  return text;
}

export function markerText(machine, { bundleVersion, bundleSha256, cliBin, profile, plugins }) {
  return JSON.stringify({ version: 1, bundleVersion, bundleSha256,
    dshVersion: machine.dshVersion ?? null, profile: profile ?? machine.residentProfile ?? 'remote-resident', plugins: plugins ?? null,
    runtimeDirectory: runtimePaths(machine).runtimeDirectory, socketPath: machine.socketPath,
    cliBin, nodePath: machine.remoteNode, createdAt: new Date().toISOString() });
}

// ── facade ────────────────────────────────────────────────────────────────────

/** Extract a named `- id: <name>` YAML section from a patch file body. */
function yamlSection(text, id) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex(line => line.trim() === `- id: ${id}`);
  if (start < 0) return null;
  const collected = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^- id: /.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join('\n');
}

/**
 * Drift check for a provisioned-but-stopped resident. The resident binds its
 * socket inside the runtimeDirectory its PROFILE PATCH names, so a machine
 * whose configured paths moved (settings edit, Detect rewrite, manual edit)
 * must re-provision before start — blindly starting the stale resident would
 * bind the old socket and leave the configured one dead. Returns true when
 * the recorded marker or the resident profile patch disagrees with the
 * machine's configured runtimeDirectory/socketPath.
 */
async function residentDrift(exec, machine, probed, signal) {
  const paths = runtimePaths(machine);
  const marker = probed.marker ?? {};
  if (typeof marker.runtimeDirectory === 'string' && marker.runtimeDirectory !== paths.runtimeDirectory) return true;
  if (typeof marker.socketPath === 'string' && marker.socketPath !== machine.socketPath) return true;
  const profileName = typeof marker.profile === 'string' && marker.profile ? marker.profile : machine.residentProfile ?? 'remote-resident';
  const dshHome = realDshHome(machine, probed);
  if (!dshHome) return true;
  const patch = await exec(machine, `cat ${q(join(dshHome, 'profiles', profileName, 'cordis.patch.yml'))} 2>/dev/null`, { signal })
    .catch(() => null);
  if (!patch || patch.code !== 0) return true;
  const section = yamlSection(patch.stdout, 'remote-resident');
  if (!section) return true;
  // Accept quoted or bare absolute values; the generated patch quotes them.
  const runtime = /runtimeDirectory:\s*"([^"]+)"/.exec(section) ?? /runtimeDirectory:\s*'([^']+)'/.exec(section)
    ?? /runtimeDirectory:\s*(\/[^\s#'"]+)/.exec(section);
  return !runtime || runtime[1] !== paths.runtimeDirectory;
}

/**
 * Create the setup facade. `exec(machine, script, {input, signal, timeoutMs})`
 * and `spawn({argv, ...})` are injectable for tests; production callers pass
 * the DSH subprocess-backed implementations.
 */
export function createRemoteSetup({ exec, spawn, bundle = createBundleArchive, version = localDshVersion, listRunning, readEnvironment } = {}) {
  if (typeof exec !== 'function') throw failure('SUBPROCESS_UNAVAILABLE', 503);
  const mutex = new Map(), cooldown = new Map(), archiveCache = new Map();
  const latestBundle = async () => {
    const key = String((await version()) ?? 'unpinned');
    if (!archiveCache.has(key)) {
      const produced = await bundle(spawn);
      archiveCache.set(key, produced);
      // A cached archive must not outlive the plugin session's files.
      setTimeout(() => { if (archiveCache.get(key) === produced) archiveCache.delete(key); }, 10 * 60 * 1000).unref?.();
    }
    return archiveCache.get(key);
  };
  async function probe(machine, signal) {
    const result = await exec(machine, probeScript(machine), { signal });
    if (result.code !== 0) throw failure(result.code === 255 ? 'SSH_UNAVAILABLE' : 'PROBE_FAILED', 502);
    return parseProbe(result.stdout);
  }
  async function cliVersion(machine, state, signal) {
    let cliRoot = null;
    if (machine.remoteCli) {
      const resolved = await exec(machine, resolveCliScript(machine), { signal });
      if (resolved.code !== 0 || !resolved.stdout.trim() || resolved.stdout.trim() === 'none') return null;
      const cliBin = resolved.stdout.trim();
      cliRoot = cliBin.endsWith('/lib/bin.js') ? cliBin.slice(0, -'/lib/bin.js'.length) : dirname(cliBin);
    } else {
      if (!state.cliRoot) return null;
      cliRoot = state.cliRoot;
    }
    const result = await exec(machine, cliVersionScript(machine, cliRoot), { signal }).catch(() => null);
    if (!result || result.code !== 0) return null;
    return result.stdout.trim() || null;
  }
  async function ensureCli(machine, state, signal, { wanted }) {
    if (machine.remoteCli) {
      const resolved = await exec(machine, resolveCliScript(machine), { signal });
      const cliBin = resolved.code === 0 ? resolved.stdout.trim() : '';
      if (!cliBin || cliBin === 'none') throw failure('REMOTE_CLI_MISSING', 502);
      return { cliBin, cliRoot: cliBin.endsWith('/lib/bin.js') ? cliBin.slice(0, -'/lib/bin.js'.length) : dirname(cliBin) };
    }
    if (state.cliBin && state.cliRoot) return { cliBin: state.cliBin, cliRoot: state.cliRoot };
    const target = wanted ?? (await version());
    if (!target) throw failure('DSH_VERSION_UNKNOWN', 502);
    if (state.npm === false) throw failure('REMOTE_NPM_MISSING', 502);
    if (machine.npmInstall === false) throw failure('REMOTE_CLI_MISSING', 502);
    const installed = await exec(machine, `npm install -g ${q('@deepseek-ai/dsh@' + target)} >/dev/null 2>&1`, { signal, timeoutMs: SETUP_LIMITS.installMs });
    if (installed.code !== 0) throw failure('REMOTE_INSTALL_FAILED', 502);
    const again = await probe(machine, signal);
    if (!again.cliBin || !again.cliRoot) throw failure('REMOTE_INSTALL_FAILED', 502);
    return { cliBin: again.cliBin, cliRoot: again.cliRoot };
  }
  async function writeFile(machine, path, content, signal) {
    // One file per exec: content streams over stdin, so no shell quoting of
    // file bodies is ever needed.
    const written = await exec(machine, `cat > ${q(path)}`, { input: content, signal });
    if (written.code !== 0) throw failure('PROFILE_WRITE_FAILED', 502);
  }
  async function provisionFiles(machine, probe, signal, { cli, bundleInfo, profile, environment }) {
    const paths = runtimePaths(machine);
    // File contents need the real expanded DSH home; shell commands use the
    // unexpanded segment so the remote login shell resolves $HOME itself.
    const dshHome = realDshHome(machine, probe);
    if (!dshHome) throw failure('PROBE_FAILED', 502);
    // An existing resident keeps the profile its marker recorded: upgrades and
    // restarts must not drift to a differently-named profile directory.
    const profileName = profile ?? probe.marker?.profile ?? machine.residentProfile ?? 'remote-resident';
    const profileDir = join(dshHome, 'profiles', profileName);
    // Transient scratch (bundle uploads) lives under /tmp, never in $HOME:
    // a per-run UUID namespace, created private, removed by the apply step.
    const incoming = '/tmp/dsh-remote-sessions/bundle-' + randomUUID();
    const ensureDir = directory => `if [ ! -d ${q(directory)} ]; then mkdir -m 700 -p ${q(directory)}; fi`;
    const upload = [
      ensureDir(dshHome),
      ensureDir(join(dshHome, 'profiles')),
      ensureDir(profileDir),
      ensureDir(paths.runtimeDirectory),
      // The resident and the SSH relay fail closed on group/world-writable
      // ancestors (no sticky bit). mkdir -p intermediates carry the umask
      // (often 775), so strip write bits from EVERY created segment between
      // the DSH home and the runtime directory, plus the profile chain.
      ...(chainSegments(dshHome, paths.runtimeDirectory).map(directory => `chmod go-w ${q(directory)}`)),
      `chmod go-w ${q(dshHome)} ${q(join(dshHome, 'profiles'))} ${q(profileDir)}`,
      `mkdir -m 700 -p ${q('/tmp/dsh-remote-sessions')}`,
      `mkdir -m 700 ${q(incoming)}`,
      `tar -xzf - -C ${q(incoming)}`,
    ].join(' && ');
    const extracted = await exec(machine, upload, { input: bundleInfo.archive, signal, timeoutMs: SETUP_LIMITS.installMs });
    if (extracted.code !== 0) { await exec(machine, `rm -rf ${q(incoming)} 2>/dev/null || true`, { signal }).catch(() => {}); throw failure('BUNDLE_UPLOAD_FAILED', 502); }
    const link = join(profileDir, 'node_modules', 'dsh-remote-sessions-resident');
    const residentDir = join(paths.bundle, 'resident');
    // The CLI's hoisted node_modules carries every DSH peer the companion
    // chain imports (bundle-root lib/). The link sits at the BUNDLE ROOT so
    // Node's walk-up resolution from bundle/lib/*.js finds it; a resident
    // placed outside a resolvable tree cannot boot.
    const peerTree = join(cli.cliRoot, 'node_modules');
    const apply = [
      `rm -rf ${q(paths.bundle)} 2>/dev/null || true`,
      `mv ${q(incoming)} ${q(paths.bundle)}`,
      `rmdir ${q('/tmp/dsh-remote-sessions')} 2>/dev/null || true`,
      `if [ ! -d ${q(join(profileDir, 'node_modules'))} ]; then mkdir -m 700 ${q(join(profileDir, 'node_modules'))}; fi`,
      `rm -rf ${q(link)} 2>/dev/null || true`,
      // Link the RESIDENT SUB-BUNDLE, never the whole plugin package: the
      // package root's entry is the local-side native host, which must not
      // load inside the resident process.
      `ln -s ${q(residentDir)} ${q(link)}`,
      `rm -rf ${q(join(paths.bundle, 'node_modules'))} 2>/dev/null || true`,
      `ln -s ${q(peerTree)} ${q(join(paths.bundle, 'node_modules'))}`,
    ].join(' && ');
    if ((await exec(machine, apply, { signal })).code !== 0) throw failure('BUNDLE_INSTALL_FAILED', 502);
    await writeFile(machine, join(profileDir, 'package.json'), profileManifestText(machine, machine.plugins ?? [], environment), signal);
    await writeFile(machine, join(profileDir, 'cordis.patch.yml'), profilePatchText(machine, machine.plugins ?? [], environment), signal);
    // npm install is reserved for OPERATOR plugin pins (machine.plugins):
    // third-party packages are not shipped with the CLI installation.
    // CLI-shipped bundle pins already compose through the bundles list.
    if ((machine.plugins ?? []).length) await syncPlugins(machine, probe, signal, { profileDir, plugins: machine.plugins });
    await writeFile(machine, paths.marker, markerText(machine, { bundleVersion: bundleInfo.version, bundleSha256: bundleInfo.sha256, cliBin: cli.cliBin, profile: profileName, plugins: setupSignature(machine, environment) }), signal);
  }
  /** Install the machine's pinned plugins into the resident profile using the
   * npm discovered on the remote (PATH, npm-global or node-derived). */
  async function syncPlugins(machine, probed, signal, { profileDir, plugins } = {}) {
    const pins = plugins ?? machine.plugins ?? [];
    if (!pins.length) return { installed: 0 };
    if (!probed.npm) throw failure('REMOTE_NPM_MISSING', 502);
    const directory = profileDir ?? join(realDshHome(machine, probed) ?? '', 'profiles', machine.residentProfile ?? 'remote-resident');
    const paths = runtimePaths(machine);
    const residentDir = join(paths.bundle, 'resident');
    const link = join(directory, 'node_modules', 'dsh-remote-sessions-resident');
    // npm install prunes entries it doesn't manage, including the provisioning
    // symlink. Re-link the resident sub-bundle after installing the plugins.
    // npm needs node on PATH; the SSH session's default PATH may miss both.
    const nodeBin = probed.node ? dirname(String(probed.node)) : dirname(machine.remoteNode);
    // env sets PATH correctly without quoting pitfalls; npm needs node visible.
    const script = `cd ${q(directory)} && env PATH=${nodeBin}:/usr/local/bin:/usr/bin:/bin ${q(probed.npm)} install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | tee /tmp/dsh-npm-debug.log; npm_status=\$?; rm -rf ${q(link)} 2>/dev/null || true; ln -s ${q(residentDir)} ${q(link)} 2>/dev/null || true; exit \$npm_status`;
    const result = await exec(machine, script, { signal, timeoutMs: SETUP_LIMITS.installMs });
    if (result.code !== 0) {
      // Surface the npm diagnostics (they contain no secrets).
      const detail = String(result.stdout ?? '').split('\n').filter(Boolean).slice(-4).join('; ');
      const error = failure('PLUGIN_INSTALL_FAILED', 502);
      error.message = detail || error.message;
      throw error;
    }
    return { installed: pins.length };
  }
  async function start(machine, cliBin, signal, profile) {
    const result = await exec(machine, startScript(machine, cliBin, profile), { signal, timeoutMs: SETUP_LIMITS.startMs });
    if (result.code === 75) throw failure('RESIDENT_START_TIMEOUT', 504);
    if (result.code !== 0) throw failure('RESIDENT_START_FAILED', 502);
  }
  /** Ensure a resident exists and is running. Never stops or replaces a live one. */
  async function ensure(machine, signal, options = {}) {
    if (machine.autoSetup === false) throw failure('AUTO_SETUP_DISABLED', 409);
    const key = machine.name;
    if (mutex.has(key)) return mutex.get(key);
    const earlier = cooldown.get(key);
    if (earlier && Date.now() - earlier < SETUP_LIMITS.retryCooldownMs && !options.force) throw failure('SETUP_COOLDOWN', 429);
    const task = (async () => {
      const bundleInfo = await latestBundle();
      const environment = typeof readEnvironment === 'function' ? await readEnvironment().catch(() => null) : null;
      const probed = await probe(machine, signal);
      if (probed.socket) {
        return { outcome: 'reused', detail: 'resident already serving', probe: probed,
          upgradeAvailable: !!probed.marker && probed.marker.bundleVersion !== bundleInfo.version };
      }
      if (probed.marker) {
        // A provisioned resident that is not serving: ALWAYS stop first —
        // a prior boot whose companion failed, or a duplicate instance from
        // a stale PID file, would otherwise leak alongside the new one.
        const stoppedPrior = await exec(machine, stopScript(machine), { signal, timeoutMs: SETUP_LIMITS.stopMs });
        if (stoppedPrior.code !== 0 && stoppedPrior.code !== 76) throw failure('RESIDENT_STOP_FAILED', 502);
        const recorded = typeof probed.marker.cliBin === 'string' ? probed.marker.cliBin : '';
        const cliBin = recorded && (await exec(machine, `if [ -x ${q(recorded)} ]; then printf '%s' ${q(recorded)}; fi`, { signal })).stdout.trim();
        if (!cliBin) throw failure('RESIDENT_CLI_MISSING', 502);
        const profileName = typeof probed.marker.profile === 'string' ? probed.marker.profile : undefined;
        // Configuration drift heal: the marker or the resident's profile patch
        // may record paths this machine no longer uses (settings edits moved
        // them). Starting the stale resident would bind the OLD socket while
        // the transport connects to the configured one — re-provision first.
        if (await residentDrift(exec, machine, probed, signal)) {
          const cli = await ensureCli(machine, probed, signal, { wanted: machine.dshVersion });
          const bundleInfo = await latestBundle();
          await provisionFiles(machine, probed, signal, { cli, bundleInfo, profile: probed.marker.profile, environment });
          await start(machine, cli.cliBin, signal, profileName);
          return { outcome: 'reprovisioned', detail: 'recorded configuration drifted; resident re-provisioned', probe: probed };
        }
        await start(machine, cliBin, signal, profileName);
        return { outcome: 'started', detail: 'existing resident started', probe: probed };
      }
      const cli = await ensureCli(machine, probed, signal, { wanted: machine.dshVersion });
      await provisionFiles(machine, probed, signal, { cli, bundleInfo, environment });
      await start(machine, cli.cliBin, signal);
      return { outcome: 'provisioned', detail: 'resident provisioned and started', probe: probed };
    })().catch(error => { cooldown.set(key, Date.now()); throw error; })
      .finally(() => { if (mutex.get(key) === task) mutex.delete(key); });
    mutex.set(key, task);
    return task;
  }
  /**
   * Explicit, guarded upgrade: refuses while remote work is active or cannot
   * be verified on a live socket, stops only the recorded PID, re-provisions
   * the bundle, and starts the new resident.
   */
  async function upgrade(machine, signal) {
    if (machine.autoSetup === false) throw failure('AUTO_SETUP_DISABLED', 409);
    const key = machine.name;
    if (mutex.has(key)) return mutex.get(key);
    const task = (async () => {
      const bundleInfo = await latestBundle();
      const probed = await probe(machine, signal);
      if (probed.socket && probed.pid === undefined) {
        // A serving socket without a recorded owner cannot be verified or
        // stopped safely; its operator supervises it manually.
        throw failure('RESIDENT_UNSUPERVISED', 409);
      }
      if (typeof listRunning === 'function') {
        const running = await listRunning(machine).catch(() => undefined);
        if (running === undefined) { if (probed.socket) throw failure('ACTIVE_WORK_UNVERIFIABLE', 409); }
        else if (running.length > 0) throw failure('ACTIVE_WORK_PRESENT', 409);
      } else if (probed.socket) throw failure('ACTIVE_WORK_UNVERIFIABLE', 409);
      const stopped = await exec(machine, stopScript(machine), { signal, timeoutMs: SETUP_LIMITS.stopMs });
      if (stopped.code === 76) throw failure('RESIDENT_STOP_TIMEOUT', 504);
      if (stopped.code !== 0) throw failure('RESIDENT_STOP_FAILED', 502);
      const cli = await ensureCli(machine, probed, signal, { wanted: machine.dshVersion });
      const profile = typeof probed.marker?.profile === 'string' ? probed.marker.profile : undefined;
      const environment = typeof readEnvironment === 'function' ? await readEnvironment().catch(() => null) : null;
      await provisionFiles(machine, probed, signal, { cli, bundleInfo, profile, environment });
      await start(machine, cli.cliBin, signal, profile);
      return { outcome: 'upgraded', detail: 'resident upgraded and restarted',
        from: probed.marker?.bundleVersion ?? null, to: bundleInfo.version };
    })().finally(() => { if (mutex.get(key) === task) mutex.delete(key); });
    mutex.set(key, task);
    return task;
  }
  async function status(machine, signal) {
    const bundleInfo = await latestBundle().catch(() => null);
    const probed = await probe(machine, signal).catch(error => ({ error: error.code }));
    const entry = { name: machine.name, socketPath: machine.socketPath,
      profile: machine.residentProfile ?? 'remote-resident',
      runtimeDirectory: machine.runtimeDirectory ?? dirname(machine.socketPath),
      autoSetup: machine.autoSetup !== false };
    if (probed.error) return { ...entry, state: 'unreachable', error: probed.error };
    const cli = await cliVersion(machine, probed, signal).catch(() => null);
    return { ...entry,
      state: probed.socket ? 'running' : probed.marker ? 'stopped' : 'absent',
      nodeVersion: probed.node ?? null,
      dshVersion: cli,
      dshCompatible: compatibleDshVersion(cli),
      bundleVersion: probed.marker?.bundleVersion ?? null,
      availableBundleVersion: bundleInfo?.version ?? null,
      upgradeAvailable: !!bundleInfo && !!probed.marker && probed.marker.bundleVersion !== bundleInfo.version,
      processAlive: probed.pid !== undefined,
      dshVersionWanted: machine.dshVersion ?? null,
      versionPinned: !!machine.dshVersion && machine.dshVersion !== cli,
    };
  }
  /** Sync the machine's pinned plugins on demand. A plugin-list change on a
   * serving resident requires a restart, so it reuses the upgrade guard:
   * active remote work refuses; otherwise stop, re-provision, re-sync, start.
   * The signature covers the synced model catalog too: a models/sync that
   * changed providers must re-provision and restart, never report in-sync. */
  async function sync(machine, signal) {
    if (machine.autoSetup === false) throw failure('AUTO_SETUP_DISABLED', 409);
    const key = machine.name;
    if (mutex.has(key)) return mutex.get(key);
    const task = (async () => {
      const environment = typeof readEnvironment === 'function' ? await readEnvironment().catch(() => null) : null;
      const signature = setupSignature(machine, environment);
      const probed = await probe(machine, signal);
      if (probed.socket && probed.marker?.plugins === signature) {
        return { outcome: 'in-sync', detail: 'resident already serves the pinned plugin list and model catalog', probe: probed };
      }
      if (probed.socket && probed.pid === undefined) throw failure('RESIDENT_UNSUPERVISED', 409);
      // Only ask the remote about active work when the socket is serving:
      // transport.identify triggers auto-setup on a dead socket and would
      // recurse the sync. A down socket has no observable work either.
      if (probed.socket && typeof listRunning === 'function') {
        const running = await listRunning(machine).catch(() => undefined);
        if (running === undefined) throw failure('ACTIVE_WORK_UNVERIFIABLE', 409);
        if (running.length > 0) throw failure('ACTIVE_WORK_PRESENT', 409);
      }
      if (probed.socket || probed.marker) {
        const stopped = await exec(machine, stopScript(machine), { signal, timeoutMs: SETUP_LIMITS.stopMs });
        if (stopped.code === 76) throw failure('RESIDENT_STOP_TIMEOUT', 504);
        if (stopped.code !== 0) throw failure('RESIDENT_STOP_FAILED', 502);
      }
      const cli = await ensureCli(machine, probed, signal, { wanted: machine.dshVersion });
      const bundleInfo = await latestBundle();
      const profile = typeof probed.marker?.profile === 'string' ? probed.marker.profile : undefined;
      await provisionFiles(machine, probed, signal, { cli, bundleInfo, profile, environment });
      await start(machine, cli.cliBin, signal, profile);
      return { outcome: 'synced', detail: 'plugins installed and resident restarted', plugins: signature };
    })().finally(() => { if (mutex.get(key) === task) mutex.delete(key); });
    mutex.set(key, task);
    return task;
  }
  return { probe, ensure, upgrade, sync, status };
}
