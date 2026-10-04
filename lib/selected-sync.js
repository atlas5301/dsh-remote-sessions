/**
 * Isolated, opt-in selected provider/model synchronization. No host imports,
 * local file reads, SSH, deployment, environment lookup, or import-time effects.
 *
 * Lead integration contracts:
 * - createSelectedSyncPlan({ providers, selections: [{ provider, model }],
 *     defaultPin?: { provider, model, reasoningEffort? }, credentialRefs?: [],
 *     credentials?: { version: 1, refs: {}, records?: {} } }) -> frozen preview.
 *   Source profiles must contain explicit models; only selected model entries
 *   and modelOverrides leave this process. No local default is ever consulted.
 *   Credentials must be explicitly selected API-key refs used by those routes.
 *   The returned plan contains NO values or individual credential-value hashes.
 *   Values are retained in a WeakMap, not serializable properties of the plan.
 * - hashDocumentText(string | null) -> deterministic sha256 fingerprint; null
 *   means absent, and differs from an existing empty file. Capture remote bytes
 *   and these fingerprints through a separately authenticated read-only probe.
 * - createSelectedSyncPayload(plan, { yamlModulePath, expectedHashes: {
 *     config, credentials? }, dshHome?, baseProviderConfig? }) -> PRIVATE stdin
 *   JSON string. NEVER put it in argv, UI responses, previews, or logs. A plan
 *   must be the original in-process object, not a deserialized preview.
 *   baseProviderConfig is the remote effective llm-pi-ai config, required when
 *   the home patch has no managed config row (otherwise inherited routes would
 *   be shadowed). Discover it remotely; never substitute the local full config.
 * - generateRemoteMergeProgram() -> secret-free CommonJS source for node -e.
 *   Send payload separately on stdin. This module does not execute that code.
 * - mergeSelectedSyncDocuments({ configText, credentialsText, payload, yaml })
 *   -> { configText, credentialsText, changed }; PURE but its result is PRIVATE.
 *   Inject the already-installed YAML library; no source dependency is needed.
 *
 * Safety/limitations: only ~/.dsh/cordis.patch.yml and ~/.dsh/.credentials.yaml
 * are mutation targets; custom DSH_HOME/profile patches are not supported. The
 * existing ~/.dsh directory and every target to be changed must exist (initial
 * creation is deliberately left to a separate, explicit operator action).
 * Headers, URL auth/query/fragment, arbitrary chat-template fields, unknown
 * route/model fields, aliases/tags, ambiguous managed rows, and flat legacy
 * credential stores are refused. Catalog-only local AND selected remote routes
 * need caller-materialized explicit model definitions. Changing a remote auth
 * ref requires the new ref's explicitly selected value. Changing shared route
 * fields while retaining other
 * remote models is refused. No memory/skill/plugin/OAuth/browser-record transfer.
 * Untouched YAML nodes/comments are preserved, not necessarily byte formatting.
 * The selected route is a new YAML node; its own comments/formatting may change.
 * Semantic hashes are integrity checks, NOT authentication or approval tokens.
 * Rejecting known authentication locations cannot identify arbitrary secrets
 * disguised as otherwise-valid names/labels/model IDs; callers must supply
 * trusted configuration. Keep remote fingerprints and merged texts private.
 * CAS checks plus backups are NOT a multi-file transaction or an interprocess
 * lock: a non-cooperating writer can still race the final check/rename, and a
 * second-file failure can leave a partial commit. Retained backups/stages require
 * manual recovery/retention management; this program never deletes files.
 * Remote inherited-env credentials may shadow file refs. Route readiness,
 * effective-layer drift, DSH reload, ACLs and network authentication are outside
 * this helper's contract. POSIX owner/mode/no-follow protections are mandatory.
 */
import { createHash } from 'node:crypto';

