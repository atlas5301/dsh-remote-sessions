# Standalone native-session backend — implementation contract

## v0.8.1 behaviour-fix contract

Every fix below is pinned by [test/behaviour-regressions.test.js](<test/behaviour-regressions.test.js>); each test was verified to fail against the shipped v0.8.0 code first.

- **Model sync (TDZ)**: `syncModelsToRemote` computes `remoteDshHome` before its first use (home-level patch step). The API key reaches the remote over stdin (`cat >>`), never on the SSH command line; a freshly created credential store is `umask 077` (owner-only).
- **Runtime drift heal**: `ensure()`'s provisioned-but-stopped branch compares the marker's AND the resident profile patch's `runtimeDirectory`/`socketPath` with the machine config (`residentDrift`); a mismatch re-provisions before start instead of binding the old socket. A consistent resident still cheap-starts (no bundle upload, no file rewrites). The stop pattern stays anchored to `node .* --profile <name>$`.
- **Settings edits never rewire a provisioned machine**: Detect fills a socket default only for an empty field, slugging the machine name like the resident profile (`_`→`-`); Edit+Save carries every non-form machine field from the record being edited, and the backend (`preserveMachineFields`) treats an omitted key as "unchanged" while an explicit `plugins: []` clears the pins. Quarantined legacy records never donate fields; values failing field validation re-default instead of failing the save.
- **Lifecycle writes keep the model catalog**: `readLocalEnvironment(settings, profileDir)` also reads the local profile's `llm-pi-ai` section; `profilePatchText` emits it; the provision signature (`setupSignature`) covers plugins + model catalog + plugin states, so a changed catalog re-provisions and restarts, an unchanged one reports in-sync, and no provision pass can wipe a section an explicit sync wrote.
- **Panel crash**: a failed machines load (`machines === false`) renders an empty list instead of throwing inside the settings section.

## Non-negotiable architecture

- The native DSH frontend stays unchanged except ONE settings/control section. No custom composer or chat panel, no main-panel or sidebar takeover, no workspace-picker hijack, no iframe, no browser authentication extraction, no global frontend transport rewrite.
- Standalone installation: no `dsh-remote` package or metadata required. Its backend service overlays were a reference. Compatibility metadata is opt-in only.
- Remote DSH owns AgentLoop, tools, model calls, sessions, files, policy and durable history. The local host owns metadata-only session identities, native workspace membership and transport.
- No browser work is part of implementation or verification. No DSH core source files are changed.

## Modules

| Module | Responsibility |
| --- | --- |
| [native-host](<lib/native-host.js>) | Package entry, declared Cordis dependencies, lifecycle composition and retained explicit selected actions |
| [native-workspace](<lib/native-workspace.js>) | Explicit standalone anchor → target/remote-directory routing; longest root, no symlink alias |
| [native-mirror](<lib/native-mirror.js>) | Optional dsh-remote metadata compatibility |
| [native-bindings](<lib/native-bindings.js>) | Schema-validated public DSH storage domain; binding committed before remote mutation |
| [native-session-proxy](<lib/native-session-proxy.js>) | Native SessionController overlays, metadata shells, Agent factory fences, uploads and composer APIs |
| [native-observers](<lib/native-observers.js>) | Remote control/status/approval/question events into existing native BFF |
| [native-transport](<lib/native-transport.js>) | Authority/epoch-pinned resident links, native results and unknown mutation outcomes |
| [runtime-adapter](<lib/runtime-adapter.js>) | Resident public Typert/Connection/Gateway descriptor bridge |
| [upload-relay](<lib/upload-relay.js>) | Bounded, backpressured stream chunks into remote fileUploads; expiry/abort |
| [ssh-carrier](<lib/ssh-carrier.js>) | Strict SSH stdio byte relay; opens an existing socket only |
| [remote-setup](<lib/remote-setup.js>) | Strict-SSH detection, provisioning, detached start and guarded upgrades; marker/pid bookkeeping in the runtime directory |
| [native-services](<lib/native-services.js>) | `workspaceFiles` and `terminalController` overlays forwarding file-tree and terminal calls to the remote session owner |
| [remote-workspaces](<lib/remote-workspaces.js>) | Managed virtual workspaces: remote directory browse/mkdir over strict SSH, forwarded remote `workspace/create`, plugin-owned anchors, live mapping refresh and settings persistence |
| [client](<lib/client.js>) | The single settings/control surface: machines CRUD + runtime actions, workspace table and the remote-browse open flow; no chat, main-panel or picker surfaces |
| [companion](<lib/companion.js>) | Public-service readiness and private Unix listener lifetime |

