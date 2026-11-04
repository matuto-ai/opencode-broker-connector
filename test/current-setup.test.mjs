import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeSetup } from '../src/native-setup.mjs';
import { readPending } from '../src/installation.mjs';
async function fixture(t, overrides={}) {
 const directory=mkdtempSync(join(tmpdir(),'psst-native-setup-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const stored=new Map(),calls=[],ctrl=new AbortController();let result={state:'pending',requestId:'same-request',approvalUrl:'https://fixture.invalid/admin'};
 const helper={readApprovalState:()=>null,beginApproval:async()=>{calls.push('begin');return result;},pollApproval:async()=>{calls.push('poll');return result;},...overrides};
 const options={directory,storage:{get:async k=>stored.get(k),set:async(k,v)=>stored.set(k,v)},verify:async id=>({id,projectID:'project',location:{directory},time:{created:1}}),connect:async()=>calls.push('connect'),status:()=>({connected:calls.includes('connect')}),signal:ctrl.signal,loadHelper:async()=>helper,select:async()=>calls.push('select'),pollMs:10};
 const setup=createNativeSetup(options);t.after(()=>setup.stop());const context={sessionID:'one',signal:new AbortController().signal};return{setup,options,calls,context,directory,ctrl,stored,setResult:r=>result=r};
}
test('URL setup never starts on load/status; approval is human action, result contains no private files',async t=>{
 const f=await fixture(t);await f.setup.resume();assert.deepEqual(f.calls,[]);await f.setup.invoke('broker_setup_status',{},f.context);assert.deepEqual(f.calls,[]);
 const r=await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);assert.equal(r.request_id,'same-request');assert.equal(r.state,'pending');assert.equal(JSON.stringify(r).includes('connectionFile'),false);
 f.setResult({state:'approved',requestId:'same-request',connectionFile:'/private/token-not-output'});await delay(30);assert.ok(f.calls.includes('select'));assert.ok(f.calls.includes('connect'));
});
test('same pending setup cancellation retains request and never selects late approval',async t=>{
 const f=await fixture(t);await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);await f.setup.invoke('broker_cancel_setup',{},f.context);f.setResult({state:'approved',requestId:'same-request',connectionFile:'/private'});await delay(30);assert.equal(f.calls.includes('select'),false);assert.equal(readPending(f.directory).paused,true);assert.equal(readPending(f.directory).requestId,'same-request');
});
test('second session cannot overwrite pending request, denial cannot silently create replacement',async t=>{
 const f=await fixture(t);await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);await assert.rejects(()=>f.setup.invoke('broker_setup',{broker_url:'https://elsewhere.invalid'},{...f.context,sessionID:'two'}),/owner/);assert.equal(f.calls.filter(x=>x==='begin').length,1);
 const denied=await fixture(t,{readApprovalState:()=>({state:'denied',requestId:'old'})});const r=await denied.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},denied.context);assert.equal(r.state,'denied');assert.equal(denied.calls.length,0);
});
test('setup shutdown drains unknown begin and preserves durable request, without selecting',async t=>{
 let release;const f=await fixture(t,{beginApproval:()=>new Promise(r=>release=r)});const call=f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);while(!release)await delay(0);const stop=f.setup.stop();release({state:'pending',requestId:'original'});await call;await stop;assert.equal(readPending(f.directory).requestId,'original');assert.equal(readPending(f.directory).paused,true);assert.equal(f.calls.includes('select'),false);
});
test('reloaded explicit pending flow resumes with GET only and exact native binding',async t=>{
 const f=await fixture(t);await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);await f.setup.stop();const second=createNativeSetup(f.options);t.after(()=>second.stop());await second.resume();await delay(15);assert.equal(f.calls.filter(x=>x==='begin').length,1);assert.ok(f.calls.filter(x=>x==='poll').length>0);
});
test('unsafe URL rejected before any enrollment effect',async t=>{
 const f=await fixture(t);for(const url of ['http://fixture.invalid','https://secret@fixture.invalid','https://fixture.invalid/path'])await assert.rejects(()=>f.setup.invoke('broker_setup',{broker_url:url},f.context));assert.deepEqual(f.calls,[]);
});
test('caller cancellation during approval selection validation cannot commit or connect',async t=>{
 const f=await fixture(t);await f.setup.stop();let entered,release;const validating=new Promise(r=>entered=r);const options={...f.options,select:async({signal})=>{entered();await new Promise(r=>release=r);if(signal.aborted)throw new Error('selection_cancelled');f.calls.push('select');}};
 f.setResult({state:'approved',requestId:'same-request',connectionFile:'/private'});const setup=createNativeSetup(options);t.after(()=>setup.stop());const caller=new AbortController();const pending=setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},{...f.context,signal:caller.signal});await validating;caller.abort();release();await assert.rejects(()=>pending,/selection_cancelled/);assert.equal(f.calls.includes('select'),false);assert.equal(f.calls.includes('connect'),false);assert.equal(readPending(f.directory).paused,true);
});
test('owner native-session deletion fences background approval activation during async validation',async t=>{
 const f=await fixture(t);await f.setup.stop();let entered,release;const validating=new Promise(r=>entered=r);const options={...f.options,select:async({signal})=>{entered();await new Promise(r=>release=r);if(signal.aborted)throw new Error('owner_cancelled');f.calls.push('select');}};
 const setup=createNativeSetup(options);t.after(()=>setup.stop());await setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);f.setResult({state:'approved',requestId:'same-request',connectionFile:'/private'});await validating;setup.event({type:'session.deleted',data:{sessionID:'one'}});release();await delay(20);assert.equal(f.calls.includes('select'),false);assert.equal(f.calls.includes('connect'),false);assert.equal(readPending(f.directory).paused,true);
});
test('actual installation selector rechecks native binding after private-file validation',async t=>{
 const {selectInstallation,readSelection}=await import('../src/installation.mjs');const {writeFileSync}=await import('node:fs');const f=await fixture(t);const connectionFile=join(f.directory,'connection.json');writeFileSync(connectionFile,JSON.stringify({broker:{url:'https://fixture.invalid/',tokenFile:join(f.directory,'token')},stateDirectory:join(f.directory,'state')}),{mode:0o600});let checked=false;
 await assert.rejects(()=>selectInstallation({directory:f.directory,connectionFile,expectedRevision:null,verify:async()=>{checked=true;return false;}}),/binding_changed/);assert.equal(checked,true);assert.equal(readSelection(f.directory),null);
});

