import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { Inbox, newSessionIdentity } from '../vendor/broker/reference/inbox.mjs';
import { openNativeIncarnation } from '../src/native-incarnation.mjs';
import { openNativeInbox } from '../src/native-inbox.mjs';
import { nativeSessionBinding } from '../src/native-delivery.mjs';

// Expiry is a transport input to this connector, not a broker lifecycle to retest.
class FakeClient {
  constructor(inbox) {
    this.inbox = inbox;
    this.identity = inbox.identity;
    this.registrationVersion = 2;
    this.expiredIdentityConfirmed = true;
    this.allocations = 0;
  }
  async createReplacementInbox({ directory, verifySession, signal }) {
    if (signal?.aborted || !await verifySession(this.identity)) {
      throw Object.assign(new Error('session_mismatch'), { code: 'session_mismatch' });
    }
    this.allocations++;
    return new Inbox({ directory, identity: newSessionIdentity('opencode') });
  }
}
const reference = { Inbox, newSessionIdentity, BrokerClient: FakeClient };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'psst-incarnation-unit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settings = { stateDirectory: join(directory, 'native'), broker: { url: 'https://broker.invalid/', registrationVersion: 2 } };
  const binding = nativeSessionBinding({ id: 'one', projectID: 'p', location: { directory }, time: { created: 1 } }, 'host');
  return { reference, settings, binding };
}

test('confirmed expiry selects an empty journal and reloads its pointer while retaining the original lock and data', async t => {
  const options = fixture(t);
  let owner = openNativeIncarnation(options);
  t.after(() => owner.close());
  const root = owner.inbox, first = root.identity.client_id, client = new FakeClient(root);
  root.setState('claim_pending', { key: 'old-claim' });
  root.db.exec('CREATE TABLE v2_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  root.db.prepare('INSERT INTO v2_state VALUES(?,?)').run('uncertain', 'old-native-operation');
  root.close(); // An adapter stop must not release the incarnation owner's lock.
  assert.throws(() => openNativeIncarnation(options), { code: 'owner_conflict' });

  const next = await owner.replace({ client, verifySession: () => true });
  assert.notEqual(next.identity.client_id, first);
  assert.equal(next.getState('claim_pending'), null);
  assert.equal(next.db.prepare("SELECT name FROM sqlite_master WHERE name='v2_state'").get(), undefined);
  assert.equal(root.db.prepare('SELECT value FROM v2_state').get().value, 'old-native-operation');
  assert.throws(() => new Inbox({ directory: root.directory, identity: root.identity }), { code: 'owner_conflict' });
  assert.throws(() => openNativeInbox(options), /native_incarnation_required/);
  const second = next.identity.client_id;
  owner.close();
  owner = openNativeIncarnation(options);
  assert.equal(owner.inbox.identity.client_id, second);
});

test('missing expiry proof and native mismatch do not allocate, and corrupt pointers fail closed', async t => {
  const options = fixture(t), owner = openNativeIncarnation(options);
  t.after(() => owner.close());
  const client = new FakeClient(owner.inbox);
  client.expiredIdentityConfirmed = false;
  await assert.rejects(owner.replace({ client, verifySession: () => true }), /unavailable/);
  client.expiredIdentityConfirmed = true;
  await assert.rejects(owner.replace({ client, verifySession: () => false }), { code: 'session_mismatch' });
  assert.equal(client.allocations, 0);
  const root = owner.inbox.directory;
  owner.close();
  writeFileSync(join(root, 'current-incarnation.json'), '{', { mode: 0o600 });
  assert.throws(() => openNativeIncarnation(options));
  assert.throws(() => openNativeInbox(options), /native_incarnation_required/);
});

test('a committed pointer never recreates a missing child journal', async t => {
  const options = fixture(t), owner = openNativeIncarnation(options);
  t.after(() => owner.close());
  const next = await owner.replace({ client: new FakeClient(owner.inbox), verifySession: () => true });
  const path = join(next.directory, 'inbox.sqlite');
  owner.close();
  unlinkSync(path);
  assert.throws(() => openNativeIncarnation(options));
  assert.equal(existsSync(path), false);
});

test('concurrent replacement is rejected and pointer uncertainty fences further allocation', async t => {
  const options = fixture(t), owner = openNativeIncarnation(options);
  t.after(() => owner.close());
  const client = new FakeClient(owner.inbox), root = owner.inbox.directory;
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const pending = owner.replace({ client, verifySession: async () => {
    if (++calls === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return true;
  } });
  await ready;
  await assert.rejects(owner.replace({ client, verifySession: () => true }), /unavailable/);
  mkdirSync(join(root, 'current-incarnation.json')); // Rename must fail, retaining uncertainty.
  release();
  await assert.rejects(pending, { code: 'native_incarnation_uncertain' });
  const names = readdirSync(root);
  assert.throws(() => owner.inbox, /unavailable/);
  await assert.rejects(owner.replace({ client, verifySession: () => true }), /unavailable/);
  assert.equal(client.allocations, 1);
  assert.deepEqual(readdirSync(root), names);
});

test('partial journal creation failure stops automatic replacement without touching old data', async t => {
  const options = fixture(t), owner = openNativeIncarnation(options);
  t.after(() => owner.close());
  const root = owner.inbox, client = new FakeClient(root);
  root.setState('claim_pending', { key: 'keep' });
  client.createReplacementInbox = async ({ directory }) => { mkdirSync(directory); throw new Error('disk failed'); };
  await assert.rejects(owner.replace({ client, verifySession: () => true }), { code: 'native_incarnation_uncertain' });
  assert.equal(root.getState('claim_pending').key, 'keep');
  await assert.rejects(owner.replace({ client, verifySession: () => true }), /unavailable/);
});
