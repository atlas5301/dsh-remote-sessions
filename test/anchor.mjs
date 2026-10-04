// Shared anchor resolution for tests that must execute the INSTALLED DSH CLI's
// packages (no dependency installs, no runtime edits). Resolution order:
// explicit env anchors, the global npm root, common system prefixes.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function installedAnchor() {
  for (const key of ['DSH_TEST_DEPENDENCY_ANCHOR', 'DSH_TEST_RUNTIME_ANCHOR']) {
    if (process.env[key]) return process.env[key];
  }
  const candidates = [];
  try { candidates.push(join(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), '@deepseek-ai', 'dsh', 'package.json')); } catch {}
  for (const base of ['/usr/local/lib/node_modules', '/usr/lib/node_modules', '/opt/homebrew/lib/node_modules']) {
    candidates.push(join(base, '@deepseek-ai', 'dsh', 'package.json'));
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error('Set DSH_TEST_RUNTIME_ANCHOR to the installed @deepseek-ai/dsh/package.json (absolute path)');
}

/** URL of a module shipped inside the installed CLI tree (e.g. the `yaml`
 * package the selected-actions fixtures retain from the CLI's dependencies). */
export function installedModuleUrl(specifier) {
  const require = createRequire(installedAnchor());
  return pathToFileURL(require.resolve(specifier)).href;
}
