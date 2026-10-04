// Read dsh-remote's existing picker metadata; never replace its picker or UI.
// Explicit operator mapping is required: mutable active-machine state is not used.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fault } from './protocol.js';

export function createMirrorResolver({ root, targets, identify }) {
  const registry = path.resolve(root);
  return async cwd => {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    const local = path.resolve(cwd), relative = path.relative(registry, local);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    // dsh-remote stores <host-user-port>/<workspace>/.dsh-remote-meta.json.
    const segments = relative.split(path.sep);
    if (segments.length < 2 || segments.some(value => !value)) throw fault('INVALID_REMOTE_MIRROR');
    const mirror = path.join(registry, segments[0], segments[1]);
    if (await fs.realpath(local) !== local || await fs.realpath(mirror) !== mirror) throw fault('UNSAFE_REMOTE_MIRROR');
    const file = path.join(mirror, '.dsh-remote-meta.json'), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || stat.uid !== process.getuid?.() || stat.mode & 0o022) throw fault('UNSAFE_REMOTE_MIRROR');
    let meta;
    try { meta = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw fault('INVALID_REMOTE_MIRROR'); }
    if (!meta || typeof meta.remotePath !== 'string' || !meta.remotePath.startsWith('/') || /[\0\r\n]/.test(meta.remotePath)) throw fault('INVALID_REMOTE_MIRROR');
    const candidates = targets.filter(target => target.alias
      ? target.alias === meta.alias
      : target.host === meta.host && target.username === meta.username && (target.port ?? 22) === (Number(meta.port) || 22));
    if (candidates.length !== 1) throw fault('REMOTE_MIRROR_NOT_CONFIGURED');
    const identity = await identify(candidates[0].target);
    return { ...identity, remoteCwd: path.posix.join(meta.remotePath, ...segments.slice(2)) };
  };
}
