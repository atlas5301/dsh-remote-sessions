// Remote forwarding for the native workspace file-tree and terminal services.
// Like the session proxy, only the owning service instance's public methods are
// wrapped; ordinary local calls keep their original receiver. A remote-bound
// session NEVER falls back to local files or a local PTY: forwarding failures
// surface as errors in the unchanged native UI.
import { fault } from './protocol.js';

/** Wire tag for binary payloads crossing the JSON relay; see runtime-adapter. */
export const BYTES_TAG = '$dshBytes';

export function decodeTagged(value) {
  if (value === null || typeof value !== 'object') return value;
  if (BYTES_TAG in value && typeof value[BYTES_TAG] === 'string') return new Uint8Array(Buffer.from(value[BYTES_TAG], 'base64'));
  if (Array.isArray(value)) return value.map(decodeTagged);
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = decodeTagged(item);
  return copy;
}

/** Map a UI file path onto the remote workspace: absolute anchor paths become
 * workspace-relative so the remote root resolves them; other absolute paths
 * pass through unchanged and resolve under the remote user's authority. */
export function mapWorkspacePath(binding, path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return path;
  const anchor = String(binding.cwd ?? '').replace(/\/+$/, '');
  if (!anchor) return path;
  if (path === anchor) return '.';
  if (path.startsWith(anchor + '/')) return path.slice(anchor.length + 1);
  return path;
}

/**
 * Install optional service overlays. Each service is wrapped when it becomes
 * available (their host composition varies by profile); wrappers are restored
 * when the fiber or the whole overlay disposes. `bindings` and `transport`
 * come from the native host installation.
 */
export function installNativeServices(ctx, { bindings, transport }) {
  let disposed = false;
  const alive = () => { if (disposed) throw fault('PROXY_UNAVAILABLE'); };
  const trailingSignal = args => (args.length && args.at(-1) instanceof AbortSignal ? args.at(-1) : undefined);
  const withoutSignal = args => (args.length && args.at(-1) instanceof AbortSignal ? args.slice(0, -1) : args);

  function wrapService(owner, methods, onDispose) {
    const restores = [];
    const installed = (name, wrapper) => Object.getOwnPropertyDescriptor(owner, name)?.value === wrapper;
    for (const [name, handler] of methods) {
      const original = owner[name];
      if (typeof original !== 'function') throw fault('INCOMPATIBLE_DSH');
      const wrapper = function (...args) { return handler.call(this, original, args); };
      owner[name] = wrapper;
      restores.push(() => { if (installed(name, wrapper)) owner[name] = original; });
    }
    onDispose(() => { for (const restore of restores.reverse()) { try { restore(); } catch {} } restores.length = 0; });
  }

  // ── workspaceFiles: the native sidebar file tree, previews and watches ──────
  const filesFiber = ctx.inject(['workspaceFiles'], scope => {
    wrapService(scope.workspaceFiles, [
      ...['read', 'readBytes', 'stat', 'list'].map(name => [name, function (original, args) {
        const [fileScope, path, ...rest] = args;
        const binding = bindings.get(fileScope?.sessionId);
        if (!binding) return original.apply(this, args);
        alive();
        const result = transport.call(binding, 'workspaceFiles/' + name,
          [binding.remoteSessionId, mapWorkspacePath(binding, path), ...withoutSignal(rest)], trailingSignal(args));
        return name === 'readBytes' ? result.then(decodeTagged) : result;
      }]),
      ['changes', function (original, args) {
        const [fileScope, path] = args;
        const binding = bindings.get(fileScope?.sessionId);
        if (!binding) return original.apply(this, args);
        alive();
        const signal = trailingSignal(args);
        return { async *[Symbol.asyncIterator]() {
          yield* transport.stream(binding, 'workspaceFiles/changes', [binding.remoteSessionId, mapWorkspacePath(binding, path)], signal);
        } };
      }],
    ], cleanup => scope.effect(() => cleanup, 'remote-sessions.workspace-files'));
  });

  // ── terminalController: native session terminals over the remote PTY ────────
  const terminalFiber = ctx.inject(['terminalController'], scope => {
    wrapService(scope.terminalController, [
      ...['environment', 'shells', 'create', 'write', 'resize', 'rename', 'close'].map(name => [name, function (original, args) {
        const binding = bindings.get(args[0]?.id);
        if (!binding) return original.apply(this, args);
        alive();
        return transport.call(binding, 'terminal/' + name,
          [binding.remoteSessionId, ...withoutSignal(args.slice(1))], trailingSignal(args));
      }]),
      ['list', function (original, args) {
        const binding = bindings.get(args[0]);
        if (!binding) return original.apply(this, args);
        alive();
        return transport.call(binding, 'terminal/list', [binding.remoteSessionId]);
      }],
      ...['retain', 'follow'].map(name => [name, function (original, args) {
        const binding = bindings.get(args[0]?.id ?? args[0]);
        if (!binding) return original.apply(this, args);
        alive();
        const signal = trailingSignal(args);
        const params = withoutSignal(args.slice(1));
        return { async *[Symbol.asyncIterator]() {
          yield* transport.stream(binding, 'terminal/' + name, [binding.remoteSessionId, ...params], signal);
        } };
      }]),
    ], cleanup => scope.effect(() => cleanup, 'remote-sessions.terminal'));
  });

  return {
    async dispose() {
      disposed = true;
      await Promise.allSettled([filesFiber.dispose(), terminalFiber.dispose()]);
    },
  };
}
