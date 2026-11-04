# Native prolonged-offline notices

With a broker advertising `policy.presence_events: true`, selected OpenCode conversations poll one bounded page (10 events, at most 64 KiB) per minute. Empty continuation pages are followed on later polls; each completed scan restarts without a cursor. Older brokers are not polled. The broker chooses the prolonged-absence grace and which affected sender may see an event; this connector does not infer a reply timeout or override presence policy.

Notices enter the same bound native conversation as a synthetic machine message, without changing agent/model, granting permissions or treating peer data as human instructions. They contain only validated recipient/event/message IDs, timestamps and pending-delivery uncertainty. A leased transport is not proof of process or model responsiveness. Status is an observation, not a guarantee that the recipient remains offline. Messages are never automatically resent, cancelled or closed.

The inbox's private, exclusively owned SQLite journal stores event ID, native ID and immutable payload before submission. Queue acceptance alone does **not** ACK an event. ACK requires an exact matching synthetic entry in native context, and means verified native presentation/admission into context, not human/model reading or a response. The original payload is compared on recovery, even if the broker's pending-message sample or observation timestamp changes.

Lost responses remain pinned; no potentially invoked native submission is repeated, including after restart. Exact context can reconcile it later. ACK failures can retry after durable local presentation. If a broker suppresses an obsolete event before submission, no notice is submitted; once queued it cannot be silently removed, so its text explicitly states that current state may have changed. Durably presented notices retry ACK independently of polling results, including after a lost applied ACK. An exact broker `404 message_not_found` retires an obsolete presented notice; other errors remain unresolved.

Cancellation, interrupted/failed execution, archive/revert, foreign binding, deselection and disposal fence this path just as they fence normal delivery. Explicit host-started execution can resume a paused conversation. No fallback prompt, notification subprocess or model-selection override is used.

Confirmed/obsolete tombstones are retained eight days, then pruned; the broker already deduplicates their ACK. Uncertain/unconfirmed rows are never automatically pruned. The journal is capped at 10,000 events; the existing database/free-space bounds also apply. At capacity, new notices stop with `native_presence_capacity`, rather than evicting uncertainty and risking duplicate presentation. No credential changes, destructive journal cleanup or automatic reset is performed.

## Validation scope

`test/presence-notices.test.mjs` covers context-only ACK, restart, unknown native
outcome, ACK failure, immutable payload, capability gating, cancellation, selection,
bounded pagination, invalid metadata and durable-write failure. Native and transport
APIs are in-process fakes. These unit checks do not prove broker grace-period behavior,
authenticated model response or actual interactive TUI acceptance.