// A single self-contained implementation is used by pure helpers and the
// generated program, so remote validation cannot drift from local validation.
function selectedSyncCore(digest) {
  const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const mapping = (value) => value !== null && typeof value === 'object' &&
    !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
  const badKey = (key) => ['__proto__', 'prototype', 'constructor'].includes(key);
  function json(value, seen = new Set()) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if ((!mapping(value) && !Array.isArray(value)) || seen.has(value)) fail('INVALID_JSON');
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (badKey(key)) fail('UNSAFE_KEY');
      json(value[key], seen);
    }
    seen.delete(value);
  }
  function stable(value) {
    json(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (mapping(value)) return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  const clone = (value) => JSON.parse(stable(value));
  function fields(value, allowed, code) {
    if (!mapping(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
  }
  function identifier(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 ||
      /[\x00-\x1f\x7f]/.test(value) || badKey(value)) fail('INVALID_IDENTIFIER');
    return value;
  }
  function ref(value, apiOnly = false) {
    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || badKey(value)) fail('INVALID_CREDENTIAL_REF');
    // The native store allows arbitrary POSIX refs. This deliberately narrower
    // API-key-only feature does not offer token/signing/cookie ref transport.
    if (apiOnly && (!/^(?:[A-Za-z_][A-Za-z0-9_]*_)?API_KEY$/.test(value) ||
      /OAUTH|BROWSER|SIGN|SESSION|TOKEN|COOKIE|JWT|PRIVATE_KEY/i.test(value))) fail('NON_API_KEY_REF');
    return value;
  }
  const routeFields = ['apiKeyEnv', 'displayName', 'api', 'baseURL', 'models',
    'modelOverrides', 'compat', 'defaultContextWindow', 'defaultMaxTokens',
    'defaultInput', 'headers', 'reasoning', 'thinkingBudgets', 'cacheRetention',
    'transport', 'timeoutMs', 'websocketConnectTimeoutMs', 'streamIdleTimeoutMs',
    'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes', 'retryPolicy'];
  const modelFields = ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'];
  // These nested fields have no string-valued authentication escape hatch.
  const compatFields = ['supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort',
    'supportsUsageInStreaming', 'supportsFinishReason', 'maxTokensField',
    'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText',
    'requiresReasoningContentOnAssistantMessages', 'thinkingFormat',
    'supportsThinkingTokenBudget', 'thinkingTokenBudgetField', 'vllmPriority',
    'supportsMaxOutputTokens', 'supportsStrictMode', 'cacheControlFormat',
    'supportsLongCacheRetention', 'supportsEagerToolInputStreaming',
    'supportsCacheControlOnTools', 'supportsTemperature', 'forceAdaptiveThinking',
    'allowEmptySignature', 'supportsStrictTools'];
  // Arbitrary chatTemplateKwargs/Args are deliberately unsupported: those
  // string-valued wire fields can carry authentication material unnoticed.
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  function enumValue(value, allowed) { if (typeof value !== 'string' || !allowed.includes(value)) fail('INVALID_PROFILE_VALUE'); }
  function positive(value) { if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_PROFILE_VALUE'); }
  function modalities(value) { if (!Array.isArray(value) || value.some((entry) => !['text', 'image'].includes(entry))) fail('INVALID_PROFILE_VALUE'); }
  function compat(value) {
    fields(value, compatFields, 'UNSUPPORTED_COMPAT_FIELD');
    const enums = {
      maxTokensField: ['max_completion_tokens', 'max_tokens'],
      thinkingFormat: ['openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling'],
      thinkingTokenBudgetField: ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'],
      cacheControlFormat: ['anthropic'],
    };
    for (const [key, entry] of Object.entries(value)) {
      if (own(enums, key)) enumValue(entry, enums[key]);
      else if (key === 'vllmPriority') { if (!Number.isSafeInteger(entry)) fail('INVALID_PROFILE_VALUE'); }
      else if (typeof entry !== 'boolean') fail('INVALID_PROFILE_VALUE');
    }
  }
  function retry(value) {
    fields(value, ['mode', 'maxRetries', 'retryableCodes', 'backoff'], 'UNSUPPORTED_RETRY_FIELD');
    enumValue(value.mode, ['normal', 'always']);
    if (own(value, 'maxRetries') && (!Number.isSafeInteger(value.maxRetries) || value.maxRetries < 0)) fail('INVALID_PROFILE_VALUE');
    if (own(value, 'retryableCodes') && (!Array.isArray(value.retryableCodes) || value.retryableCodes.some((code) => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,80}$/.test(code)))) fail('INVALID_PROFILE_VALUE');
    if (own(value, 'backoff')) {
      fields(value.backoff, ['initialDelayMs', 'maxDelayMs', 'jitterRatio'], 'UNSUPPORTED_RETRY_FIELD');
      for (const [key, entry] of Object.entries(value.backoff)) if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || (key === 'jitterRatio' && entry > 1)) fail('INVALID_PROFILE_VALUE');
    }
  }
  function safeNested(value) {
    if (Array.isArray(value)) { value.forEach(safeNested); return; }
    if (!mapping(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (/^(?:api.?key|access.?token|refresh.?token|id.?token|token|secret|password|authorization|cookies?|credentials?|signing.?key|private.?key)$/i.test(key)) fail('EMBEDDED_AUTH_MATERIAL');
      safeNested(nested);
    }
  }
  function model(value, override = false) {
    fields(value, override ? modelFields.filter((key) => key !== 'id') : modelFields, 'UNSUPPORTED_MODEL_FIELD');
    json(value);
    safeNested(value);
    if (!override) identifier(value.id);
    if (own(value, 'name')) identifier(value.name);
    for (const key of ['contextWindow', 'maxTokens']) if (own(value, key)) positive(value[key]);
    if (own(value, 'input')) modalities(value.input);
    if (own(value, 'reasoningEfforts') && value.reasoningEfforts !== false) {
      fields(value.reasoningEfforts, levels, 'INVALID_REASONING_EFFORTS');
      for (const wire of Object.values(value.reasoningEfforts)) if (wire !== null && typeof wire !== 'string') fail('INVALID_REASONING_EFFORTS');
    }
    if (own(value, 'compat')) compat(value.compat);
    return clone(value);
  }
  function route(value) {
    fields(value, routeFields, 'UNSUPPORTED_ROUTE_FIELD');
    json(value);
    if (own(value, 'apiKeyEnv')) ref(value.apiKeyEnv, true);
    if (own(value, 'displayName')) identifier(value.displayName);
    if (own(value, 'api')) enumValue(value.api, ['openai-completions', 'openai-responses', 'anthropic-messages']);
    if (own(value, 'reasoning')) enumValue(value.reasoning, levels);
    if (own(value, 'cacheRetention')) enumValue(value.cacheRetention, ['none', 'short', 'long']);
    if (own(value, 'transport')) enumValue(value.transport, ['sse', 'websocket', 'websocket-cached', 'auto']);
    for (const key of ['defaultContextWindow', 'defaultMaxTokens', 'streamIdleTimeoutMs', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes']) if (own(value, key)) positive(value[key]);
    for (const key of ['timeoutMs', 'websocketConnectTimeoutMs']) if (own(value, key) && (!Number.isSafeInteger(value[key]) || value[key] < 0)) fail('INVALID_PROFILE_VALUE');
    if (own(value, 'defaultInput')) modalities(value.defaultInput);
    if (own(value, 'thinkingBudgets')) {
      fields(value.thinkingBudgets, ['minimal', 'low', 'medium', 'high'], 'INVALID_PROFILE_VALUE');
      for (const budget of Object.values(value.thinkingBudgets)) if (typeof budget !== 'number' || !Number.isFinite(budget)) fail('INVALID_PROFILE_VALUE');
    }
    if (own(value, 'retryPolicy')) retry(value.retryPolicy);
    if (own(value, 'headers') && (!mapping(value.headers) || Object.keys(value.headers).length > 0)) fail('EMBEDDED_HEADER_MATERIAL');
    if (own(value, 'baseURL')) {
      let url;
      try { url = new URL(value.baseURL); } catch { fail('INVALID_BASE_URL'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('EMBEDDED_URL_MATERIAL');
    }
    if (!Array.isArray(value.models) || value.models.length === 0) fail('EXPLICIT_MODELS_REQUIRED');
    const ids = new Set();
    for (const entry of value.models) {
      model(entry);
      if (ids.has(entry.id)) fail('DUPLICATE_MODEL');
      ids.add(entry.id);
    }
    if (own(value, 'modelOverrides')) {
      if (!mapping(value.modelOverrides)) fail('INVALID_MODEL_OVERRIDES');
      for (const [id, entry] of Object.entries(value.modelOverrides)) { identifier(id); model(entry, true); }
    }
    if (own(value, 'compat')) compat(value.compat);
    for (const [key, nested] of Object.entries(value)) if (key !== 'apiKeyEnv') safeNested(nested);
    return clone(value);
  }
  function pin(value, selections) {
    if (value === undefined || value === null) return null;
    fields(value, ['provider', 'model', 'reasoningEffort'], 'INVALID_DEFAULT_PIN');
    identifier(value.provider); identifier(value.model);
    if (!selections.some((item) => item.provider === value.provider && item.model === value.model)) fail('UNSELECTED_DEFAULT_PIN');
    if (own(value, 'reasoningEffort') && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.reasoningEffort)) fail('INVALID_REASONING_EFFORT');
    return clone(value);
  }
  function prepare(options) {
    fields(options, ['providers', 'selections', 'defaultPin', 'credentialRefs', 'credentials'], 'INVALID_PLAN_OPTIONS');
    if (!mapping(options.providers) || !Array.isArray(options.selections) || options.selections.length === 0) fail('EXPLICIT_SELECTION_REQUIRED');
    const selections = options.selections.map((item) => {
      fields(item, ['provider', 'model'], 'INVALID_SELECTION');
      return { provider: identifier(item.provider), model: identifier(item.model) };
    }).sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
    if (new Set(selections.map(stable)).size !== selections.length) fail('DUPLICATE_SELECTION');
    const routes = [];
    for (const provider of [...new Set(selections.map((item) => item.provider))]) {
      if (!own(options.providers, provider)) fail('SELECTED_PROVIDER_NOT_FOUND');
      // Refuse unknown/auth fields even when they sit on an unselected model
      // inside this selected route, rather than silently sanitizing a secret.
      const source = route(options.providers[provider]);
      const selected = new Set(selections.filter((item) => item.provider === provider).map((item) => item.model));
      const models = source.models.filter((entry) => selected.has(entry.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      if (models.length !== selected.size) fail('SELECTED_MODEL_NOT_FOUND');
      source.models = models;
      if (source.modelOverrides) source.modelOverrides = Object.fromEntries(Object.entries(source.modelOverrides).filter(([id]) => selected.has(id)));
      routes.push({ provider, profile: source });
    }
    if (options.credentialRefs !== undefined && !Array.isArray(options.credentialRefs)) fail('INVALID_CREDENTIAL_SELECTION');
    const credentialRefs = (options.credentialRefs ?? []).map((value) => ref(value, true)).sort();
    if (new Set(credentialRefs).size !== credentialRefs.length) fail('DUPLICATE_CREDENTIAL_REF');
    const refs = {};
    if (credentialRefs.length) {
      fields(options.credentials, ['version', 'refs', 'records'], 'INVALID_LOCAL_CREDENTIAL_DOCUMENT');
      if (options.credentials.version !== 1 || !mapping(options.credentials.refs)) fail('VERSIONED_CREDENTIALS_REQUIRED');
      for (const name of credentialRefs) {
        if (!routes.some((item) => item.profile.apiKeyEnv === name)) fail('UNSELECTED_ROUTE_CREDENTIAL');
        if (!own(options.credentials.refs, name) || typeof options.credentials.refs[name] !== 'string' || options.credentials.refs[name].length === 0) fail('SELECTED_CREDENTIAL_NOT_FOUND');
        refs[name] = options.credentials.refs[name];
      }
    }
    const operations = { routes, defaultPin: pin(options.defaultPin, selections), refs };
    const publicOperation = { routes, defaultPin: operations.defaultPin, credentialRefs };
    const planHash = digest(`selected-sync-plan-v1\n${stable(publicOperation)}`);
    const preview = { version: 1, planHash, routes: routes.map(({ provider, profile }) => ({
      provider, models: profile.models.map((entry) => entry.id),
      ...(profile.apiKeyEnv === undefined ? {} : { apiKeyEnv: profile.apiKeyEnv }),
      routeHash: digest(`selected-sync-route-v1\n${stable(profile)}`)
    })), defaultPin: operations.defaultPin, credentialRefs,
      warnings: ['Credential values are not part of the preview hash.', 'Backups and CAS do not provide a multi-file transaction.'] };
    return { operations, preview };
  }
  function fingerprint(text) {
    if (text !== null && typeof text !== 'string') fail('INVALID_DOCUMENT_TEXT');
    return digest(text === null ? 'selected-sync-document-v1\nabsent' : `selected-sync-document-v1\npresent\n${text}`);
  }
  function hash(value) { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) fail('INVALID_EXPECTED_HASH'); }
  function validatePayload(payload) {
    fields(payload, ['version', 'planHash', 'yamlModulePath', 'dshHome', 'expectedHashes', 'operations', 'baseProviderConfig'], 'INVALID_PAYLOAD');
    if (payload.version !== 1) fail('INVALID_PAYLOAD_VERSION');
    if (typeof payload.yamlModulePath !== 'string' || !payload.yamlModulePath.startsWith('/') ||
      !/\/node_modules\/yaml(?:\/dist\/index\.js)?$/.test(payload.yamlModulePath) ||
      payload.yamlModulePath.split('/').some((part) => part === '.' || part === '..') || /[\x00-\x1f\x7f]/.test(payload.yamlModulePath)) fail('INVALID_YAML_MODULE_PATH');
    if (payload.dshHome !== undefined && typeof payload.dshHome !== 'string') fail('INVALID_DSH_HOME');
    fields(payload.expectedHashes, ['config', 'credentials'], 'INVALID_EXPECTED_HASHES');
    hash(payload.expectedHashes.config);
    fields(payload.operations, ['routes', 'defaultPin', 'refs'], 'INVALID_OPERATIONS');
    if (!Array.isArray(payload.operations.routes) || payload.operations.routes.length === 0 || !mapping(payload.operations.refs)) fail('INVALID_OPERATIONS');
    const providers = {};
    const selections = [];
    for (const item of payload.operations.routes) {
      fields(item, ['provider', 'profile'], 'INVALID_ROUTE_OPERATION');
      identifier(item.provider);
      if (own(providers, item.provider)) fail('DUPLICATE_PROVIDER');
      providers[item.provider] = route(item.profile);
      selections.push(...item.profile.models.map((entry) => ({ provider: item.provider, model: entry.id })));
    }
    const credentialRefs = Object.keys(payload.operations.refs);
    if (credentialRefs.length) hash(payload.expectedHashes.credentials);
    else if (payload.expectedHashes.credentials !== undefined && payload.expectedHashes.credentials !== null) fail('UNSELECTED_CREDENTIAL_HASH');
    const result = prepare({ providers, selections, defaultPin: payload.operations.defaultPin,
      credentialRefs, credentials: { version: 1, refs: payload.operations.refs } });
    if (payload.planHash !== result.preview.planHash) fail('PLAN_HASH_MISMATCH');
    if (payload.baseProviderConfig !== undefined) {
      if (!mapping(payload.baseProviderConfig) || !mapping(payload.baseProviderConfig.providers)) fail('INVALID_REMOTE_BASE_CONFIG');
      json(payload.baseProviderConfig);
    }
    return payload;
  }
  function parse(text, yaml, kind) {
    if (text !== null && typeof text !== 'string') fail('INVALID_DOCUMENT_TEXT');
    let document, value;
    try {
      document = text === null ? new yaml.Document(kind === 'config' ? [] : {}) : yaml.parseDocument(text, { uniqueKeys: true, prettyErrors: false, strict: true });
      if (document.errors.length || document.warnings.length) fail('INVALID_REMOTE_YAML');
      if (document.contents == null) document.contents = document.createNode(kind === 'config' ? [] : {});
      value = document.toJS({ maxAliasCount: 0 });
      json(value);
    } catch { fail('INVALID_REMOTE_YAML'); }
    return { document, value };
  }
  function managed(rows, id, name) {
    if (!Array.isArray(rows)) fail('INVALID_REMOTE_CONFIG_ROOT');
    const matches = [];
    let encountered = 0;
    function visit(entries, prefix) {
      entries.forEach((entry, index) => {
        if (!mapping(entry)) fail('INVALID_REMOTE_PATCH_ROW');
        const path = [...prefix, index];
        if (entry.id === id) {
          encountered++;
          if (own(entry, 'insert') || (own(entry, 'name') && entry.name !== name) || entry.group) fail('AMBIGUOUS_MANAGED_ROW');
          if (own(entry, 'config')) {
            if (!mapping(entry.config)) fail('INVALID_MANAGED_CONFIG');
            matches.push({ path, config: entry.config });
          }
        }
        if (own(entry, 'insert')) {
          if (!Array.isArray(entry.insert)) fail('INVALID_REMOTE_INSERT');
          visit(entry.insert, [...path, 'insert']);
        }
        if (entry.group && Array.isArray(entry.config)) visit(entry.config, [...path, 'config']);
      });
    }
    visit(rows, []);
    if (encountered > 1) fail('AMBIGUOUS_MANAGED_ROW');
    return matches[0];
  }
  function credentialDocument(value) {
    if (!mapping(value)) fail('INVALID_REMOTE_CREDENTIAL_ROOT');
    if (Object.keys(value).length === 0) return;
    fields(value, ['version', 'refs', 'records'], 'INVALID_REMOTE_CREDENTIAL_FIELDS');
    if (value.version !== 1) fail('VERSIONED_CREDENTIALS_REQUIRED');
    for (const section of ['refs', 'records']) if (value[section] != null && !mapping(value[section])) fail('INVALID_REMOTE_CREDENTIAL_SECTION');
    for (const [name, secret] of Object.entries(value.refs ?? {})) {
      ref(name);
      if (typeof secret !== 'string' || secret.length === 0) fail('INVALID_REMOTE_CREDENTIAL_VALUE');
    }
    for (const [key, record] of Object.entries(value.records ?? {})) {
      if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(key) || !mapping(record)) fail('INVALID_REMOTE_CREDENTIAL_RECORD');
      if (record.kind === 'api-key') {
        fields(record, ['kind', 'key', 'env'], 'INVALID_REMOTE_CREDENTIAL_RECORD');
        if (record.key !== undefined && (typeof record.key !== 'string' || record.key.length === 0)) fail('INVALID_REMOTE_CREDENTIAL_RECORD');
        if (record.env !== undefined) {
          if (!mapping(record.env)) fail('INVALID_REMOTE_CREDENTIAL_RECORD');
          for (const [name, secret] of Object.entries(record.env)) {
            ref(name);
            if (typeof secret !== 'string' || secret.length === 0) fail('INVALID_REMOTE_CREDENTIAL_RECORD');
          }
        }
      } else if (record.kind === 'grant') {
        fields(record, ['kind', 'payload'], 'INVALID_REMOTE_CREDENTIAL_RECORD');
        if (!own(record, 'payload')) fail('INVALID_REMOTE_CREDENTIAL_RECORD');
        json(record.payload);
      } else fail('INVALID_REMOTE_CREDENTIAL_RECORD');
    }
  }
  function mergeRoute(current, selected) {
    if (current === undefined) return clone(selected);
    if (!mapping(current)) fail('INVALID_REMOTE_PROVIDER');
    // Never retain embedded authentication in a selected remote route either.
    // Other providers are untouched and are not subject to export validation.
    route(current);
    const selectedIds = new Set(selected.models.map((entry) => entry.id));
    if (current.models !== undefined && !Array.isArray(current.models)) fail('INVALID_REMOTE_MODELS');
    if (current.modelOverrides !== undefined && !mapping(current.modelOverrides)) fail('INVALID_REMOTE_MODEL_OVERRIDES');
    // Shared endpoint/auth/protocol changes must not affect unselected models.
    const hasOtherModels = current.models.some((entry) => {
      if (!mapping(entry) || typeof entry.id !== 'string') fail('INVALID_REMOTE_MODEL');
      return !selectedIds.has(entry.id);
    }) || Object.keys(current.modelOverrides ?? {}).some((id) => !selectedIds.has(id));
    if (hasOtherModels) for (const [key, value] of Object.entries(selected)) {
      if (!['models', 'modelOverrides'].includes(key) && (!own(current, key) || stable(current[key]) !== stable(value))) fail('SHARED_ROUTE_CHANGE_CONFLICT');
    }
    const next = { ...clone(current), ...clone(selected) };
    if (current.models !== undefined) {
      const ids = new Set();
      for (const entry of current.models) {
        if (!mapping(entry) || typeof entry.id !== 'string' || ids.has(entry.id)) fail('INVALID_REMOTE_MODEL');
        ids.add(entry.id);
      }
      const replacements = new Map(selected.models.map((entry) => [entry.id, entry]));
      next.models = current.models.map((entry) => replacements.get(entry.id) ?? clone(entry));
      next.models.push(...selected.models.filter((entry) => !ids.has(entry.id)));
    }
    if (current.modelOverrides !== undefined || selected.modelOverrides !== undefined) {
      if (current.modelOverrides !== undefined && !mapping(current.modelOverrides)) fail('INVALID_REMOTE_MODEL_OVERRIDES');
      next.modelOverrides = { ...clone(current.modelOverrides ?? {}), ...clone(selected.modelOverrides ?? {}) };
      // A retained selected-model override must not silently mask the chosen
      // explicit model. Reset its fields via an empty mapping, not deletion.
      for (const id of selectedIds) if (own(current.modelOverrides ?? {}, id) &&
        !own(selected.modelOverrides ?? {}, id)) next.modelOverrides[id] = {};
    }
    return next;
  }
  function merge({ configText, credentialsText = null, payload, yaml }) {
    validatePayload(payload);
    if (!yaml || typeof yaml.parseDocument !== 'function' || typeof yaml.Document !== 'function') fail('YAML_REQUIRED');
    if (fingerprint(configText) !== payload.expectedHashes.config) fail('CONFIG_CHANGED');
    const selectedRefs = Object.keys(payload.operations.refs);
    if (selectedRefs.length && fingerprint(credentialsText) !== payload.expectedHashes.credentials) fail('CREDENTIALS_CHANGED');
    const parsed = parse(configText, yaml, 'config');
    const providerRow = managed(parsed.value, 'llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai');
    const defaultRow = payload.operations.defaultPin ? managed(parsed.value, 'agent-default-model', '@deepseek-ai/dsh-agent-default-model') : undefined;
    const current = providerRow?.config ?? payload.baseProviderConfig;
    if (!current) fail('REMOTE_BASE_CONFIG_REQUIRED');
    if (current.providers !== undefined && !mapping(current.providers)) fail('INVALID_REMOTE_PROVIDERS');
    const next = clone(current);
    next.providers ??= {};
    for (const { provider, profile } of payload.operations.routes) {
      const oldProfile = next.providers[provider];
      if (oldProfile?.apiKeyEnv && oldProfile.apiKeyEnv !== profile.apiKeyEnv && !selectedRefs.includes(profile.apiKeyEnv)) fail('AUTH_REF_CHANGE_REQUIRES_SELECTED_CREDENTIAL');
      next.providers[provider] = mergeRoute(oldProfile, profile);
    }
    let configChanged = !providerRow || stable(current) !== stable(next);
    if (configChanged) {
      if (providerRow) {
        if (providerRow.config.providers == null) parsed.document.setIn([...providerRow.path, 'config', 'providers'], parsed.document.createNode({}));
        for (const { provider } of payload.operations.routes) {
          if (stable(providerRow.config.providers?.[provider] ?? null) !== stable(next.providers[provider])) {
            // Patch this selected route only, preserving other provider nodes,
            // their comments, and unrelated llm-pi-ai configuration nodes.
            parsed.document.setIn([...providerRow.path, 'config', 'providers', provider], parsed.document.createNode(next.providers[provider]));
          }
        }
      } else parsed.document.add({ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: next });
    }
    if (payload.operations.defaultPin) {
      const nextDefault = { ...clone(defaultRow?.config ?? {}), ...clone(payload.operations.defaultPin) };
      if (!defaultRow || stable(defaultRow.config) !== stable(nextDefault)) {
        configChanged = true;
        if (defaultRow) for (const [key, value] of Object.entries(payload.operations.defaultPin)) parsed.document.setIn([...defaultRow.path, 'config', key], parsed.document.createNode(value));
        else parsed.document.add({ id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: nextDefault });
      }
    }
    let credentialsChanged = false, nextCredentialsText = credentialsText;
    if (selectedRefs.length) {
      const parsedCredentials = parse(credentialsText, yaml, 'credentials');
      credentialDocument(parsedCredentials.value);
      for (const name of selectedRefs.sort()) {
        const value = payload.operations.refs[name];
        if (parsedCredentials.value.refs?.[name] !== value) {
          credentialsChanged = true;
          if (parsedCredentials.value.refs == null) {
            parsedCredentials.document.set('refs', parsedCredentials.document.createNode({}));
            parsedCredentials.value.refs = {};
          }
          parsedCredentials.document.setIn(['refs', name], value);
        }
      }
      if (credentialsChanged) {
        parsedCredentials.document.set('version', 1);
        nextCredentialsText = parsedCredentials.document.toString();
      }
    }
    return { configText: configChanged ? parsed.document.toString() : configText,
      credentialsText: nextCredentialsText, changed: { config: configChanged, credentials: credentialsChanged } };
  }
  return { fail, stable, prepare, fingerprint, validatePayload, merge };
}

const digest = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const core = selectedSyncCore(digest);
const privatePlans = new WeakMap();
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function createSelectedSyncPlan(options) {
  const { operations, preview } = core.prepare(options);
  privatePlans.set(preview, operations);
  return freeze(preview);
}
export function hashDocumentText(text) { return core.fingerprint(text); }
export function createSelectedSyncPayload(plan, options) {
  const operations = privatePlans.get(plan);
  if (!operations) core.fail('UNKNOWN_PLAN');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) =>
    !['yamlModulePath', 'expectedHashes', 'dshHome', 'baseProviderConfig'].includes(key))) core.fail('INVALID_PAYLOAD_OPTIONS');
  const payload = { version: 1, planHash: plan.planHash, ...options, operations };
  core.validatePayload(payload);
  return core.stable(payload);
}
export function mergeSelectedSyncDocuments(options) {
  let payload = options.payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { core.fail('INVALID_PAYLOAD_JSON'); } }
  return core.merge({ ...options, payload });
}

