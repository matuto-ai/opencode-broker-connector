# Outgoing message lifecycle

`broker_send` takes recipient ID and text; retry keys are private.
`broker_sent_history` lists the exact sender session's outgoing metadata;
`broker_message_content` retrieves a retained original; `broker_resend` explicitly
creates a new delivery; `broker_cancel` cannot undo receipt or execution.

A native call's original assistant tool block supplies its stable ID and creation
time. The connector persists the operation before HTTP and preserves its key on
technical retry/recovery. A different native call is new intent even when text is
identical. Aged or missing original proof fails closed, including after ledger GC.

Inspect current status/history after uncertainty before requesting a new explicit
send. Recovery is bounded to 10 retained operations and 5 seconds. Unknown effects
remain unknown, never fabricated success. Broker 0.5.0 supplies the lifecycle APIs;
transport, native admission and model completion remain separate evidence.

## CodeMode routing

OpenCode's CodeMode executor forwards one outer `execute` ID to all nested calls.
The plugin therefore registers only `broker_send` and `broker_resend` with the
supported `options.codemode:false`. The actual host catalog advertises those as
direct tools alongside `execute`; all other broker tools retain normal CodeMode
routing. Direct calls retain individually persisted native IDs and original
timestamps. No invented child index, random retry ID or content-based dedup is
used. An obsolete wrapper call remains fail-closed instead of sending ambiguously.

Unit tests exercise scoped outgoing calls, stable operation IDs, payload conflicts,
cancellation and recovery using an in-process transport and native API. They also
assert that send/resend bypass CodeMode while other tools retain default routing.
They do not run OpenCode's executor or prove an authenticated model turn.