test('renamed namespace cannot resume or replace a pending request whose native owner is unavailable',async t=>{
 const {readFileSync,writeFileSync}=await import('node:fs');const f=await fixture(t);await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);await f.setup.stop();
 const legacy=readPending(f.directory);delete legacy.owner;writeFileSync(join(f.directory,'pending.json'),JSON.stringify(legacy));
 const before=readFileSync(join(f.directory,'pending.json'));f.stored.clear();f.calls.length=0;
 const second=createNativeSetup(f.options);t.after(()=>second.stop());await second.resume();
 assert.equal((await second.invoke('broker_setup_status',{},f.context)).state,'setup_owner_recovery_required');
 await assert.rejects(()=>second.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context),/setup_owner_recovery_required/);
 assert.deepEqual(f.calls,[]);assert.deepEqual(readFileSync(join(f.directory,'pending.json')),before);
});

test('durable exact owner resumes after native namespace loss, while changed native binding cannot resume',async t=>{
 const f=await fixture(t);await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);await f.setup.stop();f.stored.clear();f.calls.length=0;
 const second=createNativeSetup(f.options);t.after(()=>second.stop());await second.resume();await delay(20);
 assert.equal(f.calls.includes('begin'),false);assert.ok(f.calls.includes('poll'));assert.equal((await second.invoke('broker_setup_status',{},f.context)).request_id,'same-request');
 await second.stop();f.calls.length=0;const changed=createNativeSetup({...f.options,verify:async id=>({id,projectID:'other',location:{directory:f.directory},time:{created:2}})});t.after(()=>changed.stop());await changed.resume();await delay(20);assert.deepEqual(f.calls,[]);await assert.rejects(()=>changed.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context),/mismatch/);
});
test('restart hydrates denied, expired and paused status without minting or polling',async t=>{
 for(const state of ['denied','expired','pending']) {
  let saved;const f=await fixture(t,{readApprovalState:()=>saved});await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);await f.setup.invoke('broker_cancel_setup',{},f.context);await f.setup.stop();
  saved={state,requestId:'same-request'};f.calls.length=0;const second=createNativeSetup(f.options);t.after(()=>second.stop());await second.resume();const result=await second.invoke('broker_setup_status',{},f.context);
  assert.equal(result.state,state==='pending'?'paused':state);assert.equal(result.request_id,'same-request');assert.deepEqual(f.calls,[]);
 }
});
test('terminal replacement requires native confirmation of exact request, then creates one new candidate',async t=>{
 let began;const f=await fixture(t,{readApprovalState:()=>({state:'denied',requestId:'old'}),beginApproval:async options=>{began=options;return{state:'pending',requestId:'new'};},pollApproval:async()=>({state:'pending',requestId:'new'})});
 const preflight=await f.setup.invoke('broker_setup_status',{broker_url:'https://fixture.invalid'},f.context);assert.equal(preflight.replacement_confirmation_required,true);
 for(const context of [f.context,{...f.context,confirmedReplacement:true,replacementRequestId:'changed'}]) {
  const result=await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},context);assert.equal(result.replacement_confirmation_required,true);assert.equal(began,undefined);
 }
 const result=await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},{...f.context,confirmedReplacement:true,replacementRequestId:'old'});assert.equal(result.request_id,'new');assert.equal(began.replaceRequestId,'old');assert.equal(readPending(f.directory).requestId,'new');
});
test('approved candidate attachment failure preserves selection and retry reuses same approved request',async t=>{
 let saved,begins=0,attempts=0;const f=await fixture(t,{readApprovalState:()=>saved,beginApproval:async options=>{begins++;assert.equal(options.replaceRequestId,undefined);saved={state:'approved',requestId:'same-request',connectionFile:'/candidate'};return saved;}});await f.setup.stop();
 const setup=createNativeSetup({...f.options,activate:async({commit})=>{if(++attempts===1)throw new Error('candidate_unavailable');await commit();}});t.after(()=>setup.stop());
 await assert.rejects(()=>setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context),/candidate_unavailable/);assert.equal(f.calls.includes('select'),false);
 const status=await setup.invoke('broker_setup_status',{broker_url:'https://fixture.invalid'},f.context);assert.equal(status.replacement_confirmation_required,false);
 await setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);assert.equal(begins,2);assert.equal(attempts,2);assert.equal(f.calls.filter(x=>x==='select').length,1);
});

