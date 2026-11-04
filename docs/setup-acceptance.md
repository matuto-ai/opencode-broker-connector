# URL-only setup and persistence

## Install, configure, use

The scoped 0.6.0 package is an unreleased source candidate. After publication,
install it using the single native plugin-manager command in the README. The
same package loads its server and TUI entries; do not install a second wrapper.

1. Select a conversation in the local OpenCode 2.2.5 TUI. Run `/psst-setup` and
   enter only the HTTPS broker origin.
2. Open the displayed broker `/admin` page. Its form login and exact-request
   approval are human actions. Pending setup is not a connection.
3. Once approved, use the existing send/client tools. Incoming peer data enters
   the native synthetic queue automatically for the selected conversation.
   `/psst-status` reports status; `/psst-cancel-setup` pauses a pending local flow.

Missing configuration never starts enrollment. Pending retries retain the same
candidate and request, including uncertain network results. Private candidate
persistence precedes the first enrollment POST. Restart only reads or polls an
already durable request; it cannot generate a request or rotate credentials.
If the server starts before the owner TUI, selecting that exact owner later
resumes GET-only polling. Fatal poll, attachment or selection failures pause the
flow; selection changes alone cannot retry them. Explicit setup is required.

## Replacement and recovery

The native dialog asks before replacing a terminal request and fences that
confirmation to its exact request ID. Model tools cannot supply this confirmation.
The prior authorization remains selected and usable until the approved candidate
has attached and the original selection revision still matches. Cancellation,
late results, failed attachment or an intervening selection cannot promote it.
Retrying an approved but uncommitted candidate reuses its receipt and original
selection baseline rather than silently replacing a newer choice.

An explicit replacement creates a new credential-bound identity. It retains the
old authorization's local inbox and history, but does not move unread messages or
uncertain sends across authorities. Ordinary plugin upgrade or restart, without
replacement, retains the original credential, mailbox, addresses and pending data.

Denied, expired, paused and pending states are restored from private records.
An expired but fully validated receipt can be inspected only for exact identity
recovery, allowing the native setup UI to offer replacement. It is never accepted
for connection or selection. Wrong token hashes, origin/type mismatches, missing
receipts and corrupt files remain fatal. Broker rejection is reported separately
from validated expiry and from protocol/retry failures.

## Paths for disposable runtimes

The shared installation directory is, in precedence order:

- `PSST_OPENCODE_CONFIG_DIR`;
- `$OPENCODE_CONFIG_DIR/psst`;
- `$XDG_CONFIG_HOME/opencode/psst`, default `~/.config/opencode/psst`.

Persist the complete directory, including selected and pending records, approval
receipts, credentials, binding manifests and inbox journals. Keep the same absolute
path and UID, directory permissions 0700 and file permissions 0600. Do not mount a
subdirectory that omits receipts or owner locks. TUI and server must share this
local private installation directory for active-conversation signaling.

Installation sharing does not recreate OpenCode conversation history. To reopen
an existing native conversation, also retain that host's OpenCode configuration,
native data and state roots under the same project/workspace location. The pinned
host uses `XDG_CONFIG_HOME/opencode`, `XDG_DATA_HOME/opencode` and
`XDG_STATE_HOME/opencode` (default `~/.config/opencode`, `~/.local/share/opencode`
and `~/.local/state/opencode`). An `OPENCODE_CONFIG_DIR` override must also remain
available. Keep native host data separate for intentionally independent hosts;
share the Psst installation, not their entire OpenCode database.

A new host receives a fresh anchor only after native lookup proves all relevant
previous sessions absent, or the persisted bindings belong elsewhere. Matching
native history recovers the existing anchor. Unknown lookups, changed live
bindings, multiple matching anchors or corruption do not permit a reset. Classic
journals without a current native binding are retained and require explicit
migration work; they are never silently adopted.

## Test scope and remaining acceptance

The maintained suite covers connector behavior with in-process native/transport
fakes and temporary private storage: exact session bindings, setup cancellation,
late results, selection CAS, attachment rollback, malformed state, expiry handling,
identity separation, delivery receipts and uncertainty recovery.

Real broker/server, OpenCode TUI, package-install, container recreation and
end-to-end harnesses have been removed. There are no opt-in heavy test stages.
Historical results remain in the repository's pull-request history; they are not
current CI checks or proof of the current environment.

Unit success does not establish authenticated provider execution, active model
toolchain/abort behavior, release availability or native-host compatibility.
For issue #8, the owner explicitly accepted source implementation, focused unit
tests, independent review and CI as the current acceptance scope on 2026-11-04.
Real-environment and integrated native/provider/container tests are deferred to a
later run on the owner's machine, not current acceptance gates. Package
publication is handled separately by the owner. These changes do not provision
credentials or deploy anything.