The old host helper module remains an internal dependency for safe selected-actions utilities; its custom session broker/routes are not activated by the package entry. Rejected client code and visual fixtures are not release files.

## Automatic setup and lifecycle

The setup facade wraps one strict-SSH executor (bounded output, explicit exit codes, stdin uploads). Detection is a read-only line-oriented probe; provisioning uploads the shipped resident bundle over stdin, writes a private profile (manifest, patch, marker) and starts one detached process recording its PID. The transport consults the facade only after a failed relay connect and only for machines with a normalized `remoteNode` and `autoSetup` enabled; failures enter a cooldown so connect storms cannot hammer SSH. Upgrades are explicit route actions that first ask the remote itself (`session/list`) for running work, then stop only the recorded PID. Machine lifecycle fields are validated like every other field but excluded from `machineIdentity`.

## Managed virtual workspaces and the settings client

The settings client registers exactly one `settings.section`. Its machine CRUD validates through `machine-registry`, carries private command/env for unchanged names, refuses machines still used by workspaces, and persists through the host settings service; runtime tables update immediately (registry reassignment + resolver refresh) so actions never wait for the config reload. Opening a remote workspace forwards `workspace/create` to the resident (the remote DSH owns the actual workspace), creates a plugin-managed anchor under `~/.dsh/remote-sessions/anchors`, links the mapping, and the client then creates the native workspace and first session through the ordinary client services. Remote browsing is NUL-separated `cd`+`ls` over the same strict SSH executor as setup; `~` aliases are restricted to plain path characters and all paths compose as quoted shell words. The client adapts its request prefix for the Electron Connection channel (`/api`) versus admitted webserver routes.

## File-tree and terminal forwarding

`workspaceFiles` and `terminalController` instances are wrapped when their services become available (profile-dependent), with the same reversible method overlay as the session controller. Session-scoped file paths stay session-relative; absolute paths under the local anchor map to remote-relative form. `readBytes` results carry binary: the resident adapter rebuilds the DSH connection's multipart byte attachments, tags the payload as base64 for the JSON relay, and the local overlay decodes it back into bytes before the native gateway encodes its own response. Terminal input control, retention and screen recovery are enforced by the remote controller itself; the overlay forwards calls and streams, and never falls back to a local PTY.

## Native session seam

Gateway obtains the live service method at invocation time. The plugin reversibly wraps **public instance methods**, preserving native descriptors, validation and receiver context. This is runtime method wrapping, not an official pluggable remote-Agent factory; upgrades require contract tests.

An ordinary native create for a mapped workspace reserves a pinned durable binding, creates the remote session, then publishes a local Session **without an Agent or persistence writer**. That shell supplies the native Workspace's header/membership contract. Follow/page/projections and commands route to the remote owner, not the empty shell transcript. Shells are reconstructed from the binding domain on local restart.

AgentRegistry create/resume and SessionController resolveAgent are fenced for proxy IDs. Agent-lookup APIs get an opaque token handled only by explicit forwarded upload/command/file-reference/question wrappers. Unsupported local Agent operations fail rather than starting a local loop. Scope identity for native approval presentation is routing-only, never registry-published.

