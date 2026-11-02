# Pinned OpenCode notice-renderer excerpts (test only)

Source: [anomalyco/opencode v2.2.5](https://github.com/anomalyco/opencode/tree/v2.2.5),
commit `9bbb8ce18c80f099e0e448775f59d965ead40a21`, MIT license (included).
These are unchanged function excerpts, not a replacement UI implementation.

- `session-notice.tsx`: complete `SessionNoticeMessageV2` function from
  [`packages/tui/src/routes/session/index.tsx`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/tui/src/routes/session/index.tsx#L2090).
  Upstream blob `ce5d3cbc293a468ddc583666b22e0b705c977578`;
  excerpt SHA-256 `d93e768c835b12e8d4de9964f05c4f6895103d1f56caf2df6ffd42e474f9babb`.
- `inline-tool-row.tsx`: complete `InlineToolRow` function from
  [`packages/tui/src/routes/session/message-parts.tsx`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/tui/src/routes/session/message-parts.tsx#L202).
  Upstream blob `5a7af359311f32dd1b05689851082653c713a335`;
  excerpt SHA-256 `f2a4c0385b7bb3513e89f8be444d4faf925e6a499821dafc6c0992bd88e51cee`.
- `LICENSE`: SHA-256 `625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b`.

`native-renderer-contract.test.mjs` executes the actual notice selectors from the
pinned source and checks the JSX fallback contract: `source: 'psst'` is a generic
notice with `description` passed as a literal text child, not a subagent or shell
completion card. It does not mount a TUI, render terminal pixels, run a host, or
prove authenticated model acceptance. These files are excluded from the package.
