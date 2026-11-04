import { randomUUID } from 'node:crypto';
import { SETUP_RPC } from '../src/setup-rpc.mjs';
import { installationDirectory } from '../src/installation.mjs';
import { createPresenceWriter, presenceDirectory } from '../src/active-presence.mjs';

export default {
  id: 'matuto.psst',
  setup(ctx) {
    let writer, directory, last, lastWrite = 0, warned = false;
    const offline = () => {
      if (!warned) ctx.ui?.toast?.show?.({ title: 'Psst offline', message: 'Active-chat messaging requires a local TUI sharing the server private directory.', variant: 'warning' });
      warned = true;
    };
    if (ctx.app?.version !== '2.2.5' || typeof ctx.ui?.router?.current !== 'function' || typeof ctx.storage?.memory !== 'function') { offline(); return; }
    const [memory, update] = ctx.storage.memory('psst-active-owner', { initial: { owner: randomUUID(), seq: 0 } });
    const counter = { get seq() { return memory.seq; }, set seq(value) { update(draft => { draft.seq = value; }); } };
    const tick = () => {
      try {
        const route = ctx.ui.router.current(), location = ctx.location;
        if (!location) throw new Error('native_selection_location_unavailable');
        const nextDirectory = presenceDirectory(installationDirectory(), location);
        if (nextDirectory !== directory) {
          writer?.stop(); writer = undefined; directory = undefined;
          writer = createPresenceWriter({ directory: nextDirectory, owner: memory.owner, counter });
          directory = nextDirectory; last = undefined;
        }
        const selected = route.type === 'session' ? route.sessionID : null;
        if (selected !== last || Date.now() - lastWrite >= 1000) { writer.write(selected); last = selected; lastWrite = Date.now(); }
        warned = false;
      } catch { try { writer?.stop(); } catch {} writer = undefined; directory = undefined; offline(); }
    };
    const stopSetupUI = registerSetupUI(ctx, () => { tick(); return !!writer; });
    tick(); const timer = setInterval(tick, 250); timer.unref?.();
    return () => { stopSetupUI(); clearInterval(timer); try { writer?.stop(); } catch {} };
  },
};


