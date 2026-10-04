// Install in an independently supervised DSH base-backed profile.
// Connections own observation only, never resident agent handles.
import z from '@deepseek-ai/schemastery';
import { resolve } from 'node:path';
import { runtimeIdentity, listenCompanion } from './companion-server.js';
import { createRuntimeAdapter, REQUIRED } from './runtime-adapter.js';

export const name = 'remote-sessions-companion';
export const inject = ['connection', 'typertGateway', 'sessionController', 'typert', 'fileUploads'];
export const Config = z.object({ runtimeDirectory: z.string().required() });
export async function apply(ctx, config) {
  const directory = resolve(config.runtimeDirectory);
  const id = await runtimeIdentity(directory);
  const definitions = ctx.typert.local;
  if (typeof definitions.subscribe !== 'function') throw new Error('INCOMPATIBLE_DSH');
  ctx.effect(() => {
    let closed = false, ready = !ctx.get('appReady'), opening, server, failed = false;
    const maybeStart = () => {
      if (closed || !ready || opening || failed || !REQUIRED.every(endpoint => definitions.get(endpoint))) return;
      opening = (async () => {
        const adapter = createRuntimeAdapter(ctx, { runtimeId: id });
        server = await listenCompanion({ socketPath: directory + '/agent.sock', adapter });
        if (closed) await server.close();
        else ctx.logger.info('remote-sessions: resident protocol ready (private Unix socket)');
      })().catch(error => {
        failed = true;
        ctx.logger.error('remote-sessions: companion failed: ' + (error.code || 'START_FAILED'));
      });
    };
    // Public registry observation handles descriptors arriving after controller activation.
    const unsubscribe = definitions.subscribe(maybeStart);
    const appReady = ctx.get('appReady');
    const cancelReady = appReady?.onReady(() => { ready = true; maybeStart(); });
    maybeStart();
    return async () => {
      closed = true; unsubscribe(); cancelReady?.();
      await opening; await server?.close();
    };
  }, 'remote-sessions.companion');
}
