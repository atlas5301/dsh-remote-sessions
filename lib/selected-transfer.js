/**
 * Isolated selected-file / selected-skill transfer capabilities. Node built-ins
 * only. No import-time reads, SSH, shell commands, GUI integration or execution.
 *
 * Lead contract (all errors expose fixed codes, never file bytes):
 * - await scanSelectedTransfer({ kind: 'files'|'skills', localRoot: absolute,
 *     selections: string[], limits? }, capabilities?) -> frozen SHA256 manifest.
 *   Files are explicitly selected relative regular files. Skills are explicitly
 *   selected top-level directories, each with SKILL.md, recursively scanned.
 *   Bytes are copied into a private WeakMap, not properties of the manifest.
 *   capabilities is a trusted test seam: { fs: fs.promises, uid, fdBase }.
 * - createSelectedTransferProbePayload(manifest, { approval }) -> stdin JSON.
 *   approval = { kind, root, confirmed: true }; skills require exactly
 *   '~/.dsh/skills'; files require an explicitly confirmed absolute workspace.
 * - mergeSelectedTransferPreview(manifest, probeResult, { approval }) -> frozen
 *   per-path { localSha256, remoteSha256, status: create|unchanged|conflict }.
 *   Pure hash-only planning. The original preview is also a WeakMap capability.
 * - createSelectedTransferWritePayload(manifest, preview, {
 *     conflictAuthorizations?: [{ path, approveOverwrite: true,
 *       expectedLocalSha256, expectedRemoteSha256 }]
 *   }) -> PRIVATE stdin JSON containing selected base64 bytes. Default: reject
 *   every differing existing remote file. Exact per-path SHA approvals required.
 *   NEVER expose this string in argv, UI, logs, errors, telemetry or previews.
 * - generateRemoteSelectedTransferProbeProgram() / ...WriteProgram() -> static,
 *   secret-free CommonJS node -e source. Caller alone executes it, quoting ONLY
 *   that static source; root/paths/bytes/approvals travel solely on private stdin.
 *   Probe outputs JSON hashes/statuses, never bytes, and performs no writes.
 * - SELECTED_TRANSFER_LIMITS -> hard ceilings (callers may only lower them):
 *   256 files, 1 MiB/file, 8 MiB total, 16 relative components, 1024-byte
 *   relative paths (ASCII, max 255-byte component), 2048 scanned tree nodes.
 *   Program stdin is independently capped at 16 MiB.
 *
 * Safety/limitations: no memories, cooperation/resource-policy skills, links or
 * special local sources, or selected nested .dsh/.ssh/.config/.agents/.codex
 * stores. Local skill roots themselves may be under .dsh. Conservative
 * path/name/frontmatter exclusion is not a
 * semantic classifier: the operator must not rename memories/policy as files.
 * Remote requires Linux /proc/self/fd, O_NOFOLLOW/O_DIRECTORY and getuid; existing
 * approved root; uid-owned, non-group/world-writable directories/regular files.
 * System ancestors may be root-owned. No tar, deletion, chmod of existing files,
 * metadata transfer, resource-policy changes, skill pruning or blanket overwrite.
 * New files/backups/stages are 0600; new selected subdirectories are 0700.
 * Absent files use atomic no-clobber link publication with a RETAINED stage;
 * therefore published remote files have a stage hardlink. Remote hardlinks are
 * safe to read/replace because existing inodes are NEVER modified in place.
 * Workspace roots may not be top-level, hidden config directories or system
 * paths. SKILL.md policy identity checks also apply in individually-selected file
 * mode. Authorized replacement retains an owner-only byte backup before rename.
 * No unlink/rm/rmdir is used, including cleanup. Stages/backups remain for manual
 * recovery/retention. No filesystem evidence is written by these local helpers.
 * CAS rechecks detect drift, but Node lacks renameat2 conditional replacement:
 * a non-cooperating uid-owner writer can race the final SHA check/rename. This is
 * NOT an interprocess lock or a multi-file transaction; partial commits remain
 * possible, reported as hash/status entries on failure. Stronger guarantees need
 * an external exclusive owner lock or kernel conditional-rename capability.
 * Linux local scanning is fd-anchored. Other platforms hold nofollow directory
 * handles and revalidate ancestry; without openat they cannot rule out a hostile
 * concurrent ancestor swap during a path-based open. Use quiescent local roots.
 * No GUI, SSH authentication, DSH reload, ACL/xattr enforcement, remote skill
 * enablement or deployment is claimed. Hashes/selected filenames are public
 * fingerprints, not encryption; never select secrets unless intended.
 */
