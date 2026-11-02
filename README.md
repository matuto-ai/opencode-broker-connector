# Psst for OpenCode

**0.6.0 source candidate — not published yet.**
One npm package, one current native plugin, registered as **`matuto.psst`**.
The same npm package provides official server and TUI entries. There is no separate installation, Git wrapper or legacy entry.

## Install or update

After this version is published:

```sh
opencode plugin add @matuto-ai/opencode-psst-connector@0.6.0
```

For an existing installation, first inspect `opencode plugin list` and remove
only this connector's exact previous package entry with `opencode plugin remove
<old-entry>` before adding the new version. The manager matches exact package
specs; keep unrelated plugins and all private Psst directories. Do not install
both an old Git wrapper and this npm package.

Reopen OpenCode. Ask the agent to run `broker_setup` with only
`broker_url: "https://YOUR-BROKER"`, then approve that exact request in the broker
admin page. `broker_setup_status` reports status; `broker_cancel_setup` pauses an
unapproved local request. No token, connection-file handoff or host policy change
is needed. Startup never enrolls; an already approved installation is reused.

## Messages

Only the conversation selected in a local TUI receives automatic messages and renews its heartbeat. Home, exit and stale TUI leases suspend transport without closing the identity; reopening reconnects that identity. Multiple CLIs are independent. No TUI signal means offline. See [active-conversation behavior and limits](docs/active-conversation.md).

Incoming messages use the native synthetic queue automatically, without changing
agent/model selection or the user's draft. New native history notices include a
compact literal preview, clearly labeled `Psst · new message`, with `From:` followed
by sender name and client type. Correlation and IDs are not shown in the notice.
Controls and bidi formatting are escaped; long text is truncated.
The full machine-origin body is unchanged. Existing persisted notices keep their
original payload, including their old label. There is no manual receive/ack tool.
Use `broker_list_clients`, `broker_send`, `broker_message_status`,
`broker_update_metadata`, `broker_sent_history`, `broker_message_content`,
`broker_resend` and `broker_cancel`. Native tool identity and original timestamp
scope private retry records; a new tool call is not semantically deduplicated.
With CodeMode enabled, `broker_send` and `broker_resend` are advertised by the
host as direct native tools alongside `execute`, so every outgoing call has its
own durable identity. Other broker tools remain available inside CodeMode. No
mode, permission or session change is required; sends are not nested under
`execute`, whose children share one outer call ID.

A broker receipt proves durable inbox storage; native admission proves persistence,
not model understanding, human approval or completed work. Sender/message IDs stay
in a compact machine-origin envelope. Uncertain/cancelled submissions are never
blindly retried or discarded. See [delivery](docs/native-automation.md).

## Compatibility

OpenCode **2.x** native plugin APIs are the target; **2.2.5** is the validated
version and current runtime guard. This is not a promise that every 2.0+ build
has the required session admission, context, storage and lifecycle APIs. The
public executable is `opencode`; unsupported versions fail clearly rather than
falling back to another integration.

## Existing authorization and private state

The installation path is unchanged: `PSST_OPENCODE_CONFIG_DIR`, otherwise
`$OPENCODE_CONFIG_DIR/psst`, otherwise `$XDG_CONFIG_HOME/opencode/psst` (default
`~/.config/opencode/psst`). Keep it private (directory 0700, files 0600), under the
same UID and absolute path. Existing approved credentials, receipts and inbox
journals are not deleted, rotated or rewritten. An intentional `PSST_CONFIG_FILE`
override remains respected and disables URL setup rather than secretly replacing it.

The old registered ID had a different host-storage namespace. The new plugin can
recover one unique private host anchor only from owned connector manifests and an
exact matching native session ID, creation time, project and location. The old
private format/path markers remain internal compatibility data, not plugin names.
Corrupt, ambiguous or unprovable ownership stops with `identity_recovery_*`; no
replacement client is silently created. Existing live ownership still causes an
owner conflict. Preserve the files and report the error rather than resetting them.
Old classic journals without exact native bindings cannot be migrated automatically:
`identity_legacy_migration_required` preserves them and stops new identity creation.
This is a preservation limit, not a successful migration of that old layout.

An old **unapproved** setup request whose owner existed only in the old host
namespace cannot be resumed safely. It remains intact and inert with
`setup_owner_recovery_required`; existing approved authorization is unaffected.
No direct host-database access or invented cross-namespace migration is used.

## Verification

```sh
npm ci --ignore-scripts --omit=peer
npm run check
npm test
npm run pack:check
```

Tests install the actual root tarball with Git unavailable, use the
official 2.2.5 package loader to select the native server entry, and cover private
state, exact receipts, ownership, recovery and cancellation. Optional real-host
checks use an already available executable via `OPENCODE_BINARY`; this package
and CI do not install a CLI or model provider. Native/model behavior in the owner's
sandbox is part of the joint pilot, not asserted by package tests.

MIT. Vendored Psst code keeps its license and exact integrity pins.

## Migrating to the Psst package name

Version 0.6.0 uses a new npm package and GitHub repository name. Follow the [migration checklist](docs/migration-0.6.0.md) before publication or upgrading an existing installation. Preserve all private Psst state and do not load both old and new sources.

### Opt-in registration v2 and retained native conversations

Registration remains v1 by default. With a compatible broker, an operator can set
`broker.registrationVersion: 2` in plain configuration, or `registration_version: 2`
in an existing `broker-client-bundle-v1` connection file. Only numeric1 or2 is
accepted. The bundle keeps its enrollment-receipt requirement, credentials and
paths; do not convert an enrolled bundle into plain configuration to opt in.
This does not enable server cleanup. The broker's retention/enforcement activation
is a separate operator decision after all connectors are compatible.

An inactive native conversation resumes the same identity before expiry. After an
authenticated lookup confirms its own broker session is gone, the connector
revalidates the exact native conversation and selected state, then creates a fresh
empty journal and identity. A private atomic `current-incarnation.json` pointer
selects that generation on reload. Old pending sends, claims, native admissions and
uncertain operations are never copied or replayed into the new generation. Old
local journals remain untouched; this is not local-history deletion.

The original root `owner.sqlite` lock remains held across rebuilding and child
journals, preventing another worker from concurrently adopting the old root.
Missing/corrupt pointed journals and v1 fallback after a pointer exists fail closed.
Storage uncertainty stops automatic restoration for that conversation during the
plugin lifetime; recovery requires a deliberate plugin reload that first reads the
durable pointer. Never delete journals or change identities to force a retry.

The reviewed SDK also contains two cooperative presence-event tools. This native
connector intentionally continues exposing its existing eight tools, not those two
new tools; unknown future SDK catalog changes still fail closed.