async function remoteMain(core) {
  const fs = require('node:fs/promises');
  const { constants } = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { randomBytes } = require('node:crypto');
  const committed = [];
  try {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || !constants.O_NOFOLLOW) core.fail('POSIX_PROTECTION_REQUIRED');
    let input = '', bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) core.fail('INPUT_TOO_LARGE');
      input += chunk.toString('utf8');
    }
    let payload;
    try { payload = JSON.parse(input); } catch { core.fail('INVALID_PAYLOAD_JSON'); }
    core.validatePayload(payload);
    const home = path.resolve(os.homedir());
    const dshHome = path.join(home, '.dsh');
    if (payload.dshHome !== undefined && payload.dshHome !== dshHome) core.fail('PATH_NOT_ALLOWED');
    const uid = process.getuid();
    // Check every component, not just the final file. Existing hierarchy only;
    // never repair permissions or follow a symlink to an unexpected location.
    const components = [];
    let cursor = dshHome;
    while (true) { components.unshift(cursor); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
    for (const component of components) {
      const info = await fs.lstat(component);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) ||
        (info.uid !== uid && info.uid !== 0) || (component === dshHome && info.uid !== uid)) core.fail('UNSAFE_DIRECTORY');
    }
    const targets = { config: path.join(dshHome, 'cordis.patch.yml'), credentials: path.join(dshHome, '.credentials.yaml') };
    const safeTarget = (filename) => Object.values(targets).includes(filename) && path.dirname(filename) === dshHome;
    function fileInfo(info, kind) {
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== uid ||
        (info.mode & 0o7000) || (info.mode & (kind === 'credentials' ? 0o077 : 0o022))) core.fail('UNSAFE_FILE');
    }
    async function snapshot(kind) {
      const filename = targets[kind];
      if (!safeTarget(filename)) core.fail('PATH_NOT_ALLOWED');
      let before;
      try { before = await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return { text: null, info: null }; throw error; }
      fileInfo(before, kind);
      if (before.size > 4 * 1024 * 1024) core.fail('REMOTE_FILE_TOO_LARGE');
      const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat(); fileInfo(info, kind);
        if (before.dev !== info.dev || before.ino !== info.ino) core.fail('FILE_RACE');
        const text = await handle.readFile('utf8');
        const after = await handle.stat();
        if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || Buffer.byteLength(text) > 4 * 1024 * 1024) core.fail('FILE_RACE');
        return { text, info: after };
      } finally { await handle.close(); }
    }
    const yaml = require(payload.yamlModulePath); // trusted, installed DSH YAML location, never supplied source code
    const touchesCredentials = Object.keys(payload.operations.refs).length > 0;
    const config = await snapshot('config');
    const credentials = touchesCredentials ? await snapshot('credentials') : { text: null, info: null };
    const merged = core.merge({ configText: config.text, credentialsText: credentials.text, payload, yaml });
    const originals = { config, credentials };
    const changed = Object.keys(merged.changed).filter((kind) => merged.changed[kind]);
    if (!changed.length) { process.stdout.write(JSON.stringify({ ok: true, changed: [], backups: [] }) + '\n'); return; }
    if (changed.some((kind) => originals[kind].text === null)) core.fail('TARGET_CREATION_REQUIRES_OPERATOR');
    const suffix = `${Date.now()}-${randomBytes(16).toString('hex')}`;
    const stages = {}, backups = [];
    async function exclusive(filename, text, mode) {
      // Only sibling artifacts of a whitelisted target can ever be created.
      if (path.dirname(filename) !== dshHome || !Object.values(targets).some((target) =>
        filename === `${target}.selected-sync-${suffix}.backup` || filename === `${target}.selected-sync-${suffix}.stage`)) core.fail('PATH_NOT_ALLOWED');
      const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    }
    async function recheck() {
      for (const kind of ['config', ...(touchesCredentials ? ['credentials'] : [])]) {
        const current = await snapshot(kind);
        const original = originals[kind];
        if (core.fingerprint(current.text) !== core.fingerprint(original.text) ||
          (!!current.info !== !!original.info) || (current.info &&
          (current.info.dev !== original.info.dev || current.info.ino !== original.info.ino || current.info.mode !== original.info.mode || current.info.ctimeMs !== original.info.ctimeMs))) core.fail('CONCURRENT_CHANGE');
      }
    }
    await recheck();
    for (const kind of changed) {
      const target = targets[kind];
      if (originals[kind].text !== null) {
        const backup = `${target}.selected-sync-${suffix}.backup`;
        await exclusive(backup, originals[kind].text, 0o600);
        backups.push(path.basename(backup));
      }
      stages[kind] = `${target}.selected-sync-${suffix}.stage`;
      await exclusive(stages[kind], merged[`${kind}Text`], 0o600);
    }
    await recheck();
    for (const kind of changed) {
      // A second CAS check immediately precedes each commit. The program does
      // not claim to eliminate the remaining TOCTOU window with other writers.
      await recheck();
      const target = targets[kind], stage = stages[kind];
      if (!safeTarget(target) || stage !== `${target}.selected-sync-${suffix}.stage` || path.dirname(stage) !== dshHome) core.fail('PATH_NOT_ALLOWED');
      const stagedInfo = await fs.lstat(stage); fileInfo(stagedInfo, 'credentials');
      await fs.rename(stage, target);
      committed.push(kind);
      originals[kind] = await snapshot(kind);
    }
    const directory = await fs.open(dshHome, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    process.stdout.write(JSON.stringify({ ok: true, changed: committed, backups }) + '\n');
  } catch (error) {
    // Never echo YAML/parser/filesystem messages, paths, stdin, or values.
    const allowed = /^[A-Z][A-Z0-9_]{0,80}$/;
    const code = typeof error.code === 'string' && allowed.test(error.code) ? error.code : 'REMOTE_MERGE_FAILED';
    process.stdout.write(JSON.stringify({ ok: false, error: code, committed }) + '\n');
    process.exitCode = 1;
  }
}

export function generateRemoteMergeProgram() {
  return `'use strict';\nconst digest = text => 'sha256:' + require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');\nconst core = (${selectedSyncCore.toString()})(digest);\n(${remoteMain.toString()})(core);\n`;
}
