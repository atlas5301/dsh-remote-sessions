/**
 * node --test test/selected-sync.test.js
 * Uses Node built-ins plus the ALREADY installed DSH yaml dependency. Override
 * DSH_SELECTED_SYNC_YAML_PATH to its absolute module directory or dist/index.js.
 * No install, SSH, remote operation, live config mutation or deployment. Pure
 * helper tests and the exact generated program run against an in-memory fs;
 * unlink/rm/rmdir/truncate and unexpected operations are forbidden by the mock.
 * This proves protocol/validation behavior, not OS race resistance or deployment.
 */
import test from 'node:test';
import { createRequire } from 'node:module';
import { installedAnchor } from './anchor.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';
import {
  createSelectedSyncPlan, createSelectedSyncPayload, hashDocumentText,
  mergeSelectedSyncDocuments, generateRemoteMergeProgram,
} from '../lib/selected-sync.js';

let yaml;
const anchorRequire = createRequire(installedAnchor());
try { yaml = anchorRequire(process.env.DSH_SELECTED_SYNC_YAML_PATH ?? 'yaml'); }
catch { throw new Error('Set DSH_SELECTED_SYNC_YAML_PATH to an already-installed DSH YAML module. No install is required.'); }
const remoteYamlPath = '/isolated-owner/.dsh/profiles/desktop/node_modules/yaml';
const chosenSecret = 'PRIVATE_SELECTED_API_VALUE';
const unselectedSecret = 'DO_NOT_COPY_OTHER_API_VALUE';
const oauthSecret = 'DO_NOT_COPY_OAUTH_GRANT';
const signingSecret = 'DO_NOT_COPY_BROWSER_SIGNING';
const profiles = {
  deepinfra: {
    apiKeyEnv: 'DEEPINFRA_API_KEY', displayName: 'DeepInfra', api: 'openai-completions',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    models: [
      { id: 'chosen/model', name: 'Chosen', contextWindow: 65536, maxTokens: 8192,
        compat: { maxTokensField: 'max_tokens' } },
      { id: 'not-selected/model', name: 'Do not transfer' },
    ],
    modelOverrides: { 'chosen/model': { maxTokens: 4096 }, 'not-selected/model': { maxTokens: 2048 } },
  },
  codex: { apiKey: 'EMBEDDED_BUT_UNSELECTED_PROVIDER', models: [{ id: 'codex-local-default' }] },
};
const localCredentials = {
  version: 1,
  refs: { DEEPINFRA_API_KEY: chosenSecret, OTHER_API_KEY: unselectedSecret,
    BROWSER_SIGNING_KEY: signingSecret },
  records: { 'codex/default': { kind: 'grant', payload: { accessToken: oauthSecret } },
    'browser/signing': { kind: 'grant', payload: { signingKey: signingSecret } } },
};
function makePlan(overrides = {}) {
  return createSelectedSyncPlan({ providers: structuredClone(profiles),
    selections: [{ provider: 'deepinfra', model: 'chosen/model' }],
    credentialRefs: ['DEEPINFRA_API_KEY'], credentials: structuredClone(localCredentials), ...overrides });
}
function remoteConfig() {
  return yaml.stringify([
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: {
      unrelatedSetting: true,
      providers: {
        other: { apiKeyEnv: 'REMOTE_OTHER_API_KEY', models: [{ id: 'keep-other' }] },
        deepinfra: { ...structuredClone(profiles.deepinfra), models: [
          { id: 'chosen/model', maxTokens: 1 }, { id: 'remote-only/model', name: 'Remote custom model' },
        ], modelOverrides: { 'chosen/model': { maxTokens: 1 }, 'remote-only/model': { maxTokens: 99 } } },
      },
    } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: {
      provider: 'codex', model: 'remote-default', reasoningEffort: 'low', customFlag: true,
    } },
    { id: 'skills', config: { roots: ['/remote/skills'] } },
    { id: 'memories', config: { path: '/remote/memories' } },
  ]);
}
const credentialsText = `# Remote credentials must survive\nversion: 1\nrefs:\n  # Keep this unrelated ref\n  REMOTE_OTHER_API_KEY: REMOTE_OTHER_PRIVATE\n  DEEPINFRA_API_KEY: OLD_CHOSEN\nrecords:\n  codex/default:\n    kind: grant\n    payload:\n      accessToken: REMOTE_OAUTH_PRIVATE\n  browser/signing:\n    kind: grant\n    payload:\n      signingKey: REMOTE_SIGNING_PRIVATE\n`;
function payload(plan = makePlan(), configText = remoteConfig(), credentialText = credentialsText, extra = {}) {
  return createSelectedSyncPayload(plan, { yamlModulePath: remoteYamlPath,
    expectedHashes: { config: hashDocumentText(configText),
      ...(plan.credentialRefs.length ? { credentials: hashDocumentText(credentialText) } : {}) }, ...extra });
}
function merge(configText = remoteConfig(), credentialText = credentialsText, plan = makePlan(), extra = {}) {
  return mergeSelectedSyncDocuments({ configText, credentialsText: credentialText,
    payload: payload(plan, configText, credentialText, extra), yaml });
}
function fails(fn, code) { assert.throws(fn, (error) => error.code === code && error.message === code); }

