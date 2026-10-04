#!/usr/bin/env node
// Explicit offline preparation only: creates NEW profile/service files, never starts,
// reloads, enables, restarts, deletes or replaces an existing runtime.
import { promises as fs } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const opts = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--home', '--profile', '--runtime-directory', '--node', '--cli'].includes(key) || !value || opts[key]) throw new Error('Usage: prepare-resident.mjs --home ABS --profile NAME --runtime-directory ABS --node ABS --cli ABS');
  opts[key] = value;
}
for (const key of ['--home','--runtime-directory','--node','--cli']) if (!opts[key]?.startsWith('/') || /[\0\r\n]/.test(opts[key])) throw new Error('Explicit absolute paths are required: ' + key);
const profile = opts['--profile'];
if (!/^[a-z][a-z0-9-]{1,50}$/.test(profile ?? '') || ['desktop','web','headless','acp','sdk','sdk-minimal'].includes(profile)) throw new Error('Choose a new, non-shipped profile name');
const home = resolve(opts['--home']), runtime = resolve(opts['--runtime-directory']);
if (Buffer.byteLength(runtime + '/agent.sock') > 100) throw new Error('Runtime directory is too long for a portable Unix socket');
for (const executable of [opts['--node'], opts['--cli']]) { const st = await fs.stat(executable); if (!st.isFile()) throw new Error('Executable/CLI must exist'); }
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = join(home, 'profiles', profile);
// Parents must exist and must not be symlinks; no broad recursive home creation.
for (const parent of [home, join(home, 'profiles'), dirname(runtime)]) {
  if (resolve(await fs.realpath(parent)) !== parent) throw new Error('Parent must be a real, existing directory');
  const st = await fs.stat(parent); if (!st.isDirectory() || st.uid !== process.getuid()) throw new Error('Parent must be owned by the current user');
  for (let ancestor = parent; ; ancestor = dirname(ancestor)) {
    const info = await fs.lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.getuid()].includes(info.uid) || ((info.mode & 0o022) && !(info.mode & 0o1000))) throw new Error('Unsafe ancestor ownership or permissions');
    if (dirname(ancestor) === ancestor) break;
  }
}
for (const path of [target, runtime]) {
  try { await fs.lstat(path); throw new Error('Refusing existing directory: ' + path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await fs.mkdir(target, { mode: 0o700 });
await fs.mkdir(runtime, { mode: 0o700 });
const write = (name, text) => fs.writeFile(join(target, name), text, { flag: 'wx', mode: 0o600 });
await fs.mkdir(join(target, 'node_modules'), { mode: 0o700 });
await fs.symlink(join(root, 'resident'), join(target, 'node_modules', 'dsh-remote-sessions-resident'), 'dir');
await write('package.json', JSON.stringify({ private: true, type: 'module', dependencies: { 'dsh-remote-sessions-resident': 'file:' + join(root, 'resident') }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-remote-sessions-resident'] } } }, null, 2) + '\n');
await write('cordis.patch.yml', '# Explicit resident directory; no model or credential stores are copied.\n- id: remote-resident\n  config:\n    runtimeDirectory: ' + JSON.stringify(runtime) + '\n');
const unitQuote = text => '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
await write('dsh-remote-resident.service', '[Unit]\nDescription=DSH resident agent (' + profile + ')\nAfter=network-online.target\n\n[Service]\nType=simple\nUMask=0077\nEnvironment=' + unitQuote('DSH_HOME=' + home) + '\nEnvironment=' + unitQuote('DSH_REMOTE_RUNTIME_DIR=' + runtime) + '\nExecStart=' + [opts['--node'],opts['--cli'],'--profile',profile].map(unitQuote).join(' ') + '\nRestart=no\nTimeoutStopSec=90\n\n[Install]\nWantedBy=default.target\n');
console.log(JSON.stringify({ prepared: true, profile: target, socketPath: join(runtime, 'agent.sock'), serviceTemplate: join(target,'dsh-remote-resident.service'), started: false, note: 'Review the profile and unit. Configure remote models/credentials explicitly. Install/enable the user service separately. No resident runtime was touched.' }, null, 2));
