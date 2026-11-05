# Focused connector verification

Use Node 24.19.0 or newer in the Node 24 line:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

`npm test` uses the Node test runner directly and runs every `test/*.test.mjs` file.
There are no local/integration/host partitions, optional heavy probes or skip gates.
CI's single `verify` job runs the same syntax and unit commands. The only npm
dependency is the runtime schema validator, Zod.

## What belongs here

Tests cover this connector's observable behavior: configuration and private-file
validation, native identity and ownership, setup state/confirmation, scoped tool
routing, message formatting, exact delivery receipts, cancellation, resource
cleanup, and recovery after uncertain or failed effects. Host calls, transport and
approval responses use in-process fakes. Temporary files and SQLite journals are
used where persistence or ownership is the connector behavior being tested; no
broker process, OpenCode executable, container, package installation or network is
started by the suite. Vendored client code remains a production dependency, not a
second broker test suite.

Do not add snapshots of upstream broker/renderer implementations or assertions
that only check workflow text. Add a focused regression at the connector boundary
for a real bug. Unit results are not native-host, model-response or deployment
acceptance evidence.

## Outage and return regression

Run the retained caller-facing fault scenarios without credentials, sockets, a broker process or an OpenCode executable:

```sh
node --test test/transport-recovery.test.mjs test/current-setup-ui.test.mjs
```

The fixture runs the real native plugin, adapter, pinned `BrokerClient`/`AdapterRuntime`, durable SQLite inbox and native delivery code. Only broker request/response outcomes, host APIs and time are controlled. Its reproducible outage/return sequence is:

1. Start a selected native chat with a mailbox poll in flight and an uncertain outgoing operation already journaled.
2. Interrupt that poll and fail five heartbeat intervals. Assert no new registration, mailbox polling, approval request, model polling or human-draft mutation while offline; status reports automatic retry waiting.
3. Return a validated stale-lease heartbeat response before any successful heartbeat. Fail three owned-session reconciliation attempts, with one- and two-second spacing; assert round exhaustion remains retry waiting.
4. Advance the heartbeat-length cooldown, restore the broker, and deliver the queued envelope into the same native session and inbox. Assert one exact synthetic admission, durable inbox storage before broker completion, preserved outgoing identity, and no read ACK or automatic reply.

Additional cases retain the original claim key after an ambiguous completion, deduplicate durable storage, recover a receive-only failure while heartbeats succeed, distinguish an ordinary long poll from a stall, preserve explicit human delivery pauses, block malformed successful responses and security/storage/identity failures, serialize overlapping failures, and fence old work on native-session change/shutdown. Current status and slash-command rendering are checked separately from historical diagnostics.

The coordinated local Psst candidate `92f84f1fda7453000272e2b4fac0725a55bd3556` also retains seven shared-runtime fault tests, including real loopback HTTP parsing of HTML/non-protocol JSON 502/503/504 responses, strict malformed 200/security responses, concurrent recovery, round cooldown and disabled-receiver health. Its focused runtime/reference/presence/registration-v2 checks passed 75 tests. Those upstream checks are separate from this connector's process-free unit suite; the seven vendored files remain exact hash-pinned source bytes.

These results demonstrate controlled caller-facing recovery, not an authenticated native OpenCode host or a deployed broker outage. Native-host qualification still needs a disposable compatible broker: keep one chat selected, queue a peer message, interrupt broker connectivity during its long poll, restore the broker, and observe the same chat receive it without `/psst-connect`, host restart or new approval. Check the original client identity and retained local data, then repeat with an explicit human pause and disconnect to confirm neither is lifted. Do not infer model consumption or replies from durable native admission.

## Release packaging

`npm run pack:check` separately checks the npm file list for runtime entry points
and accidental tests, credentials or state. The release workflow runs it after the
unit suite, then creates one archive and publishes that exact archive. It does not
install the archive or launch native hosts. Publication still requires the owner's
release workflow; ordinary push/PR verification never publishes.