test('preview is deterministic, frozen, selected-only, and never holds credential values', () => {
  const plan = makePlan();
  assert.deepEqual(plan.routes.map((entry) => [entry.provider, entry.models]), [['deepinfra', ['chosen/model']]]);
  assert.equal(plan.defaultPin, null);
  assert.deepEqual(plan.credentialRefs, ['DEEPINFRA_API_KEY']);
  assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.routes[0].models));
  const publicJson = JSON.stringify(plan);
  for (const secret of [chosenSecret, unselectedSecret, oauthSecret, signingSecret]) assert.ok(!publicJson.includes(secret));
  assert.ok(!publicJson.includes('codex-local-default'));
  const credentials = structuredClone(localCredentials);
  credentials.refs.DEEPINFRA_API_KEY = 'DIFFERENT_PRIVATE_VALUE';
  assert.equal(makePlan({ credentials }).planHash, plan.planHash, 'no brute-forceable credential value digest in public preview');
  const reordered = structuredClone(profiles);
  reordered.deepinfra.models.reverse();
  reordered.deepinfra = Object.fromEntries(Object.entries(reordered.deepinfra).reverse());
  assert.deepEqual(makePlan({ providers: reordered }), plan);
  assert.equal(payload(makePlan()), payload(plan));
});

test('private stdin contains only selected key and selected models, no records/memories/local default', () => {
  const plan = makePlan();
  const stdin = payload(plan);
  assert.ok(stdin.includes(chosenSecret));
  for (const forbidden of [unselectedSecret, oauthSecret, signingSecret, 'not-selected/model', 'codex-local-default', 'records', 'memories']) assert.ok(!stdin.includes(forbidden));
  const parsed = JSON.parse(stdin);
  assert.deepEqual(Object.keys(parsed.operations.refs), ['DEEPINFRA_API_KEY']);
  assert.deepEqual(parsed.operations.routes[0].profile.modelOverrides, { 'chosen/model': { maxTokens: 4096 } });
  fails(() => createSelectedSyncPayload(JSON.parse(JSON.stringify(plan)), {}), 'UNKNOWN_PLAN');
  const mutableCredentials = structuredClone(localCredentials);
  const captured = makePlan({ credentials: mutableCredentials });
  mutableCredentials.refs.DEEPINFRA_API_KEY = 'MUTATED_LATER';
  assert.equal(JSON.parse(payload(captured)).operations.refs.DEEPINFRA_API_KEY, chosenSecret);
});

test('default pin is explicit and must be a selected provider/model', () => {
  const pin = { provider: 'deepinfra', model: 'chosen/model', reasoningEffort: 'high' };
  assert.deepEqual(makePlan({ defaultPin: pin }).defaultPin, pin);
  fails(() => makePlan({ defaultPin: { provider: 'codex', model: 'codex-local-default' } }), 'UNSELECTED_DEFAULT_PIN');
  fails(() => makePlan({ defaultPin: { ...pin, reasoningEffort: 'PRIVATE_VALUE' } }), 'INVALID_REASONING_EFFORT');
  fails(() => makePlan({ defaultPin: true }), 'INVALID_DEFAULT_PIN');
  fails(() => makePlan({ selections: [] }), 'EXPLICIT_SELECTION_REQUIRED');
  fails(() => makePlan({ selections: [{ provider: 'deepinfra', model: 'absent' }] }), 'SELECTED_MODEL_NOT_FOUND');
  fails(() => makePlan({ selections: [{ provider: 'absent', model: 'chosen/model' }] }), 'SELECTED_PROVIDER_NOT_FOUND');
  fails(() => makePlan({ selections: [{ provider: 'deepinfra', model: 'chosen/model' }, { provider: 'deepinfra', model: 'chosen/model' }] }), 'DUPLICATE_SELECTION');
});

