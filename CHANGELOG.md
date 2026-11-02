# Changelog

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
