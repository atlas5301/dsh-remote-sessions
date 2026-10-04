# v0.8.2 — operator round 2: config sync, live sync, environment isolation

Four operator-reported issues, each reproduced, pinned by new regression tests
([test/behaviour-regressions.test.js](<test/behaviour-regressions.test.js>), now
20 tests; each new test was verified to FAIL against the previous code), fixed,
and verified live on dl1. Release gate: **229 backend + 11 installed-runtime
tests green**.

## 1. "Local omlx models are not synced to the remote"

The credential step synced only the FIRST provider's `apiKeyEnv` (deepinfra);
omlx never got its key, so the resident could not route it. Model sync now
writes EVERY provider key in the `llm-pi-ai` section (stdin-delivered,
`umask 077`). Live-verified: `OMLX_API_KEY` reaches the resident and the synced
models appear in the resident's catalog.

## 2. "Auto-review permission does not work on the remote session"

The composer's permission picker runs `/permission <preset>` as a session
command — forwarded to the resident — but the RESIDENT never had the
`@deepseek-ai/dsh-experimental-auto-review` bundle, so `auto` was unknown
there. The lifecycle environment now derives session-behavior bundle pins from
the LOCAL profile's enabled optional bundles (the CLI's `OPTIONAL_BUNDLES`,
client-only voice-input excluded, pinned to the CLI version): they compose into
the resident profile manifest, npm-install on provision, and enter the setup
signature so a changed local bundle set re-provisions and restarts. Operator
pins (`machine.plugins`) still win on the same package. Live-verified:
auto-review + agent-team-profile installed on the resident.

## 3. "Remote on-going session is not properly synced to the local side"

Two confirmed symptoms, two root causes:

- **Remote-created sessions invisible locally.** The session list only merged
  BOUND sessions; a session created through another remote interface never
  appeared. `list` now adopts workspace-mapped remote sessions on first
  sight: durable binding + local metadata shell + observer streams + workspace
  membership + `api-session/added` — transcript and live follow then sync
  through the ordinary paths. Unmapped remote directories stay invisible; a
  colliding local session id is never stolen; adoption is best-effort and
  never breaks the list.
- **Bindings died at every resident restart.** The instance id changed on
  restart while the session store PERSISTED, so every bound session went
  permanently offline ("fail closed"). The transport now adopts a new instance
  after verifying the bound remote session still exists
  (`createInstanceAdoption` + `bindings.adopt`, the ONLY deliberate binding
  mutation — every field except the instance stays pinned); a runtime-id
  change still fails closed. Live-verified with the operator's real stale
  binding: the pre-restart session kept serving with its full transcript.

## 4. "Do not break the remote environment: apply only where the remote DSH runs"

The generated resident patch now pins the credential store to the RESIDENT's
OWN runtime directory (`credentials` plugin `path:`), and model sync writes
keys there — the shared `~/.dsh/.credentials.yaml` and the shared
`~/.dsh/cordis.patch.yml` are NEVER written (the old home-level patch cleanup
is removed: a same-id patch entry replaces the whole config, so the
profile-level `llm-pi-ai` fully controls the resident). The credential pin is
part of the setup signature, so residents provisioned before it re-provision
once. The live remote was restored to its pre-testing shared state (probe
sessions and the previously appended shared key removed; only the
resident-owned store carries synced keys).

## Live verification (dl1, production code paths)

- Model sync: all provider keys synced; resident catalog serves
  GLM-5.3/GLM-5.3-Flash/DeepSeek-V4.1-Flash; transport hello + 40 endpoints.
- Bundle pins installed; resident restarted cleanly; exactly one resident
  process at the configured socket.
- Instance adoption: the operator's real stale binding re-served its session
  ("Hi, can you check this") and rebound durably to the new instance.
- Shared home files untouched (mtimes unchanged across a sync); resident-owned
  `credentials.yaml` created owner-only.

## Installation

0.8.2 installed into the desktop profile (0.8.1 copy kept as
`dsh-remote-sessions.bak-0.8.1`). **Restart the desktop app to activate.**
After the restart: the permission picker's Auto works on remote sessions,
remote-created sessions appear, and previously-broken sessions rebind through
instance adoption.


# v0.8.3 — hotfix: session create failed after the bundle-pin install

Operator report: "Action failed: session create failed: gateway/internal:
failed to create session …: SessionQueryError: session … not found" on every
new session/workspace. Root cause: the v0.8.2 bundle pins were npm-installed
into the resident profile, dragging a FULL DUPLICATE of the @deepseek-ai stack
into the profile node_modules — the resident then loaded two copies of the
core modules and `instanceof SessionQueryError` failed across them, so the
"session not found" fallback inside `createOrAdopt` stopped being swallowed
and every create aborted.

Fix (pinned by the updated regression test "CLI-shipped bundle pins compose
WITHOUT npm install"):

- CLI-shipped optional bundles compose through the profile **bundles list**
  only — `resolveBundleDir` resolves them from the installation; they are
  never npm dependencies (`dependencies: {}`).
- npm install stays reserved for OPERATOR plugin pins (`machine.plugins`,
  third-party packages not shipped with the CLI).
- The setup signature carries a manifest format marker, so the layout change
  re-provisions every existing resident exactly once instead of reporting
  in-sync with the broken node_modules.

Live-verified on dl1: duplicate module tree removed; re-provision with the
clean layout; `session/create` and `workspace/create` succeed; the follow
snapshot streams; `/permission` on the resident lists `auto` — the Auto
review preset is live; only the resident symlink remains in the profile
node_modules; probe artifacts cleaned. Gate: **229 backend + 11 runtime**.
