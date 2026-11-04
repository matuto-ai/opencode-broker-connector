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

## Release packaging

`npm run pack:check` separately checks the npm file list for runtime entry points
and accidental tests, credentials or state. The release workflow runs it after the
unit suite, then creates one archive and publishes that exact archive. It does not
install the archive or launch native hosts. Publication still requires the owner's
release workflow; ordinary push/PR verification never publishes.
