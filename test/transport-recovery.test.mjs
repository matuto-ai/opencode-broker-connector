import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setupNativePlugin } from '../src/native-plugin.mjs';
import { loadBrokerReference } from '../src/reference.mjs';
import { BrokerError } from '../vendor/broker/reference/client.mjs';
import { tool } from '../src/tool-schema.mjs';

const reference = await loadBrokerReference();
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const failure = () => new reference.LocalError('request_failed', { effect: 'unknown', retryable: true });
const stale = () => new BrokerError(409, { error: { code: 'stale_lease_epoch', effect: 'not_applied' } });
function clock() {
  let time = Date.now(); const timers = new Set();
  return { now: () => time,
    sleep(ms, _, { signal }) { return new Promise((resolve, reject) => {
      const timer = { at: time + ms, done() { timers.delete(timer); signal.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { timers.delete(timer); reject(new reference.LocalError('request_aborted')); };
      if (signal.aborted) return abort(); signal.addEventListener('abort', abort, { once: true }); timers.add(timer);
    }); },
    async advance(ms) { time += ms; for (const timer of [...timers]) if (timer.at <= time) timer.done(); await flush(); },
  };
}
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-recovery-')), time = clock(), stored = new Map(), calls = [], admissions = [], hooks = new Map();
  let poll, state, client, transport, plugin, loseCompletion = false, terminal, alive = true;
  const broker = { online: true, stale: false, reconcileFailures: 0 };
  const binding = { id: 'one', title: 'Recovery chat', projectID: 'project', location: { directory }, time: { created: 1 } };
  const ctx = { app: { version: '2.2.5' }, location: { directory },
    storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, value), scan: async ({ prefix }) => ({ entries: [...stored].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }) },
    session: { get: async () => alive ? binding : { ...binding, time: { created: 2 } },
      hook: async (name, fn) => { hooks.set(name, fn); return { dispose() {} }; }, context: async () => [],
      synthetic: async input => { admissions.push(input); return { ...input, type: 'synthetic', payload: { text: input.text, description: input.description, metadata: input.metadata } }; } },
    tool: { transform: async () => ({ dispose() {} }) },
    event: { async *subscribe({ signal }) { if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } },
  };
  class Runtime extends reference.AdapterRuntime {
    constructor(options) { super({ ...options, sleep: time.sleep, now: time.now, random: () => 0.5 }); transport = this; }
  }
  const options = { ctx, reference: { ...reference, AdapterRuntime: Runtime }, tool, setupEnabled: false,
    setupOptions: { directory: join(directory, 'installation') }, presenceFactory: () => ({ selected: () => new Set(['one']) }),
    loadSettings: async () => ({ stateDirectory: join(directory, 'state'), broker: { url: 'https://fixture.invalid', registrationVersion: 2 } }),
    clientFactory(inbox) {
      client = new reference.BrokerClient({ url: 'https://fixture.invalid', tokenEnvironment: 'UNUSED_RECOVERY_TEST_TOKEN', inbox, maxAttempts: 1, now: time.now, registrationVersion: 2 });
      client.requestOnce = async (method, path, { body, key, signal }) => {
        calls.push({ method, path, key, body });
        if (!broker.online) throw failure();
        if (path === '/v1/sessions') {
          state = { ...body, lease_epoch: body.previous_epoch + 1, metadata_revision: 1, connected: true, closed: false,
            server_time: new Date(time.now()).toISOString(), lease_expires_at: new Date(time.now() + 180000).toISOString(), policy: { heartbeat_interval_seconds: 60 } };
          broker.stale = false; return state;
        }
        if (method === 'GET' && path.startsWith('/v1/sessions/')) {
          if (broker.reconcileFailures-- > 0) throw failure();
          return state;
        }
        if (path.endsWith('/heartbeat')) { if (broker.stale) throw stale(); return { ...state, server_time: new Date(time.now()).toISOString() }; }
        if (path === '/v1/mailbox/claim') {
          if (terminal) throw terminal;
          return new Promise((resolve, reject) => {
            const abort = () => reject(new reference.LocalError('request_aborted'));
            poll = { resolve: value => { signal.removeEventListener('abort', abort); resolve(value); }, reject: error => { signal.removeEventListener('abort', abort); reject(error); } };
            if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
          });
        }
        if (path.endsWith('/complete')) {
          assert.ok(inbox.head(), 'durable storage precedes broker delivery completion');
          if (loseCompletion) { loseCompletion = false; throw failure(); } return {};
        }
        if (path.endsWith('/disconnect')) return {};
        assert.fail(`Unexpected transport call: ${method} ${path}`);
      };
      return client;
    },
  };
  t.after(async () => { await plugin?.dispose(); rmSync(directory, { recursive: true, force: true }); });
  plugin = await setupNativePlugin(options); const native = await plugin.connect('one'); await flush();
  return { plugin, native, transport, client, calls, admissions, hooks, broker, time, poll: () => poll,
    loseCompletion() { loseCompletion = true; }, terminal(error) { terminal = error; }, changeSession() { alive = false; },
    claim(envelope) { return { claim_id: randomUUID(), lease_epoch: client.attachment.lease_epoch, attempt: 1, claim_expires_at: new Date(time.now() + 30000).toISOString(), envelope }; },
    envelope() { const now = time.now(); return { protocol_version: '1', message_id: randomUUID(), recipient_id: client.identity.client_id, recipient_sequence: 1,
      sender: { client_id: randomUUID(), client_type: 'pi', name: 'peer', model: { provider: null, id: null, source: 'unknown' }, project: null, metadata_revision: 1 },
      origin: 'broker_agent', authority: 'untrusted_agent_input', content: { type: 'text/plain', text: 'queued during outage' },
      accepted_at: new Date(now).toISOString(), expires_at: new Date(now + 86400000).toISOString(), correlation_id: null, reply_to_message_id: null }; },
  };
}
const count = (f, suffix) => f.calls.filter(call => call.path.endsWith(suffix)).length;

