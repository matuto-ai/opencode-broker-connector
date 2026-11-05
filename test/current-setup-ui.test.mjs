import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tui from '../plugin/tui.mjs';
import { SETUP_RPC } from '../src/setup-rpc.mjs';
import { presenceDirectory } from '../src/active-presence.mjs';

function fixture(t, { prompt = async () => 'https://broker.example.com', confirm = async () => true, result = {}, sharedRoot, sessionID = 'ses_one' } = {}) {
  const root = sharedRoot ?? mkdtempSync(join(tmpdir(), 'setup-ui-'));
  presenceDirectory(root, { directory: root }, { create: true });
  const prior = process.env.PSST_OPENCODE_CONFIG_DIR;
  process.env.PSST_OPENCODE_CONFIG_DIR = root;
  let commands, memory, route = { type: 'session', sessionID };
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
  t.after(() => { stop(); if (sharedRoot) return; if (prior === undefined) delete process.env.PSST_OPENCODE_CONFIG_DIR; else process.env.PSST_OPENCODE_CONFIG_DIR = prior; if (!sharedRoot) rmSync(root, { recursive: true, force: true }); });
  return { ctx, commands, calls, prompts, confirmations, toasts, renderer, stop,
    route(value) { route = value; renderer.emit('frame'); }, run: (id, input) => commands.find(x => x.id === id).run(input) };
}
test('official native palette/slash commands use one URL and selected-session RPC', async t => {
  const f = fixture(t);
  assert.deepEqual(f.commands.map(x => [x.id, x.slash.name, x.palette]), ['psst-setup', 'psst-reauthorize', 'psst-status', 'psst-cancel-setup'].map(x => [x, x, true]));
  await f.run('psst-setup');
  assert.equal(f.prompts.length, 1); assert.equal(f.confirmations.length, 0);
  assert.deepEqual(f.calls.map(x => [x.name, x.input]), [
    ['status', { sessionID: 'ses_one' }],
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
  assert.deepEqual(f.calls.at(-1).input, { sessionID: 'ses_one', broker_url: 'https://broker.example.com', replacement_confirmed: true, replacement_request_id: 'ar_old' });
});
test('approved uncommitted receipt resumes without replacement confirmation', async t => {
  const f = fixture(t, { result: { status: { state: 'paused', request_state: 'approved', replacement_confirmation_required: false } } });
  await f.run('psst-setup'); assert.equal(f.confirmations.length, 0); assert.equal(f.calls.at(-1).input.replacement_confirmed, undefined);
});
for (const answer of [false, undefined]) test(`replacement dismissed (${answer}) creates nothing`, async t => {
  const f = fixture(t, { confirm: async () => answer, result: { status: { replacement_confirmation_required: true, request_id: 'ar_old' } } });
  await f.run('psst-setup'); assert.equal(f.calls.length, 2);
});
test('prompt dismissed creates no setup request', async t => {
  const f = fixture(t, { prompt: async () => undefined }); await f.run('psst-setup'); assert.equal(f.calls.length, 1);
});
for (const url of ['https://user:secret@broker.example.com', 'http://broker.example.com', 'https://broker.example.com/path', 'https://broker.example.com?token=secret', 'bad\x1b[2J']) test('invalid URL is rejected before URL RPC: ' + JSON.stringify(url), async t => {
  const f = fixture(t, { prompt: async () => url }); await f.run('psst-setup'); assert.equal(f.calls.length, 1); assert.doesNotMatch(JSON.stringify(f.toasts), /secret|\x1b/);
});
for (const change of ['session', 'location', 'blur', 'dispose', 'away-back']) test(`prompt rejects ${change} changes before sending URL`, async t => {
  let resolve; const f = fixture(t, { prompt: () => new Promise(r => { resolve = r; }) });
  const running = f.run('psst-setup');
  while (!resolve) await new Promise(r => setImmediate(r));
  if (change === 'session' || change === 'away-back') f.route({ type: 'session', sessionID: 'ses_other' });
  if (change === 'away-back') f.route({ type: 'session', sessionID: 'ses_one' });
  if (change === 'location') f.ctx.location = { directory: '/another-location' };
  if (change === 'blur') { f.renderer.emit('blur'); f.renderer.emit('focus'); }
  if (change === 'dispose') f.stop();
  resolve('https://broker.example.com'); await running;
  assert.equal(f.calls.length, 1); assert.equal(f.renderer.listenerCount('blur'), 0); assert.equal(f.renderer.listenerCount('frame'), 0);
});
test('selection change while replacement confirm is open cannot replace', async t => {
  let resolve; const f = fixture(t, { confirm: () => new Promise(r => { resolve = r; }), result: { status: { replacement_confirmation_required: true, request_id: 'ar_old' } } });
  const pending = f.run('psst-setup'); while (!resolve) await new Promise(r => setImmediate(r));
  f.route({ type: 'session', sessionID: 'ses_other' }); resolve(true); await pending;
  assert.equal(f.calls.length, 2);
});
test('duplicate command during prompt is bounded; dismissal permits another', async t => {
  let resolve; const f = fixture(t, { prompt: () => new Promise(r => { resolve = r; }) });
  const running = f.run('psst-setup'); while (!resolve) await new Promise(r => setImmediate(r)); await f.run('psst-setup'); assert.equal(f.prompts.length, 1);
  resolve(undefined); await running; await f.run('psst-status'); assert.equal(f.calls.length, 2);
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
  assert.deepEqual(Object.keys(SETUP_RPC.methods.setup.input.properties), ['sessionID', 'broker_url', 'reauthorize', 'replacement_confirmed', 'replacement_request_id', 'selection_revision']);
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
  await f.run('psst-setup'); assert.equal(f.confirmations.length, 0); assert.equal(f.calls.length, 2);
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

for (const phase of ['prompt', 'rpc']) test(`two independent TUI views stay isolated during an active ${phase}`, async t => {
  let release;
  const gate = () => new Promise(resolve => { release = resolve; });
  const first = fixture(t, phase === 'prompt' ? { prompt: gate } : { result: { setup: gate } });
  const second = fixture(t, { sharedRoot: first.ctx.location.directory, sessionID: 'ses_two' });
  const action = first.run('psst-setup');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  second.route({ type: 'session', sessionID: 'ses_three' });
  second.renderer.emit('blur');
  await second.run('psst-status');
  for (const call of first.calls) assert.equal(call.options.signal.aborted, false);
  release(phase === 'prompt' ? 'https://broker.example.com' : { state: 'pending', request_id: 'first-request', request_outcome: 'saved' });
  await action;
  assert.deepEqual(first.calls.map(c => c.input.sessionID), ['ses_one', 'ses_one', 'ses_one']);
  assert.deepEqual(second.calls.map(c => c.input.sessionID), ['ses_three']);
  for (const call of first.calls) assert.equal(call.options.signal.aborted, false);
  assert.doesNotMatch(first.toasts.at(-1).message, /suspended/);
});

for (const stage of ['url_prompt', 'replacement_confirmation', 'setup', 'status', 'cancel']) test(`blur at ${stage} reports bounded phase and preserves context fences`, async t => {
  let release;
  const gate = () => new Promise(resolve => { release = resolve; });
  const f = fixture(t, {
    prompt: stage === 'url_prompt' ? gate : async () => 'https://broker.example.com',
    confirm: stage === 'replacement_confirmation' ? gate : async () => true,
    result: {
      status: stage === 'status' ? gate : { state: 'denied', request_id: 'old', replacement_confirmation_required: true },
      setup: stage === 'setup' ? gate : { state: 'pending' }, cancel: gate,
    },
  });
  const action = f.run(stage === 'status' ? 'psst-status' : stage === 'cancel' ? 'psst-cancel-setup' : 'psst-setup');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.renderer.emit('blur'); f.renderer.emit('focus');
  release(stage === 'url_prompt' ? 'https://broker.example.com' : stage === 'replacement_confirmation' ? true : { state: 'paused', request_id: 'saved', request_outcome: 'saved' });
  await action;
  const message = f.toasts.at(-1).message;
  assert.match(message, new RegExp(`phase=${stage}; cause=terminal_blur`));
  assert.match(message, /Other chats can stay open/);
  assert.match(message, stage === 'setup' ? /request=saved/ : /request=not_submitted/);
  assert.equal(f.calls.filter(c => c.name === 'setup').length, stage === 'setup' ? 1 : 0);
  assert.equal(f.renderer.listenerCount('blur'), 0);
});

test('lost setup reply cannot reuse preflight receipt as evidence that replacement was saved', async t => {
  const f = fixture(t, { result: {
    status: { state: 'denied', request_id: 'old', replacement_confirmation_required: true },
    setup: () => { throw Error('lost_reply'); },
  } });
  await f.run('psst-setup'); assert.match(f.toasts.at(-1).message, /request=unknown/);
});

test('real session switch after request persistence reports saved without displaying stale success', async t => {
  let release;
  const f = fixture(t, { result: { setup: () => new Promise(resolve => { release = resolve; }) } });
  const action = f.run('psst-setup'); while (!release) await new Promise(resolve => setImmediate(resolve));
  f.route({ type: 'session', sessionID: 'ses_other' });
  release({ state: 'approved', request_id: 'same', request_outcome: 'saved' }); await action;
  assert.match(f.toasts.at(-1).message, /phase=setup; cause=session_changed; request=saved/);
  assert.doesNotMatch(f.toasts.at(-1).message, /authorization approved/);
  assert.equal(f.calls.at(-1).input.sessionID, 'ses_one');
});

test('setup owned elsewhere stops at preflight, without replaying confirmation', async t => {
  const f = fixture(t, { result: { status: { state: 'setup_owned_elsewhere' } } });
  await f.run('psst-setup'); assert.equal(f.calls.length, 1); assert.equal(f.confirmations.length, 0);
  assert.match(f.toasts.at(-1).message, /belongs to another chat/);
});

test('reauthorize supplies command intent with the exact request and revision, without another dialog', async t => {
  const f = fixture(t, { confirm: () => assert.fail('The explicit command already supplies replacement intent'), result: { status: { broker_url: 'https://broker.example.com', state: 'approved', request_id: 'old', replacement_confirmation_required: true, selection_revision: 'revision-one' },
    setup: { state: 'pending', request_id: 'new', approval_url: 'https://broker.example.com/admin', connected: true } } });
  await f.run('psst-reauthorize', 'https://broker.example.com/');
  assert.equal(f.prompts.length, 0); assert.equal(f.confirmations.length, 0);
  assert.deepEqual(f.calls.map(c => c.name), ['status', 'setup']);
  assert.deepEqual(f.calls.at(-1).input, { sessionID: 'ses_one', broker_url: 'https://broker.example.com', reauthorize: true, selection_revision: 'revision-one', replacement_confirmed: true, replacement_request_id: 'old' });
  assert.match(f.toasts.at(-1).message, /new/); assert.match(f.toasts.at(-1).message, /https:\/\/broker.example.com\/admin/);
});

for (const state of ['pending', 'paused', 'approved']) test(`reauthorize reconciles ${state} candidate without replacing it`, async t => {
  const f = fixture(t, { result: { status: { broker_url: 'https://broker.example.com', state, request_id: 'same', replacement_confirmation_required: false, selection_revision: null },
    setup: { state, request_id: 'same', request_outcome: 'saved', connected: false } } });
  await f.run('psst-reauthorize', 'https://broker.example.com');
  assert.equal(f.confirmations.length, 0); assert.equal(f.prompts.length, 0);
  assert.equal(f.calls.at(-1).input.replacement_confirmed, undefined);
  assert.match(f.toasts.at(-1).message, /same/);
  if (state === 'approved') assert.match(f.toasts.at(-1).message, /not connected yet/);
});

for (const change of ['blur', 'session', 'location', 'dispose']) test(`reauthorization preflight rejects ${change} without setup`, async t => {
  let release;
  const f = fixture(t, { confirm: () => assert.fail('No replacement dialog'), result: { status: () => new Promise(resolve => { release = resolve; }) } });
  const action = f.run('psst-reauthorize', 'https://broker.example.com'); while (!release) await new Promise(resolve => setImmediate(resolve));
  if (change === 'blur') f.renderer.emit('blur');
  if (change === 'session') f.route({ type: 'session', sessionID: 'other' });
  if (change === 'location') { f.ctx.location = { directory: '/another-location' }; f.renderer.emit('frame'); }
  if (change === 'dispose') f.stop();
  release({ broker_url: 'https://broker.example.com', state: 'revoked', request_id: 'old', replacement_confirmation_required: true, selection_revision: 'rev' }); await action;
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.calls.filter(c => c.name === 'setup').length, 0);
});

for (const request_id of [undefined, '', '/private/secret', 'x'.repeat(129)]) test(`reauthorize rejects an invalid previous-request fence: ${JSON.stringify(request_id)}`, async t => {
  const f = fixture(t, { confirm: () => assert.fail('No replacement dialog'), result: { status: { broker_url: 'https://broker.example.com', replacement_confirmation_required: true, request_id, selection_revision: 'rev' } } });
  await f.run('psst-reauthorize', 'https://broker.example.com');
  assert.deepEqual(f.calls.map(call => call.name), ['status']);
  assert.doesNotMatch(JSON.stringify(f.toasts), /private|secret/);
});

test('reauthorize without saved origin uses its explicit endpoint without another dialog', async t => {
  const f = fixture(t, { confirm: () => assert.fail('No replacement dialog'), result: { status: { state: 'setup_needed', selection_revision: null } } });
  await f.run('psst-reauthorize', 'https://broker.example.com'); assert.equal(f.prompts.length, 0); assert.equal(f.confirmations.length, 0);
  assert.equal(f.calls.at(-1).name, 'setup'); assert.equal(f.calls.at(-1).input.selection_revision, null);
});

for (const endpoint of [undefined, '', ' ', 'http://broker.example.com', 'https:broker.example.com', 'https:///broker.example.com', 'https://broker.example.com\\path', 'https://broker.example.com/path', 'https://broker.example.com/../', 'https://user:secret@broker.example.com', 'https://broker.example.com?token=secret', 'https://broker.example.com?', 'https://broker.example.com#', 'https://broker.example.com\u0085', 'https://broker.example.com\n', 'https://broker.example.com https://other.example.com']) test(`reauthorize rejects missing/malformed endpoint before RPC: ${JSON.stringify(endpoint)}`, async t => {
  const f = fixture(t, { result: { status: { broker_url: 'https://broker.example.com', state: 'approved' } } });
  f.ctx.client.rpc = () => assert.fail('Invalid invocation must not inspect setup status');
  await f.run('psst-reauthorize', endpoint);
  assert.equal(f.calls.length, 0); assert.equal(f.prompts.length, 0); assert.equal(f.confirmations.length, 0);
  assert.match(f.toasts.at(-1).message, /Usage: \/psst-reauthorize <https:\/\/broker.example.com>/);
  assert.doesNotMatch(JSON.stringify(f.toasts), /secret|other.example.com|\u0085/);
});

for (const state of ['pending', 'paused', 'approved']) test(`reauthorize rejects configured-target mismatch for ${state} without setup`, async t => {
  const f = fixture(t, { result: { status: { broker_url: 'https://configured.example.com', state } } });
  await f.run('psst-reauthorize', 'https://different.example.com');
  assert.deepEqual(f.calls.map(call => call.name), ['status']);
  assert.equal(f.prompts.length, 0); assert.equal(f.confirmations.length, 0);
  assert.match(f.toasts.at(-1).message, /does not match the configured broker/);
});

test('reauthorize advertises native argument support and reports server-side target drift', async t => {
  const f = fixture(t, { result: { status: { broker_url: 'https://broker.example.com', state: 'pending' }, setup: { state: 'setup_blocked', code: 'broker_endpoint_mismatch' } } });
  const command = f.commands.find(command => command.id === 'psst-reauthorize');
  assert.equal(command.slash.arguments, true);
  await command.run(); assert.match(f.toasts.at(-1).message, /Usage:/); assert.equal(f.calls.length, 0);
  await command.run('https://broker.example.com');
  assert.equal(f.calls.at(-1).input.reauthorize, true);
  assert.match(f.toasts.at(-1).message, /does not match the configured broker/);
});

test('selected but not connected candidate is not reported as working access', async t => {
  const f = fixture(t, { result: { status: { state: 'approved', candidate_selected: true, connected: false, authorization_state: 'rejected' } } });
  await f.run('psst-status'); assert.match(f.toasts.at(-1).message, /not connected yet/);
  assert.doesNotMatch(f.toasts.at(-1).message, /Existing connection stays active/);
});

test('reauthorize reconciles a lost replacement response without another dialog or replacement intent', async t => {
  let state = { broker_url: 'https://broker.example.com', state: 'revoked', request_id: 'old', replacement_confirmation_required: true, selection_revision: 'rev' }, attempts = 0;
  const f = fixture(t, { result: { status: () => state, setup: () => {
    state = { ...state, state: 'pending', request_id: 'same-candidate', replacement_confirmation_required: false };
    if (++attempts === 1) throw Error('reply_lost');
    return { ...state, request_outcome: 'saved' };
  } } });
  await f.run('psst-reauthorize', 'https://broker.example.com'); assert.match(f.toasts.at(-1).message, /request=unknown/);
  await f.run('psst-reauthorize', 'https://broker.example.com'); assert.equal(f.confirmations.length, 0);
  assert.equal(f.calls.at(-1).input.replacement_confirmed, undefined);
  assert.match(f.toasts.at(-1).message, /same-candidate/);
});

test('actual failed-attachment payloads distinguish approved candidate from blocked or paused setup', async t => {
  const { createNativeSetup } = await import('../src/native-setup.mjs');
  let publicResult, saved;
  const f = fixture(t, { result: { status: () => publicResult } });
  const stored = new Map(), controller = new AbortController();
  const setup = createNativeSetup({
    directory: f.ctx.location.directory, signal: controller.signal,
    storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, value) },
    verify: async id => ({ id, projectID: 'project', location: f.ctx.location, time: { created: 1 } }),
    status: () => ({ connected: false }), activate: async () => { throw Error('candidate_attachment_failed'); },
    loadHelper: async () => ({ readApprovalState: () => saved,
      beginApproval: async () => saved = { state: 'approved', requestId: 'approved-candidate', connectionFile: '/candidate' } }),
  });
  t.after(() => setup.stop());
  const context = { sessionID: 'ses_one', signal: controller.signal };
  let failure;
  try { await setup.invoke('broker_setup', { broker_url: 'https://broker.example.com' }, context); }
  catch (error) { failure = error; }
  assert.equal(failure?.message, 'candidate_attachment_failed');
  publicResult = await setup.failure(failure, context.sessionID);
  assert.equal(publicResult.state, 'setup_blocked'); assert.equal(publicResult.request_state, 'approved');
  await f.run('psst-status'); assert.match(f.toasts.at(-1).message, /approved candidate is not connected yet/);
  publicResult = await setup.invoke('broker_setup_status', {}, context);
  assert.equal(publicResult.state, 'paused'); assert.equal(publicResult.request_state, 'approved');
  await f.run('psst-status'); assert.match(f.toasts.at(-1).message, /setup is paused/);
  assert.match(f.toasts.at(-1).message, /approved candidate is not connected yet/);
  assert.match(f.toasts.at(-1).message, /approved-candidate/);
});

test('candidate annotation does not override denied or pending setup state', async t => {
  for (const state of ['denied', 'pending']) {
    const f = fixture(t, { result: { status: { state, request_state: 'approved', connected: false } } });
    await f.run('psst-status'); assert.doesNotMatch(f.toasts.at(-1).message, /approved candidate/);
  }
});

test('explicit status and pause slash commands dispatch without exploratory questions or diagnostics', async t => {
  const f = fixture(t, { prompt: () => assert.fail('No missing parameter'), confirm: () => assert.fail('No redundant command approval') });
  await f.run('psst-status'); await f.run('psst-cancel-setup');
  assert.deepEqual(f.calls.map(call => call.name), ['status', 'cancel']);
  assert.ok(f.calls.every(call => call.input.sessionID === 'ses_one'));
});

test('setup reuses known broker and preflight without a redundant URL prompt or confirmation', async t => {
  const f = fixture(t, { prompt: () => assert.fail('Known broker must be reused'), confirm: () => assert.fail('Pending request needs no new authorization'),
    result: { status: { broker_url: 'https://broker.example.com', state: 'pending', request_id: 'same', selection_revision: 'rev' } } });
  await f.run('psst-setup');
  assert.deepEqual(f.calls.map(call => call.name), ['status', 'setup']);
  assert.deepEqual(f.calls[1].input, { sessionID: 'ses_one', broker_url: 'https://broker.example.com', selection_revision: 'rev' });
});