test('reject embedded authentication, arbitrary headers, URL auth/query, and opaque source shapes', () => {
  for (const addition of [{ apiKey: chosenSecret }, { token: chosenSecret }, { env: { KEY: chosenSecret } },
    { headers: { authorization: `Bearer ${chosenSecret}` } }, { headers: { 'x-api-key': chosenSecret } },
    { headers: { 'X-Innocent-Looking': chosenSecret } },
    { baseURL: `https://user:${chosenSecret}@example.com/v1` },
    { baseURL: `https://example.com/v1?api_key=${chosenSecret}` },
    { baseURL: `https://example.com/v1#${chosenSecret}` },
    { compat: { chatTemplateKwargs: { api_key: chosenSecret } } }]) {
    const providers = structuredClone(profiles); Object.assign(providers.deepinfra, addition);
    assert.throws(() => makePlan({ providers }), (error) => !error.message.includes(chosenSecret));
  }
  const providers = structuredClone(profiles);
  delete providers.deepinfra.models;
  fails(() => makePlan({ providers }), 'EXPLICIT_MODELS_REQUIRED');
  const maliciousModel = structuredClone(profiles);
  maliciousModel.deepinfra.models[0].apiKey = chosenSecret;
  fails(() => makePlan({ providers: maliciousModel }), 'UNSUPPORTED_MODEL_FIELD');
  fails(() => makePlan({ providers: JSON.parse('{"__proto__":{},"deepinfra":{"models":[{"id":"x"}]}}'), selections: [{ provider: '__proto__', model: 'x' }] }), 'INVALID_IDENTIFIER');
});

test('credential opt-in admits only selected API-key refs, never OAuth/browser refs or records', () => {
  for (const ref of ['BROWSER_SIGNING_KEY', 'OAUTH_API_KEY', 'SESSION_API_KEY', 'ACCESS_TOKEN', 'codex/default']) {
    assert.throws(() => makePlan({ credentialRefs: [ref] }), (error) => !error.message.includes(chosenSecret));
  }
  fails(() => makePlan({ credentialRefs: ['OTHER_API_KEY'] }), 'UNSELECTED_ROUTE_CREDENTIAL');
  fails(() => makePlan({ credentialRefs: ['DEEPINFRA_API_KEY', 'DEEPINFRA_API_KEY'] }), 'DUPLICATE_CREDENTIAL_REF');
  fails(() => makePlan({ credentials: { DEEPINFRA_API_KEY: chosenSecret } }), 'INVALID_LOCAL_CREDENTIAL_DOCUMENT');
  fails(() => makePlan({ credentials: { version: 1, refs: {} } }), 'SELECTED_CREDENTIAL_NOT_FOUND');
  fails(() => makePlan({ credentials: { version: 1, refs: { DEEPINFRA_API_KEY: '' } } }), 'SELECTED_CREDENTIAL_NOT_FOUND');
  const plan = makePlan({ credentialRefs: [], credentials: undefined });
  assert.deepEqual(plan.credentialRefs, []);
  assert.deepEqual(JSON.parse(payload(plan)).operations.refs, {});
});

