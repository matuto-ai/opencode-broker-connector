# Publishing the current OpenCode plugin

The root npm package is `@matuto-ai/opencode-broker-connector`; the next version
is **0.5.1**. Both `.` and `./server` resolve to the same native server object.
No TUI, alternate package, Git source dependency or host installer is included.

The owner publishes the matching GitHub release after review/merge. The release
workflow verifies tag/package parity, runs tests/package checks, then publishes
npm with provenance. Code publication and a green workflow are not proof that a
release exists. Do not instruct installation of an unpublished version.

After npm publication is verified, the supported command is:

```sh
opencode plugin add @matuto-ai/opencode-broker-connector@0.5.1
```

Keep current 2.2.5 native-runtime acceptance separate from package-loader tests.
Do not use a Git URL, Git shorthand, source tarball workaround or policy bypass.
