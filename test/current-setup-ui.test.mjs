import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tui from '../plugin/tui.mjs';
import { SETUP_RPC } from '../src/setup-rpc.mjs';
import { presenceDirectory } from '../src/active-presence.mjs';

function fixture(t, { prompt = async () => 'https://broker.example.com', confirm = async () => true, result = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setup-ui-'));
  presenceDirectory(root, { directory: root }, { create: true });
  const prior = process.env.PSST_OPENCODE_CONFIG_DIR;
  process.env.PSST_OPENCODE_CONFIG_DIR = root;
  let commands, memory, route = { type: 'session', sessionID: 'ses_one' };
  const calls = [], prompts = [], confirmations = [], toasts = [], renderer = new EventEmitter();
  const ctx = {
    app: { version: '2.2.5' }, location: { directory: root }, renderer,
    storage: { memory: (_key, { initial }) => { memory ??= initial; return [memory, mutate => mutate(memory)]; } },
    keymap: { layer(factory) { assert.equal(factory().mode, 'global', 'slash commands remain reachable in autocomplete mode'); commands = factory().commands; assert.deepEqual(factory().commands.map(x => x.id), commands.map(x => x.id)); } },
    ui: { router: { current: () => route }, toast: { show: toast => toasts.push(toast) },
      dialog: { prompt: async arg => { prompts.push(arg); return prompt(); }, confirm: async arg => { confirmations.push(arg); return confirm(); } } },
    client: { rpc(definition) {
      assert.equal(definition, SETUP_RPC);
      return Object.fromEntries(['status', 'setup', 'cancel'].map(name => [name, async (input, options) => {
        calls.push({ name, input, options });
        assert.deepEqual(options.location, ctx.location); assert.ok(options.signal instanceof AbortSignal);
        return typeof result[name] === 'function' ? result[name](input, options) : result[name] ?? { state: name === 'cancel' ? 'paused' : 'pending' };
      }]));
    } },
  };
  const stop = tui.setup(ctx);
  t.after(() => { stop(); if (prior === undefined) delete process.env.PSST_OPENCODE_CONFIG_DIR; else process.env.PSST_OPENCODE_CONFIG_DIR = prior; rmSync(root, { recursive: true, force: true }); });
  return { ctx, commands, calls, prompts, confirmations, toasts, renderer, stop,
    route(value) { route = value; renderer.emit('frame'); }, run: id => commands.find(x => x.id === id).run() };
}
test('official native palette/slash commands use one URL and selected-session RPC', async t => {
  const f = fixture(t);
  assert.deepEqual(f.commands.map(x => [x.id, x.slash.name, x.palette]), ['psst-setup', 'psst-status', 'psst-cancel-setup'].map(x => [x, x, true]));
  await f.run('psst-setup');
  assert.equal(f.prompts.length, 1); assert.equal(f.confirmations.length, 0);
  assert.deepEqual(f.calls.map(x => [x.name, x.input]), [
    ['status', { sessionID: 'ses_one', broker_url: 'https://broker.example.com' }],
    ['setup', { sessionID: 'ses_one', broker_url: 'https://broker.example.com' }],
  ]);
  await f.run('psst-status'); await f.run('psst-cancel-setup');
  assert.deepEqual(f.calls.slice(-2).map(x => [x.name, x.input]), [['status', { sessionID: 'ses_one' }], ['cancel', { sessionID: 'ses_one' }]]);
});
test('terminal replacement binds native explicit confirmation to the exact request', async t => {
  const f = fixture(t, { result: { status: { state: 'denied', replacement_confirmation_required: true, request_id: 'ar_old' } } });
  await f.run('psst-setup');
  assert.match(f.confirmations[0].message, /new credential-bound addresses/);
  assert.match(f.confirmations[0].message, /Old local data is retained/);
  assert.deepEqual(f.calls[1].input, { sessionID: 'ses_one', broker_url: 'https://broker.example.com', replacement_confirmed: true, replacement_request_id: 'ar_old' });
});
test('approved uncommitted receipt resumes without replacement confirmation', async t => {
  const f = fixture(t, { result: { status: { state: 'paused', request_state: 'approved', replacement_confirmation_required: false } } });
  await f.run('psst-setup'); assert.equal(f.confirmations.length, 0); assert.equal(f.calls[1].input.replacement_confirmed, undefined);
});
for (const answer of [false, undefined]) test(`replacement dismissed (${answer}) creates nothing`, async t => {
  const f = fixture(t, { confirm: async () => answer, result: { status: { replacement_confirmation_required: true, request_id: 'ar_old' } } });
  await f.run('psst-setup'); assert.equal(f.calls.length, 1);
});
test('prompt dismissed creates nothing', async t => {
  const f = fixture(t, { prompt: async () => undefined }); await f.run('psst-setup'); assert.equal(f.calls.length, 0);
});
for (const url of ['https://user:secret@broker.example.com', 'http://broker.example.com', 'https://broker.example.com/path', 'https://broker.example.com?token=secret', 'bad\x1b[2J']) test('invalid URL is rejected without RPC: ' + JSON.stringify(url), async t => {
  const f = fixture(t, { prompt: async () => url }); await f.run('psst-setup'); assert.equal(f.calls.length, 0); assert.doesNotMatch(JSON.stringify(f.toasts), /secret|\x1b/);
});
for (const change of ['session', 'location', 'blur', 'dispose', 'away-back']) test(`prompt rejects ${change} changes before sending URL`, async t => {
  let resolve; const f = fixture(t, { prompt: () => new Promise(r => { resolve = r; }) });
  const running = f.run('psst-setup');
  if (change === 'session' || change === 'away-back') f.route({ type: 'session', sessionID: 'ses_other' });
  if (change === 'away-back') f.route({ type: 'session', sessionID: 'ses_one' });
  if (change === 'location') f.ctx.location = { directory: '/another-location' };
  if (change === 'blur') { f.renderer.emit('blur'); f.renderer.emit('focus'); }
  if (change === 'dispose') f.stop();
  resolve('https://broker.example.com'); await running;
  assert.equal(f.calls.length, 0); assert.equal(f.renderer.listenerCount('blur'), 0); assert.equal(f.renderer.listenerCount('frame'), 0);
});
test('selection change while replacement confirm is open cannot replace', async t => {
  let resolve; const f = fixture(t, { confirm: () => new Promise(r => { resolve = r; }), result: { status: { replacement_confirmation_required: true, request_id: 'ar_old' } } });
  const pending = f.run('psst-setup'); while (!resolve) await new Promise(r => setImmediate(r));
  f.route({ type: 'session', sessionID: 'ses_other' }); resolve(true); await pending;
  assert.equal(f.calls.length, 1);
});
test('duplicate command during prompt is bounded; dismissal permits another', async t => {
  let resolve; const f = fixture(t, { prompt: () => new Promise(r => { resolve = r; }) });
  const running = f.run('psst-setup'); await f.run('psst-setup'); assert.equal(f.prompts.length, 1);
  resolve(undefined); await running; await f.run('psst-status'); assert.equal(f.calls.length, 1);
});
test('errors and arbitrary status fields never disclose server secrets or private paths', async t => {
  const f = fixture(t, { result: { status: () => { throw Error('/private/token-secret\x1b[2J'); } } });
  await f.run('psst-status'); assert.doesNotMatch(JSON.stringify(f.toasts), /private|token-secret|\x1b/);
});
test('safe public status is rendered without arbitrary server fields', async t => {
  const f = fixture(t, { result: { status: { state: 'pending', approval_url: 'https://broker.example.com/admin', request_id: 'ar_123', connectionFile: '/private/secret', token: 'secret' } } });
  await f.run('psst-status'); const rendered = JSON.stringify(f.toasts);
  assert.match(rendered, /https:\/\/broker.example.com\/admin/); assert.match(rendered, /ar_123/); assert.doesNotMatch(rendered, /secret|connectionFile/);
});
test('shared local presence guard must pass before dialog or RPC', async t => {
  const f = fixture(t); f.ctx.location = { directory: '/nonexistent-psst-local' };
  await f.run('psst-setup'); assert.equal(f.prompts.length, 0); assert.equal(f.calls.length, 0);
});
test('portable RPC schemas accept only native session, URL, and explicit replacement fence', () => {
  assert.deepEqual(Object.keys(SETUP_RPC.methods.setup.input.properties), ['sessionID', 'broker_url', 'replacement_confirmed', 'replacement_request_id']);
  for (const method of Object.values(SETUP_RPC.methods)) assert.equal(method.input.additionalProperties, false);
});
test('focus change during preflight aborts RPC and never begins setup', async t => {
  let complete;
  const f = fixture(t, { result: { status: () => new Promise(resolve => { complete = resolve; }) } });
  const running = f.run('psst-setup'); while (!complete) await new Promise(resolve => setImmediate(resolve));
  f.renderer.emit('blur'); assert.equal(f.calls[0].options.signal.aborted, true);
  complete({ state: 'setup_needed' }); await running; assert.equal(f.calls.length, 1);
});
test('malformed replacement request fence fails closed without confirmation or setup', async t => {
  const f = fixture(t, { result: { status: { replacement_confirmation_required: true, request_id: '/private/secret' } } });
  await f.run('psst-setup'); assert.equal(f.confirmations.length, 0); assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(f.toasts), /secret/);
});
test('home route cannot prompt, inspect status, or cancel another session', async t => {
  const f = fixture(t); f.route({ type: 'home' });
  for (const command of f.commands) await command.run();
  assert.equal(f.prompts.length, 0); assert.equal(f.calls.length, 0);
});

for (const state of ['pending', 'denied', 'expired', 'paused']) test(`existing connection does not hide ${state} setup state`, async t => {
  const f = fixture(t, { result: { status: { connected: true, state } } });
  await f.run('psst-status'); const message = f.toasts.at(-1).message;
  assert.match(message, /Existing connection stays active/);
  const phrases = { pending: /Waiting for human approval/, denied: /request was denied/, expired: /request expired/, paused: /setup is paused/ };
  assert.match(message, phrases[state]);
});
test('approved candidate is not presented as connected before native status proves connection', async t => {
  const f = fixture(t, { result: { status: { connected: false, state: 'approved' } } });
  await f.run('psst-status'); assert.doesNotMatch(f.toasts.at(-1).message, /is connected/); assert.match(f.toasts.at(-1).message, /authorization approved/);
});