test('OpenCode outage/return exhausts one round then restores the same session and native admission without new authorization', async t => {
  const f = await fixture(t), identity = { ...f.client.identity };
  const key = f.client.prepareSend({ recipient_id: randomUUID(), content: { type: 'text/plain', text: 'uncertain send' } });
  f.client.inbox.markOutgoingAttempt(key); const pending = f.client.inbox.outgoing(key);
  const draft = { sessionID: 'one', prompt: { text: 'human draft' } };
  f.broker.online = false; f.poll().reject(failure()); await flush();
  for (let i = 0; i < 5; i++) await f.time.advance(60000);
  assert.equal(count(f, '/v1/sessions'), 1); assert.equal(count(f, '/claim'), 1);
  assert.equal(f.plugin.status('one').connected, false); assert.equal(f.plugin.status('one').transport.heartbeat, 'unreachable');
  assert.equal(f.plugin.status('one').transport.recovery, 'retry_waiting');
  await f.hooks.get('prompt')(draft); assert.equal(draft.prompt.text, 'human draft');
  f.broker.online = true; f.broker.stale = true; f.broker.reconcileFailures = 3;
  await f.time.advance(60000); await f.time.advance(1000); await f.time.advance(2000);
  assert.equal(count(f, `/v1/sessions/${identity.client_id}`), 4, 'initial owned verification plus three reconciliation attempts');
  assert.equal(f.plugin.status('one').transport.recovery, 'retry_waiting');
  await f.time.advance(60000); await f.time.advance(1000);
  assert.equal(count(f, '/v1/sessions'), 2); assert.equal(f.client.attachment.lease_epoch, 2);
  const envelope = f.envelope(); f.poll().resolve(f.claim(envelope)); await flush(); await f.native.delivery.tick();
  assert.deepEqual(f.client.identity, identity); assert.deepEqual(f.client.inbox.outgoing(key), pending);
  assert.equal(f.admissions.length, 1); assert.equal(f.admissions[0].sessionID, 'one');
  assert.equal(f.admissions[0].metadata.broker_message_id, envelope.message_id);
  assert.equal(f.admissions[0].delivery, 'queue'); assert.equal(count(f, '/complete'), 1);
  assert.equal(f.calls.some(call => /\/ack|\/messages$/.test(call.path)), false, 'no read ACK or automatic reply');
  const recovered = f.plugin.status('one');
  assert.equal(recovered.connected, true); assert.equal(recovered.transport.error_code, null);
  assert.equal(recovered.node_version, process.versions.node);
  assert.equal(recovered.metadata.name, `Recovery chat [${identity.client_id.slice(0, 8)}]`);
  assert.equal(f.client.inbox.getState('metadata').name, recovered.metadata.name);
  assert.equal(recovered.pending_count, 0); assert.equal(recovered.delivery_paused, false);
});

test('receive-only interruption reuses the pending claim identity, deduplicates lost completion and leaves ordinary long polls healthy', async t => {
  const f = await fixture(t); f.poll().resolve(null); await flush();
  for (let i = 0; i < 3; i++) await f.time.advance(60000);
  assert.equal(f.plugin.status('one').connected, true); assert.equal(count(f, '/v1/sessions'), 1);
  const envelope = f.envelope(); f.loseCompletion(); f.poll().resolve(f.claim(envelope)); await flush();
  const pending = f.client.inbox.getState('claim_pending');
  assert.equal(f.plugin.status('one').transport.recovery, 'retry_waiting');
  await f.time.advance(60000); await f.time.advance(1000);
  assert.deepEqual(f.client.inbox.getState('claim_pending'), pending);
  assert.equal(f.calls.filter(call => call.path.endsWith('/claim')).at(-1).key, pending.key);
  assert.equal(f.plugin.status('one').transport.error_code, 'request_failed', 'healthy heartbeat alone does not clear receive failure');
  f.poll().resolve(f.claim(envelope)); await flush(); await f.native.delivery.tick();
  assert.equal(f.client.inbox.db.prepare('SELECT count(*) n FROM inbox').get().n, 1); assert.equal(f.admissions.length, 1);
  assert.equal(count(f, '/v1/sessions'), 1); assert.equal(f.plugin.status('one').transport.error_code, null);
});

