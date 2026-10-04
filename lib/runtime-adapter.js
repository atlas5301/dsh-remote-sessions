// All DSH coupling lives here. Only public Connection, Typert and Gateway APIs.
// No imported private implementation, browser bootstrap, cookie or source rewriting.
import { randomUUID } from 'node:crypto';
import { PROTOCOL, StreamShelf, exact, fault, plain } from './protocol.js';
import { createUploadRelay } from './upload-relay.js';

export const READ_ENDPOINTS = Object.freeze([
  'session/list', 'session/page', 'session/projections', 'session/modelCatalog', 'session/attachment',
  'session/search', 'userQuestions/attachWait', 'skills/list', 'commands/list', 'fileReferences/list', 'workspace/follow', 'session/follow', 'session/control',
  'workspaceFiles/list', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/stat',
  'terminal/environment', 'terminal/shells', 'terminal/list',
]);
export const WRITE_ENDPOINTS = Object.freeze([
  'session/create', 'session/prompt', 'session/cancel', 'session/rename', 'session/selectModel',
  'session/updateQueue', 'session/fork', 'workspace/create', 'workspace/rename', 'fileUploads/upload', 'commands/execute', 'userQuestions/answer',
  'terminal/create', 'terminal/write', 'terminal/resize', 'terminal/rename', 'terminal/close',
]);
export const STREAM_ENDPOINTS = Object.freeze(['session/follow', 'workspace/follow', 'session/control', 'userQuestions/attachWait', 'workspaceFiles/changes', 'terminal/follow', 'terminal/retain']);
const ALLOWED = new Set([...READ_ENDPOINTS, ...WRITE_ENDPOINTS, ...STREAM_ENDPOINTS]);
export const REQUIRED = ['session/list', 'session/create', 'session/prompt', 'session/follow', 'session/page', 'session/cancel'];
export const BYTES_TAG = '$dshBytes';
export const EMPTY_UPLINK = Object.freeze({ async *[Symbol.asyncIterator]() {} });