import { createHash } from 'node:crypto';
import { promises as nodeFs, constants } from 'node:fs';

export const SELECTED_TRANSFER_LIMITS = Object.freeze({
  maxFiles: 256, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024,
  maxDepth: 16, maxPathBytes: 1024, maxNodes: 2048,
});
const privateManifests = new WeakMap();
const privatePreviews = new WeakMap();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Shared by local helpers and the exact generated remote programs.
function transferCore(hash, ceilings) {
  const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const fields = (v, names, code) => {
    if (!object(v) || Object.keys(v).some((name) => !names.includes(name))) fail(code);
  };
  const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const frozen = (value) => {
    if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
    return value;
  };
  const order = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  function limits(input = {}) {
    fields(input, Object.keys(ceilings), 'INVALID_LIMITS');
    const result = { ...ceilings, ...input };
    for (const [name, value] of Object.entries(result)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[name]) fail('INVALID_LIMITS');
    }
    return result;
  }
  function forbiddenComponent(value) {
    const name = value.toLowerCase().replace(/[ _]/g, '-');
    return /^(?:\.)?(?:memories|memory)(?:$|[.-])/.test(name) ||
      /cooperation|resource-?policy/.test(name) || name.startsWith('.dsh-selected-transfer-');
  }
  function relative(value, bound, allowStores = false) {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > bound.maxPathBytes ||
      value.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(value)) fail('UNSAFE_PATH');
    const parts = value.split('/');
    if (parts.length > bound.maxDepth) fail('DEPTH_LIMIT');
    if (parts.some((part) => part.startsWith(' ') || part.endsWith(' '))) fail('UNSAFE_PATH');
    // Reject protected store components as well as memory/policy names. Otherwise
    // a uid-0 caller approving an ordinary ancestor could select nested config.
    if (!allowStores && parts.some((part) => ['.dsh', '.ssh', '.gnupg', '.config', '.agents', '.codex'].includes(part.toLowerCase()))) fail('FORBIDDEN_SELECTION');
    for (const part of parts) {
      if (part === '' || part === '.' || part === '..' || Buffer.byteLength(part) > 255 ||
        !/^[A-Za-z0-9._ -]+$/.test(part)) fail('UNSAFE_PATH');
      if (forbiddenComponent(part)) fail('FORBIDDEN_SELECTION');
    }
    return value;
  }
  function absolute(value, bound, local = false) {
    if (typeof value !== 'string' || value === '/' || !value.startsWith('/') || value.endsWith('/')) fail('INVALID_ROOT');
    relative(value.slice(1), { ...bound, maxDepth: 64 }, true);
    if (!local && value.split('/').some((part) => ['.dsh', '.ssh', '.gnupg'].includes(part.toLowerCase()))) fail('INVALID_ROOT');
    return value;
  }
  function approval(value, kind, bound) {
    fields(value, ['kind', 'root', 'confirmed'], 'ROOT_APPROVAL_REQUIRED');
    if (value.confirmed !== true || value.kind !== kind || !['files', 'skills'].includes(kind)) fail('ROOT_APPROVAL_REQUIRED');
    if (kind === 'skills') {
      if (value.root !== '~/.dsh/skills') fail('INVALID_SKILLS_ROOT');
    } else {
      absolute(value.root, bound);
      // An approved workspace may not be a system/config root even if the uid
      // could write it (especially uid 0). Nested ordinary workspaces are OK.
      const parts = value.root.slice(1).split('/');
      if (parts.length < 2 || ['bin', 'boot', 'dev', 'etc', 'lib', 'lib64', 'proc', 'sbin', 'sys', 'usr'].includes(parts[0]) ||
        parts.some((part) => part.startsWith('.'))) fail('INVALID_ROOT');
    }
    return { kind, root: value.root, confirmed: true };
  }
  function manifest(value, bound) {
    fields(value, ['version', 'kind', 'files', 'totalBytes', 'manifestHash'], 'INVALID_MANIFEST');
    if (value.version !== 1 || !['files', 'skills'].includes(value.kind) || !Array.isArray(value.files) ||
      !value.files.length || value.files.length > bound.maxFiles) fail('INVALID_MANIFEST');
    let total = 0;
    const paths = new Set();
    for (const file of value.files) {
      fields(file, ['path', 'bytes', 'sha256'], 'INVALID_MANIFEST');
      relative(file.path, bound);
      if (paths.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        file.bytes > bound.maxFileBytes || !sha(file.sha256)) fail('INVALID_MANIFEST');
      if (value.kind === 'skills' && !file.path.includes('/')) fail('INVALID_MANIFEST');
      paths.add(file.path); total += file.bytes;
    }
    // A selected file can never simultaneously be an ancestor of another file.
    for (const path of paths) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) fail('PATH_COLLISION');
    }
    if (value.kind === 'skills') {
      for (const name of new Set(value.files.map((file) => file.path.split('/')[0]))) {
        if (!paths.has(`${name}/SKILL.md`)) fail('SKILL_DOCUMENT_REQUIRED');
      }
    }
    if (total > bound.maxTotalBytes || total !== value.totalBytes) fail('TOTAL_SIZE_LIMIT');
    const canonical = { version: 1, kind: value.kind, files: [...value.files].sort(order), totalBytes: total };
    if (!sha(value.manifestHash) || hash(Buffer.from(JSON.stringify(canonical))) !== value.manifestHash) fail('MANIFEST_HASH_MISMATCH');
    return value;
  }
  function skillIdentity(bytes) {
    const text = bytes.subarray(0, 8192).toString('utf8');
    if (!/^---\r?\n/.test(text)) return;
    const end = text.indexOf('\n---', 4);
    if (end < 0) fail('INVALID_SKILL_HEADER');
    const header = text.slice(4, end);
    for (const line of header.split('\n')) {
      const found = /^\s*name\s*:\s*(.*?)\s*$/.exec(line);
      if (found) {
        const name = found[1].replace(/^['"]|['"]$/g, '');
        // Do not guess at YAML escapes, tags, aliases or multiline identities.
        if (!/^[A-Za-z0-9._ -]+$/.test(name)) fail('INVALID_SKILL_HEADER');
        if (forbiddenComponent(name)) fail('FORBIDDEN_SELECTION');
      }
    }
  }
  function preview(value, probe, root, bound) {
    manifest(value, bound);
    fields(probe, ['ok', 'version', 'kind', 'root', 'manifestHash', 'entries'], 'INVALID_PROBE');
    if (probe.ok !== true || probe.version !== 1 || probe.kind !== value.kind || probe.root !== root.root ||
      probe.manifestHash !== value.manifestHash || !Array.isArray(probe.entries) ||
      probe.entries.length !== value.files.length) fail('INVALID_PROBE');
    const remote = new Map();
    let total = 0;
    for (const entry of probe.entries) {
      fields(entry, ['path', 'remoteSha256', 'remoteBytes', 'status'], 'INVALID_PROBE');
      relative(entry.path, bound);
      if (remote.has(entry.path) || !Number.isSafeInteger(entry.remoteBytes) || entry.remoteBytes < 0 ||
        entry.remoteBytes > bound.maxFileBytes ||
        !(entry.status === 'absent' && entry.remoteSha256 === null && entry.remoteBytes === 0 ||
          entry.status === 'file' && sha(entry.remoteSha256))) fail('INVALID_PROBE');
      total += entry.remoteBytes; remote.set(entry.path, entry);
    }
    if (total > bound.maxTotalBytes) fail('TOTAL_SIZE_LIMIT');
    const entries = [...value.files].sort(order).map((file) => {
      const entry = remote.get(file.path);
      if (!entry) fail('INVALID_PROBE');
      return { path: file.path, bytes: file.bytes, localSha256: file.sha256,
        remoteSha256: entry.remoteSha256, remoteBytes: entry.remoteBytes,
        status: entry.remoteSha256 === null ? 'create' : entry.remoteSha256 === file.sha256 ? 'unchanged' : 'conflict' };
    });
    return frozen({ version: 1, kind: value.kind, root: root.root,
      manifestHash: value.manifestHash, entries, conflicts: entries.filter((entry) => entry.status === 'conflict').length });
  }
  function request(value, write) {
    fields(value, write ? ['version', 'approval', 'manifest', 'limits', 'entries'] :
      ['version', 'approval', 'manifest', 'limits'], 'INVALID_REQUEST');
    if (value.version !== 1) fail('INVALID_REQUEST');
    const bound = limits(value.limits);
    manifest(value.manifest, bound);
    const root = approval(value.approval, value.manifest.kind, bound);
    let entries;
    if (write) {
      if (!Array.isArray(value.entries) || value.entries.length !== value.manifest.files.length) fail('INVALID_REQUEST');
      const seen = new Set();
      const files = new Map(value.manifest.files.map((file) => [file.path, file]));
      entries = value.entries.map((entry) => {
        fields(entry, ['path', 'expectedLocalSha256', 'expectedRemoteSha256', 'approveOverwrite', 'contentBase64'], 'INVALID_REQUEST');
        const file = files.get(entry.path);
        if (!file || seen.has(entry.path) || entry.expectedLocalSha256 !== file.sha256 ||
          !(entry.expectedRemoteSha256 === null || sha(entry.expectedRemoteSha256)) ||
          typeof entry.approveOverwrite !== 'boolean' || typeof entry.contentBase64 !== 'string' ||
          entry.contentBase64.length > 4 * Math.ceil(bound.maxFileBytes / 3) ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.contentBase64)) fail('INVALID_REQUEST');
        const bytes = Buffer.from(entry.contentBase64, 'base64');
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail('CONTENT_HASH_MISMATCH');
        const differing = entry.expectedRemoteSha256 !== null && entry.expectedRemoteSha256 !== file.sha256;
        if (entry.approveOverwrite !== differing) fail('CONFLICT_AUTHORIZATION_REQUIRED');
        if (entry.path.split('/').at(-1) === 'SKILL.md') skillIdentity(bytes);
        seen.add(entry.path); return { ...entry, bytes };
      }).sort(order);
    }
    return { bound, root, entries, manifest: value.manifest };
  }
  return { fail, fields, sha, frozen, order, limits, relative, absolute, approval, manifest, skillIdentity, preview, request };
}
const core = transferCore(digest, SELECTED_TRANSFER_LIMITS);

