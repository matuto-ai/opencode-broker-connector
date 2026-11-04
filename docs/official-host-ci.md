# Official-host CI evidence

Every push and pull request runs the `official-host` job alongside the existing
`checks` job. The existing required `verify` check waits for both and fails
unless both succeed, including failure, cancellation or skipped prerequisites.
The host job has a three-minute bound and is not an optional local probe. It installs only the packed plugin's runtime dependency (`zod`), so it does
not duplicate the heavier SDK integration dependency installation.

## Pinned inputs

- The Linux x64 CLI comes from the [official OpenCode 2.2.5 release](https://github.com/anomalyco/opencode/releases/tag/v2.2.5).
- Archive: `opencode-linux-x64.tar.gz`.
- SHA-256: `09f44302c10fd036912f59c81fd1aef5df45dd06f649197f9dfc9bbe2a79614e`, verified against the release asset digest before extraction or execution. The checksum is committed in CI; it is not downloaded from the same request at test time.
- The real TLS broker/admin approval fixture is checked out at Psst commit `72f5d2d1b834e02cfb6b2f7dc11c6f1a55729344`, the same pin used by the existing persistence gate.

No floating CLI install, install script, global configuration change, provider
credential or GitHub secret is required. Temporary server passwords and enrollment
credentials belong only to disposable loopback fixtures. The server and TUI run
with fresh HOME/XDG directories and an explicit environment allowlist. TLS
verification stays enabled. Teardown stops the TUI/server before closing the broker
and removing private directories, and attempts every cleanup even after failure.
Download timeout and job timeout bound infrastructure
failure without downgrading the test to a skip.

## What the two tests prove

`node scripts/test.mjs host` requires an absolute executable `OPENCODE_BINARY`
and a readable `PSST_APPROVAL_BROKER_DIR/test/approval-tls-fixture.mjs`. Missing
prerequisites fail the stage before test execution. Both existing `current-host`
tests then run against the official server and its actual TUI in a PTY:

1. The freshly packed root plugin loads through the native plugin manager. The
   selected conversation obtains its TUI lease, an inactive conversation is not
   woken, and restoring selection automatically admits a real broker message to
   native synthetic inbox/context without changing the selected agent or model.
2. Actual keyboard `/psst-setup` opens one broker-URL text field in the official
   TUI. No native connection exists before exact-request TLS admin approval.
   Native RPC probes additionally cover cancellation, denial, exact-request
   replacement, preservation of the working authorization and admin revocation
   without automatic re-enrollment.

The approval case also restarts while its exact request is pending and approves
it before the TUI reconnects, proving selection recovery resumes without another
enrollment. Both tests restart the actual server and TUI with the documented private/native
roots, retain the exact native conversation and broker identity, recover unread
broker delivery and give a fresh conversation an independent address. They also
retain queued native human input, leave a native permission request unapproved,
and verify that a failed execution is not silently woken again.

The fixture driver uses native tool/command/router/RPC APIs for lifecycle cases;
the initial setup dialog is exercised using actual PTY keyboard input. Human admin
approval comes from the real disposable form-login UI, never from peer content.
The selected provider deliberately does not exist. These are **real native
admission, routing, restart and failure tests, not authenticated model-response
acceptance**. They do not qualify an active authenticated model toolchain or
in-flight model abort. The separate 30-session Docker gate uses a synthetic native API. The actual-host
container gate below instead runs this official CLI/TUI scenario inside removed
and recreated containers; neither gate proves authenticated model execution.
See [the complete evidence boundary](setup-acceptance.md).

## Local reproduction

Obtain and verify the same CLI archive and checkout the pinned Psst fixture, then:

```sh
npm ci --ignore-scripts --omit=dev --omit=peer --no-audit --no-fund
OPENCODE_BINARY=/absolute/path/to/opencode \
PSST_APPROVAL_BROKER_DIR=/absolute/path/to/pinned-psst \
node scripts/test.mjs host
```

Linux, `openssl`, `tar`, and util-linux `script` are required, as on the pinned
Ubuntu 24.04 runner. Use normal full `npm ci` before the SDK integration suite.
The default `npm test` retains optional host probes for developers without the CLI, but
CI's dedicated host stage cannot silently pass with either prerequisite absent.
The published-package installer probe remains a separate opt-in gate requiring
`PSST_OPENCODE_PACKAGE_SPEC`; this job does not claim that release proof.

### Actual-host container persistence gate

The same `current-host.test.mjs` scenarios run a second time with
`PSST_OPENCODE_DOCKER=1`. This launches the checksum-verified official binary,
not the synthetic host fixture, in a fresh container for every server and TUI
invocation. The TUI receives its own container PTY. Both containers are removed
before reopening, and Docker container IDs must change. The runner records owned
names before creation, confirms creation in the supervising test process before
starting any killable attach wrapper, checks removal at restart, and force-cleans
owned leftovers on failure. A leftover at normal teardown fails the test even after cleanup.

Only the disposable fixture tree is a writable bind mount; `/tmp` remains
ephemeral and `noexec,nosuid,nodev`. The pinned Bun executable extracts OpenTUI
native libraries into an owned 0700 `cache/native-assets` subdirectory using
an explicit `BUN_TMPDIR` value. This executable extraction location is
inside the existing fixture bind, not a relaxation of `/tmp` or root permissions.
It is deleted with XDG cache and recreated before each launch; tests require
actual native shared-library extraction there before and after cache rebuilding.
The verified
binary, runtime dependencies, and broker public CA are read-only mounts. No user
home, checkout, Docker socket, or runner token is mounted. Host networking is used
only so the official server/TUI can reach the ephemeral loopback TLS broker and
host API; processes run with the runner's UID/GID, dropped capabilities, and
`no-new-privileges`.

Persistence retains the same test HOME, XDG config/data/state, private connector
installation, absolute project path and UID. XDG cache is deleted before reopening.
The gate checks the same exact native session, broker identity, unread admission,
setup ownership, keyboard dialog, denial/replacement, and revocation scenarios as
the process gate. It does not qualify an authenticated provider response or a
running model/toolchain. The separate synthetic Docker fixture remains distinct.

A failed or timed-out create is reconciled only after a positively observed owned
container can be removed. If the bounded reconciliation cannot establish its
outcome, the gate fails and retains the fixture plus a private ownership receipt
outside it. The failure names both retained paths without printing credentials;
an absent inspect result is never treated as proof that a late create is impossible.
Executable fake-Docker tests cover that failure layer cheaply, but are not real
Docker acceptance. Local environments without Docker cannot qualify this gate.
