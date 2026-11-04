# Automatic source and artifact identity

Every verification run resolves the current Psst `main` to an immutable commit,
checks out that commit, and fails before integration tests if HEAD differs or the
fixture contains modified/untracked files. The provenance line records commit,
tree and package version. An intentional old-version migration fixture remains
pinned separately; it is never labeled the current server.

Package tests build `npm pack` from the checkout, install that actual tarball in a
disposable prefix, compare every installed file byte-for-byte to source, and
require every runtime file to be included. The source commit, dirty flag, tarball
SHA-256 and per-file SHA-256 values are emitted as `PACKAGE_PROVENANCE`. In CI the
checkout commit must match `GITHUB_SHA`. A same-version stale artifact fails too.

The installed Claude MCP process must initialize and expose its native tool
catalog with the package version. OpenCode's installed native plugin reports
`connector_version` from its own package metadata; the existing real-host/TUI
suite also checks this live status. The isolated OpenCode host-API fixture is
component evidence, not real-host/model acceptance.

Negative regressions cover stale version, stale source bytes with an unchanged
version, an omitted runtime module, mismatched running version, wrong source
commit and dirty fixture. No manual release/version edit is required to assemble
these tests. Release verification retains the exact successful tarball and its
SHA-256 receipt; publication uses those bytes with lifecycle scripts disabled,
not a second package build. The official host binaries remain explicit compatibility targets;
this gate does not silently upgrade host runtimes or mutate production.

