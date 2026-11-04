# 0.6.0 package and repository migration

This is an unreleased source candidate, not proof of npm publication. The new package is `@matuto-ai/opencode-psst-connector@0.6.0`; the old package is `@matuto-ai/opencode-broker-connector`. No prerelease/RC package is required.

## Owner publication order

1. Review and merge the code in the existing repository; retain its history and branch protections. CI checks out this repository and runs its unit suite; it does not fetch a second repository.
2. Rename the GitHub repository to `matuto-ai/opencode-psst-connector`. Do not create a replacement repository. Update local remotes and verify the `verify` check and repository settings after the rename. Package metadata already points at this final name.
3. Establish the new public npm package through npm's supported owner/account setup. Configure its own trusted publisher for GitHub owner `matuto-ai`, repository `opencode-psst-connector`, workflow `npm-publish.yml`, allowing direct `npm publish`. The old package's trusted publisher does not transfer. Validate new configuration within npm's two-day first-publish window. Account and publishing actions belong to the owner, not this code change.
4. Publish the GitHub release tagged `v0.6.0` only when the new package's publishing access is ready. The workflow checks tag/version parity and tests before publishing. Never publish the same package-name/version twice: if initial owner setup already published the final `0.6.0` artifact, do not trigger a second publish of it; reconcile the artifact and workflow plan first.
5. Verify the new npm artifact, provenance, exact version and a clean native install plus upgrade. Only then deprecate the old package with a message naming its replacement. Keep old versions downloadable; do not unpublish them.

## Existing installation migration

After the new npm version is confirmed, list the native manager's existing package sources and remove only this connector's exact old source. Keep unrelated plugins and every private Psst state/credential directory. Add the new exact package version using the README command, then reload the native host. Do not load old and new copies together. An ordinary update of the old npm name does not switch names automatically.

The change is packaging only: native commands, tool names, identities, protocol, saved authorization and durable journals stay unchanged. Do not delete state or request fresh credentials just to change the package name. Validate reconnect/resume and absence of duplicate delivery with the preserved installation, separately from clean-install tests. Unit test success is not acceptance in the user's authenticated environment.

Keep native plugin ID `matuto.psst`, exports `.` and `./server`, commands and tool names unchanged. Preserve `PSST_OPENCODE_CONFIG_DIR` or the current `~/.config/opencode/psst` location and host-owned plugin storage. Use `opencode plugin list` to find the exact old source and `opencode plugin remove` for that source only; then add the new npm package. Do not erase the old private plugin journals or add a second plugin identity.

References: [npm deprecation](https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions/) · [trusted publishing](https://docs.npmjs.com/trusted-publishers/).