// Linux fd paths anchor operations to verified directory inodes, not mutable
// ancestor path strings. Portable local scanning instead rechecks held ancestry.
function fileAccess(fs, flags, options, validation) {
  const { fail } = validation;
  const handles = [];
  const directories = [];
  const children = new Map();
  const fdBase = options.fdBase;
  if (typeof flags.O_NOFOLLOW !== 'number' || typeof flags.O_DIRECTORY !== 'number' ||
    typeof flags.O_NONBLOCK !== 'number') fail('NOFOLLOW_UNAVAILABLE');
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const inode = (stat, directory, rootOwned = false) => {
    if (directory ? !stat.isDirectory() : !stat.isFile()) fail(directory ? 'UNSAFE_DIRECTORY' : 'NON_REGULAR_FILE');
    if (options.remote) {
      if (!(stat.uid === options.uid || directory && rootOwned && stat.uid === 0) ||
        (stat.mode & 0o022) !== 0 || (stat.mode & 0o7000) !== 0 ||
        (!directory && (stat.mode & 0o400) === 0)) fail('UNSAFE_OWNER_MODE');
    } else if (!directory) {
      if (stat.nlink !== 1) fail('LOCAL_HARDLINK');
      if ((stat.mode & 0o7000) !== 0) fail('UNSAFE_OWNER_MODE');
    }
  };
  const at = (directory, name) => fdBase ? `${fdBase}/${directory.handle.fd}/${name}` :
    `${directory.path === '/' ? '' : directory.path}/${name}`;
  async function directory(path, parent, name, rootOwned = false) {
    if (parent) await verify();
    const before = await fs.lstat(path);
    if (before.isSymbolicLink()) fail('SYMLINK_REJECTED');
    inode(before, true, rootOwned);
    const handle = await fs.open(path, flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_DIRECTORY);
    handles.push(handle);
    const stat = await handle.stat();
    inode(stat, true, rootOwned);
    if (!same(before, stat)) fail('ANCESTRY_CHANGED');
    const item = { handle, parent, name, stat, path: parent ? `${parent.path === '/' ? '' : parent.path}/${name}` : '/', rootOwned };
    directories.push(item);
    if (parent) children.set(`${parent.handle.fd}/${name}`, item);
    return item;
  }
  async function root(path) {
    let current = await directory('/', null, '', true);
    const parts = path.slice(1).split('/');
    for (let i = 0; i < parts.length; i++) current = await directory(at(current, parts[i]), current, parts[i], i < parts.length - 1);
    await verify(); return current;
  }
  async function verify() {
    for (const item of directories) {
      const stat = await item.handle.stat();
      inode(stat, true, item.rootOwned);
      const named = await fs.lstat(item.parent ? at(item.parent, item.name) : '/');
      if (named.isSymbolicLink() || !same(named, stat) || !same(item.stat, stat)) fail('ANCESTRY_CHANGED');
      inode(named, true, item.rootOwned);
    }
  }
  async function child(parent, name, create = false) {
    await verify();
    const known = children.get(`${parent.handle.fd}/${name}`);
    if (known) return known;
    const target = at(parent, name);
    try { return await directory(target, parent, name); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return null;
      // Only selected descendants; never create the approved root or ancestors.
      try { await fs.mkdir(target, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      return directory(target, parent, name);
    }
  }
  async function parent(rootDir, path, create = false) {
    const parts = path.split('/');
    let current = rootDir;
    for (const name of parts.slice(0, -1)) {
      current = await child(current, name, create);
      if (!current) return null;
    }
    return current;
  }
  async function read(parentDir, name, bound, missing = false) {
    await verify();
    const path = at(parentDir, name);
    let before;
    try { before = await fs.lstat(path); }
    catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    if (before.isSymbolicLink()) fail('SYMLINK_REJECTED');
    inode(before, false);
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > bound.maxFileBytes) fail('FILE_SIZE_LIMIT');
    const handle = await fs.open(path, flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      inode(opened, false);
      if (!same(before, opened) || opened.size !== before.size) fail('FILE_CHANGED');
      const bytes = Buffer.alloc(opened.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const result = await handle.read(bytes, count, bytes.length - count, count);
        if (result.bytesRead === 0) break;
        count += result.bytesRead;
      }
      const after = await handle.stat();
      inode(after, false);
      if (!same(opened, after) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs || count !== opened.size) fail('FILE_CHANGED');
      await verify();
      const named = await fs.lstat(path);
      if (named.isSymbolicLink() || !same(named, after)) fail('FILE_CHANGED');
      inode(named, false);
      if (named.size !== after.size || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs) fail('FILE_CHANGED');
      return Buffer.from(bytes.subarray(0, count));
    } finally { await handle.close(); }
  }
  async function close() {
    let first;
    for (const handle of handles.reverse()) { try { await handle.close(); } catch (error) { first ??= error; } }
    if (first) throw first;
  }
  return { at, root, child, parent, read, verify, close };
}

/** The second argument is a trusted test seam, never a remote/UI capability. */
export async function scanSelectedTransfer(options, capabilities = {}) {
  core.fields(options, ['kind', 'localRoot', 'selections', 'limits'], 'INVALID_SCAN_OPTIONS');
  core.fields(capabilities, ['fs', 'uid', 'fdBase'], 'INVALID_CAPABILITIES');
  const bound = core.limits(options.limits);
  if (!['files', 'skills'].includes(options.kind) || !Array.isArray(options.selections) ||
    !options.selections.length || options.selections.length > bound.maxFiles) core.fail('EXPLICIT_SELECTION_REQUIRED');
  const rootPath = core.absolute(options.localRoot, bound, true);
  const selections = options.selections.map((path) => core.relative(path, bound)).sort();
  if (new Set(selections).size !== selections.length) core.fail('DUPLICATE_SELECTION');
  if (options.kind === 'skills' && selections.some((path) => path.includes('/'))) core.fail('TOP_LEVEL_SKILL_REQUIRED');
  const access = fileAccess(capabilities.fs ?? nodeFs, constants, {
    uid: capabilities.uid ?? process.getuid?.(), remote: false,
    fdBase: capabilities.fdBase ?? (process.platform === 'linux' ? '/proc/self/fd' : null),
  }, core);
  const data = new Map();
  let totalBytes = 0;
  let nodes = 0;
  async function collect(parent, name, path) {
    if (++nodes > bound.maxNodes) core.fail('NODE_LIMIT');
    core.relative(path, bound);
    const bytes = await access.read(parent, name, bound);
    totalBytes += bytes.length;
    if (totalBytes > bound.maxTotalBytes) core.fail('TOTAL_SIZE_LIMIT');
    if (data.size >= bound.maxFiles) core.fail('FILE_COUNT_LIMIT');
    if (name === 'SKILL.md') core.skillIdentity(bytes);
    data.set(path, bytes);
  }
  async function tree(parent, name, path) {
    if (++nodes > bound.maxNodes) core.fail('NODE_LIMIT');
    core.relative(path, bound);
    const directory = await access.child(parent, name);
    if (!directory) core.fail('SELECTION_NOT_FOUND');
    const entries = await (capabilities.fs ?? nodeFs).readdir(access.at(directory, '.'), { withFileTypes: true });
    if (entries.length > bound.maxNodes - nodes) core.fail('NODE_LIMIT');
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const relative = `${path}/${entry.name}`;
      core.relative(relative, bound);
      if (entry.isSymbolicLink()) core.fail('SYMLINK_REJECTED');
      if (entry.isDirectory()) await tree(directory, entry.name, relative);
      else if (entry.isFile()) await collect(directory, entry.name, relative);
      else core.fail('NON_REGULAR_FILE');
    }
  }
  try {
    const root = await access.root(rootPath);
    for (const path of selections) {
      if (options.kind === 'skills') {
        await tree(root, path, path);
        if (!data.has(`${path}/SKILL.md`)) core.fail('SKILL_DOCUMENT_REQUIRED');
      } else {
        const parent = await access.parent(root, path);
        if (!parent) core.fail('SELECTION_NOT_FOUND');
        await collect(parent, path.split('/').at(-1), path);
      }
    }
    const files = [...data.entries()].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) })).sort(core.order);
    const canonical = { version: 1, kind: options.kind, files, totalBytes };
    const manifest = core.frozen({ ...canonical, manifestHash: digest(Buffer.from(JSON.stringify(canonical))) });
    core.manifest(manifest, bound);
    privateManifests.set(manifest, { data, bound });
    return manifest;
  } catch (error) {
    // Do not leak filesystem error messages that can include source paths.
    if (error.message !== error.code) core.fail('SOURCE_IO_ERROR');
    throw error;
  } finally {
    try { await access.close(); } catch { core.fail('SOURCE_IO_ERROR'); }
  }
}

