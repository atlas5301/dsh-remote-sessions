// Standalone backend routing for ordinary native DSH workspaces. No dsh-remote
// package or metadata is required. Longest configured root wins. The mapping
// table can be swapped at runtime by control actions (remote workspace open/
// remove) without waiting for the config reload to re-apply the plugin.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fault } from './protocol.js';

export function normalizeWorkspaceMappings(workspaces = []) {
  const roots = new Set();
  return workspaces.map(value => {
    if (!value || typeof value.localPath !== 'string' || !path.isAbsolute(value.localPath) || typeof value.remotePath !== 'string' || !value.remotePath.startsWith('/') || typeof value.target !== 'string' || !value.target || /[\0\r\n]/.test(value.localPath + value.remotePath + value.target)) throw fault('INVALID_WORKSPACE_BINDING');
    const localPath = path.resolve(value.localPath);
    if (roots.has(localPath)) throw fault('DUPLICATE_WORKSPACE_BINDING');
    roots.add(localPath);
    return { localPath, remotePath: path.posix.resolve(value.remotePath), target: value.target };
  }).sort((a, b) => b.localPath.length - a.localPath.length);
}

export function createWorkspaceResolver({ workspaces = [], identify, compatibility }) {
  const mappings = normalizeWorkspaceMappings(workspaces);
  /** The resolver stays callable: the session proxy awaits it directly. */
  const resolve = async cwd => {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    const local = path.resolve(cwd);
    for (const mapping of mappings) {
      const relative = path.relative(mapping.localPath, local);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
      if (await fs.realpath(local) !== local || await fs.realpath(mapping.localPath) !== mapping.localPath) throw fault('UNSAFE_WORKSPACE_BINDING');
      if (!(await fs.stat(local)).isDirectory()) throw fault('INVALID_WORKSPACE_BINDING');
      return { ...await identify(mapping.target), remoteCwd: path.posix.join(mapping.remotePath, ...relative.split(path.sep)) };
    }
    return compatibility ? compatibility(local) : null;
  };
  resolve.refresh = next => {
    const replaced = normalizeWorkspaceMappings(next);
    mappings.length = 0;
    for (const mapping of replaced) mappings.push(mapping);
  };
  resolve.snapshot = () => mappings.map(value => ({ ...value }));
  return resolve;
}
