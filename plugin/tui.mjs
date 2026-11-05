import { randomUUID } from 'node:crypto';
import { SETUP_RPC } from '../src/setup-rpc.mjs';
import { DOCTOR_ROLES, DOCTOR_CODES } from '../src/doctor.mjs';
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
  denied: 'The approval request was denied. Request a replacement with /psst-reauthorize <https-origin>.',
  expired: 'The approval request expired. Request a replacement with /psst-reauthorize <https-origin>.',
  revoked: 'The authorization was revoked. Request a replacement with /psst-reauthorize <https-origin>.',
  paused: 'Local setup is paused. Existing authorization and local data are retained.',
  setup_blocked: 'Setup could not continue. Check /psst-status before retrying.',
  setup_owner_recovery_required: 'Setup ownership needs recovery. Existing authorization and local data are retained.',
  setup_owned_elsewhere: 'Setup belongs to another chat. Return to that chat and use /psst-status; do not close other chats or reset setup.',
};
function brokerOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\/[^/?#\\]+\/?$/i.test(value) || /[\s\x00-\x1f\x7f-\x9f]/u.test(value)) throw Error('invalid_url');
  let url;
  try { url = new URL(value); } catch { throw Error('invalid_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('invalid_url');
  return url.origin;
}
const ENDPOINT_MISMATCH = 'Broker endpoint does not match the configured broker. Broker switching is not supported; no setup request was submitted.';
function statusMessage(result) {
  if (result?.code === 'broker_endpoint_mismatch') return ENDPOINT_MISMATCH;
  // Never render exception strings or arbitrary server fields, including paths,
  // credentials and terminal controls. Public approval URLs have one fixed path.
  const setupMessage = stateMessages[result?.state];
  let message = result?.connected === true
    ? 'Psst is connected for this selected chat.' + (setupMessage && result.state !== 'setup_needed' ? ` Existing connection stays active. Setup: ${setupMessage}` : '')
    : setupMessage ?? 'Psst is not connected. Use /psst-setup to configure it.';
  if (result?.authorization_state === 'expired') message = 'The current authorization expired. Use /psst-reauthorize <https-origin> for an explicitly approved replacement. Existing local data is retained.';
  if (result?.authorization_state === 'rejected') message = 'The broker rejected the current authorization. Use /psst-reauthorize <https-origin> for an explicitly approved replacement. Existing local data is retained.';
  const approvedCandidate = result?.state === 'approved'
    || ['paused', 'setup_blocked'].includes(result?.state) && result?.request_state === 'approved';
  if (approvedCandidate && (result?.candidate_selected !== true || result?.connected !== true)) message += ' The approved candidate is not connected yet.' + (result?.candidate_selected !== true ? ' Its attachment has not been committed.' : '');
  if (typeof result?.approval_url === 'string' && result.approval_url.length <= 2048) {
    try {
      const url = new URL(result.approval_url);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/admin') message += ` Approve at ${url.origin}/admin.`;
    } catch {}
  }
  if (typeof result?.request_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(result.request_id)) message += ` Request: ${result.request_id}.`;
  if (result?.request_outcome === 'unknown') message += ' The request outcome is unknown. Check /psst-status in the original chat before retrying; the saved request must be reconciled.';
  else if (result?.request_outcome === 'saved') message += ' The exact request is saved and will be reused.';
  if (result?.connected === true && result?.delivery_resumed === false) message += ' Automatic delivery remains paused; a newer cancellation or native guard was retained. Check /psst-status before retrying.';
  if (result?.disconnected === true) message = 'Psst is disconnected for this chat. Polling, heartbeat and automatic delivery are stopped. Use /psst-connect to reuse saved authorization. Local data is retained.';
  if (result?.disconnected === true && setupMessage && result.state !== 'setup_needed') message += ` Setup: ${setupMessage}`;
  return message + statusDetails(result);
}
function statusDetails(result) {
  if (!result || !['connector_version', 'client_id', 'metadata', 'pending_count', 'delivery_paused'].some(key => Object.hasOwn(result, key))) return '';
  const version = value => typeof value === 'string' && value.length <= 64 && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]{1,40})?$/.test(value) ? value : 'unknown';
  const label = value => typeof value === 'string' && value.length <= 256 && value.isWellFormed()
    && !/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value)
    && !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(value) ? JSON.stringify(value) : 'unknown';
  const id = typeof result.client_id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.client_id) ? result.client_id : 'unknown';
  const count = Number.isSafeInteger(result.pending_count) && result.pending_count >= 0 ? result.pending_count : 'unknown';
  const reasons = { 'session.execution.interrupted': 'interrupted turn', 'session.execution.failed': 'failed turn',
    'session.inbox.cancelled': 'cancelled native admission', 'session.revert.staged': 'native revert', storage_unavailable: 'storage unavailable' };
  const pause = result.delivery_paused === true ? `paused (${Object.hasOwn(reasons, result.delivery_pause_reason) ? reasons[result.delivery_pause_reason] : 'unknown reason'})`
    : result.delivery_paused === false ? 'not paused' : 'unknown';
  const availability = ['selected', 'inactive'].includes(result.availability) ? result.availability : 'unknown';
  const authorization = ['active', 'expired', 'rejected', 'blocked', 'unknown'].includes(result.authorization_state) ? result.authorization_state : 'unknown';
  return ` Connector ${version(result.connector_version)}; OpenCode ${version(result.host_version)}; Node ${version(result.node_version)}. Client ID: ${id}. Name: ${label(result.metadata?.name)}; project: ${label(result.metadata?.project)}; model: ${label(result.metadata?.model?.id)}. Pending: ${count}; delivery: ${pause}; selection: ${availability}; authorization: ${authorization}. Native admission is not model reading or task completion.`;
}
function doctorMessage(result) {
  const version = value => typeof value === 'string' && value.length <= 64 && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]{1,40})?$/.test(value) ? value : 'unknown';
  const checks = Array.isArray(result?.checks) ? result.checks.slice(0, 8).filter(check => DOCTOR_ROLES.includes(check?.role) && DOCTOR_CODES.includes(check?.code)) : [];
  return `Read-only Psst doctor: connector ${version(result?.connector_version)}; OpenCode ${version(result?.host_version)}; Node ${version(result?.node_version)} (requires 24.19+ within major 24). ${checks.length ? checks.map(check => `${check.role}=${check.code}`).join('; ') : 'Storage inspection unavailable'}. Missing paths may be normal before setup. For unsafe/unavailable storage, check the named role with your administrator; preserve credentials, journals and locks. No file contents, databases or credentials are opened, and no repairs or broker requests are made.`;
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
  const run = async (kind, input) => {
    if (disposed) return;
    let endpoint;
    if (kind === 'reauthorize') {
      try { endpoint = brokerOrigin(input); }
      catch { toast('Usage: /psst-reauthorize <https://broker.example.com> — supply the broker HTTPS origin explicitly, without credentials, path, query or fragment. No setup request was submitted.', 'warning'); return; }
    }
    if (active && kind === 'disconnect') active.abort();
    else if (active) { toast('Finish or dismiss the current Psst dialog first.', 'warning'); return; }
    const controller = new AbortController();
    const configuring = kind === 'setup' || kind === 'reauthorize';
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
        phase = method === 'status' && configuring ? 'preflight' : method;
        if (method === 'setup') { submitted = true; received = undefined; }
        const result = await rpc[method]({ sessionID: selected.sessionID, ...input }, { location, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        received = result;
        verify(); return result;
      };
      if (configuring) {
        const configured = await call('status', {});
        if (configured?.disconnected === true) { toast(statusMessage(configured)); return; }
        if (['setup_owned_elsewhere', 'setup_owner_recovery_required', 'setup_blocked'].includes(configured?.state)) { toast(statusMessage(configured), 'warning'); return; }
        if (endpoint && configured?.broker_url && brokerOrigin(configured.broker_url) !== endpoint) { toast(ENDPOINT_MISMATCH, 'warning'); return; }
        phase = 'url_prompt';
        const value = endpoint ?? configured?.broker_url ?? await ctx.ui.dialog.prompt({ title: 'Set up Psst', description: 'Enter only your HTTPS broker URL. Approval happens in the broker admin UI; never paste a token or credential.', placeholder: 'https://broker.example.com' });
        if (value === undefined) return;
        verify();
        const broker_url = brokerOrigin(value);
        const status = configured?.broker_url ? configured : await call('status', { broker_url });
        if (['setup_owned_elsewhere', 'setup_owner_recovery_required', 'setup_blocked'].includes(status?.state)) { toast(statusMessage(status), 'warning'); return; }
        let replacement_confirmed = false;
        if (status?.replacement_confirmation_required === true) {
          if (typeof status.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(status.request_id)) throw Error('invalid_status');
          phase = kind === 'reauthorize' ? 'preflight' : 'replacement_confirmation';
          // The explicit native command supplies intent; keep the RPC request/revision fences.
          replacement_confirmed = kind === 'reauthorize' || await ctx.ui.dialog.confirm({ title: 'Replace Psst authorization?', message: `Broker: ${broker_url}. This creates a new approval request and, after approval and safe attachment, replaces the selected installation authorization with new credential-bound addresses. Old addresses will not become the new identity. Old local data is retained. This does not revoke the old credential; manual revocation in Psst admin is a separate human action. Existing access is retained where still valid. Continue?`, label: { confirm: 'Create new request', cancel: 'Keep existing' } }) === true;
          verify();
          if (!replacement_confirmed) return;
        }
        const result = await call('setup', { broker_url,
          ...(kind === 'reauthorize' ? { reauthorize: true } : {}),
          ...(Object.hasOwn(status ?? {}, 'selection_revision') ? { selection_revision: status.selection_revision } : {}),
          ...(replacement_confirmed && status?.replacement_confirmation_required === true ? { replacement_confirmed: true, replacement_request_id: status.request_id } : {}) });
        toast(statusMessage(result));
      } else {
        const result = await call(kind, {});
        toast(kind === 'doctor' ? doctorMessage(result) : statusMessage(result));
      }
    } catch (error) {
      let message = error?.message === 'invalid_url'
        ? 'Enter an HTTPS broker origin only, without credentials, path, query or fragment.'
        : controller.signal.aborted || error?.message === 'selection_changed'
          ? 'Psst action suspended. Return focus to the original chat, dismiss the old dialog, then use /psst-status. Re-run the command there if needed; old dialogs cannot authorize a retry. Other chats can stay open.'
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
    { id: 'psst-reauthorize', title: 'Psst: Reauthorize (explicit HTTPS endpoint required)', description: 'Usage: /psst-reauthorize <https://broker.example.com>. Requests replacement without another confirmation; broker admin approval still required. No broker switching.', group: 'Psst', palette: true, slash: { name: 'psst-reauthorize', arguments: true }, run: input => run('reauthorize', input) },
    { id: 'psst-connect', title: 'Psst: Connect using saved authorization', description: 'Reconnect this chat without setup or replacement authorization.', group: 'Psst', palette: true, slash: { name: 'psst-connect' }, run: () => run('connect') },
    { id: 'psst-disconnect', title: 'Psst: Disconnect this chat', description: 'Stop transport until /psst-connect, including across reload. Retain credentials and local data.', group: 'Psst', palette: true, slash: { name: 'psst-disconnect' }, run: () => run('disconnect') },
    { id: 'psst-status', title: 'Psst: Check status', group: 'Psst', palette: true, slash: { name: 'psst-status' }, run: () => run('status') },
    { id: 'psst-doctor', title: 'Psst: Read-only diagnostics', description: 'Inspect runtime versions and private storage metadata; no credentials, broker requests or repairs.', group: 'Psst', palette: true, slash: { name: 'psst-doctor' }, run: () => run('doctor') },
    { id: 'psst-cancel-setup', title: 'Psst: Pause setup', group: 'Psst', palette: true, slash: { name: 'psst-cancel-setup' }, run: () => run('cancel') },
  ] }));
  return () => { disposed = true; active?.abort(); };
}
