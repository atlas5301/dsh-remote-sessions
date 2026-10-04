# Native carrier test contract

The current carrier exposes `registry.reconcileNative()` and the machine save route invokes this after updating `registry.machines`. Calling it closes deleted/retargeted owned forwards and sockets, unregisters obsolete identity-specific mux routes, and registers new identity routes. Never signals remote DSH.

Native index is rc.2's exact renderer JSON global: `<script>globalThis["__DSH_BOOT__"] = {"rev":"fixture","entries":[...],"batches":[...]}</script>`. No eval. Schema mirrors dsh-client-modules parseBootManifest. Required IDs are `@deepseek-ai/dsh-client-modules`, `@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-client-ui-workspace`; entries must each be batched exactly once. Unsupported renderer or collision fails before prepare success. Do not assume `window.__DSH_BOOT__` or another global expression is supported.

CSP CONFIRMED: preserve arbitrary API/file CSP exactly. Unknown index CSP now deliberately fails CLOSED: composeRemoteIndex(bytes,identity,headers) rejects content-security-policy header or meta policy. Prepare/initial native GET must 502 with owned child terminated rather than insecure 200. Do NOT remove/weaken a CSP. Present rc.2 supported native index has no CSP. Tests should strictly assert this behavior, not an insecure removal/200.

Caller cancellation: preparing/HTTP/WS waiters should pass abort signal into shared attach; last abandoned pending attach closes only its owned tunnel; an independent live waiter must continue. Buffered index uses combined caller+entry lifetime. Mutation bytes are never replayed.

Latest confirmation: CSP FAIL CLOSED is the intended supported contract; current source rejects unknown index header/meta CSP. Carrier requestLifetime now observes raw net.Socket end as cancellation (not only close). Source is evolving; reread latest before final tests.
