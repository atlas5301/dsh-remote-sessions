import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
let require;
export function initialize({ anchor }) { require = createRequire(anchor); }
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/') || ['zod', 'yaml'].includes(specifier)) {
    try { return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }; } catch {}
  }
  return next(specifier, context);
}