export function createRuntimeAdapter(ctx, { runtimeId, instanceId = randomUUID() }) {
  const connection = ctx.get?.('connection') ?? ctx.connection;
  const gateway = ctx.get?.('typertGateway') ?? ctx.typertGateway;
  const typert = ctx.get?.('typert') ?? ctx.typert;
  if (typeof connection?.createSharedFetchHandler !== 'function' || typeof gateway?.wireStream?.open !== 'function' || typeof typert?.local?.get !== 'function') throw fault('INCOMPATIBLE_DSH');
  const descriptors = new Map();
  for (const endpoint of ALLOWED) {
    const descriptor = typert.local.get(endpoint);
    if (descriptor && Array.isArray(descriptor.parameters) && descriptor.parameters.every(p => typeof p.wire === 'string')) descriptors.set(endpoint, descriptor);
  }
  for (const endpoint of REQUIRED) if (!descriptors.has(endpoint)) throw fault('INCOMPATIBLE_DSH');
  const fetcher = connection.createSharedFetchHandler('/api');
  const hello = Object.freeze({ protocol: PROTOCOL, runtimeId, instanceId,
    capabilities: [...descriptors].map(([endpoint, d]) => ({ endpoint, stream: d.mode === 'stream', parameters: d.parameters.map(p => p.wire) })),
    features: ['session-journal', 'pending-approvals', 'no-ui-assets', 'transport-independent-agent',
      ...descriptors.has('workspaceFiles/list') ? ['workspace-files'] : [],
      ...descriptors.has('terminal/create') ? ['remote-terminal'] : []] });
  function payload(endpoint, values) {
    const d = descriptors.get(endpoint);
    if (!d || !Array.isArray(values) || values.length > d.parameters.length) throw fault('UNSUPPORTED_OPERATION');
    // Re-check the live descriptors. An unload/upgrade cannot silently change routing.
    if (typert.local.get(endpoint) !== d) throw fault('RUNTIME_CHANGED');
    return { args: Object.fromEntries(d.parameters.flatMap((p, i) => values[i] === undefined ? [] : [[p.wire, values[i]]])) };
  }
  /** Tag Uint8Array results so the JSON relay carries them losslessly; the
   * local overlay decodes the tag back into bytes before the native reply. */
  function tagBytes(endpoint, value) {
    if (endpoint !== 'workspaceFiles/readBytes' || value === null || typeof value !== 'object') return value;
    if (value.data instanceof Uint8Array) return { ...value, data: { [BYTES_TAG]: Buffer.from(value.data).toString('base64') } };
    return value;
  }
  /**
   * One RPC may carry byte attachments: the DSH connection encodes binary
   * results as multipart FormData with a `metadata` JSON part plus `bytes-N`
   * parts addressed by paths into the result value. Rebuild the plain result.
   */
  async function readRpcEnvelope(response, rpcId) {
    const type = response.headers.get('content-type') ?? '';
    let envelope;
    if (type.includes('multipart/form-data')) {
      const form = await response.formData();
      const meta = form.get('metadata');
      if (meta === null) throw fault('INVALID_RUNTIME_REPLY');
      envelope = JSON.parse(String(meta));
      for (const attachment of envelope.attachments ?? []) {
        if (!Array.isArray(attachment.path) || typeof attachment.part !== 'string') throw fault('INVALID_RUNTIME_REPLY');
        const part = form.get(attachment.part);
        if (part === null) throw fault('INVALID_RUNTIME_REPLY');
        const bytes = new Uint8Array(await part.arrayBuffer());
        let cursor = envelope.result?.value;
        for (const step of attachment.path.slice(0, -1)) cursor = cursor?.[step];
        if (cursor === null || typeof cursor !== 'object') throw fault('INVALID_RUNTIME_REPLY');
        cursor[attachment.path.at(-1)] = bytes;
      }
    } else envelope = await response.json();
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || typeof envelope.result?.ok !== 'boolean') throw fault('INVALID_RUNTIME_REPLY');
    return envelope.result;
  }
  async function rpc(endpoint, body, signal) {
    const rpcId = randomUUID();
    const response = await fetcher.fetch(new Request('http://plugin.internal/api/' + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: body }),
    }));
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !(type.includes('application/json') || type.includes('multipart/form-data'))) throw fault('UNSUPPORTED_RESPONSE');
    return readRpcEnvelope(response, rpcId);
  }
  return {
    hello,
    // Each transport gets observers; none owns or disposes a DSH Agent.
    client() {
      const streams = new StreamShelf();
      const uploads = createUploadRelay(ctx.get?.('fileUploads'));
      const eventClients = new Set();
      let closed = false;
      return {
        async handle(method, params, signal) {
          if (closed) throw fault('TRANSPORT_LOST');
          if (['upload-start', 'upload-chunk', 'upload-finish', 'upload-abort'].includes(method)) return uploads.handle(method, params, signal);
          if (method === 'hello') { exact(params, ['protocol']); if (params.protocol !== PROTOCOL) throw fault('INCOMPATIBLE_PROTOCOL'); return hello; }
          if (method === 'call') {
            exact(params, ['endpoint', 'values', 'confirmDefaultChange']);
            if (params.endpoint === 'session/selectModel') {
              if (params.confirmDefaultChange !== true) throw fault('DEFAULT_CHANGE_CONFIRMATION_REQUIRED');
            } else if (params.confirmDefaultChange !== undefined) throw fault('INVALID_REQUEST');
            if (!descriptors.has(params.endpoint) || descriptors.get(params.endpoint).mode !== undefined) throw fault('UNSUPPORTED_OPERATION');
            const result = await rpc(params.endpoint, payload(params.endpoint, params.values), signal);
            // Preserve the {ok, value} envelope; only byte-carrying values are
            // tagged so the JSON relay transports them losslessly.
            return result.ok ? { ...result, value: tagBytes(params.endpoint, result.value) } : result;
          }
          if (method === 'open') {
            exact(params, ['endpoint', 'values']);
            const events = params.endpoint === '$events';
            if (!events && descriptors.get(params.endpoint)?.mode !== 'stream') throw fault('UNSUPPORTED_OPERATION');
            const body = events ? { args: {} } : payload(params.endpoint, params.values);
            if (events && (!Array.isArray(params.values) || params.values.length)) throw fault('INVALID_REQUEST');
            const id = await streams.open(async lifetime => {
              const source = await gateway.wireStream.open(params.endpoint, body, EMPTY_UPLINK, connection.operator, lifetime);
              return { async *[Symbol.asyncIterator]() {
                let clientId;
                try {
                  for await (const item of source) {
                    if (events && item?.type === 'ready') { clientId = item.clientId; eventClients.add(clientId); }
                    yield item;
                  }
                } finally { if (clientId) eventClients.delete(clientId); }
              } };
            }, signal);
            return { streamId: id };
          }
          if (method === 'next') { exact(params, ['streamId', 'waitMs']); return streams.next(params.streamId, { waitMs: params.waitMs, signal }); }
          if (method === 'close') { exact(params, ['streamId']); if (typeof params.streamId !== 'string' || !params.streamId) throw fault('INVALID_REQUEST'); await streams.close(params.streamId); return { closed: true }; }
          if (method === 'event-result') {
            exact(params, ['clientId', 'eventId', 'outcome']);
            if (!eventClients.has(params.clientId) || typeof params.eventId !== 'string' || !plain(params.outcome)) throw fault('INVALID_EVENT_OWNER');
            return rpc('$events/result', { args: params }, signal);
          }
          throw fault('UNSUPPORTED_OPERATION');
        },
        async dispose() { closed = true; uploads.dispose(); await streams.dispose(); eventClients.clear(); },
      };
    },
  };
}