test('cancel during durable native owner save prevents a later enrollment POST',async t=>{
 const f=await fixture(t);await f.setup.stop();let entered,release;const ready=new Promise(r=>entered=r);
 const setup=createNativeSetup({...f.options,storage:{...f.options.storage,set:async(k,v)=>{await f.options.storage.set(k,v);entered();await new Promise(r=>release=r);}}});t.after(()=>setup.stop());
 const pending=setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);await ready;await setup.invoke('broker_cancel_setup',{},f.context);release();await assert.rejects(()=>pending,/cancelled/);assert.equal(f.calls.includes('begin'),false);assert.equal(readPending(f.directory).paused,true);
});

test('cancel before durable owner allocation stops setup without candidate files or POST',async t=>{
 const f=await fixture(t);await f.setup.stop();let entered,release;const ready=new Promise(r=>entered=r);
 const setup=createNativeSetup({...f.options,loadHelper:async()=>{entered();await new Promise(r=>release=r);return await f.options.loadHelper();}});t.after(()=>setup.stop());
 const pending=setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);await ready;assert.equal(readPending(f.directory),null);await setup.invoke('broker_cancel_setup',{},f.context);release();await assert.rejects(()=>pending,/cancelled/);assert.equal(readPending(f.directory),null);assert.equal(f.calls.includes('begin'),false);
});