test('document hashes distinguish absent/empty and exact bytes; invalid inputs are refused', () => {
  assert.match(hashDocumentText(null), /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(hashDocumentText(null), hashDocumentText(''));
  assert.notEqual(hashDocumentText('a'), hashDocumentText('a\n'));
  assert.equal(hashDocumentText('a'), hashDocumentText('a'));
  fails(() => hashDocumentText(undefined), 'INVALID_DOCUMENT_TEXT');
  fails(() => createSelectedSyncPayload(makePlan(), { yamlModulePath: remoteYamlPath, expectedHashes: { config: 'anything' } }), 'INVALID_EXPECTED_HASH');
  for (const yamlModulePath of ['/tmp/arbitrary.js', './node_modules/yaml', '/tmp/../node_modules/yaml', '/tmp/node_modules/yaml/../../evil']) {
    assert.throws(() => payload(makePlan(), remoteConfig(), credentialsText, { yamlModulePath }));
  }
});

test('pure merge preserves other providers, remote-only models/overrides, defaults, skills, memory and credential records', () => {
  const configText = `# Keep config header\n${remoteConfig()}`;
  const result = merge(configText);
  assert.deepEqual(result.changed, { config: true, credentials: true });
  assert.ok(result.configText.startsWith('# Keep config header'));
  const before = yaml.parse(configText), after = yaml.parse(result.configText);
  assert.deepEqual(after[0].config.providers.other, before[0].config.providers.other);
  assert.equal(after[0].config.unrelatedSetting, true);
  const models = after[0].config.providers.deepinfra.models;
  assert.deepEqual(models.map((entry) => entry.id), ['chosen/model', 'remote-only/model']);
  assert.equal(models[0].maxTokens, 8192);
  assert.deepEqual(models[1], before[0].config.providers.deepinfra.models[1]);
  assert.deepEqual(after[0].config.providers.deepinfra.modelOverrides['remote-only/model'], { maxTokens: 99 });
  assert.deepEqual(after.slice(1), before.slice(1));
  const oldCredentials = yaml.parse(credentialsText), newCredentials = yaml.parse(result.credentialsText);
  assert.equal(newCredentials.refs.DEEPINFRA_API_KEY, chosenSecret);
  assert.equal(newCredentials.refs.REMOTE_OTHER_API_KEY, oldCredentials.refs.REMOTE_OTHER_API_KEY);
  assert.deepEqual(newCredentials.records, oldCredentials.records);
  assert.ok(result.credentialsText.includes('# Keep this unrelated ref'));
  assert.ok(result.credentialsText.includes('# Remote credentials must survive'));
});

test('credential opt-out does not parse, return new bytes, or touch remote credential file', () => {
  const plan = makePlan({ credentialRefs: [], credentials: undefined });
  const invalidSecretText = 'not: [valid yaml SECRET\n';
  const result = merge(remoteConfig(), invalidSecretText, plan);
  assert.equal(result.credentialsText, invalidSecretText);
  assert.equal(result.changed.credentials, false);
});

test('explicit default pin updates only selected fields and keeps unknown remote default options', () => {
  const plan = makePlan({ defaultPin: { provider: 'deepinfra', model: 'chosen/model', reasoningEffort: 'high' } });
  const result = merge(remoteConfig(), credentialsText, plan);
  assert.deepEqual(yaml.parse(result.configText)[1].config, { provider: 'deepinfra', model: 'chosen/model', reasoningEffort: 'high', customFlag: true });
});

test('idempotent merge returns original exact texts and reports no writes', () => {
  const first = merge();
  const second = merge(first.configText, first.credentialsText);
  assert.deepEqual(second.changed, { config: false, credentials: false });
  assert.equal(second.configText, first.configText);
  assert.equal(second.credentialsText, first.credentialsText);
});

test('CAS rejects either changed remote document before any merge', () => {
  const stdin = payload();
  fails(() => mergeSelectedSyncDocuments({ configText: `${remoteConfig()}# concurrent edit\n`, credentialsText, payload: stdin, yaml }), 'CONFIG_CHANGED');
  fails(() => mergeSelectedSyncDocuments({ configText: remoteConfig(), credentialsText: `${credentialsText}# concurrent edit\n`, payload: stdin, yaml }), 'CREDENTIALS_CHANGED');
  const altered = JSON.parse(stdin);
  altered.operations.routes[0].profile.models[0].maxTokens = 999;
  fails(() => mergeSelectedSyncDocuments({ configText: remoteConfig(), credentialsText, payload: altered, yaml }), 'PLAN_HASH_MISMATCH');
});

test('missing managed config requires explicit remote base to preserve inherited providers', () => {
  const source = '- id: skills\n  config:\n    roots: [remote]\n';
  fails(() => merge(source), 'REMOTE_BASE_CONFIG_REQUIRED');
  const baseProviderConfig = { providers: { inherited: { models: [{ id: 'untouched' }] } }, customSetting: true };
  const result = merge(source, credentialsText, makePlan(), { baseProviderConfig });
  const rows = yaml.parse(result.configText);
  assert.deepEqual(rows[0], yaml.parse(source)[0]);
  assert.deepEqual(rows[1].config.providers.inherited, baseProviderConfig.providers.inherited);
  assert.equal(rows[1].config.customSetting, true);
});

test('supports inserted managed rows; ambiguous duplicates or plugin mismatch are refused', () => {
  const rows = yaml.parse(remoteConfig());
  const source = yaml.stringify([{ insert: rows }, { id: 'unrelated', disabled: true }]);
  const result = merge(source);
  assert.equal(yaml.parse(result.configText)[0].insert[0].config.providers.deepinfra.models[0].maxTokens, 8192);
  for (const modified of [
    [...rows, structuredClone(rows[0])],
    [{ ...rows[0], name: 'arbitrary-other-plugin' }, ...rows.slice(1)],
    [{ id: 'llm-pi-ai', insert: [] }],
    [{ id: 'llm-pi-ai', config: [] }],
  ]) assert.throws(() => merge(yaml.stringify(modified)));
});

test('refuses shared endpoint/auth changes when unselected remote models would be affected', () => {
  const rows = yaml.parse(remoteConfig());
  rows[0].config.providers.deepinfra.baseURL = 'https://different-remote.example.com/v1';
  fails(() => merge(yaml.stringify(rows)), 'SHARED_ROUTE_CHANGE_CONFLICT');
  delete rows[0].config.providers.deepinfra.models;
  fails(() => merge(yaml.stringify(rows)), 'EXPLICIT_MODELS_REQUIRED');
});

test('rejects duplicate keys, YAML alias amplification, malformed roots, flat/unknown credentials without leaking values', () => {
  for (const config of ['secret: [PRIVATE_SELECTED_API_VALUE', 'version: 1\n', '- id: llm-pi-ai\n  config: {providers: {}, providers: {}}\n', '- &row { id: skills }\n- *row\n']) {
    assert.throws(() => merge(config), (error) => !error.message.includes(chosenSecret));
  }
  for (const creds of [
    `DEEPINFRA_API_KEY: ${chosenSecret}\n`,
    `version: 2\nrefs: {DEEPINFRA_API_KEY: ${chosenSecret}}\n`,
    `version: 1\nunknown: ${chosenSecret}\n`,
    `version: 1\nrefs: {DEEPINFRA_API_KEY: ''}\n`,
    `version: 1\nrefs: {DEEPINFRA_API_KEY: ${chosenSecret}, DEEPINFRA_API_KEY: other}\n`,
    `version: 1\nrecords: {browser/signing: {kind: unknown, secret: ${chosenSecret}}}\n`,
  ]) assert.throws(() => merge(remoteConfig(), creds), (error) => !error.message.includes(chosenSecret));
});

test('empty credential document admits multiple selected refs without dropping either', () => {
  const providers = structuredClone(profiles);
  providers.second = { apiKeyEnv: 'SECOND_API_KEY', models: [{ id: 'model-2' }] };
  const plan = makePlan({ providers, selections: [{ provider: 'deepinfra', model: 'chosen/model' }, { provider: 'second', model: 'model-2' }],
    credentialRefs: ['SECOND_API_KEY', 'DEEPINFRA_API_KEY'], credentials: { version: 1, refs: { DEEPINFRA_API_KEY: chosenSecret, SECOND_API_KEY: 'SECOND_PRIVATE' } } });
  const result = merge(remoteConfig(), '', plan);
  assert.deepEqual(yaml.parse(result.credentialsText), { version: 1, refs: { DEEPINFRA_API_KEY: chosenSecret, SECOND_API_KEY: 'SECOND_PRIVATE' } });
});

test('pure helpers safely initialize absent/empty texts using explicit remote base; explicit null roots remain invalid', () => {
  for (const configText of [null, '', '# empty config\n']) {
    const result = merge(configText, null, makePlan(), { baseProviderConfig: { providers: {} } });
    assert.equal(yaml.parse(result.configText)[0].config.providers.deepinfra.models[0].id, 'chosen/model');
    assert.equal(yaml.parse(result.credentialsText).refs.DEEPINFRA_API_KEY, chosenSecret);
  }
  assert.throws(() => merge('null\n', credentialsText, makePlan(), { baseProviderConfig: { providers: {} } }));
  assert.throws(() => merge(remoteConfig(), 'null\n'));
});

test('unrelated provider/config/default field comments survive selected route and pin changes', () => {
  const commented = remoteConfig().replace('    unrelatedSetting: true', '    # preserve unrelated setting comment\n    unrelatedSetting: true')
    .replace('      other:', '      # preserve unrelated provider comment\n      other:')
    .replace('    customFlag: true', '    # preserve default option comment\n    customFlag: true');
  const plan = makePlan({ defaultPin: { provider: 'deepinfra', model: 'chosen/model' } });
  const result = merge(commented, credentialsText, plan);
  for (const marker of ['preserve unrelated setting comment', 'preserve unrelated provider comment', 'preserve default option comment']) assert.ok(result.configText.includes(marker));
});

test('selected-model override is reset when source has none, leaving remote-only override untouched', () => {
  const providers = structuredClone(profiles); delete providers.deepinfra.modelOverrides;
  const result = merge(remoteConfig(), credentialsText, makePlan({ providers }));
  const overrides = yaml.parse(result.configText)[0].config.providers.deepinfra.modelOverrides;
  assert.deepEqual(overrides['chosen/model'], {});
  assert.deepEqual(overrides['remote-only/model'], { maxTokens: 99 });
});

test('selected remote route with embedded key is refused; auth-ref rebinding requires selected credential', () => {
  const rows = yaml.parse(remoteConfig());
  rows[0].config.providers.deepinfra.apiKey = 'REMOTE_EMBEDDED_KEY';
  fails(() => merge(yaml.stringify(rows)), 'UNSUPPORTED_ROUTE_FIELD');
  delete rows[0].config.providers.deepinfra.apiKey;
  rows[0].config.providers.deepinfra.apiKeyEnv = 'OLD_ROUTE_API_KEY';
  rows[0].config.providers.deepinfra.models = [{ id: 'chosen/model', maxTokens: 1 }];
  delete rows[0].config.providers.deepinfra.modelOverrides;
  const plan = makePlan({ credentialRefs: [], credentials: undefined });
  fails(() => merge(yaml.stringify(rows), credentialsText, plan), 'AUTH_REF_CHANGE_REQUIRES_SELECTED_CREDENTIAL');
  const result = merge(yaml.stringify(rows), credentialsText);
  assert.equal(yaml.parse(result.configText)[0].config.providers.deepinfra.apiKeyEnv, 'DEEPINFRA_API_KEY');
});

test('reject malformed typed values and authentication escape hatches nested in supported fields', () => {
  for (const addition of [
    { displayName: { apiKey: chosenSecret } }, { api: { apiKey: chosenSecret } },
    { api: chosenSecret }, { compat: { maxTokensField: chosenSecret } },
    { compat: { supportsStore: chosenSecret } }, { defaultContextWindow: chosenSecret },
    { retryPolicy: { mode: 'normal', innocentHeader: chosenSecret } },
    { retryPolicy: { mode: 'normal', backoff: { innocentHeader: chosenSecret } } },
    { thinkingBudgets: { high: chosenSecret } },
  ]) {
    const providers = structuredClone(profiles); Object.assign(providers.deepinfra, addition);
    assert.throws(() => makePlan({ providers }), (error) => !error.message.includes(chosenSecret));
  }
});

// In-memory POSIX files: real generated source, no executable remote or disk I/O.
function memoryFilesystem(options = {}) {
  const home = '/isolated-owner', dshHome = `${home}/.dsh`, uid = 1000;
  let inode = 10, tick = 100;
  const files = new Map(), operations = [];
  const error = (code) => Object.assign(new Error(`PRIVATE_FS_MESSAGE_${chosenSecret}`), { code });
  function info(type, mode, extra = {}) {
    return { type, mode, uid, nlink: 1, dev: 1, ino: inode++, mtimeMs: tick++, ctimeMs: tick++, size: 0,
      isDirectory() { return this.type === 'directory'; }, isFile() { return this.type === 'file'; },
      isSymbolicLink() { return this.type === 'symlink'; }, ...extra };
  }
  for (const directory of ['/', home, dshHome]) files.set(directory, { text: '', info: info('directory', 0o700, directory === '/' ? { uid: 0 } : {}) });
  const configTarget = `${dshHome}/cordis.patch.yml`, credentialsTarget = `${dshHome}/.credentials.yaml`;
  function add(filename, text, mode) {
    files.set(filename, { text, info: info('file', mode, { size: Buffer.byteLength(text) }) });
  }
  add(configTarget, options.configText ?? remoteConfig(), options.configMode ?? 0o644);
  add(credentialsTarget, options.credentialsText ?? credentialsText, options.credentialsMode ?? 0o600);
  options.mutate?.({ files, configTarget, credentialsTarget, dshHome });
  const fs = {
    async lstat(filename) {
      operations.push(['lstat', filename]);
      options.beforeLstat?.({ files, filename, operations });
      if (!files.has(filename)) throw error('ENOENT');
      return { ...files.get(filename).info };
    },
    async open(filename, flags, mode) {
      operations.push(['open', filename, flags, mode]);
      if (!(flags & constants.O_NOFOLLOW)) throw error('MOCK_MISSING_NOFOLLOW');
      if (flags & constants.O_CREAT) {
        if (!(flags & constants.O_EXCL) || files.has(filename)) throw error('EEXIST');
        add(filename, '', mode);
      }
      if (!files.has(filename)) throw error('ENOENT');
      const entry = files.get(filename);
      if (entry.info.type === 'symlink') throw error('ELOOP');
      return {
        async stat() { return { ...entry.info }; },
        async readFile() { operations.push(['readFile', filename]); return entry.text; },
        async writeFile(text) {
          operations.push(['writeFile', filename]);
          if (!(flags & constants.O_CREAT)) throw error('MOCK_DIRECT_OVERWRITE');
          entry.text = text; entry.info.size = Buffer.byteLength(text); entry.info.mtimeMs = tick++; entry.info.ctimeMs = tick++;
          options.afterWrite?.({ files, filename, operations });
        },
        async sync() { operations.push(['sync', filename]); },
        async close() { operations.push(['close', filename]); },
      };
    },
    async rename(source, target) {
      operations.push(['rename', source, target]);
      options.beforeRename?.({ source, target, files });
      const entry = files.get(source);
      assert.ok(entry); files.set(target, entry); files.delete(source);
    },
  };
  return { fs, files, operations, home, dshHome, uid, configTarget, credentialsTarget };
}
async function runGenerated(stdin, options = {}) {
  const memory = memoryFilesystem(options);
  const output = [], logs = [];
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const fakeProcess = {
    platform: 'linux', getuid: () => memory.uid, exitCode: 0,
    stdin: (async function* () { yield Buffer.from(stdin); })(),
    stdout: { write(value) { output.push(value); settle(); } },
  };
  // YAML is loaded in the host realm, while generated code is in the VM realm.
  // Re-home toJS values exactly as a normal same-process require would see them.
  let realmJSON;
  const wrapDocument = (document) => {
    const toJS = document.toJS.bind(document);
    document.toJS = (options) => realmJSON.parse(JSON.stringify(toJS(options)));
    return document;
  };
  const realmYaml = { parseDocument: (...args) => wrapDocument(yaml.parseDocument(...args)),
    Document: function Document(...args) { return wrapDocument(new yaml.Document(...args)); } };
  const mockRequire = (id) => {
    if (id === 'node:fs/promises') return new Proxy(memory.fs, { get(target, key) {
      if (key in target) return target[key];
      return () => { throw new Error(`Forbidden fs operation ${String(key)}`); };
    } });
    if (id === 'node:fs') return { constants };
    if (id === 'node:path') return path;
    if (id === 'node:os') return { homedir: () => memory.home };
    if (id === 'node:crypto') return { createHash, randomBytes };
    if (id === remoteYamlPath) return realmYaml;
    throw new Error('Forbidden module load');
  };
  const context = { require: mockRequire, process: fakeProcess, Buffer, URL,
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) } };
  const vmContext = vm.createContext(context);
  realmJSON = vm.runInContext('JSON', vmContext);
  new vm.Script(generateRemoteMergeProgram(), { filename: 'selected-sync-generated.cjs' }).runInContext(vmContext);
  await done;
  // Error exitCode is set immediately after stdout.write in the same microtask.
  assert.equal(logs.length, 0);
  return { ...memory, response: JSON.parse(output.join('')), output: output.join(''), exitCode: fakeProcess.exitCode };
}