function source(manifest) {
  const privateData = privateManifests.get(manifest);
  if (!privateData) core.fail('UNKNOWN_MANIFEST');
  return privateData;
}
export function createSelectedTransferProbePayload(manifest, options) {
  const { bound } = source(manifest);
  core.fields(options, ['approval'], 'INVALID_PROBE_OPTIONS');
  const approval = core.approval(options.approval, manifest.kind, bound);
  return JSON.stringify({ version: 1, approval, manifest, limits: bound });
}
export function mergeSelectedTransferPreview(manifest, probeResult, options) {
  // Hash-only inputs may be deserialized; write capability still requires the
  // original scanned manifest AND the original preview bound to that object.
  core.fields(options, ['approval'], 'INVALID_PREVIEW_OPTIONS');
  const bound = privateManifests.get(manifest)?.bound ?? core.limits();
  core.manifest(manifest, bound);
  const approval = core.approval(options.approval, manifest.kind, bound);
  const preview = core.preview(manifest, probeResult, approval, bound);
  privatePreviews.set(preview, { manifest, approval, bound });
  return preview;
}
export function createSelectedTransferWritePayload(manifest, preview, options = {}) {
  const { data, bound } = source(manifest);
  const prepared = privatePreviews.get(preview);
  if (!prepared || prepared.manifest !== manifest) core.fail('UNKNOWN_PREVIEW');
  core.fields(options, ['conflictAuthorizations'], 'INVALID_WRITE_OPTIONS');
  const authorizations = options.conflictAuthorizations ?? [];
  if (!Array.isArray(authorizations) || authorizations.length > bound.maxFiles) core.fail('INVALID_CONFLICT_AUTHORIZATION');
  const approved = new Map();
  for (const item of authorizations) {
    core.fields(item, ['path', 'approveOverwrite', 'expectedLocalSha256', 'expectedRemoteSha256'], 'INVALID_CONFLICT_AUTHORIZATION');
    const entry = preview.entries.find((entry) => entry.path === item.path);
    if (!entry || entry.status !== 'conflict' || approved.has(item.path) || item.approveOverwrite !== true ||
      item.expectedLocalSha256 !== entry.localSha256 || item.expectedRemoteSha256 !== entry.remoteSha256) core.fail('INVALID_CONFLICT_AUTHORIZATION');
    approved.set(item.path, item);
  }
  const entries = preview.entries.map((entry) => {
    if (entry.status === 'conflict' && !approved.has(entry.path)) core.fail('REMOTE_CONFLICT');
    return { path: entry.path, expectedLocalSha256: entry.localSha256,
      expectedRemoteSha256: entry.remoteSha256, approveOverwrite: approved.has(entry.path),
      contentBase64: data.get(entry.path).toString('base64') };
  });
  const request = { version: 1, approval: prepared.approval, manifest, limits: bound, entries };
  core.request(request, true);
  return JSON.stringify(request);
}

