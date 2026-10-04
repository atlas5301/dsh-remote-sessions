// Test-only resolution to an explicitly supplied, already installed DSH runtime.
// No dependency installs, no runtime edits, no production import hooks.
import { register } from 'node:module';
const anchor = process.env.DSH_TEST_RUNTIME_ANCHOR;
if (!anchor) throw new Error('Set DSH_TEST_RUNTIME_ANCHOR to the installed @deepseek-ai/dsh/package.json');
register(new URL('./runtime-resolver.mjs', import.meta.url), { data: { anchor } });
