import { createPresenceNotices } from './presence-notices.mjs';
import { randomUUID } from 'node:crypto';
import { canonical } from '../vendor/broker/src/protocol.mjs';
import { nativeMessage, NATIVE_FORMAT } from './message-format.mjs';
import { nativeDescription } from './message-preview.mjs';

export const HOST_VERSION = '2.2.5';
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
export function nativeSessionBinding(info, hostID) {
  if (!id(info?.id) || !id(hostID) || !id(info?.projectID)
    || !Number.isSafeInteger(info?.time?.created) || info.time.created <= 0
    || typeof info?.location?.directory !== 'string' || !info.location.directory.startsWith('/')) throw new Error('native_session_binding_unavailable');
  return { hostID, sessionID: info.id, created: info.time.created, projectID: info.projectID,
    location: { directory: info.location.directory, ...(info.location.workspaceID ? { workspaceID: info.location.workspaceID } : {}) } };
}

/** Native OpenCode queue admission, never classic promptAsync or a human-role prompt.
 * A successful receipt means durable native admission, NOT model consumption.
 * No mutation retry: native cancellation removes its idempotency lookup row.
 */
export function createNativeDelivery({ session, inbox, binding, signal, verify, client, noticeNow, available = () => true, interval = 250,
  requestTimeout = 2000, onDiagnostic = () => {} }) {
  if (!session || ['synthetic', 'context'].some(key => typeof session[key] !== 'function')
    || !(signal instanceof AbortSignal) || typeof verify !== 'function' || typeof available !== 'function' || !id(binding?.sessionID)
    || !Number.isSafeInteger(interval) || interval < 10 || interval > 60000
    || !Number.isSafeInteger(requestTimeout) || requestTimeout < 10 || requestTimeout > 30000) throw new Error('native_capability_unavailable');
  inbox.transaction(() => inbox.db.exec('CREATE TABLE IF NOT EXISTS v2_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)'));
  const getState = key => { inbox.assertUsable(); const row = inbox.db.prepare('SELECT value FROM v2_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
  const setState = (key, value) => inbox.transaction(() => inbox.db.prepare('INSERT INTO v2_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, canonical(value)));
  const persisted = getState('v2_binding');
  if (persisted && canonical(persisted) !== canonical(binding)) throw new Error('native_session_mismatch');
  if (!persisted) setState('v2_binding', binding);
  inbox.transaction(() => inbox.db.exec(`CREATE TABLE IF NOT EXISTS v2_submissions (
    broker_message_id TEXT PRIMARY KEY REFERENCES inbox(message_id) ON DELETE CASCADE,
    native_id TEXT NOT NULL UNIQUE, injection_id TEXT NOT NULL, payload TEXT NOT NULL,
    promoted INTEGER NOT NULL DEFAULT 0)`));
  let stopped = false, running, timer, epoch = 0;
  const active = () => !stopped && !signal.aborted && available();
  const diagnostic = code => { try { onDiagnostic({ code }); } catch {} };
  async function call(method, input, permitted = active) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]);
    let listener;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (bounded.aborted || !permitted()) throw new Error('native_request_aborted'); return method(input, { signal: bounded }); }),
        new Promise((_, reject) => { listener = () => reject(new Error('native_request_incomplete'));
          if (bounded.aborted) listener(); else bounded.addEventListener('abort', listener, { once: true }); }),
      ]);
    } finally { bounded.removeEventListener('abort', listener); }
  }
  async function current() {
    if (!active()) return null;
    const info = await verify();
    if (!active() || !info || canonical(nativeSessionBinding(info, binding.hostID)) !== canonical(binding)
      || info.revert || info.time?.archived) return null;
    return info;
  }
  function exactPayload(candidate, target) {
    return candidate && canonical(candidate) === target.payload;
  }
  function exactAdmission(receipt, target) {
    return receipt?.id === target.native_id && receipt.sessionID === binding.sessionID
      && receipt.type === 'synthetic' && receipt.delivery === 'queue' && exactPayload(receipt.payload, target);
  }
  function exactContext(message, target) {
    return message?.id === target.native_id && message.type === 'synthetic'
      && exactPayload({ text: message.text, description: message.description, metadata: message.metadata }, target);
  }
  async function contextProof(target) {
    const messages = await call(session.context.bind(session), { sessionID: binding.sessionID });
    if (!Array.isArray(messages)) return false;
    return messages.some(message => exactContext(message, target));
  }
  function accept(head, target) {
    inbox.recordNativeAcceptance(head.message_id, target.injection_id, {
      accepted: true, receipt_id: `${binding.sessionID}/${target.native_id}`,
    });
  }
  const outcomeKey = info => canonical({ outcome: info.outcome ?? null, idle: info.time.idle ?? 0, busy: info.time.busy ?? 0 });
  const paused = info => !!getState('v2_paused') || ['interrupted', 'failed'].includes(info.outcome)
    && (info.time.idle ?? 0) >= (info.time.busy ?? 0) && getState('v2_resumed_outcome') !== outcomeKey(info);
  async function deliver() {
    const observedEpoch = epoch;
    const info = await current();
    if (!info) return;
    // Interrupt/failure is durable across reload. Never wake a cancelled or
    // failed session just because the broker has another pending envelope.
    if (paused(info)) return;
    const head = inbox.head();
    if (!head) return;
    if (head.state !== 'pending') {
      const target = inbox.db.prepare('SELECT * FROM v2_submissions WHERE broker_message_id=?').get(head.message_id);
      if (!target || target.injection_id !== head.injection_id) return;
      if (await contextProof(target) && active() && observedEpoch === epoch && await current()) {
        accept(head, target);
        inbox.transaction(() => inbox.db.prepare('UPDATE v2_submissions SET promoted=1 WHERE broker_message_id=?').run(head.message_id));
        diagnostic('native_admission_reconciled');
      }
      return;
    }
    // Bound native backlog to one outstanding item. A lost delivered event is
    // recovered by exact read-only context inspection, never another submit.
    const outstanding = inbox.db.prepare('SELECT * FROM v2_submissions WHERE promoted=0 ORDER BY rowid LIMIT 1').get();
    if (outstanding) {
      if (!await contextProof(outstanding)) return;
      if (!active() || observedEpoch !== epoch || !await current()) return;
      inbox.transaction(() => inbox.db.prepare('UPDATE v2_submissions SET promoted=1 WHERE broker_message_id=?').run(outstanding.broker_message_id));
    }
    if (!active() || observedEpoch !== epoch || !await current()) return;
    const payload = { text: nativeMessage(head.envelope), description: nativeDescription(head.envelope), metadata: {
      source: 'psst', broker_message_id: head.message_id, sender_client_id: head.envelope.sender.client_id, format: NATIVE_FORMAT,
    } };
    const target = { native_id: 'msg_psst_' + randomUUID().replaceAll('-', ''), injection_id: randomUUID(), payload: canonical(payload) };
    // State and exact immutable payload are committed atomically before effect.
    inbox.transaction(() => {
      const now = inbox.head();
      if (now?.message_id !== head.message_id || now.state !== 'pending') throw new Error('native_inbox_changed');
      inbox.db.prepare('INSERT INTO v2_submissions(broker_message_id,native_id,injection_id,payload) VALUES(?,?,?,?)')
        .run(head.message_id, target.native_id, target.injection_id, target.payload);
      inbox.db.prepare("UPDATE inbox SET state='injecting',injection_id=? WHERE message_id=?").run(target.injection_id, head.message_id);
    }, { growth: Buffer.byteLength(target.payload) * 2 + 8192 });
    // Even an aborted request may have reached the server. Leave its journal
    // pinned, including on timeout, exception, cancellation or payload mismatch.
    let invoked = false;
    const notInvoked = () => inbox.transaction(() => {
      const row = inbox.head();
      if (row?.message_id !== head.message_id || row.state !== 'injecting' || row.injection_id !== target.injection_id) throw new Error('native_inbox_changed');
      inbox.db.prepare("UPDATE inbox SET state='pending',injection_id=NULL WHERE message_id=?").run(head.message_id);
      inbox.db.prepare('DELETE FROM v2_submissions WHERE broker_message_id=? AND injection_id=?').run(head.message_id, target.injection_id);
    });
    if (!active() || observedEpoch !== epoch) { notInvoked(); return; }
    try {
      const receipt = await call((...args) => { invoked = true; return session.synthetic(...args); }, { sessionID: binding.sessionID,
        id: target.native_id, ...payload, delivery: 'queue', resume: true }, () => active() && observedEpoch === epoch);
      if (!active() || observedEpoch !== epoch || !await current()) return;
      if (!exactAdmission(receipt, target)) { diagnostic('native_receipt_mismatch'); return; }
      accept(head, target);
      diagnostic('native_admission_confirmed');
    } catch {
      if (!invoked) { notInvoked(); diagnostic('native_admission_deferred'); }
      else diagnostic('native_admission_uncertain');
    }
  }
  const notices = client ? createPresenceNotices({ client, inbox, session, binding, diagnostic, now: noticeNow,
    call: (method, input) => { const observedEpoch = epoch;
      return call(method, input, () => active() && epoch === observedEpoch && !getState('v2_paused')); },
    permitted: async () => {
      const info = await current();
      return !!info && !paused(info);
    } }) : null;
  function tick() {
    if (!active() || running) return running;
    running = Promise.resolve().then(deliver).then(() => notices?.tick()).catch(() => diagnostic('native_delivery_paused')).finally(() => { running = null; });
    return running;
  }
  return {
    tick,
    start() { if (!timer && active()) { timer = setInterval(tick, interval); timer.unref?.(); } },
    event(event) {
      if (!active() || event?.data?.sessionID !== binding.sessionID) return;
      if (['session.execution.interrupted', 'session.execution.failed', 'session.inbox.cancelled', 'session.revert.staged'].includes(event.type)) {
        epoch++; setState('v2_paused', event.type); diagnostic('native_delivery_paused');
      }
      // Only host-started work, not an idle poll, can reopen cancellation.
      if (event.type === 'session.execution.started') setState('v2_paused', null);
      if (['session.deleted', 'session.moved', 'session.archived'].includes(event.type)) { epoch++; stopped = true; clearInterval(timer); }
    },
    status(info) {
      const local = getState('v2_paused');
      const reason = info?.revert ? 'session.revert.staged' : local || (info && paused(info) ? `session.execution.${info.outcome}` : null);
      const known = ['session.execution.interrupted', 'session.execution.failed', 'session.inbox.cancelled', 'session.revert.staged'];
      return { paused: reason ? true : info ? false : null, pause_reason: reason ? known.includes(reason) ? reason : 'unknown' : null };
    },
    async stop() { stopped = true; epoch++; clearInterval(timer); await running; },
  };
}
