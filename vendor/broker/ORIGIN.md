# Pinned Psst runtime candidate

Seven runtime/protocol files are copied byte-for-byte from Psst candidate commit
`92f84f1fda7453000272e2b4fac0725a55bd3556` and verified by `src/reference-pin.mjs`. This is a coordinated local, unreleased candidate based on `f32ddc79ec7b812062ed3f6de7b9a0c12a7128f3`, not a published upstream commit, registry release or evidence of deployed broker support. Only `reference/runtime.mjs` and `reference/client.mjs` changed from that base: heartbeat-supervised reception recovery, bounded reconciliation, current health and transient proxy handling. The same candidate is shared with the Pi, Claude Code and Antigravity connector recovery work.
Source repository: https://github.com/matuto-ai/psst . MIT license retained.

The new outgoing history/content/resend/cancel APIs require the matching broker
candidate. Existing protocol-v1 send/receive remains compatible. Older brokers
return an explicit unsupported HTTP error for new routes; no local success is fabricated.
Approval/enrollment helpers and test-only broker fixtures retain their separate
original pins. Connector display and read acknowledgment changes live in `src/`.
