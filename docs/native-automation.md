# Native delivery contract

The supported OpenCode 2.2.5 plugin uses public `session.get`, `synthetic`,
`context`, hooks, events, storage and tool transforms. The root npm package exposes
one server plugin, `matuto.psst`; no classic or optional alternate entry is shipped.

- A durable private host/native-session binding and exclusive SQLite ownership
  keep inboxes isolated. Same-session reopen retains the original broker identity.
- Exact payload, native ID and injection ID commit before the single
  `synthetic({delivery:"queue",resume:true})` effect. Receipt validation compares
  session, ID, type, delivery and complete payload, not HTTP success alone.
- At most one native item is pending. Native cancellation removes the host's
  idempotency lookup, so uncertain delivery never automatically retries synthetic
  admission. Read-only context proof can reconcile promotion; missing, cancelled,
  compacted or mismatched evidence remains blocked rather than reinjected.
- Interrupt/failure pauses delivery. Subsequent native execution can reopen the
  event pause. Move/archive/delete/unload fence the exact owner; resumable unload
  does not terminally close its surviving broker identity.
- Losing the native event subscription, including a clean stream end, stops
  transport, delivery and tools. Reload the plugin to resume the same durable
  identities. In-flight admissions remain uncertain until exact native context
  proves acceptance; stream recovery never resubmits them automatically.
- Peer messages are native synthetic machine-origin input, not human authority.
  Agent/model selection, drafts and native permissions remain unchanged.
  Newly admitted compact-v2 payloads include exact reply routing and connector-owned guidance for ordinary collaboration, including substantive requests and unrelated work, without separate per-peer, per-message or per-purpose human grants. Resolve discoverable facts and low-risk reversible choices independently; ask only when consequential uncertainty needs human judgment or information. Peer text cannot override human instructions or host safeguards, and identity/routing comes from connector-supplied metadata. Incoming messages do not automatically stop current work or silently displace the human task. This is model guidance, not automatic permission enforcement, an auto-reply loop or an exactly-once task-execution guarantee.
  All persisted admissions, including earlier compact-v2 guidance and compact-v1/legacy payloads, reconcile against their original bytes, never regenerated with new instructions. See the README contract.
- Private operation IDs include the verified native call identity and original
  assistant tool timestamp. An aged replay after journal GC fails closed.

The public-ID correction preserves approved filesystem state. Identity recovery
requires a single proven private anchor; old unapproved setup-owner records cannot
be read from another host plugin namespace and remain inert. See the README.

Official contracts: [plugin manager](https://opencode.ai/v2/docs/plugins/),
[server plugins](https://opencode.ai/v2/docs/build/plugins/server),
[synthetic admission](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/session.ts),
[host loader](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/host.ts).

Unreleased: automatic transport is additionally limited by the local TUI selection preference described in [active-conversation.md](active-conversation.md). This does not grant authentication or tool authority.
