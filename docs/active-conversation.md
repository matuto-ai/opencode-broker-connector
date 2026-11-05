# Active conversation availability (Unreleased)

The same root npm package provides the official OpenCode 2.2.5 `./server` and
`./tui` entries. There is no second plugin installation or CLI wrapper.

Only the conversation currently selected in a local TUI receives automatic
messages and renews its broker heartbeat. Different TUI processes can select
different conversations. If two select the same conversation, it remains active
until the last owner leaves. Home and plugin pages select no conversation.

Changing selection suspends transport and native delivery without closing the
broker identity or deleting history. The broker may still show it connected until
its existing lease expires (normally three minutes). Reopening reconnects the
same persisted identity; heartbeat alone is not used to revive an expired lease.
A synthetic submission already in flight may finish: its original journal and
receipt are reconciled, not duplicated or rewritten.

No TUI signal means offline, including a headless server. A remote TUI without a
shared local private directory is unsupported and shows `Psst offline`; it does
not restore all historic conversations. A newly selected conversation does not
create a broker identity from this signal: its verified native prompt, tool or
approved setup establishes the binding first.

## Local preference, not authority

TUI selection is an ephemeral file lease in the existing private installation
area, scoped to the native directory and workspace. Files are atomically replaced,
private (0600 in 0700 directories), bounded, and reject symlinks. A TUI-local
in-memory owner and increasing sequence survive plugin reload. Each generation
only removes its own last write. Updates are sampled every 250 ms and expire after
five seconds without renewal. Server reconciliation runs every 500 ms. On Linux,
PID start time and boot ID also reject dead or recycled owners; other supported
platforms use process liveness and the bounded TTL, not Linux-specific `/proc`.

**Processes with the same UID can forge this preference.** It is not an
anti-spoofing security boundary. A forged lease can change availability of an
already-authorized conversation (and cause its normal automatic wake/cost).
It cannot create an authorized native binding, supply credentials, change scopes,
redirect an inbox to another session, or grant tool access. The server continues
to own credentials and journals and independently verifies exact native bindings.
There is no public activate RPC or credential exchange. The native setup RPC accepts only a selected session ID, broker URL and request/revision-bound replacement intent; it cannot supply credentials or bypass broker admin approval.

Archive suspension can resume after native unarchive. Explicit disabled records,
and older disabled records whose reason is unknown, remain disabled; selection
never overrides them. Existing unread and uncertain operations remain intact.

## Validation limits

Unit tests exercise connector selection, identity, cancellation and recovery with
in-process native and transport fakes. They do not start OpenCode or a broker.
Authenticated model response and native-host compatibility remain separate product
acceptance concerns. See [setup acceptance](setup-acceptance.md).

## Display metadata

Project labels resolve from the explicit local plugin/config `project`, then the
single variable named by `PSST_PROJECT_ENV`, local `projectEnv`, or the default
`AI_AGENTS_SANDBOX_PROJECT_NAME` (in that order), then the native directory's
basename. Only a bounded display label is used, not a full environment dump.

The exact native session `model.providerID` and `model.id` are preferred. If absent,
`OPENCODE_MANAGED_MODEL=provider/model` is an explicitly configured fallback,
reported as `configured`, never `observed`. Otherwise model remains `unknown`.
Initial registration and newly prepared outgoing sends observe this metadata;
retries retain their original immutable outgoing payload. Model selections and
permissions are not modified.
