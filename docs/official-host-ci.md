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

1. The freshly packed root plugin is loaded by the native plugin manager. The
   selected conversation obtains its TUI lease, an inactive conversation is not
   woken, and restoring selection automatically admits a real broker message to
   native synthetic inbox/context without changing the selected agent or model.
2. Explicit URL-only setup creates a pending request, with no OpenCode broker
   connection before approval. Real local TLS admin approval permits native
   registration and the same automatic admission path.

The fixture driver invokes the native tool/command and router APIs. It does not
paste terminal input or manufacture human approval from a peer message. The
provider deliberately does not exist, so these are **real native admission and
routing tests, not authenticated model-response acceptance**. They also do not
prove the published npm installer, Docker host recreation, or the full concurrent
session acceptance matrix. Issue #8 remains open for those outstanding gates.

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
