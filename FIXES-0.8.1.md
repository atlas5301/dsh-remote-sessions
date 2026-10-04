# v0.8.1 — operator-reported failures: diagnosis and fixes

Two operator reports against the live v0.8.0 installation: **"Action failed:
BACKEND_ERROR" on the Sync models button** and **"cannot connect to the remote
workspace"**. Both were reproduced against the exact installed code, fixed, and
pinned by a new operator-behaviour regression suite
([test/behaviour-regressions.test.js](<test/behaviour-regressions.test.js>),
12 tests, each verified to fail against the shipped buggy code first).
Release gate: **221 backend + 11 installed-runtime tests green**; live
end-to-end verification on dl1 below.

## Bug 1 — BACKEND_ERROR on "Sync models" (TDZ ReferenceError)

The installed v0.8.0 `lib/model-sync.js` used `remoteDshHome` in the home-level
patch step (5b) **before its `const` declaration** (step 6). Any Sync-models
click threw `ReferenceError: Cannot access 'remoteDshHome' before
initialization`; the route wrapper maps non-conforming errors to
`BACKEND_ERROR`. Reproduced with the exact installed code + real machine config
(`audit/repro-models-sync.mjs`).

Fix: the declaration moved to the top of `syncModelsToRemote` (already in the
source tree; v0.8.1 ships it). Hardening in the same function: the API key now
streams to the remote over **stdin** (`cat >>`), never on the SSH command line
(process lists), and a freshly created credential store is `umask 077`.

## Bug 2 — cannot connect to the remote workspace (configuration drift)

The resident binds its socket inside the `runtimeDirectory` its **profile
patch** names; the transport connects where the **machine config** points.
The live machine `ssh_dl1` had drifted: settings-panel *Detect* rewrote
`socketPath` from the raw machine name (`rs-runtime/ssh_dl1/`), diverging from
the provisioned runtime (`rs-runtime/ssh-dl1/`, dash), and *Edit + Save*
dropped the non-form machine fields (`runtimeDirectory`, `residentProfile`,
…) which then re-defaulted. `ensure()` blindly restarted the stopped resident
with the stale profile patch: it bound the old socket, the start script polled
the configured one, timed out, and every connect failed — while the old
stopScript's un-anchored `pkill` killed the healthy resident AND its own SSH
session.

Fixes:
- **Drift heal** (`residentDrift` + `ensure()`): a provisioned-but-stopped
  resident whose marker **or** profile patch records different
  runtimeDirectory/socketPath is re-provisioned before start (marker drift and
  patch drift are separate cases). A consistent resident still cheap-starts
  (no bundle upload, no rewrites). The stop pattern stays anchored to
  `node .* --profile <name>$`.
- **Client**: Detect fills a socket default only for an empty field, slugging
  the machine name like the resident profile (`_` → `-`); Edit + Save carries
  every non-form machine field from the record being edited.
- **Backend** (`preserveMachineFields`): an omitted key in a posted machine
  record means "unchanged" (never "reset to default"); explicit `plugins: []`
  clears the pins; quarantined legacy records never donate fields; values
  failing field validation re-default instead of failing the save.

## Bug 3 — found by the new tests: Sync models took effect nowhere

Even with 1+2 fixed, the route's lifecycle pass regenerated the resident
profile patch **without** the `llm-pi-ai` provider section the sync had just
written (the resident's model catalog showed only deepseek-official), and the
sync signature covered only plugins, so nothing restarted the resident to load
the new config.

Fixes: `readLocalEnvironment(settings, profileDir)` now also reads the local
profile's `llm-pi-ai` section; `profilePatchText` emits it; the provision
signature (`setupSignature`) covers plugins + model catalog + plugin states —
a changed catalog forces re-provision + restart, an unchanged one stays
in-sync. Also fixed: a failed machines load (`machines === false`) crashed the
settings section render.

## Live verification (dl1, real SSH, production code paths)

- Sync models route: `{ok:true, synced:{providers:true, defaultModel:true,
  credential:true}}`, resident re-provisioned and restarted — exactly one
  resident process, socket serving at the **configured** path
  `/home/ubuntu/.dsh/rs-runtime/ssh_dl1/agent.sock`.
- Transport `connectSsh` (real SSH carrier + protocol hello): hello OK,
  40 endpoints, `session/list` round-trips.
- Resident model catalog: synced models live (`zai-org/GLM-5.3`,
  `zai-org/GLM-5.3-Flash`, `deepseek-ai/DeepSeek-V4.1-Flash`).
- Remote drift state healed; the stale `rs-runtime/ssh-dl1/` incident directory
  was removed.

## Installation

- **0.8.1 installed** into the desktop profile
  (`~/.dsh/profiles/desktop/node_modules/dsh-remote-sessions`; the 0.8.0 copy
  is kept as `dsh-remote-sessions.bak-0.8.0`). The GUI loads plugin code at
  startup — **restart the desktop app to activate the fixed button**. The
  remote connection already works before the restart: the resident now serves
  the configured socket, and the running old code's connect path is
  data-driven.
- Package: `dsh-remote-sessions-0.8.1.tgz`
  (sha256 `016aa7f08d14b124572205e8cbce6d51a2a2fb4fcc0801cca277bd98cdb35605`).
- Re-run the full gate on DSH upgrades: `npm test` and
  `DSH_TEST_RUNTIME_ANCHOR=<installed dsh>/package.json npm run test:runtime`.