test('generated program is independent of secrets and persists only owner-only stages/backups for whitelist files', async () => {
  const source = generateRemoteMergeProgram();
  assert.ok(!source.includes(chosenSecret));
  const result = await runGenerated(payload());
  assert.equal(result.response.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.response.changed, ['config', 'credentials']);
  assert.equal(result.response.backups.length, 2);
  const creates = result.operations.filter(([kind, , flags]) => kind === 'open' && (flags & constants.O_CREAT));
  assert.equal(creates.length, 4);
  for (const [, filename, flags, mode] of creates) {
    assert.ok(filename.startsWith(`${result.dshHome}/`));
    assert.match(filename, /\/(?:cordis\.patch\.yml|\.credentials\.yaml)\.selected-sync-\d+-[a-f0-9]+\.(?:backup|stage)$/);
    assert.ok(flags & constants.O_EXCL); assert.ok(flags & constants.O_NOFOLLOW); assert.equal(mode, 0o600);
  }
  assert.equal(result.files.get(result.configTarget).info.mode, 0o600);
  assert.equal(result.files.get(result.credentialsTarget).info.mode, 0o600);
  for (const backup of result.response.backups) {
    const entry = result.files.get(`${result.dshHome}/${backup}`);
    assert.ok(entry); assert.equal(entry.info.mode, 0o600);
    assert.equal(entry.text, backup.startsWith('cordis') ? remoteConfig() : credentialsText);
  }
  assert.ok(!result.output.includes(chosenSecret));
  assert.ok(!result.output.includes('REMOTE_OAUTH_PRIVATE'));
});