async function remoteTransfer(request, write, dependencies) {
  const { fs, flags, uid, home, platform, hash, random, validation } = dependencies;
  const { fail } = validation;
  if (platform !== 'linux' || !Number.isSafeInteger(uid) || uid < 0) fail('REMOTE_PLATFORM_UNSUPPORTED');
  const parsed = validation.request(request, write);
  const rootPath = parsed.root.kind === 'skills' ? `${validation.absolute(home, parsed.bound, true)}/.dsh/skills` : parsed.root.root;
  const access = fileAccess(fs, flags, { remote: true, uid, fdBase: '/proc/self/fd' }, validation);
  const applied = [];
  const status = (entry, remoteSha256, result) => ({ path: entry.path,
    localSha256: entry.expectedLocalSha256, remoteSha256, status: result });
  async function remoteFile(root, path) {
    const parent = await access.parent(root, path);
    return parent ? access.read(parent, path.split('/').at(-1), parsed.bound, true) : null;
  }
  async function artifact(parent, bytes, suffix) {
    await access.verify();
    const name = `.dsh-selected-transfer-${random()}.${suffix}`;
    if (!/^\.dsh-selected-transfer-[a-f0-9]{32}\.(?:stage|backup)$/.test(name)) fail('INVALID_RANDOM_ID');
    const target = access.at(parent, name);
    const handle = await fs.open(target, flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size !== bytes.length) fail('UNSAFE_ARTIFACT');
    } finally { await handle.close(); }
    const check = await access.read(parent, name, parsed.bound);
    if (hash(check) !== hash(bytes)) fail('ARTIFACT_HASH_MISMATCH');
    return target;
  }
  try {
    const root = await access.root(rootPath);
    if (!write) {
      const entries = [];
      let total = 0;
      for (const file of [...parsed.manifest.files].sort(validation.order)) {
        const bytes = await remoteFile(root, file.path);
        total += bytes?.length ?? 0;
        if (total > parsed.bound.maxTotalBytes) fail('TOTAL_SIZE_LIMIT');
        entries.push({ path: file.path, remoteSha256: bytes === null ? null : hash(bytes),
          remoteBytes: bytes?.length ?? 0, status: bytes === null ? 'absent' : 'file' });
      }
      return { ok: true, version: 1, kind: parsed.manifest.kind, root: parsed.root.root,
        manifestHash: parsed.manifest.manifestHash, entries };
    }
    // Refuse mixed descendant-parent failures before staging any earlier entry.
    // A file target absent at probe can have become a directory by write time.
    // Preflight EVERY expected hash before the first mkdir/stage/backup.
    const originals = new Map();
    let total = 0;
    for (const entry of parsed.entries) {
      const bytes = await remoteFile(root, entry.path);
      total += bytes?.length ?? 0;
      if (total > parsed.bound.maxTotalBytes) fail('TOTAL_SIZE_LIMIT');
      if ((bytes === null ? null : hash(bytes)) !== entry.expectedRemoteSha256) fail('REMOTE_CAS_MISMATCH');
      originals.set(entry.path, bytes);
    }
    for (const entry of parsed.entries) {
      if (entry.expectedRemoteSha256 === entry.expectedLocalSha256) {
        applied.push(status(entry, entry.expectedRemoteSha256, 'unchanged')); continue;
      }
      const parent = await access.parent(root, entry.path, true);
      const name = entry.path.split('/').at(-1);
      const target = access.at(parent, name);
      const stage = await artifact(parent, entry.bytes, 'stage');
      if (entry.approveOverwrite) await artifact(parent, originals.get(entry.path), 'backup');
      // Make artifact directory entries durable before publishing/replacing.
      await parent.handle.sync();
      await access.verify();
      const staged = await access.read(parent, stage.split('/').at(-1), parsed.bound);
      if (hash(staged) !== entry.expectedLocalSha256) fail('ARTIFACT_HASH_MISMATCH');
      const current = await access.read(parent, name, parsed.bound, true);
      if ((current === null ? null : hash(current)) !== entry.expectedRemoteSha256) fail('REMOTE_CAS_MISMATCH');
      if (entry.expectedRemoteSha256 === null) {
        // link is atomic and fails if ANY destination appeared; never clobbers.
        await fs.link(stage, target);
      } else {
        // Explicit hash-authorized overwrite only. Backup already durable.
        // No Node built-in provides an atomic conditional-hash rename.
        await fs.rename(stage, target);
      }
      applied.push(status(entry, entry.expectedLocalSha256, entry.approveOverwrite ? 'replaced' : 'created'));
      await parent.handle.sync();
    }
    return { ok: true, version: 1, manifestHash: parsed.manifest.manifestHash, entries: applied };
  } catch (error) {
    // Attach only deliberately constructed hash/status rows, not private bytes.
    error.applied = applied; throw error;
  } finally { await access.close(); }
}