const stateMessages = {
  setup_needed: 'Enter your broker URL with /psst-setup.',
  pending: 'Waiting for human approval in the broker admin UI. Use /psst-status to check.',
  approved: 'Broker authorization approved.',
  denied: 'The approval request was denied. A new request requires confirmation in /psst-setup.',
  expired: 'The approval request expired. A new request requires confirmation in /psst-setup.',
  revoked: 'The authorization was revoked. A new request requires confirmation in /psst-setup.',
  paused: 'Local setup is paused. Existing authorization and local data are retained.',
  setup_blocked: 'Setup could not continue. Check /psst-status before retrying.',
  setup_owner_recovery_required: 'Setup ownership needs recovery. Existing authorization and local data are retained.',
  setup_owned_elsewhere: 'Setup belongs to another chat. Return to that chat and use /psst-status; do not close other chats or reset setup.',
};
function brokerOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f-\x9f]/u.test(value)) throw Error('invalid_url');
  let url;
  try { url = new URL(value); } catch { throw Error('invalid_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('invalid_url');
  return url.origin;
}
function statusMessage(result) {
  // Never render exception strings or arbitrary server fields, including paths,
  // credentials and terminal controls. Public approval URLs have one fixed path.
  const setupMessage = stateMessages[result?.state];
  let message = result?.connected === true
    ? 'Psst is connected for this selected chat.' + (setupMessage && result.state !== 'setup_needed' ? ` Existing connection stays active. Setup: ${setupMessage}` : '')
    : setupMessage ?? 'Psst is not connected. Use /psst-setup to configure it.';
  if (result?.authorization_state === 'expired') message = 'The current authorization expired. Use /psst-setup for an explicitly approved replacement. Existing local data is retained.';
  if (result?.authorization_state === 'rejected') message = 'The broker rejected the current authorization. Use /psst-setup for an explicitly approved replacement. Existing local data is retained.';
  if (typeof result?.approval_url === 'string' && result.approval_url.length <= 2048) {
    try {
      const url = new URL(result.approval_url);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/admin') message += ` Approve at ${url.origin}/admin.`;
    } catch {}
  }
  if (typeof result?.request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(result.request_id)) message += ` Request: ${result.request_id}.`;
  if (result?.request_outcome === 'unknown') message += ' The request outcome is unknown. Check /psst-status in the original chat before retrying; the saved request must be reconciled.';
  else if (result?.request_outcome === 'saved') message += ' The exact request is saved and will be reused.';
  return message;
}
function registerSetupUI(ctx, available) {
  // Presence-only hosts/tests still work; never touch the client without the
  // supported native command and dialog APIs.
  if (typeof ctx.keymap?.layer !== 'function' || typeof ctx.ui?.dialog?.prompt !== 'function'
    || typeof ctx.ui?.dialog?.confirm !== 'function') return () => {};
  let disposed = false, active;
  const toast = (message, variant = 'info') => { if (!disposed) ctx.ui.toast.show({ title: 'Psst', message, variant, duration: 12000 }); };
  const selection = () => {
    const route = ctx.ui.router.current();
    if (route?.type !== 'session' || typeof route.sessionID !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(route.sessionID) || !ctx.location) throw Error('selection_changed');
    return { sessionID: route.sessionID, directory: ctx.location.directory, workspaceID: ctx.location.workspaceID };
  };
  const run = async kind => {
    if (disposed) return;
    if (active) { toast('Finish or dismiss the current Psst dialog first.', 'warning'); return; }
    const controller = new AbortController();
    active = controller;
    let timer, check, blur, phase = 'selection', reason, submitted = false, received;
    const abort = cause => { reason ??= cause; controller.abort(); };
    try {
      const selected = selection();
      if (!available()) throw Error('local_unavailable');
      const location = { ...ctx.location };
      check = () => {
        try { const current = selection();
          if (current.sessionID !== selected.sessionID) abort('session_changed');
          else if (current.directory !== selected.directory || current.workspaceID !== selected.workspaceID) abort('location_changed');
        } catch { abort('selection_unavailable'); }
      };
      // A blur cannot prove where native confirmation input will go. Suspend
      // this action, not other TUIs or the persisted enrollment request.
      blur = () => abort('terminal_blur');
      ctx.renderer?.on?.('blur', blur);
      ctx.renderer?.on?.('frame', check);
      timer = setInterval(check, 50); timer.unref?.();
      controller.signal.addEventListener('abort', () => {
        clearInterval(timer);
        ctx.renderer?.off?.('blur', blur);
        ctx.renderer?.off?.('frame', check);
      }, { once: true });
      const verify = () => {
        check();
        if (disposed || controller.signal.aborted) throw Error('selection_changed');
        if (!available()) throw Error('local_unavailable');
      };
      const rpc = ctx.client.rpc(SETUP_RPC);
      const call = async (method, input) => {
        verify();
        phase = method === 'status' && kind === 'setup' ? 'preflight' : method;
        if (method === 'setup') { submitted = true; received = undefined; }
        const result = await rpc[method]({ sessionID: selected.sessionID, ...input }, { location, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        received = result;
        verify(); return result;
      };
      if (kind === 'setup') {
        phase = 'url_prompt';
        const value = await ctx.ui.dialog.prompt({ title: 'Set up Psst', description: 'Enter only your HTTPS broker URL. Approval happens in the broker admin UI; never paste a token or credential.', placeholder: 'https://broker.example.com' });
        if (value === undefined) return;
        verify();
        const broker_url = brokerOrigin(value);
        const status = await call('status', { broker_url });
        if (['setup_owned_elsewhere', 'setup_owner_recovery_required', 'setup_blocked'].includes(status?.state)) { toast(statusMessage(status), 'warning'); return; }
        let replacement_confirmed = false;
        if (status?.replacement_confirmation_required === true) {
          if (typeof status.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(status.request_id)) throw Error('invalid_status');
          phase = 'replacement_confirmation';
          replacement_confirmed = await ctx.ui.dialog.confirm({ title: 'Replace Psst authorization?', message: 'This creates a new approval request and, after approval, new credential-bound addresses. Old addresses will not become the new identity. Old local data is retained. Continue?', label: { confirm: 'Create new request', cancel: 'Keep existing' } }) === true;
          verify();
          if (!replacement_confirmed) return;
        }
        const result = await call('setup', { broker_url, ...(replacement_confirmed ? { replacement_confirmed: true, replacement_request_id: status.request_id } : {}) });
        toast(statusMessage(result));
      } else toast(statusMessage(await call(kind, {})));
    } catch (error) {
      let message = error?.message === 'invalid_url'
        ? 'Enter an HTTPS broker origin only, without credentials, path, query or fragment.'
        : controller.signal.aborted || error?.message === 'selection_changed'
          ? 'Psst action suspended. Return focus to the original chat, dismiss the old dialog, then use /psst-status. Reopen /psst-setup there if needed; confirmations must be given again. Other chats can stay open.'
          : error?.message === 'local_unavailable'
            ? 'Setup requires a local TUI sharing the server private directory.'
            : 'Psst action could not complete. Check /psst-status before retrying; do not paste credentials.';
      const outcome = submitted ? received?.request_outcome !== 'unknown' && (received?.request_outcome === 'saved' || phase === 'setup' && received?.request_id) ? 'saved' : 'unknown' : 'not_submitted';
      message += outcome === 'not_submitted' ? ' This action did not submit a setup request.'
        : outcome === 'saved' ? ' The exact request was saved; check its status rather than creating another.'
          : ' Setup may already have saved a request; its outcome is unknown. Retry only in the original chat to reconcile it.';
      // Fixed enums only: no native IDs, private paths, dialog input or errors.
      message += ` [phase=${phase}; cause=${reason ?? (controller.signal.aborted ? 'cancelled' : 'operation_failed')}; request=${outcome}]`;
      toast(message, 'warning');
    } finally {
      clearInterval(timer);
      if (blur) ctx.renderer?.off?.('blur', blur);
      if (check) ctx.renderer?.off?.('frame', check);
      if (active === controller) active = undefined;
    }
  };
  ctx.keymap.layer(() => ({ mode: 'global', commands: [
    { id: 'psst-setup', title: 'Psst: Set up broker', group: 'Psst', palette: true, slash: { name: 'psst-setup' }, run: () => run('setup') },
    { id: 'psst-status', title: 'Psst: Check status', group: 'Psst', palette: true, slash: { name: 'psst-status' }, run: () => run('status') },
    { id: 'psst-cancel-setup', title: 'Psst: Pause setup', group: 'Psst', palette: true, slash: { name: 'psst-cancel-setup' }, run: () => run('cancel') },
  ] }));
  return () => { disposed = true; active?.abort(); };
}