test('generated no-op has no backup, write or rename; opt-out never stats/reads credentials', async () => {
  const merged = merge();
  const noOp = await runGenerated(payload(makePlan(), merged.configText, merged.credentialsText),
    { configText: merged.configText, credentialsText: merged.credentialsText });
  assert.deepEqual(noOp.response, { ok: true, changed: [], backups: [] });
  assert.equal(noOp.operations.filter(([kind]) => ['writeFile', 'rename'].includes(kind)).length, 0);
  const plan = makePlan({ credentialRefs: [], credentials: undefined });
  const optOut = await runGenerated(payload(plan), { credentialsMode: 0o666 });
  assert.equal(optOut.response.ok, true);
  assert.ok(!optOut.operations.some(([, filename]) => filename === optOut.credentialsTarget));
});

test('generated program refuses symlinks, directories, hardlinks, foreign owners and insecure permissions before any writes', async () => {
  const cases = [
    ({ files, configTarget }) => { files.get(configTarget).info.type = 'symlink'; },
    ({ files, configTarget }) => { files.get(configTarget).info.type = 'directory'; },
    ({ files, configTarget }) => { files.get(configTarget).info.nlink = 2; },
    ({ files, configTarget }) => { files.get(configTarget).info.uid = 999; },
    ({ files, configTarget }) => { files.get(configTarget).info.mode = 0o666; },
    ({ files, credentialsTarget }) => { files.get(credentialsTarget).info.mode = 0o644; },
    ({ files, dshHome }) => { files.get(dshHome).info.type = 'symlink'; },
    ({ files, dshHome }) => { files.get(dshHome).info.mode = 0o777; },
  ];
  for (const mutate of cases) {
    const result = await runGenerated(payload(), { mutate });
    assert.equal(result.response.ok, false);
    assert.equal(result.exitCode, 1);
    assert.ok(['UNSAFE_FILE', 'UNSAFE_DIRECTORY'].includes(result.response.error));
    assert.equal(result.operations.filter(([kind]) => ['writeFile', 'rename'].includes(kind)).length, 0);
    assert.ok(!result.output.includes(chosenSecret));
  }
});

