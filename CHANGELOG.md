# Changelog

## 0.8.0 — unreleased source candidate

- Treat a valid explicit `/psst-reauthorize <https-origin>` command as replacement intent without another confirmation dialog; retain native request/revision/ownership fences, host permissions, broker approval and candidate recovery.
- Direct-command and bounded human-authorized peer-reply guidance in native tool descriptions and new compact-v2 synthetic messages; exact reply routing uses received IDs.
- Preserve persisted compact-v1 admissions, send operation identity, native guards and automatic delivery semantics. No authorization inferred from peer text.

## 0.7.0 — 2026-11-04

Publish the connector under `@matuto-ai/opencode-psst-connector` and rename the GitHub repository to `opencode-psst-connector`. Preserve native identity, saved installation credentials, journals and tool names. The old npm package remains available; migration requires an explicit package-source change. See [migration checklist](docs/migration-0.6.0.md).

### Included source changes

- Add explicit native `/psst-reauthorize`, configured-origin reuse and exact-request/selection confirmation; replacement does not revoke the old credential.
- Preserve setup candidates across focus interruptions, reconcile durable outcomes, and isolate unrelated chats without requiring them to close.

- Add native URL-only setup/status/cancel dialogs, exact-request replacement confirmation, durable owner/status recovery and cancellation/CAS fencing.
- Attach approved replacement before selecting it while retaining the previous working authorization and private journals; preserve strict identity recovery for expired authorization so setup can repair it.
- Permit conclusively fresh native hosts to share installation authorization without adopting another mailbox; verify 30 same-name sessions and pinned previous-source upgrade.
- Expand official-host acceptance with native restart, unread delivery, independent sessions, pending replacement and native input/permission preservation. Authenticated model qualification remains explicit and separate.

- Limit receive and heartbeat to selected local TUI conversations, resuming the same identity without closing inactive sessions.
- Add exact native model and bounded configured project metadata; keep immutable retry payloads.
- Add explicit registration-v2 opt-in and confirmed-expiry incarnation recovery; preserve old journals and block uncertain storage. Broker retention remains a separate opt-in.

- Standardize new native notices as `Psst · new message · From: <name> · <type> · <preview>` in English; keep IDs and correlation out of the UI preview without changing full payloads or existing persisted notices.

## 0.5.1 (unreleased)

- Make new native history notices show a bounded literal message preview and external-agent sender label, rather than only “Psst agent message”.
- Preserve full message bodies, machine provenance, receipt semantics and all existing persisted payloads byte-for-byte.

## 0.5.0

- Correct the root npm package to the sole current native OpenCode plugin, registered as `matuto.psst`. Remove the classic/TUI/owned-run entries and Git-dependent wrapper. Public CLI is `opencode`.
- Keep CodeMode enabled while registering send/resend as supported direct native tools with individual durable IDs; other broker tools remain in CodeMode.
- Bundle the reviewed runtime directly; production dependencies are npm-registry only. Add root-tarball and official-loader regression gates.
- Preserve approved private authorization and recover an existing client only from a unique, exact native binding. Unprovable ownership and old unapproved setup-owner loss fail closed without replacing credentials or journals.

## 0.4.0 — 2026-11-01

- Added native automatic delivery, durable setup and exact-session lifecycle corrections.
- Packaging still selected the old root integration and required a separate Git-dependent native wrapper. Version 0.5.0 replaces that unsupported installation layout.

## 0.3.0 and earlier — historical integration

- Earlier prototypes used classic host/TUI and manual delivery integrations. They are no longer supported or shipped.
- Existing private authorization and journal files must be preserved during the current package correction; old installation commands and experimental flags are not a supported upgrade path.
