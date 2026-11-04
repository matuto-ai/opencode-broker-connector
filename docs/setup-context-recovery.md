# Setup context and focus recovery

Keep unrelated chats open. `/psst-setup` and `/psst-status` use the selected
conversation and location captured by that TUI, not the number of open chats.
Another TUI's selection or blur does not cancel this TUI's command.

The supported OpenCode 2.2.5 boundary supplies renderer blur and selection
events, but blur does not prove whether the user went to a browser, another
terminal, or another native dialog. The connector therefore suspends the current
action on blur instead of trusting a confirmation returned after losing focus.
It also fences actual conversation/location changes, including away-and-back.

- If you need a URL from another window, copy it first. Return to the intended
  chat, dismiss the old dialog, and reopen `/psst-setup`.
- After a request is saved, opening the broker `/admin` page is expected. Return
  to the original chat and run `/psst-status`; any interrupted call does not erase
  the durable request. If paused, `/psst-setup` with the same URL reconciles/resumes
  that request. A running owner retry returns its existing request without a
  second enrollment call. Never replay an old replacement confirmation.
- `/psst-reauthorize` uses the same context guards and saved candidate. Its native
  confirmation shows the broker origin and is bound to both the previous request
  and selected-installation revision. Reconnect is automatic reuse of the saved
  credential; reauthorization is a new human-approved candidate; revoke remains
  a separate human action in Psst admin. Neither an agent nor a peer message may
  silently substitute one action for another.
- `request=not_submitted` means this action never called setup. It does not mean
  there was no earlier request. `saved` means a durable request identity exists,
  not proof that the broker has received or approved it. `unknown` means a reply
  was lost or persistence could not be established; inspect status before retry.
- Setup owned elsewhere must be resumed in its original chat. Pausing a pending
  request does not authorize a different conversation to adopt it. Existing
  explicit replacement of a terminal authorization remains available with a
  fresh confirmation bound to its exact request.

Warnings include only fixed phase/cause/request-state enums. Record those fields,
host version, and whether the two chats were views of one TUI or independent
TUIs/servers. Do not include messages, tokens, private paths or credentials. Do
not delete locks, reset identity, terminate other CLIs or change permission policy.

## Evidence and limits for issue #27

Native-boundary unit doubles reproduce cancellation when this renderer emits
blur during URL entry, preflight, replacement confirmation, setup, status or
pause. A second independent TUI sharing the project can change its selection
and emit blur without interrupting the stable first TUI. These tests establish
connector event handling, not the original incident's host topology or trigger.
The report that closing another chat helped remains a workaround observation,
not evidence that two chats cause cancellation. No real-host reproduction,
container/provider suite, live setup change or release is claimed.

Regressions also cover selection change after receipt persistence, lost setup
reply after replacement preflight, same-owner retry while polling, cancellation
before/after persistence, durable read-only status and cross-chat ownership.
The existing selection CAS, credentials, journal, native permission, active-chat
routing and model/agent selection paths remain in place.
