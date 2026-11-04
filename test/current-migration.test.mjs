// These are transport/storage seam tests, not real-host or model acceptance tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { setupNativePlugin } from '../src/native-plugin.mjs';
import { tool } from '../src/tool-schema.mjs';
import { loadBrokerReference } from '../src/reference.mjs';
import { readExistingConnection } from '../src/enrollment.mjs';
import { httpFixture, registration, sendBody, uuid } from './broker-fixture/test/helpers.mjs';

const previousCommit = '04160a087e5aeb5237ab74ebddfcc720aa72327c'; // v0.5.1
const previousDirectory = process.env.PSST_PREVIOUS_SOURCE_DIR;

async function migration(t, previous) {
  const f = await httpFixture(t);
  const root = mkdtempSync(join(tmpdir(), 'oc-migration-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ref = await loadBrokerReference();
  const oldRef = previous ? await previous.loadBrokerReference() : ref;
  let tokenFile = join(root, 'token'), credentialEntry = f.b.entry;
  const preservedFiles = new Map();
  let enrolledSettings;
  if (previous) {
    // The pinned helper, not the candidate or test, generates and persists the
    // credential. Issuance is synthetic; runtime delivery uses a real HTTP broker.
    const pairingFile = join(root, 'pairing.json');
    writeFileSync(pairingFile, JSON.stringify({ format: 'psst-pairing-v1',
      broker_url: 'https://migration.example', pairing_secret: randomBytes(32).toString('base64url'),
      client_type: 'opencode', expires_at: new Date(Date.now() + 60000).toISOString() }), { mode: 0o600 });
    const api = { ...previous.helper, connectPairingFile: input => previous.helper.connectPairingFile(input, {
      transport: async (_url, _secret, body) => {
        credentialEntry = { ...f.b.entry, token_sha256: JSON.parse(body).token_sha256 };
        return { status: 201, body: { protocol_version: '1', credential_id: 'enrolled-' + uuid(),
          adapter_id: 'installation-' + uuid(), client_type: 'opencode', scopes: ['default'],
          expires_at: new Date(Date.now() + 3600000).toISOString() } };
      },
    }) };
    const load = previous.createConnectionLoader({ directory: root, stateHome: join(root, 'enrolled'), loadHelper: async () => api });
    enrolledSettings = await load(pairingFile, { clientType: 'opencode', sessionID: 'surviving' });
    tokenFile = enrolledSettings.broker.tokenFile;
    f.writeCreds([f.a.entry, credentialEntry, f.c.entry]);
    for (const name of ['token', 'connection.json', 'enrollment.json', 'attempt.json']) {
      const path = join(dirname(tokenFile), name);
      preservedFiles.set(path, readFileSync(path));
    }
  } else {
    writeFileSync(tokenFile, f.b.token, { mode: 0o600 });
    preservedFiles.set(tokenFile, readFileSync(tokenFile));
  }
  const oldStorage = new Map(), newStorage = new Map(), tools = new Map();
  const ctx = stored => ({
    app: { version: '2.2.5' }, location: { directory: root },
    storage: { get: async k => stored.get(k), set: async (k, v) => stored.set(k, v),
      scan: async ({ prefix }) => ({ entries: [...stored].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })) }) },
    session: { get: async ({ sessionID }) => ({ id: sessionID, projectID: 'project', location: { directory: root }, time: { created: 1 } }),
      synthetic: async () => { throw Error('no synthetic expected'); }, context: async () => [], hook: async () => ({ dispose: async () => {} }) },
    tool: { transform: async cb => { cb({ get: n => tools.get(n), add: d => tools.set(d.name, d) }); return { dispose: async () => tools.clear() }; } },
    event: { async *subscribe({ signal }) { if (signal.aborted) return; await new Promise(r => signal.addEventListener('abort', r, { once: true })); } },
  });
  // Both versions use the same loopback origin and durable paths. Only the
  // transport origin is substituted from the HTTPS enrollment fixture above.
  const settings = { ...enrolledSettings, stateDirectory: enrolledSettings?.stateDirectory ?? join(root, 'state'),
    broker: { url: f.base, tokenFile, insecureDevelopment: true } };
  const clients = [];
  const opts = reference => ({ presenceFactory: () => ({ selected: () => ({ has: () => true }) }), reference, tool,
    setupOptions: { directory: join(root, 'install') }, setupEnabled: false, loadSettings: async () => settings,
    deliveryFactory: () => ({ start() {}, stop: async () => {}, event() {} }),
    clientFactory: inbox => {
      inbox.now = () => f.now;
      const client = new reference.BrokerClient({ ...settings.broker, inbox, now: () => f.now, maxAttempts: 1 });
      clients.push(client); return client;
    },
  });
  const old = await (previous?.setupNativePlugin ?? setupNativePlugin)({ ...opts(oldRef), ctx: ctx(oldStorage) });
  t.after(() => old.dispose());
  await old.connect('surviving');
  const before = clients[0], id = before.identity.client_id, anchor = oldStorage.get('psst-v2-host-id');
  const mailboxDirectory = before.inbox.directory;
  const manifestPath = join(mailboxDirectory, 'binding.json'), manifest = readFileSync(manifestPath);
  const peer = registration('pi');
  assert.equal((await f.request('/v1/sessions', { method: 'POST', body: peer })).status, 200);
  const sent = await f.request('/v1/messages', { method: 'POST', session: peer.client_id, key: uuid(), body: sendBody(id, 'unread before upgrade') });
  assert.equal(sent.status, 202);
  for (let i = 0; i < 150 && !before.inbox.head(); i++) await delay(10);
  assert.equal(before.inbox.head()?.message_id, sent.body.message_id);
  const key = before.prepareSend(sendBody(peer.client_id, 'accepted response lost before upgrade'));
  const requestOnce = before.requestOnce.bind(before);
  let accepted;
  before.requestOnce = async (method, path, options) => {
    const result = await requestOnce(method, path, options);
    if (method === 'POST' && path === '/v1/messages') { accepted = result; throw new oldRef.LocalError('request_failed', { effect: 'unknown' }); }
    return result;
  };
  await assert.rejects(() => before.sendPrepared(key), e => e.effect === 'unknown');
  assert.equal(before.inbox.outgoing(key).uncertain, 1);
  await old.dispose();
  assert.equal(f.store.session(credentialEntry, id).closed, false);
  assert.equal(newStorage.size, 0);
  if (previous) {
    const restored = await readExistingConnection(join(dirname(tokenFile), 'connection.json'));
    assert.deepEqual(restored, enrolledSettings);
  }
  const current = await setupNativePlugin({ ...opts(ref), ctx: ctx(newStorage) });
  t.after(() => current.dispose());
  await current.connect('surviving');
  const after = clients.at(-1);
  assert.equal(after.identity.client_id, id);
  assert.equal(after.inbox.directory, mailboxDirectory);
  assert.equal(newStorage.get('psst-v2-host-id'), anchor);
  assert.equal(after.inbox.head()?.message_id, sent.body.message_id);
  assert.equal(after.inbox.outgoing(key).result.message_id, accepted.message_id);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM sessions WHERE type='opencode'").get().n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n, 2);
  assert.deepEqual(readFileSync(manifestPath), manifest);
  for (const [path, bytes] of preservedFiles) assert.deepEqual(readFileSync(path), bytes);
}

test('same-source restart preserves identity, unread mail and uncertain outgoing across native storage namespaces', t => migration(t));

test('pinned v0.5.1 source upgrades credential, native mailbox, unread mail and uncertain outgoing without reset', {
  skip: previousDirectory ? false : 'set PSST_PREVIOUS_SOURCE_DIR to the independently checked-out v0.5.1 source',
}, async t => {
  assert.ok(isAbsolute(previousDirectory), 'PSST_PREVIOUS_SOURCE_DIR must be absolute');
  const git = (...args) => execFileSync('git', ['-C', previousDirectory, ...args], { encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), previousCommit, 'prior source must be the pinned v0.5.1 commit');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'prior source must be an unmodified checkout');
  const load = file => import(pathToFileURL(join(previousDirectory, file)).href);
  const [plugin, reference, enrollment, helper] = await Promise.all([
    load('src/native-plugin.mjs'), load('src/reference.mjs'), load('src/enrollment.mjs'), load('vendor/enrollment/enrollment.mjs'),
  ]);
  await migration(t, { ...plugin, ...reference, ...enrollment, helper });
});