function generated(write) {
  // This source is identical for every manifest/root/content value. No values
  // are interpolated except immutable module constants and the operation flag.
  return `'use strict';\n` +
    `const fs = require('node:fs');\nconst crypto = require('node:crypto');\nconst os = require('node:os');\n` +
    `const ceilings = ${JSON.stringify(SELECTED_TRANSFER_LIMITS)};\n` +
    `const transferCore = ${transferCore.toString()};\n` +
    `const fileAccess = ${fileAccess.toString()};\n` +
    `const remoteTransfer = ${remoteTransfer.toString()};\n` +
    `const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');\n` +
    `const validation = transferCore(hash, ceilings);\n` +
    `let size = 0; const chunks = []; let finished = false;\n` +
    `const safeCodes = new Set(['INVALID_REQUEST','INVALID_LIMITS','INVALID_MANIFEST','UNSAFE_PATH','DEPTH_LIMIT','FORBIDDEN_SELECTION','INVALID_ROOT','ROOT_APPROVAL_REQUIRED','INVALID_SKILLS_ROOT','PATH_COLLISION','SKILL_DOCUMENT_REQUIRED','TOTAL_SIZE_LIMIT','MANIFEST_HASH_MISMATCH','CONTENT_HASH_MISMATCH','CONFLICT_AUTHORIZATION_REQUIRED','INVALID_SKILL_HEADER','REMOTE_PLATFORM_UNSUPPORTED','NOFOLLOW_UNAVAILABLE','UNSAFE_DIRECTORY','NON_REGULAR_FILE','UNSAFE_OWNER_MODE','SYMLINK_REJECTED','ANCESTRY_CHANGED','FILE_SIZE_LIMIT','FILE_CHANGED','INVALID_RANDOM_ID','UNSAFE_ARTIFACT','ARTIFACT_HASH_MISMATCH','REMOTE_CAS_MISMATCH','STDIN_SIZE_LIMIT','INVALID_STDIN','EACCES','EPERM','ENOENT','ENOTDIR','EEXIST']);\n` +
    `function report(error) { if (finished) return; finished = true; process.stdout.write(JSON.stringify({ ok: false, error: safeCodes.has(error.code) ? error.code : 'TRANSFER_IO_ERROR', entries: error.applied || [] }) + '\\n'); process.exitCode = 1; }\n` +
    `process.stdin.on('data', chunk => { if (finished) return; const bytes = Buffer.from(chunk); size += bytes.length; if (size > 16 * 1024 * 1024) { report({code:'STDIN_SIZE_LIMIT'}); chunks.length = 0; return; } chunks.push(bytes); });\n` +
    `process.stdin.on('error', () => report({code:'INVALID_STDIN'}));\n` +
    `process.stdin.on('end', async () => { if (finished) return; try { let request; try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { validation.fail('INVALID_STDIN'); } chunks.length = 0; const result = await remoteTransfer(request, ${write}, { fs: fs.promises, flags: fs.constants, uid: typeof process.getuid === 'function' ? process.getuid() : null, home: os.userInfo().homedir, platform: process.platform, hash, random: () => crypto.randomBytes(16).toString('hex'), validation }); if (!finished) { finished = true; process.stdout.write(JSON.stringify(result) + '\\n'); } } catch (error) { report(error); } });\n`;
}
export function generateRemoteSelectedTransferProbeProgram() { return generated(false); }
export function generateRemoteSelectedTransferWriteProgram() { return generated(true); }
