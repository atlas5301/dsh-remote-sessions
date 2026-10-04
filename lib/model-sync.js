// Explicit model + credential sync: reads the LOCAL profile's model provider
// config and API key, writes both to the remote resident's profile and
// credential store. This is a deliberate, user-triggered action.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { failure } from './machine-registry.js';
import { shellQuote } from './ssh-carrier.js';

/** Extract a named `- id: <name>` YAML section from a patch file body. */
export function extractYamlSection(text, id) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex(line => line.trim().startsWith(`- id: ${id}`));
  if (start < 0) return null;
  const collected = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^- id: /.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join('\n');
}

/** Remove named sections from a YAML patch body (returns the cleaned text). */
export function removeYamlSection(text, ids) {
  const lines = String(text ?? '').split('\n');
  const result = [];
  let skipping = false;
  for (const line of lines) {
    if (/^- id: /.test(line)) {
      const match = /^- id: (\S+)/.exec(line);
      skipping = match ? ids.includes(match[1]) : false;
    }
    if (!skipping) result.push(line);
  }
  return result.join('\n');
}

/** Read the local profile's model provider config and default model. */
export async function readLocalModelConfig(profileDir) {
  const patchPath = join(profileDir, 'cordis.patch.yml');
  let text;
  try { text = await fs.readFile(patchPath, 'utf8'); }
  catch { throw failure('LOCAL_PROFILE_NOT_FOUND', 404); }
  const providers = extractYamlSection(text, 'llm-pi-ai');
  const defaultModel = extractYamlSection(text, 'agent-default-model');
  if (!providers) throw failure('MODEL_CONFIG_NOT_FOUND', 404);
  return { providers, defaultModel };
}

/** Read the API key for a named env var from the local credential store. */
export async function readLocalCredential(envVarName) {
  const credsPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml');
  let text;
  try { text = await fs.readFile(credsPath, 'utf8'); }
  catch { return null; }
  const match = new RegExp(`^\\s*${envVarName}:\\s*(.+)$`, 'm').exec(text);
  return match ? match[1].trim() : null;
}

/**
 * Sync the local model config + credential to the remote resident.
 * The remote profile's patch is updated with the local llm-pi-ai and
 * agent-default-model sections, and the API key goes to the remote's
 * credential store. The CALLER restarts the resident afterwards.
 */
export async function syncModelsToRemote({ exec, machine, probe, profileDir, localProfileDir, signal }) {
  // 0. The remote DSH home: probe.home IS the DSH home (never append .dsh).
  const remoteDshHome = machine.remoteHome ?? probe?.home ?? null;
  if (!remoteDshHome) throw failure('PROBE_FAILED', 502);
  // 1. Read the local model config sections.
  const { providers, defaultModel } = await readLocalModelConfig(localProfileDir);

  // 2. Find EVERY provider's API key env var: one llm-pi-ai section may carry
  //    several providers (e.g. deepinfra AND omlx); syncing only the first
  //    left the rest unroutable on the remote (operator-reported: omlx).
  const envVarNames = [...new Set([...providers.matchAll(/apiKeyEnv:\s*(\S+)/g)].map(match => match[1]))];
  const credentials = [];
  for (const envVarName of envVarNames) {
    const credential = await readLocalCredential(envVarName);
    if (credential) credentials.push({ envVarName, credential });
  }

  // 3. Read the remote's current profile patch (via SSH cat).
  const remotePatchPath = join(profileDir, 'cordis.patch.yml');
  const current = await exec(machine, `cat ${shellQuote(remotePatchPath)} 2>/dev/null`, { signal });

  // 4. Remove any existing llm-pi-ai and agent-default-model rows, then append
  //    the local sections (idempotent replacement).
  const cleaned = removeYamlSection(current.stdout || '', ['llm-pi-ai', 'agent-default-model']);
  const merged = cleaned.trimEnd() + '\n\n' + providers + '\n' + (defaultModel ?? '') + '\n';

  // 5. Write the merged patch via stdin pipe (no heredoc quoting issues).
  await exec(machine, `cat > ${shellQuote(remotePatchPath)}`, { input: merged, signal });

  // 6. Write every provider credential to the RESIDENT-OWNED credential store
  //    pinned by the generated profile patch (runtimeDirectory/credentials.yaml).
  //    The shared home level (~/.dsh patch and credential store) is NEVER
  //    written: other profiles on the remote host keep their own environment
  //    untouched. Keys stream over stdin (never on the SSH command line) and
  //    umask 077 keeps a fresh store owner-only.
  const credentialStore = join(machine.runtimeDirectory ?? dirname(machine.socketPath), 'credentials.yaml');
  for (const { envVarName, credential } of credentials) {
    await exec(machine, `umask 077; grep -q ${shellQuote(envVarName + ':')} ${shellQuote(credentialStore)} 2>/dev/null`
      + ` || cat >> ${shellQuote(credentialStore)}`, { input: `  ${envVarName}: ${credential}\n`, signal });
  }

  return { providers: !!providers, defaultModel: !!defaultModel, credential: credentials.length > 0 };
}
