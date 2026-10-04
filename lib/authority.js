// Pure configuration identity shared by transport and selected-write capabilities.
// Runtime UUID + process epoch are separately verified during the protocol handshake.
import { createHash } from 'node:crypto';
export function machineIdentity(machine) {
  const env = Object.entries(machine.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([
    machine.command ?? 'ssh', machine.ssh, env, machine.socketPath ?? null,
    machine.remoteNode ?? null, machine.runtimeMode ?? 'remote-runtime', machine.authorityRevision ?? '',
  ])).digest('hex').slice(0, 20);
}
