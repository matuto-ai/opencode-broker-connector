# Pinned Psst runtime candidate

Seven runtime/protocol files are copied byte-for-byte from Psst candidate commit
`f32ddc79ec7b812062ed3f6de7b9a0c12a7128f3` and verified by `src/reference-pin.mjs`. This is a local, unreleased
candidate, not evidence of registry publication or deployed broker support.
Source repository: https://github.com/matuto-ai/psst . MIT license retained.

The new outgoing history/content/resend/cancel APIs require the matching broker
candidate. Existing protocol-v1 send/receive remains compatible. Older brokers
return an explicit unsupported HTTP error for new routes; no local success is fabricated.
Approval/enrollment helpers and test-only broker fixtures retain their separate
original pins. Connector display and read acknowledgment changes live in `src/`.
