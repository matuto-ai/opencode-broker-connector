
## CI verification stages

`.github/workflows/verify.yaml` exposes one required check, `verify`:
source syntax, local tests, native-host/protocol integration, container persistence,
and installable-package verification. `npm test` still runs every `.test.mjs` file;
`node scripts/test.mjs local` and `integration` partition that same set without omitting test files; existing opt-in host gates may
still skip when their executable or configuration is unavailable.

The container stage uses the pinned Psst HTTPS approval fixture and three separately
removed Docker containers. Only the private installation is retained: each container
gets a fresh HOME and synthetic native host storage. It verifies one enrollment POST,
three isolated session identities, recovery of the native host anchor, a pending
message surviving recreation, and no repeated native admission after another restart.
The native delivery API is synthetic; this is not acceptance with an authenticated
OpenCode model. The existing official CodeMode/core integration remains separate.

Run `node scripts/container-persistence.mjs` on Linux with Docker and the pinned
Psst checkout (set `PSST_APPROVAL_DIR` to its directory). Missing Docker fails the
stage. `PSST_CONTAINER_PROCESS_ONLY=1` runs a cheap subprocess preflight of the same
scenario, explicitly labelled **not Docker proof**; CI does not enable this option.