test('approved retry retains original selection baseline and cannot rebase over a newer authorization',async t=>{
 const {writeFileSync}=await import('node:fs');let saved;const f=await fixture(t,{readApprovalState:()=>saved,beginApproval:async()=>saved??={state:'approved',requestId:'same-request',connectionFile:'/candidate'}});await f.setup.stop();let attempts=0,revision;
 const setup=createNativeSetup({...f.options,activate:async({commit})=>{if(++attempts===1)throw Error('attach_failed');await commit();},select:async input=>{revision=input.expectedRevision;throw Error('psst_selection_changed');}});t.after(()=>setup.stop());
 await assert.rejects(()=>setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context),/attach_failed/);
 writeFileSync(join(f.directory,'installation.json'),JSON.stringify({format:'psst-opencode-installation-v1',revision:'other-choice',connectionFile:'/other-authorization'}),{mode:0o600});
 await assert.rejects(()=>setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context),/selection_changed/);assert.equal(revision,null);assert.equal(readPending(f.directory).expectedRevision,null);
});
test('cancel during final native binding check cannot create an approval request',async t=>{
 const f=await fixture(t);await f.setup.stop();let checks=0,entered,release;const ready=new Promise(r=>entered=r);
 const setup=createNativeSetup({...f.options,verify:async id=>{if(++checks===3){entered();await new Promise(r=>release=r);}return f.options.verify(id);}});t.after(()=>setup.stop());
 const pending=setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);await ready;await setup.invoke('broker_cancel_setup',{},f.context);release();await assert.rejects(()=>pending,/cancelled/);assert.equal(f.calls.includes('begin'),false);
});

test('restart reconciles helper-persisted request after crash before response without a second POST',async t=>{
 const {savePending}=await import('../src/installation.mjs');const f=await fixture(t,{readApprovalState:()=>({state:'pending',requestId:'durable-before-response'}),pollApproval:async()=>{f.calls.push('poll');return{state:'pending',requestId:'durable-before-response'};}});await f.setup.stop();
 const info=await f.options.verify('one');const {canonical}=await import('../vendor/broker/src/protocol.mjs');savePending({directory:f.directory,brokerUrl:'https://fixture.invalid/',expectedRevision:null,owner:{sessionID:'one',binding:canonical({id:info.id,projectID:info.projectID,location:info.location,created:info.time.created})}});
 const next=createNativeSetup(f.options);t.after(()=>next.stop());await next.resume();await delay(20);assert.equal(readPending(f.directory).requestId,'durable-before-response');assert.ok(f.calls.includes('poll'));assert.equal(f.calls.includes('begin'),false);
});
test('restart before replacement candidate exists never adopts prior approval or starts another POST',async t=>{
 const {savePending}=await import('../src/installation.mjs');const {canonical}=await import('../vendor/broker/src/protocol.mjs');const f=await fixture(t,{readApprovalState:()=>({state:'approved',requestId:'prior',connectionFile:'/prior'})});await f.setup.stop();const info=await f.options.verify('one');
 savePending({directory:f.directory,brokerUrl:'https://fixture.invalid/',expectedRevision:null,previousRequestId:'prior',owner:{sessionID:'one',binding:canonical({id:info.id,projectID:info.projectID,location:info.location,created:info.time.created})}});
 const next=createNativeSetup(f.options);t.after(()=>next.stop());await next.resume();assert.equal(readPending(f.directory).paused,true);assert.equal(readPending(f.directory).requestId,null);assert.deepEqual(f.calls,[]);
});
test('retryable unknown enrollment result reconciles the durable request using GET only',async t=>{
 let saved;const f=await fixture(t,{readApprovalState:()=>saved,beginApproval:async()=>{f.calls.push('begin');saved={state:'pending',requestId:'durable'};throw Object.assign(Error('transport_error'),{retryable:true,effect:'unknown'});},pollApproval:async()=>{f.calls.push('poll');return{state:'approved',requestId:'durable',connectionFile:'/candidate'};}});
 await assert.rejects(()=>f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context),/transport_error/);await delay(30);assert.equal(f.calls.filter(x=>x==='begin').length,1);assert.ok(f.calls.includes('poll'));assert.ok(f.calls.includes('select'));assert.equal(readPending(f.directory).requestId,'durable');
});