test('generated path and malformed stdin checks expose only sanitized errors', async () => {
  const changedPath = JSON.parse(payload()); changedPath.dshHome = '/tmp/not-the-DSH-home';
  const arbitrary = await runGenerated(JSON.stringify(changedPath));
  assert.equal(arbitrary.response.error, 'PATH_NOT_ALLOWED');
  assert.equal(arbitrary.operations.length, 0);
  const invalid = await runGenerated(`{"PRIVATE":"${chosenSecret}`);
  assert.equal(invalid.response.error, 'INVALID_PAYLOAD_JSON');
  assert.ok(!invalid.output.includes(chosenSecret));
});

test('generated CAS detects concurrent edit after staging and never overwrites it; retained backup remains', async () => {
  let changed = false;
  const result = await runGenerated(payload(), { afterWrite({ files, filename }) {
    if (!changed && filename.endsWith('.stage')) {
      changed = true;
      const entry = files.get('/isolated-owner/.dsh/cordis.patch.yml');
      entry.text += '# CONCURRENT REMOTE EDIT\n'; entry.info.size = Buffer.byteLength(entry.text); entry.info.ctimeMs += 10;
    }
  } });
  assert.equal(result.response.ok, false);
  assert.equal(result.response.error, 'CONCURRENT_CHANGE');
  assert.ok(result.files.get(result.configTarget).text.includes('CONCURRENT REMOTE EDIT'));
  assert.equal(result.operations.filter(([kind]) => kind === 'rename').length, 0);
  assert.ok([...result.files.keys()].some((filename) => filename.endsWith('.backup')));
});

