# Publishing the current OpenCode plugin

The root npm package is `@matuto-ai/opencode-psst-connector`; the next version
is **0.7.0**. Both `.` and `./server` resolve to the same native server object.
The official ./tui entry is included in that same package. No alternate package, Git source dependency or host installer is included.

The owner publishes the matching GitHub release after review/merge. The release
workflow verifies tag/package parity, runs syntax, unit and package file-list
checks, then packs once and publishes that archive to npm with provenance. Code publication and a green workflow are not proof that a
release exists. Do not instruct installation of an unpublished version.

After npm publication is verified, the supported command is:

```sh
opencode plugin add @matuto-ai/opencode-psst-connector@0.7.0
```

Keep current 2.2.5 native-runtime acceptance separate from the unit and package file-list checks.
Do not use a Git URL, Git shorthand, source tarball workaround or policy bypass.