test('terminal paused setup permits explicit replacement from another verified native conversation',async t=>{
 let saved;const f=await fixture(t,{readApprovalState:()=>saved,beginApproval:async options=>{saved={state:'denied',requestId:options.replaceRequestId?'second':'first'};return saved;}});
 await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);assert.equal(readPending(f.directory).paused,true);
 const second={...f.context,sessionID:'two',confirmedReplacement:true,replacementRequestId:'first'};const result=await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},second);assert.equal(result.request_id,'second');assert.equal(readPending(f.directory).owner.sessionID,'two');
});

test('pending owner selected after startup resumes with GET only and paused owner stays paused',async t=>{
 let saved={state:'pending',requestId:'same-request'};const f=await fixture(t,{readApprovalState:()=>saved,pollApproval:async()=>{f.calls.push('poll');return saved;}});await f.setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);await f.setup.stop();f.calls.length=0;let selected=false;
 const next=createNativeSetup({...f.options,verify:async id=>selected?f.options.verify(id):null});t.after(()=>next.stop());await next.resume();await delay(20);assert.deepEqual(f.calls,[]);
 selected=true;saved={state:'approved',requestId:'same-request',connectionFile:'/candidate'};await next.resume();await delay(20);assert.ok(f.calls.includes('poll'));assert.ok(f.calls.includes('select'));assert.equal(f.calls.includes('begin'),false);
 await next.invoke('broker_cancel_setup',{},f.context);await next.stop();f.calls.length=0;const paused=createNativeSetup(f.options);t.after(()=>paused.stop());await paused.resume();await delay(20);assert.deepEqual(f.calls,[]);
});

test('selection recovery never automatically retries fatal poll or candidate activation failure',async t=>{
 for(const failure of ['poll','activation']) {
  let saved={state:'pending',requestId:'same-request'},polls=0,activations=0;
  const f=await fixture(t,{readApprovalState:()=>saved,beginApproval:async()=>saved,pollApproval:async()=>{polls++;if(failure==='poll')throw Error('invalid_response');return saved;}});await f.setup.stop();
  const setup=createNativeSetup({...f.options,activate:async()=>{activations++;throw Error('psst_selection_changed');}});t.after(()=>setup.stop());await setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context);saved={state:'approved',requestId:'same-request',connectionFile:'/candidate'};await delay(30);
  assert.equal(readPending(f.directory).paused,true);const before={polls,activations};for(let i=0;i<5;i++){await setup.resume();await delay(15);}assert.deepEqual({polls,activations},before);
  if(failure==='activation'){await assert.rejects(()=>setup.invoke('broker_setup',{broker_url:'https://fixture.invalid'},f.context));assert.equal(activations,before.activations+1,'only explicit setup retries attachment');}
 }
});

