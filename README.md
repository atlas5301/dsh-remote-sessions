# dsh-remote-sessions — standalone native-session backend

English | [中文](README.zh.md)

Run a remote DSH agent through **the existing DSH workspace, conversation, composer, approvals and history UI, unchanged**. This package has no client entry, custom chat panel, remote web application, browser dependency or `dsh-remote` dependency.

```text
Existing native DSH frontend (unchanged)
                  │ ordinary session APIs
Local metadata-only session + backend proxy
                  │ strict SSH / bounded protocol
Independently supervised remote DSH + companion
                  │
Remote AgentLoop, models, tools, files and persistence
```

## Installation

Install into a DSH profile (the plugin is a backend-only package; the native UI stays unchanged):

```sh
dsh plugin --profile web add dsh-remote-sessions     # or: --profile desktop
```

Then restart the profile's runtime and open **Settings → Remote Sessions** to add a machine. The command above is the official channel; the alternatives below also work:

- **npm**: `npm install dsh-remote-sessions` inside the profile, or `dsh plugin --profile web add npm:dsh-remote-sessions@0.8.3` to pin a version.
- **GitHub**: `dsh plugin --profile web add github:atlas5301/dsh-remote-sessions` (the [releases](https://github.com/atlas5301/dsh-remote-sessions/releases) tag each published version).
- **Plugin hub**: search "dsh-remote-sessions" in the [DSH Plugin Hub](https://dsh-plugin.org) / Settings → Plugin Hub and install from the catalog.

Requires DSH **0.2.0-rc.2 or later (0.2.x)** on both hosts and Node 22.15+. SSH must authenticate non-interactively (key or agent) to the remote machine with the same Unix user that owns the runtime directory.

**Version 0.8.6 status:** implemented in source, tested against installed DSH **0.2.0-rc.2** with isolated real runtimes, and verified end-to-end on a live remote host over strict SSH (provisioning, model/credential sync, session proxy, file tree, terminals, upgrade and restart flows).

## Automatic remote setup

The resident runtime is now lifecycle-managed by the plugin itself. Installing the local plugin never touches SSH; when a configured machine is first used, the transport tries the strict SSH relay and, if the private socket is absent, the setup facade runs before one retry:

1. **Detection** (read-only SSH probe): node version, installed DSH CLI path/version, the resident marker (`<runtimeDirectory>/resident.json`), the private socket and its recorded PID.
2. **Reuse**: a serving socket is never stopped, replaced or rewritten.
3. **Start**: a provisioned-but-stopped resident is started with its recorded CLI; no file is touched.
4. **Provision**: a missing resident is created — private directories, the shipped resident bundle uploaded over stdin (tar), a profile composing `@deepseek-ai/dsh-base` + the resident bundle, and a detached launch (`setsid`, falling back to `nohup`) writing its PID. When no DSH CLI exists, `npm install -g @deepseek-ai/dsh@<version>` pins the same version as the local runtime.

Version management stays explicit and guarded: `GET /remote-sessions/runtime/status` reports each machine's runtime/node/bundle versions and upgrade availability; `POST /remote-sessions/runtime/ensure` and `POST /remote-sessions/runtime/upgrade` act on one machine. An upgrade refuses while remote sessions are running (`ACTIVE_WORK_PRESENT`) or while a serving socket cannot be verified or is not supervised through the recorded PID (`ACTIVE_WORK_UNVERIFIABLE`, `RESIDENT_UNSUPERVISED`); it stops only that PID, re-provisions and restarts, after which old bindings fail closed as after any remote process restart. Set `autoSetup: false` on a machine to opt out entirely; `npmInstall: false` forbids remote npm installs.

Machine fields added for lifecycle management (`remoteCli`, `remoteHome`, `residentProfile`, `runtimeDirectory`, `dshVersion`, `autoSetup`, `npmInstall`) are **not** part of the execution authority: existing bindings keep their pinned identity when only setup fields change.

## Settings tab and managed workspaces

The plugin ships **one native settings section** ("Remote Sessions") plus the backend that powers it. There is no chat panel, sidebar entry or workspace-picker takeover — sessions, the file tree and terminals all run through the unchanged native UI.

**Machines** card: add a machine by name and SSH target, press *Detect* (one read-only SSH probe discovers the Node path/version, npm and any installed DSH CLI, and fills safe defaults for the socket and directories). *Start* runs automatic setup; *Upgrade* appears when the shipped resident bundle is newer than the installed one and is refused while remote work is active. Removing a machine that still has workspaces is refused.

**Remote workspaces** card: *Open remote workspace* opens a browse dialog over strict SSH (machine → directories → optional new folder → open). Opening:

1. creates the **actual workspace on the remote DSH** (forwarded `workspace/create`, idempotent);
2. links a **plugin-managed local anchor** (`~/.dsh/remote-sessions/anchors/…`) — nothing for the user to create;
3. starts the native workspace and its first session, so the ordinary UI takes over.

Multiple workspaces per machine and multiple machines are first-class: every mapping is one managed anchor ↔ one remote directory. Unlinking removes the mapping only; the anchor and the remote workspace stay.

Choose remote workspace roots that give the resident's sandbox a real boundary — e.g. `~/dsh-workspaces/<name>` per project. A whole home directory as a remote workspace root provides no cross-workspace write protection and is not recommended.

Manual YAML configuration still works for operators who prefer it:

```yaml
- id: remote-sessions
  config:
    machines:
      - name: build-host
        ssh: [user@build-host]
        remoteNode: /usr/bin/node
        socketPath: /home/user/.dsh/rs-runtime/agent.sock
        remoteCwd: /srv/project
        authorityRevision: '1'
    workspaces:
      - localPath: /absolute/local/remote-project-anchor
        target: build-host
        remotePath: /srv/project
```

Use canonical absolute directories without symlink aliases. More-specific configured roots win. Machine/workspace writes from the settings tab go through the same validation (`machine-registry`) and persist into this configuration through DSH's settings service, so both views stay consistent. The local anchor is **not a synchronized mirror** and never hosts the remote agent. Relative `@file` completion is queried from the remote session. Uploaded files are transferred into remote attachment storage.

Mappings apply to newly created sessions. Existing local sessions are not silently migrated to remote ownership. Persisted proxy bindings retain their exact machine authority, runtime UUID, process instance, session ID and directories even if configuration is later edited.

### The remote web button: a bridge, not a separate instance

The settings tab's *Web* button opens a **machine-scoped web bridge profile**
(`rs-web-<machine>`) on the remote host: the shipped web UI composed over the
**resident's session store**, attachment store and credential store, carrying
the synced model catalog. Sessions, models and credentials are therefore the
SAME on both sides — a session created in the bridge web UI appears in the
local workspace (through list adoption), and every locally-created session
appears in the bridge. A stale standalone `dsh web` on the machine is never
reused for the bridge: ownership is verified per profile and port, and the
bridge replaces it.

### Optional dsh-remote compatibility

`dsh-remote` was a reference for the backend service-overlay pattern, not a dependency. If you already use it, explicitly enable compatibility:

```yaml
mirrorTargets:
  - target: build-host
    alias: my-ssh-alias
# mirrorRoot defaults to $DSH_HOME/remote-workspaces
```

An exact `host`, `username`, `port` tuple can replace `alias`. Ambiguous/unconfigured mirrors refuse remote routing. With no `mirrorTargets`, its metadata is never consulted.

## Resident preparation

The remote agent must be independent of the local GUI and SSH process. Do not use a one-shot headless task, ACP child, remote web server, or desktop child as its owner.

[The preparer](<tools/prepare-resident.mjs>) creates **new** private profile/runtime directories and a systemd user-unit template. It never starts, enables, restarts, kills, deletes or replaces an existing runtime.

```sh
node /absolute/plugin/tools/prepare-resident.mjs \
  --home /home/user/.dsh \
  --profile remote-resident \
  --runtime-directory /home/user/.dsh/rs-runtime \
  --node /absolute/path/to/node \
  --cli /absolute/path/to/@deepseek-ai/dsh/lib/bin.js
```

The home, its `profiles` directory and the runtime directory's parent must already exist and be owned by the operator. The socket path must fit 100 UTF-8 bytes. The companion uses a private Unix socket; no remote TCP/web listener is required. SSH authenticates the same Unix user, with strict host-key checking and noninteractive authentication.

Review the generated profile and service template before installing/starting them. The template uses `Restart=no`: after a remote crash, a stale socket must be investigated rather than blindly deleted. Logout/reboot supervision is a separate OS configuration choice. Configure remote models and credentials explicitly; the plugin never copies full stores, memories or credentials on startup.

The profile composes DSH base and the companion bundle. Normal base policies/plugins apply; this is not a claim that DSH telemetry or unrelated plugins are disabled.

## Implemented native operations

- Ordinary workspace membership and session create/list/search/history/follow.
- Text/image prompt forwarding, queue changes, rename and explicit Stop.
- Live assistant frames and durable journal events, unchanged apart from mapped session headers.
- Native encoded uploads and the existing raw binary-upload route, using bounded 192 KiB relay chunks and remote-owned receipts.
- Native approval and structured-question waterfalls, including client reconnect replay, timed-wait attachment and late-answer forwarding.
- Native control projections, activity/status notifications, remote `@file` completion and command discovery/execution.
- **Remote file tree**: `workspaceFiles` list/read/readBytes/stat/changes forward to the remote session's filesystem. Session-relative paths resolve against the remote workspace root; absolute paths under the local anchor map to their remote-relative form. Binary reads cross the JSON relay as base64-tagged attachments and decode back into bytes before the native reply. Remote watches stream live change frames; a remote-bound session never lists or reads local files.
- **Remote terminals**: the whole `terminalController` surface (environment, shells, create, follow, retain, write, resize, rename, close, list) forwards to the remote PTYs. Screen recovery, exclusive input attachments and retained terminals behave exactly as with a local session; input control is enforced by the remote controller.
- Native model selection and merged model catalogs. **DSH's model selection also saves that runtime's default**, just as its ordinary API does. This plugin only forwards an explicit user model-selection operation; it does not automatically apply legacy machine model-pin fields.
- Durable proxy bindings, restored metadata shells and reattachment after local-host restart, without local Agent creation or mutation replay.

## Model selection on remote sessions

Picking a model in the composer for a remote-bound session forwards
`session/selectModel` to the resident — the remote session's selector reacts
exactly as a local one does, and the selection persists in the remote journal
(`model/selection`). Two asymmetries are worth knowing:

- **Host-specific providers**: a provider whose `baseURL` points at a
  loopback server (e.g. a local `omlx` on `127.0.0.1:8000`) is synced as
  configuration, but the resident can only reach servers on ITS OWN host.
  Selecting such a model for a remote session installs the selection and then
  fails the model call itself — pick remote-reachable providers for remote
  sessions.
- **Failed selections are never silent**: a rejected remote selection (e.g. an
  unsupported reasoning effort) propagates the resident's error AND is
  surfaced through the native session-error channel. Third-party composer
  seats that swallow rejections cannot hide it.

## Failure and compatibility boundaries

- Closing the local UI, losing SSH or exiting the local host does not cancel remote work. Only explicit cancellation does. Remote survival requires its resident process and external resources to remain alive.
- Lost mutation acknowledgments are reported as unknown outcomes. Inspect the authoritative remote history before resubmitting. There is no automatic prompt replay or exactly-once guarantee.
- A remote process restart changes its instance ID while the session store persists. The transport adopts the new instance only after verifying the bound remote session survived (adoption writes through the binding store's low-level row write — the immutable `set()` refuses instance changes); a runtime-identity or authority change still fails closed. An explicit upgrade performs the same guarded restart after verifying no active work.
- The remote store is authoritative for the session list: a bound session that is CONFIRMED absent from an unfiltered remote list (a failed create that had reserved its binding, or a session deleted on the remote side) is unbound and disappears from the local list instead of haunting it as an offline ghost.
- Automatic setup only creates or starts: it never stops, deletes or replaces a running resident. Upgrades stop only the PID recorded in the runtime directory and refuse when remote work is active or unverifiable. A serving socket without a recorded PID (`RESIDENT_UNSUPERVISED`) belongs to an operator-supervised runtime and is never touched.
- Local draft retention is whatever native DSH provides; this backend adds no browser storage or replacement optimistic-message logic.
- The native file tree and terminals **are** virtualized onto the remote session's resources for remote-bound sessions; local sessions keep their ordinary local behavior. The native desktop file-opening action remains local and is not forwarded.
- Remote fork creation and full interactive subagent-management APIs are not implemented; qualified child history can be forwarded, but full parity is not claimed. Unsupported Agent operations are fenced from local execution.
- Explicit selected-sync/transfer backend endpoints remain available with preview/conflict guards; there is no replacement custom UI. No memory/full-provider/OAuth-store sync, pruning or automatic synchronization.
- A host-wide model catalog is a union; target availability is validated by the owning runtime when selected. Identical provider/model names may expose different reasoning options on different hosts.

The backend wraps public service instances and uses generated Gateway descriptors. It changes no installed DSH source files, global frontend transport or native frontend components. These are version-sensitive integration seams—not a guarantee that every future 0.2 release is compatible. Re-run integration tests on upgrades.

## Tests

```sh
npm test
DSH_TEST_RUNTIME_ANCHOR=/absolute/installed/@deepseek-ai/dsh/package.json npm run test:runtime
```

Use Node 22.15+ (the test resolver uses `registerHooks`). Some retained YAML fixtures use `DSH_SELECTED_SYNC_YAML_PATH`; host tests accept `DSH_TEST_DEPENDENCY_ANCHOR`/`DSH_TEST_RUNTIME_ANCHOR`. No dependency install or model credentials are needed when the compatible CLI is already installed.

Current release gate: **229 backend/contract tests (including the 20-test operator-behaviour regression suite) + 11 installed-runtime/profile tests passing** on DSH 0.2.0-rc.2. The runtime suites cover the session proxy, automatic-setup lifecycle scripts (pure, scripted-SSH), remote file-tree forwarding (list/read/readBytes/stat/changes against real remote files, including byte-exact binary reads and live watches) and remote terminals (create/write/follow/resize/rename/close over a real remote PTY).

### Operator-behaviour regression suite

[test/behaviour-regressions.test.js](<test/behaviour-regressions.test.js>) pins every operator-reported failure of the live v0.8.0 installation; each test was verified to FAIL against the shipped buggy code before the fix:

- **"Action failed: BACKEND_ERROR" on Sync models** — a TDZ `ReferenceError` in `syncModelsToRemote`'s home-patch step (the installed 0.8.0 declared `remoteDshHome` after first use). The suite executes the full function through the home-level patch and credential steps, asserts the credential streams over stdin (never on the SSH command line, `umask 077` for a fresh store), and drives the real `/remote-sessions/models/sync` route: healthy flow 200, SSH-down surfaces named codes, and an internal error still maps to BACKEND_ERROR.
- **"Cannot connect to the remote workspace" (configuration drift)** — settings Detect/Edit rewrote `socketPath` from the raw machine name and dropped non-form machine fields; the stopped resident was blindly restarted with a stale profile patch and bound elsewhere while the transport connected to the configured path. The suite pins: `ensure()` re-provisions a stopped resident whose marker OR profile-patch `runtimeDirectory` drifted (marker drift and patch drift are separate cases), cheap-starts a consistent one without re-upload, the settings-panel Detect never rewrites an existing socket path (slugged defaults for new machines only), and Edit+Save preserves every non-form machine field (backend-side too: omitted keys mean "unchanged", explicit `plugins: []` clears).
- **Sync models without effect (model-config wipe)** — the lifecycle provision pass regenerated the resident profile patch WITHOUT the provider section an explicit sync had just written, and the plugin signature reported "in-sync" so the resident never reloaded. `readLocalEnvironment` now reads the local profile's `llm-pi-ai` section as well, `profilePatchText` carries it, and the setup signature covers plugins + model catalog + plugin states, so a changed catalog forces re-provision+restart while an unchanged one stays a no-op restart.
- A `machines: false` (failed load) state no longer crashes the settings section render.
- **Round 2** (see [FIXES-0.8.2.md](<FIXES-0.8.2.md>)): every provider key syncs
  (omlx); session-behavior optional bundles (auto-review, agent-team-profile)
  pin onto the resident; remote-created workspace sessions are adopted into the
  local interface; instance-id changes adopt after verifying the session
  survived; the resident owns its credential store under the runtime directory —
  the remote's shared home is never written.

The standalone integration test boots separate real DSH processes with deterministic mock models, no network model calls and no `dsh-remote`. It checks native workspace membership, model controls, uploads with exact remote bytes, approvals/questions, cancellation, durable binding reopen, full local-host restart reattachment to the **same active attempt**, and fail-closed offline behavior while local sessions still work. Transport is a real Unix socket; SSH framing/configuration has separate tests. No browser is used or required.

The rejected custom frontend and historical tests remain in the development tree only; the release manifest does not register/export/package that client. See [implementation details](<IMPLEMENTATION.md>).