Installation rollback restores wrappers on partial failure. Teardown compares own property descriptors because Cordis returns traced method views with differing identity. Normal local sessions delegate through the original methods with their original receiver.

## Identity and reconnection

Each binding requires `sessionId`, `remoteSessionId`, `target`, `cwd`, `remoteCwd`, `authority`, `runtimeId`, `instanceId`. The authoritative domain is `remote_session_bindings`; corrupted or unpinned records refuse load. Existing binding identity cannot be reassigned by later configuration.

Machine authority hashes SSH command/arguments/environment/socket/runtime settings. Metadata/list/control/event caches are qualified by the full authority/runtime/instance, not only target name. The process instance is intentionally strict: remote restart is not survival of a previous model request or approval promise.

Disconnect destroys observation/relay only. Native reconnect obtains a new complete follow snapshot of the same remote session. Transport mutation failure after admission returns `UNKNOWN_MUTATION_OUTCOME`; there is no replay. Full local restart restores mappings and observes the same still-running remote attempt in integration tests.

## Events and approvals

One resident `$events` and control observer pair is maintained per pinned owner. Session-added/status/activity/error events are mapped into native local BFF events. Control baselines omit empty local-shell projections and include authoritative remote values; updates remain native frames.

Remote approvals/questions are dispatched directly through the native answerer waterfall using a scoped presentation token. The local ApprovalService is NOT asked to own/audit the remote action. Native Gateway manages pending client delivery and reconnect replay; the returned answer is sent to the corresponding resident client/event ID. Losing the bridge withdraws local presentation without granting, rejecting or replaying the remote action. Unowned waterfalls are delegated, not held by this plugin.

Timed questions retain `attachWait`, `answer` and timeout error semantics. Optional question-service wrappers are lifecycle-injected, not assumed present at initial plugin activation.

## Inputs and uploads

Native prompt content and user request IDs are forwarded without transcript reconstruction. Images remain encoded prompt inputs and are admitted by remote DSH. The existing native binary-upload Fetch route and encoded `fileUploads/upload` API both forward through remote attachment intake. File references/receipts are remote-owned and admitted by the remote session.

Upload protocol: start → ordered canonical-base64 chunks → finish/abort. Each chunk is at most 192 KiB decoded; at most four uploads per connection; no whole-file host buffer in the relay; inactivity expires abandoned uploads even while observer traffic keeps the carrier alive. Source/storage failure aborts, and finish returns only the remote native receipt.

## Wire and trust

Resident protocol `dsh-remote-sessions/1`: four-byte big-endian UTF-8 JSON frame length, max 8 MiB, correlated request/response/cancel, bounded pull streams. Public API capability descriptors select exact generated argument names. No remote HTML/TCP listener/browser tokens.

Socket parent is private and symlink-free; socket/runtime identity are owner-only. SSH enforces noninteractive authentication, strict host-key checking and no forwarding. Same-UID plugins/processes remain inside the trust boundary.

Model selection forwards only an explicit native selection and preserves DSH's runtime-default side effect. Legacy per-machine model preference fields are not auto-applied. The global native catalog is merged; final validation belongs to the target.

## Verification and remaining boundaries

Current tests run compatible installed DSH with private temporary homes and deterministic model adapters, not mock SessionControllers. The main standalone test exercises production host composition under declared Cordis dependencies and no dsh-remote metadata. It proves uploads/exact bytes, native requests/events/questions, cancellation, local restart, offline refusal, and unaffected local execution. Pure tests cover transport pins/no replay, optional compatibility routing, packaging, rollback and upload limits.

No browser, live deployment or real model credentials are used. Real SSH into the user's remote host has not been retested with this source revision. No claim of universal upgrade compatibility, exactly-once submission or remote-crash recovery.

The native desktop opener, full subagent control and remote fork creation are outside the implemented session-proxy scope. See [README limitations](<README.md>) before activation. Do not enable the old installed plugin or its legacy automatic synchronization.