test('stable owner retry while polling reconciles the same request without another begin', async t => {
 let saved; const f = await fixture(t, { readApprovalState: () => saved,
  beginApproval: async () => { f.calls.push('begin'); return saved = { state: 'pending', requestId: 'durable' }; },
  pollApproval: async () => saved });
 await f.setup.invoke('broker_setup', { broker_url: 'https://fixture.invalid' }, f.context);
 const before = readPending(f.directory);
 const result = await f.setup.invoke('broker_setup', { broker_url: 'https://fixture.invalid' }, f.context);
 assert.equal(result.request_id, 'durable'); assert.equal(result.request_outcome, 'saved');
 assert.equal(f.calls.filter(x => x === 'begin').length, 1);
 assert.equal(readPending(f.directory).flowId, before.flowId);
});

test('paused pending owner cannot be silently moved to another selected conversation', async t => {
 let saved; const f = await fixture(t, { readApprovalState: () => saved,
  beginApproval: async () => saved = { state: 'pending', requestId: 'durable' }, pollApproval: async () => saved });
 await f.setup.invoke('broker_setup', { broker_url: 'https://fixture.invalid' }, f.context);
 await f.setup.invoke('broker_cancel_setup', {}, f.context); await delay(0);
 const second = { ...f.context, sessionID: 'two' };
 assert.equal((await f.setup.invoke('broker_setup_status', {}, second)).state, 'setup_owned_elsewhere');
 await assert.rejects(() => f.setup.invoke('broker_setup', { broker_url: 'https://fixture.invalid' }, second), /owner_conflict/);
 assert.equal(readPending(f.directory).owner.sessionID, 'one');
 assert.equal(readPending(f.directory).requestId, 'durable');
});

test('cancelled begin retains receipt, status reconciles disk, and explicit retry reuses identity', async t => {
 let saved, release, begins = 0;
 const f = await fixture(t, { readApprovalState: () => saved,
  beginApproval: async () => { begins++; saved ??= { state: 'pending', requestId: 'durable' }; if (begins === 1) await new Promise(r => { release = r; }); return saved; },
  pollApproval: async () => saved });
 const caller = new AbortController();
 const action = f.setup.invoke('broker_setup', { broker_url: 'https://fixture.invalid' }, { ...f.context, signal: caller.signal });
 while (!release) await delay(0); caller.abort(); release();
 assert.equal((await action).request_outcome, 'saved');
 const status = await f.setup.invoke('broker_setup_status', {}, f.context);
 assert.equal(status.state, 'paused'); assert.equal(status.request_id, 'durable'); assert.equal(status.request_outcome, 'saved');
 const result = await f.setup.invoke('broker_setup', { broker_url: 'https://fixture.invalid' }, f.context);
 assert.equal(result.request_id, 'durable'); assert.equal(readPending(f.directory).owner.sessionID, 'one');
});

test('failure reconciliation separates unknown effect, saved request, and foreign owner without secrets', async t => {
 let saved; const f = await fixture(t, { readApprovalState: () => saved,
  beginApproval: async () => { saved = { state: 'pending', requestId: 'durable', connectionFile: '/private/token' }; throw Object.assign(Error('/private/secret'), { effect: 'unknown' }); } });
 const before = await f.setup.invoke('broker_setup_status', {}, f.context); assert.equal(before.request_outcome, 'not_started');
 await assert.rejects(() => f.setup.invoke('broker_setup', { broker_url: 'https://fixture.invalid' }, f.context));
 const failure = await f.setup.failure({ effect: 'unknown' }, 'one');
 assert.equal(failure.request_outcome, 'unknown'); assert.equal(failure.request_id, 'durable');
 const status = await f.setup.invoke('broker_setup_status', {}, f.context); assert.equal(status.request_outcome, 'saved');
 const foreign = await f.setup.failure(Error('setup_owner_conflict'), 'two'); assert.equal(foreign.state, 'setup_owned_elsewhere');
 assert.doesNotMatch(JSON.stringify([failure, status, foreign]), /private|secret|connectionFile/);
});