test('second-file commit failure is reported honestly, backups survive, no rollback/deletion occurs', async () => {
  const result = await runGenerated(payload(), { beforeRename({ target }) {
    if (target.endsWith('.credentials.yaml')) throw Object.assign(new Error(chosenSecret), { code: 'EIO' });
  } });
  assert.equal(result.response.ok, false);
  assert.equal(result.response.error, 'EIO');
  assert.deepEqual(result.response.committed, ['config']);
  assert.equal(yaml.parse(result.files.get(result.configTarget).text)[0].config.providers.deepinfra.models[0].maxTokens, 8192);
  assert.equal(result.files.get(result.credentialsTarget).text, credentialsText);
  assert.equal([...result.files.keys()].filter((filename) => filename.endsWith('.backup')).length, 2);
  assert.ok(!result.output.includes(chosenSecret));
});

test('generated program refuses target creation, retaining no artifacts or originals changes', async () => {
  const configText = remoteConfig();
  const stdin = payload(makePlan(), configText, null);
  const result = await runGenerated(stdin, { mutate({ files, credentialsTarget }) { files.delete(credentialsTarget); } });
  assert.equal(result.response.ok, false);
  assert.equal(result.response.error, 'TARGET_CREATION_REQUIRES_OPERATOR');
  assert.equal(result.files.get(result.configTarget).text, configText);
  assert.equal(result.operations.filter(([kind]) => kind === 'writeFile').length, 0);
});
