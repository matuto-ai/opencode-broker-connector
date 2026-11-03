import { randomUUID } from 'node:crypto';
import { canonical, validateUuid } from '../vendor/broker/src/protocol.mjs';

// Copy only bounded transport metadata. Never interpret peer content as instructions.
export function presencePayload(event) {
  const uuid = value => { if (typeof value !== 'string') throw Error('presence_event_invalid'); return validateUuid(value); };
  const date = value => { if (typeof value !== 'string' || value.length > 32 || !Number.isFinite(Date.parse(value))) throw Error('presence_event_invalid'); return new Date(value).toISOString(); };
  if (event?.type !== 'recipient_offline' || event.presence_state !== 'disconnected'
    || !Array.isArray(event.messages) || event.messages.length < 1 || event.messages.length > 10
    || typeof event.has_more_messages !== 'boolean') throw Error('presence_event_invalid');
  const metadata = { event_id: uuid(event.event_id), recipient_id: uuid(event.recipient_id),
    last_heartbeat_at: date(event.last_heartbeat_at), created_at: date(event.created_at), observed_at: date(event.observed_at),
    presence_state: 'disconnected', messages: event.messages.map(message => {
      if (!['queued', 'claimed'].includes(message.delivery_state) || typeof message.delivery_uncertain !== 'boolean') throw Error('presence_event_invalid');
      return { message_id: uuid(message.message_id), delivery_state: message.delivery_state, delivery_uncertain: message.delivery_uncertain };
    }), has_more_messages: event.has_more_messages };
  return { text: 'Psst transport notice: recipient was offline beyond the broker grace while delivery remained pending at the observation time. '
    + 'This is not a reply timeout or proof of non-receipt. No message was resent, cancelled or closed. Current state may have changed.\n' + canonical(metadata),
  description: 'Psst: recipient offline, delivery pending', metadata: { source: 'psst', presence_event_id: metadata.event_id, format: 'psst-presence-v1' } };
}

/** Uses the existing session journal/owner. Persist before mutation; never retry a
 * potentially admitted synthetic ID. Only exact promoted context permits ACK. */
export function createPresenceNotices({ client, inbox, session, binding, call, permitted, diagnostic, now = Date.now }) {
  inbox.transaction(() => inbox.db.exec(`CREATE TABLE IF NOT EXISTS v2_presence_notices (
    event_id TEXT PRIMARY KEY, native_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
    presented INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0, acknowledged_at INTEGER)`));
  let due = 0, cursor;
  const get = eventID => inbox.db.prepare('SELECT * FROM v2_presence_notices WHERE event_id=?').get(eventID);
  async function reconcile(row) {
    if (!row.presented) {
      const context = await call(session.context.bind(session), { sessionID: binding.sessionID });
      if (!Array.isArray(context) || !context.some(message => message?.id === row.native_id && message.type === 'synthetic'
        && canonical({ text: message.text, description: message.description, metadata: message.metadata }) === row.payload)) return;
      if (!await permitted()) return;
      inbox.transaction(() => inbox.db.prepare('UPDATE v2_presence_notices SET presented=1 WHERE event_id=?').run(row.event_id));
    }
    if (!await permitted()) return;
    let receipt;
    try { receipt = await call((_, options) => client.acknowledgePresenceEvent(row.event_id, options), {}); }
    catch (error) {
      // A verified broker 404 means a reconnect/expiry retired this event. A
      // generic network/permission failure must never be treated as completion.
      if (error?.code !== 'message_not_found' || error.status !== 404) throw error;
      receipt = { event_id: row.event_id, acknowledged: true };
    }
    if (receipt?.event_id !== row.event_id || receipt.acknowledged !== true || !await permitted()) return;
    inbox.transaction(() => inbox.db.prepare('UPDATE v2_presence_notices SET acknowledged=1,acknowledged_at=? WHERE event_id=?').run(now(), row.event_id));
    diagnostic('native_presence_presented');
  }
  return { async tick() {
    if (client?.policy?.presence_events !== true || typeof client.presenceEvents !== 'function'
      || typeof client.acknowledgePresenceEvent !== 'function' || now() < due || !await permitted()) return;
    due = now() + 60000;
    // Retry durable presentations independently: a successfully applied ACK
    // with a lost response already removed the event from subsequent pages.
    const presented = inbox.db.prepare('SELECT * FROM v2_presence_notices WHERE presented=1 AND acknowledged=0 ORDER BY rowid LIMIT 10').all();
    for (const row of presented) { if (!await permitted()) return; await reconcile(row); }
    inbox.transaction(() => inbox.db.prepare('DELETE FROM v2_presence_notices WHERE acknowledged=1 AND acknowledged_at<=?').run(now() - 8 * 86400000));
    const page = await call((_, options) => client.presenceEvents({ limit: 10, ...(cursor ? { cursor } : {}) }, options), {});
    if (!Array.isArray(page?.events) || page.events.length > 10 || Buffer.byteLength(JSON.stringify(page)) > 65536
      || page.next_cursor !== null && (typeof page.next_cursor !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(page.next_cursor))) throw Error('presence_page_invalid');
    // One bounded page per minute, including empty continuations. Restart at the
    // beginning after each scan so newly added events are never skipped forever.
    cursor = page.next_cursor ?? undefined;
    for (const event of page.events) {
      const payload = presencePayload(event), eventID = payload.metadata.presence_event_id;
      if (!await permitted()) return;
      let row = get(eventID);
      if (row) { if (!row.acknowledged) await reconcile(row); continue; }
      // Keep confirmed tombstones eight days. At capacity, fail closed rather
      // than evicting an uncertain record and duplicating a native notice.
      if (inbox.db.prepare('SELECT count(*) n FROM v2_presence_notices').get().n >= 10000) { diagnostic('native_presence_capacity'); return; }
      const nativeID = 'msg_psst_notice_' + randomUUID().replaceAll('-', ''), serialized = canonical(payload);
      inbox.transaction(() => inbox.db.prepare('INSERT INTO v2_presence_notices(event_id,native_id,payload) VALUES(?,?,?)').run(eventID, nativeID, serialized),
        { growth: Buffer.byteLength(serialized) * 2 + 8192 });
      let invoked = false;
      try {
        if (!await permitted()) return;
        await call((input, options) => { invoked = true; return session.synthetic(input, options); }, {
          sessionID: binding.sessionID, id: nativeID, ...payload, delivery: 'queue', resume: true });
        if (await permitted()) await reconcile(get(eventID));
      } finally {
        // Only proven non-invocation permits removal. A lost/mismatched receipt
        // stays pinned across restart and can only reconcile through context.
        if (!invoked) inbox.transaction(() => inbox.db.prepare('DELETE FROM v2_presence_notices WHERE event_id=?').run(eventID));
      }
    }
  } };
}