async function selectedFixture(t, overrides = {}) {
 const { writeFileSync, readFileSync } = await import('node:fs');
 const f = await fixture(t, overrides);
 const connectionFile = join(f.directory, 'old-connection.json');
 writeFileSync(connectionFile, JSON.stringify({ broker: { url: 'https://configured.invalid/', tokenFile: join(f.directory, 'old-token') }, stateDirectory: join(f.directory, 'old-journal') }), { mode: 0o600 });
 writeFileSync(join(f.directory, 'old-token'), 'unchanged-secret', { mode: 0o600 });
 writeFileSync(join(f.directory, 'old-journal'), 'unread-messages', { mode: 0o600 });
 const selectionFile = join(f.directory, 'installation.json');
 const selectOld = revision => writeFileSync(selectionFile, JSON.stringify({ format: 'psst-opencode-installation-v1', revision, connectionFile }), { mode: 0o600 });
 selectOld('revision-one');
 return { ...f, connectionFile, selectOld, readFileSync };
}

test('status exposes only configured HTTPS origin and selected revision, including expired credentials', async t => {
 const f = await selectedFixture(t);
 const result = await f.setup.invoke('broker_setup_status', {}, f.context);
 assert.equal(result.broker_url, 'https://configured.invalid'); assert.equal(result.selection_revision, 'revision-one');
 assert.doesNotMatch(JSON.stringify(result), /old-token|unchanged-secret|old-journal|connectionFile/);
 assert.deepEqual(f.calls, []);
});

for (const state of ['approved', 'revoked', 'expired']) test(`explicit ${state} replacement preserves old selection and unread data while pending`, async t => {
 let saved, begins = 0;
 const f = await selectedFixture(t, { readApprovalState: () => saved,
  beginApproval: async options => { begins++; assert.equal(options.replaceRequestId, 'old'); return saved = { state: 'pending', requestId: 'new' }; }, pollApproval: async () => saved });
 saved = { state, requestId: 'old', connectionFile: f.connectionFile };
 const preflight = await f.setup.invoke('broker_setup_status', {}, f.context);
 assert.equal(preflight.replacement_confirmation_required, true);
 await f.setup.invoke('broker_setup', { broker_url: preflight.broker_url }, { ...f.context, confirmedReplacement: true, replacementRequestId: 'old', confirmedSelectionRevision: preflight.selection_revision });
 assert.equal(begins, 1); assert.equal(readPending(f.directory).requestId, 'new');
 const { readSelection } = await import('../src/installation.mjs');
 assert.equal(readSelection(f.directory).connectionFile, f.connectionFile);
 assert.equal(f.readFileSync(join(f.directory, 'old-token'), 'utf8'), 'unchanged-secret');
 assert.equal(f.readFileSync(join(f.directory, 'old-journal'), 'utf8'), 'unread-messages');
});

test('selection revision changed after native confirmation cannot begin replacement', async t => {
 const f = await selectedFixture(t, { readApprovalState: () => ({ state: 'revoked', requestId: 'old' }) });
 const preflight = await f.setup.invoke('broker_setup_status', {}, f.context);
 f.selectOld('revision-two');
 await assert.rejects(() => f.setup.invoke('broker_setup', { broker_url: preflight.broker_url }, { ...f.context, confirmedReplacement: true, replacementRequestId: 'old', confirmedSelectionRevision: preflight.selection_revision }), /setup_selection_changed/);
 assert.equal(readPending(f.directory), null); assert.equal(f.calls.includes('begin'), false);
});

test('model-facing setup cannot smuggle native replacement or selection confirmation', async t => {
 const f = await fixture(t, { readApprovalState: () => ({ state: 'revoked', requestId: 'old' }) });
 for (const key of ['replacement_confirmed', 'replacement_request_id', 'selection_revision'])
  await assert.rejects(() => f.setup.invoke('broker_setup', { broker_url: 'https://fixture.invalid', [key]: true }, f.context), /invalid_configuration/);
 assert.equal(f.calls.includes('begin'), false);
});
