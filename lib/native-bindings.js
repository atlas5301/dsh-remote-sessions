// Durable proxy identity uses DSH's public storage domain, not browser storage.
// Reserving a binding precedes remote mutation admission and survives host exit.
import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { fault } from './protocol.js';
const text = z.string().min(1).max(4096);
const schema = z.object({
  sessionId: text, remoteSessionId: text, target: text,
  cwd: text.refine(value => value.startsWith('/')),
  remoteCwd: text.refine(value => value.startsWith('/')),
  authority: text, runtimeId: text, instanceId: text,
}).strict();
const PINNED = ['sessionId', 'remoteSessionId', 'target', 'cwd', 'remoteCwd', 'authority', 'runtimeId'];
const spec = defineDomain({ name: 'remote_session_bindings', version: 1, tables: { sessions: domainTable(schema) } });
/** Instance adoption: the ONLY deliberate binding mutation. A resident
 * restart changes its instance id while the persisted session SURVIVES; a
 * binding may move to the new instance, and nothing else may ever change.
 * The write goes through the store's LOW-LEVEL put: the public set() forbids
 * every field change including instanceId, so routing adoption through set()
 * made every adoption conflict (operator-reported: all sessions went
 * "offline" permanently after a resident restart). */
export function adoptableBindings(store) {
  if (typeof store.put !== 'function') throw new Error('adoptable bindings require a low-level put(id, row)');
  return {
    ...store,
    // Spread copies property VALUES; the live table size must stay a getter.
    get size() { return store.size; },
    async adopt(id, next) {
      const row = Object.freeze(schema.parse(next));
      if (id !== row.sessionId) throw fault('INVALID_BINDING');
      const previous = store.get(id);
      if (previous === undefined) throw fault('UNKNOWN_BINDING');
      if (PINNED.some(key => previous[key] !== row[key])) throw fault('REMOTE_BINDING_CONFLICT');
      await store.put(id, row);
    },
  };
}
export async function openNativeBindings(ctx) {
  const domain = await ctx.storage.domain.open(spec), table = domain.table('sessions');
  const base = {
    get size() { return table.size; },
    has: id => table.get(id) !== undefined,
    get: id => table.get(id),
    *values() { for (const [, value] of table.entries()) yield value; },
    async set(id, value) {
      const next = Object.freeze(schema.parse(value));
      if (id !== next.sessionId) throw fault('INVALID_BINDING');
      const previous = table.get(id);
      if (previous && [...PINNED, 'instanceId'].some(key => previous[key] !== next[key])) throw fault('REMOTE_BINDING_CONFLICT');
      await table.put(id, next);
    },
    put: (id, value) => table.put(id, value),
    delete: id => table.delete(id),
    close: () => domain.close(),
  };
  return adoptableBindings(base);
}