test('explicit human delivery pauses survive automatic transport recovery', async t => {
  const f = await fixture(t);
  f.native.delivery.event({ type: 'session.execution.interrupted', data: { sessionID: 'one' } });
  f.poll().reject(failure()); await flush(); await f.time.advance(60000); await f.time.advance(1000);
  f.poll().resolve(f.claim(f.envelope())); await flush(); await f.native.delivery.tick();
  assert.equal(f.admissions.length, 0); assert.equal(f.plugin.status('one').transport.reception, 'healthy');
  assert.equal(f.plugin.status('one').delivery_paused, true);
  assert.equal(f.plugin.status('one').delivery_pause_reason, 'session.execution.interrupted');
  assert.equal(f.plugin.status('one').pending_count, 1);
  f.native.delivery.event({ type: 'session.execution.started', data: { sessionID: 'one' } });
  await f.native.delivery.tick(); assert.equal(f.admissions.length, 1);
});

test('permanent authorization/identity/protocol/storage blockers do not renew, adopt a mailbox or deliver stored data', async t => {
  for (const error of [new BrokerError(403, { error: { code: 'forbidden' } }),
    ...['session_expired', 'session_mismatch', 'invalid_response', 'storage_unavailable', 'inbox_corrupt'].map(code => new reference.LocalError(code, { retryable: true, effect: 'unknown' }))]) {
    const f = await fixture(t), identity = f.client.identity.client_id;
    f.client.inbox.accept(f.envelope(), { serverNow: f.time.now() });
    f.poll().reject(error); await flush(); await f.time.advance(600000); await f.native.delivery.tick();
    assert.equal(f.plugin.status('one').transport.recovery, 'blocked'); assert.equal(f.plugin.status('one').connected, false);
    assert.equal(f.client.identity.client_id, identity); assert.equal(count(f, '/v1/sessions'), 1); assert.equal(f.admissions.length, 0);
    await assert.rejects(f.plugin.connect('one'), /native_plugin_closed/);
  }
});

test('malformed successful heartbeat and mailbox responses block without a replacement lease', async t => {
  for (const heartbeat of [true, false]) {
    const f = await fixture(t);
    if (heartbeat) {
      const request = f.client.requestOnce.bind(f.client);
      f.client.requestOnce = (method, path, options) => path.endsWith('/heartbeat') ? Promise.resolve({}) : request(method, path, options);
      await f.time.advance(60000);
    } else { f.poll().resolve(false); await flush(); }
    assert.equal(f.plugin.status('one').transport.error_code, 'invalid_response');
    assert.equal(f.plugin.status('one').transport.recovery, 'blocked'); assert.equal(count(f, '/v1/sessions'), 1);
  }
});

test('overlapping stale heartbeat and receive failures share a recovery owner and shutdown drains the final lease', async t => {
  const f = await fixture(t); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const request = f.client.requestOnce.bind(f.client);
  f.client.requestOnce = async (method, path, options) => {
    if (method === 'GET' && path.startsWith('/v1/sessions/')) { entered(); await gate; }
    return request(method, path, options);
  };
  f.broker.stale = true; f.poll().reject(stale()); await ready;
  const beat = f.transport.heartbeatOnce().catch(error => f.transport.handleTransportError(error, f.transport.controller.signal, { ownedSessionOperation: true, heartbeat: true }));
  await flush(); const stopped = f.plugin.dispose(); await flush(); release(); await Promise.all([beat, stopped]);
  assert.equal(count(f, '/v1/sessions'), 2, 'one initial registration plus one serialized recovery');
  assert.equal(f.client.inbox.closed, true); assert.equal(f.admissions.length, 0);
  assert.equal(f.transport.status().recovery, 'stopped');
});

test('native-session changes and shutdown fence all old recovery work', async t => {
  for (const change of [true, false]) {
    const f = await fixture(t); f.poll().reject(failure()); await flush();
    if (change) f.changeSession(); else await f.plugin.dispose();
    await f.time.advance(60000); await flush();
    assert.equal(f.transport.status().reception, 'stopped');
    const before = f.calls.length; await f.time.advance(600000); assert.equal(f.calls.length, before);
    assert.equal(f.admissions.length, 0);
  }
});
