import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '../src/tool-schema.mjs';
import { setupNativePlugin } from '../src/native-plugin.mjs';
import { openNativeInbox } from '../src/native-inbox.mjs';
import { createNativeDelivery } from '../src/native-delivery.mjs';
import { randomUUID } from 'node:crypto';
import { loadBrokerReference } from '../src/reference.mjs';
const reference=await loadBrokerReference();
async function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'psst-native-plugin-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const stored=new Map(),tools=new Map(),hooks=new Map(),states=[];
 const settings={stateDirectory:join(dir,'state'),broker:{url:'https://fixture.invalid/'}};
 const ctx={app:{version:'2.2.5'},location:{directory:dir},storage:{get:async k=>stored.get(k),set:async(k,v)=>stored.set(k,v),scan:async({prefix})=>({entries:[...stored].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value}))})},
  session:{get:async({sessionID})=>({id:sessionID,projectID:'project',location:{directory:dir},time:{created:1}}),synthetic:async()=>{},context:async()=>[{id:'msg',type:'assistant',content:['call1','call2'].map(id=>({type:'tool',id,name:'broker_send',time:{created:Date.now()-1000}})),time:{created:Date.now()-1000}}],hook:async(name,fn)=>{hooks.set(name,fn);return{dispose:async()=>hooks.delete(name)};}},
  tool:{transform:async callback=>{callback({get:name=>tools.get(name),add:definition=>tools.set(definition.name,definition)});return{dispose:async()=>tools.clear()};}},
  event:{async *subscribe({signal}){if(signal.aborted)return;await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}}};
 const options={presenceFactory:()=>({selected:()=>({has:()=>true})}),ctx,reference,tool,setupOptions:{directory:join(dir,'installation')},setupEnabled:false,loadSettings:async()=>settings,clientFactory:inbox=>({inbox}),
  adapterFactory:({client,binding,currentBinding,operationContext})=>{
   const state={identity:client.inbox.identity,binding,currentBinding,operationContext,client};states.push(state);
   return{start:async()=>assert.ok(await currentBinding()),stop:async()=>client.inbox.close(),tools:Object.fromEntries(reference.TOOL_DEFINITIONS.map(d=>[d.name,{execute:async(args,context)=>JSON.stringify({sessionID:binding.sessionID,operation:operationContext(context)})}]))};},
  deliveryFactory:()=>({start(){},stop:async()=>{},event(){}})};
 const runtime=await setupNativePlugin(options);t.after(()=>runtime.dispose());return{dir,ctx,tools,hooks,states,runtime,settings,stored,options};
}
test('OpenCode registers automatic-only lifecycle tools, preserves drafts and isolates native session identities',async t=>{
 const f=await fixture(t);assert.equal(f.tools.size,8);assert.equal(f.tools.has('broker_receive'),false);assert.equal(f.tools.has('broker_acknowledge'),false);
 const prompt={sessionID:'one',messageID:'human',prompt:{text:'keep my draft'}};await f.hooks.get('prompt')(prompt);await f.runtime.connect('one');await f.runtime.connect('two');assert.equal(f.states.length,2);assert.notEqual(f.states[0].identity.client_id,f.states[1].identity.client_id);assert.equal(prompt.prompt.text,'keep my draft');
});
test('OpenCode durable native tool-call ID is private and replay stable, distinct calls are distinct',async t=>{
 const f=await fixture(t),invoke=async id=>JSON.parse((await f.tools.get('broker_send').execute({}, {sessionID:'one',messageID:'msg',id,signal:new AbortController().signal})).content);
 const a=await invoke('call1'),b=await invoke('call1'),c=await invoke('call2');assert.equal(a.operation.operationId,b.operation.operationId);assert.notEqual(a.operation.operationId,c.operation.operationId);
});
test('OpenCode reload reopens same exact broker inbox identity; owner conflicts do not reset it',async t=>{
 const f=await fixture(t);await f.runtime.connect('one');const original=f.states[0].identity;
 const binding=JSON.parse([...f.stored.values()].find(v=>v?.binding)?.binding?JSON.stringify([...f.stored.values()].find(v=>v?.binding).binding):'null');
 assert.throws(()=>openNativeInbox({reference,settings:f.settings,binding}),{code:'owner_conflict'});
 await f.runtime.dispose();const runtime=await setupNativePlugin(f.options);t.after(()=>runtime.dispose());await runtime.connect('one');assert.deepEqual(f.states.at(-1).identity,original);
});
test('OpenCode rejects classic/unknown host version and foreign project sessions',async t=>{
 const f=await fixture(t);await f.runtime.dispose();f.ctx.app.version='1.19.4';await assert.rejects(()=>setupNativePlugin(f.options),/capability/);f.ctx.app.version='2.2.5';f.ctx.session.get=async({sessionID})=>({id:sessionID,projectID:'foreign',location:{directory:'/tmp'},time:{created:1}});const runtime=await setupNativePlugin(f.options);t.after(()=>runtime.dispose());await assert.rejects(()=>runtime.connect('foreign'),/mismatch/);
});
test('OpenCode never deletes or replaces an unreadable durable manifest',async t=>{
 const f=await fixture(t);await f.runtime.connect('one');const directory=f.states[0].client.inbox.directory;await f.runtime.dispose();writeFileSync(join(directory,'binding.json'),'{');await assert.rejects(()=>setupNativePlugin(f.options));assert.equal(f.states.length,1);assert.equal((await import('node:fs')).readFileSync(join(directory,'binding.json'),'utf8'),'{');
});

test('native missing or mismatched tool-call timestamp fails closed before outgoing execution',async t=>{
 const f=await fixture(t);f.ctx.session.context=async()=>[{id:'msg',type:'assistant',time:{created:Date.now()},content:[{type:'tool',id:'foreign',name:'broker_send',time:{created:Date.now()}}]}];
 const result=JSON.parse((await f.tools.get('broker_send').execute({}, {sessionID:'one',messageID:'msg',id:'call1',signal:new AbortController().signal})).content);assert.equal(result.error.code,'session_mismatch');
});
test('host anchor lock rejects concurrent initialization without executing a second storage mutation',async t=>{
 const {withNativeLock}=await import('../src/native-lock.mjs');const dir=mkdtempSync(join(tmpdir(),'psst-native-lock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let release,second=false;
 const first=withNativeLock(dir,'host-anchor',()=>new Promise(r=>release=r));await assert.rejects(()=>withNativeLock(dir,'host-anchor',()=>{second=true;}));assert.equal(second,false);release('one');assert.equal(await first,'one');assert.equal(await withNativeLock(dir,'host-anchor',async()=>'same'),'same');
});
test('plugin dispose cancels admitted tool executor before awaiting its ledger drain',async t=>{
 const f=await fixture(t);await f.runtime.dispose();let entered,aborted=false;const started=new Promise(r=>entered=r),caller=new AbortController();
 const options={...f.options,adapterFactory:({client})=>({start:async()=>{},stop:async()=>client.inbox.close(),tools:{broker_list_clients:{execute:async(args,context)=>{entered();return new Promise(resolve=>{context.abort.addEventListener('abort',()=>{aborted=true;resolve('{}');},{once:true});});}}}})};
 const runtime=await setupNativePlugin(options);const pending=f.tools.get('broker_list_clients').execute({}, {sessionID:'one',messageID:'msg',id:'call',signal:caller.signal});await started;let settled=false;const closing=runtime.dispose().then(()=>{settled=true;});
 await Promise.race([closing,new Promise(r=>setTimeout(r,100))]);const result={aborted,settled};caller.abort();await closing;await pending;assert.deepEqual(result,{aborted:true,settled:true});
});

test('durable archive state rejects reconnection even when its event was missed',async t=>{
 const f=await fixture(t);f.ctx.session.get=async({sessionID})=>({id:sessionID,projectID:'project',location:{directory:f.dir},time:{created:1,archived:2}});await assert.rejects(()=>f.runtime.connect('archived'),/mismatch/);assert.equal(f.states.length,0);
});

test('renamed plugin namespace restores two exact identities after anchor-only crash without old registry access',async t=>{
 const f=await fixture(t);await f.runtime.connect('one');await f.runtime.connect('two');
 const before=Object.fromEntries(f.states.map(x=>[x.binding.sessionID,x.identity]));await f.runtime.dispose();f.stored.clear();
 const {recoverHostAnchor}=await import('../src/identity-recovery.mjs');
 await recoverHostAnchor({storage:f.ctx.storage,session:f.ctx.session,settings:f.settings,directory:f.dir});
 assert.equal(f.stored.size,1,'simulate crash before registry restoration');
 const second=await setupNativePlugin(f.options);t.after(()=>second.dispose());await second.connect('one');await second.connect('two');
 assert.deepEqual(Object.fromEntries(f.states.slice(2).map(x=>[x.binding.sessionID,x.identity])),before);assert.notEqual(before.one.client_id,before.two.client_id);
});

test('known disabled session is not restored from a private manifest despite live native metadata',async t=>{
 const f=await fixture(t);await f.runtime.connect('one');await f.runtime.dispose();
 const key=[...f.stored.keys()].find(k=>k.startsWith('psst-v2-session:'));f.stored.set(key,{sessionID:'one',enabled:false});
 const second=await setupNativePlugin(f.options);t.after(()=>second.dispose());await assert.rejects(()=>second.connect('one'),/closed/);assert.equal(f.states.length,1);assert.equal(f.stored.get(key).enabled,false);
});

test('native archive arriving during startup fences registration after asynchronous settings read',async t=>{
 const f=await fixture(t);await f.runtime.dispose();let emit,entered,release,hold=false;
 const observed=new Promise(r=>entered=r),eventReady=new Promise(r=>emit=r);
 f.ctx.event.subscribe=async function*({signal}){await eventReady;yield{type:'session.archived',data:{sessionID:'one'}};if(!signal.aborted)await new Promise(r=>signal.addEventListener('abort',r,{once:true}));};
 const runtime=await setupNativePlugin({...f.options,loadSettings:async()=>{if(hold){entered();await new Promise(r=>release=r);}return f.settings;}});t.after(()=>runtime.dispose());
 hold=true;const connecting=runtime.connect('one');await observed;emit();await new Promise(r=>setImmediate(r));release();await assert.rejects(()=>connecting);assert.equal(f.states.length,0);
 assert.equal([...f.stored.values()].find(v=>v?.sessionID==='one').enabled,false);
});


test('selection change during native getInfo cannot return a usable binding',async t=>{
 const f=await fixture(t);await f.runtime.dispose();let active=true;
 const runtime=await setupNativePlugin({...f.options,presenceFactory:()=>({selected:()=>new Set(active?['one']:[])})});t.after(()=>runtime.dispose());await runtime.connect('one');
 const original=f.ctx.session.get;let release,entered;const ready=new Promise(r=>entered=r);
 f.ctx.session.get=async args=>{entered();await new Promise(r=>release=r);return original(args);};
 const pending=f.states.at(-1).currentBinding();await ready;active=false;release();assert.equal(await pending,null);
});
test('explicit archive reason resumes after native unarchive but unknown disabled records remain disabled',async t=>{
 const f=await fixture(t);await f.runtime.connect('one');const id=f.runtime.status('one').client_id;await f.runtime.dispose();
 const key=[...f.stored.keys()].find(k=>k.startsWith('psst-v2-session:'));f.stored.set(key,{sessionID:'one',enabled:false,reason:'archived'});
 const next=await setupNativePlugin(f.options);t.after(()=>next.dispose());await next.connect('one');assert.equal(next.status('one').client_id,id);
});

function candidateFile(f, name='candidate') {
 const tokenFile=join(f.dir,name+'.token');writeFileSync(tokenFile,'fixture-secret',{mode:0o600});
 const connectionFile=join(f.dir,name+'.json');writeFileSync(connectionFile,JSON.stringify({broker:{url:'https://fixture.invalid/',tokenFile},stateDirectory:join(f.dir,name+'-state')}),{mode:0o600});
 return connectionFile;
}
test('explicit approved replacement attaches before CAS, switches live adapter and retains old mailbox',async t=>{
 const f=await fixture(t);await f.runtime.connect('one');const original=f.runtime.status('one').client_id,old=f.states[0],connectionFile=candidateFile(f);let committed=false;
 await f.runtime.activate({sessionID:'one',connectionFile,signal:new AbortController().signal,commit:async()=>{
  assert.equal(f.runtime.status('one').client_id,original,'old adapter is live through candidate attachment');
  assert.equal(f.states.length,2,'candidate was independently attached before selection');assert.ok(await old.currentBinding());committed=true;
 }});
 assert.ok(committed);assert.notEqual(f.runtime.status('one').client_id,original);assert.equal(await old.currentBinding(),null);
 const {existsSync}=await import('node:fs');assert.ok(existsSync(join(old.client.inbox.directory,'binding.json')),'old authority journal is retained, never adopted/deleted');
 assert.equal((await f.runtime.connect('one')).client.inbox.identity.client_id,f.runtime.status('one').client_id);
});
test('replacement attachment failure or superseded selection leaves prior live adapter and no candidate delivery',async t=>{
 for(const failure of ['attach','commit']) {
  const f=await fixture(t);await f.runtime.dispose();let delivered=0,starts=0;
  const runtime=await setupNativePlugin({...f.options,adapterFactory:args=>{const adapter=f.options.adapterFactory(args);return{...adapter,start:async metadata=>{if(++starts===2&&failure==='attach')throw new Error('candidate_unavailable');await adapter.start(metadata);}};},deliveryFactory:()=>({start(){delivered++;},stop:async()=>{},event(){}})});t.after(()=>runtime.dispose());
  await runtime.connect('one');const original=runtime.status('one').client_id;let commits=0;
  await assert.rejects(()=>runtime.activate({sessionID:'one',connectionFile:candidateFile(f),signal:new AbortController().signal,commit:async()=>{commits++;throw new Error('psst_selection_changed');}}),failure==='attach'?/candidate_unavailable/:/selection_changed/);
  assert.equal(commits,failure==='attach'?0:1);assert.equal(runtime.status('one').client_id,original);assert.equal(delivered,1);assert.ok(await f.states[0].currentBinding());assert.equal(await f.states[1].currentBinding(),null);
 }
});
test('replacement cancellation while attachment waits cannot commit or disturb working adapter',async t=>{
 const f=await fixture(t);await f.runtime.dispose();let entered,release,starts=0;const ready=new Promise(r=>entered=r),caller=new AbortController();
 const runtime=await setupNativePlugin({...f.options,adapterFactory:args=>{const adapter=f.options.adapterFactory(args);return{...adapter,start:async metadata=>{if(++starts===2){entered();await new Promise(r=>release=r);}await adapter.start(metadata);}};}});t.after(()=>runtime.dispose());
 await runtime.connect('one');const original=runtime.status('one').client_id;let commits=0;
 const pending=runtime.activate({sessionID:'one',connectionFile:candidateFile(f),signal:caller.signal,commit:async()=>{commits++;}});await ready;caller.abort();release();await assert.rejects(()=>pending);
 assert.equal(commits,0);assert.equal(runtime.status('one').client_id,original);assert.ok(await f.states[0].currentBinding());
});

test('expired authorization retains exact old native anchor while setup remains available for explicit repair',async t=>{
 const f=await fixture(t);await f.runtime.connect('one');const anchor=f.stored.get('psst-v2-host-id'),oldID=f.runtime.status('one').client_id;await f.runtime.dispose();f.stored.clear();let recoveryReads=0;
 const loadSettings=async options=>{if(options?.identityRecovery){recoveryReads++;return{...f.settings,authorizationExpired:true};}throw Object.assign(Error('credential_expired'),{code:'credential_expired'});};
 const runtime=await setupNativePlugin({...f.options,setupEnabled:true,loadSettings});t.after(()=>runtime.dispose());assert.equal(recoveryReads,1);assert.equal(f.stored.get('psst-v2-host-id'),anchor);assert.ok(f.tools.has('broker_setup'));assert.equal(runtime.status('one').authorization_state,'expired');await assert.rejects(()=>runtime.connect('one'),/credential_expired/);assert.equal(f.states.length,1);assert.equal(f.states[0].identity.client_id,oldID);
});

test('old authorization expiry in another session cannot mark a committed replacement expired',async t=>{
 const f=await fixture(t);f.settings.enrollment={expiresAt:new Date(Date.now()+60000).toISOString()};await f.runtime.connect('one');await f.runtime.connect('two');const old=f.states.find(s=>s.binding.sessionID==='two');
 await f.runtime.activate({sessionID:'one',connectionFile:candidateFile(f),signal:new AbortController().signal,commit:async()=>{}});f.settings.enrollment.expiresAt=new Date(Date.now()-1000).toISOString();assert.equal(await old.currentBinding(),null);assert.equal(f.runtime.status('one').authorization_state,'active');assert.equal(f.runtime.status('two').authorization_state,'expired');
});

test('corrupt pending candidate cannot prevent independent working authorization from reconnecting',async t=>{
 const f=await fixture(t);await f.runtime.connect('one');const original=f.runtime.status('one').client_id;await f.runtime.dispose();const pendingPath=join(f.dir,'installation','pending.json');writeFileSync(pendingPath,'{corrupt',{mode:0o600});const diagnostics=[];
 const runtime=await setupNativePlugin({...f.options,setupEnabled:true,onDiagnostic:entry=>diagnostics.push(entry.code)});t.after(()=>runtime.dispose());assert.equal(runtime.status('one').connected,true);assert.equal(runtime.status('one').client_id,original);assert.ok(diagnostics.includes('native_setup_restore_unavailable'));const status=JSON.parse((await f.tools.get('broker_setup_status').execute({},{sessionID:'one',signal:new AbortController().signal})).content);assert.equal(status.state,'setup_blocked');assert.equal(status.connected,true);
 const {readFileSync}=await import('node:fs');assert.equal(readFileSync(pendingPath,'utf8'),'{corrupt');const result=JSON.parse((await f.tools.get('broker_setup').execute({broker_url:'https://fixture.invalid'},{sessionID:'one',signal:new AbortController().signal})).content);assert.equal(result.state,'setup_blocked');assert.equal(runtime.status('one').client_id,original);
});


test('only send and resend bypass CodeMode so every outgoing mutation keeps its own call identity', async t => {
  const f = await fixture(t);
  for (const [name, definition] of f.tools) {
    assert.equal(definition.options?.codemode, ['broker_send', 'broker_resend'].includes(name) ? false : undefined);
  }
});

test('confirmed session expiry replaces the connector journal once before starting delivery', async t => {
  const f = await fixture(t);
  await f.runtime.dispose();
  f.settings.broker.registrationVersion = 2;
  const clients = [];
  let attempts = 0, deliveries = 0, allocations = 0;
  const options = {
    ...f.options,
    clientFactory: inbox => {
      const client = { inbox, identity: inbox.identity, registrationVersion: 2, expiredIdentityConfirmed: true,
        async createReplacementInbox({ directory, verifySession }) {
          assert.equal(await verifySession(), true);
          allocations++;
          return new reference.Inbox({ directory, identity: reference.newSessionIdentity('opencode') });
        } };
      clients.push(client);
      return client;
    },
    adapterFactory: args => {
      const adapter = f.options.adapterFactory(args);
      return { ...adapter, start: async () => {
        if (++attempts === 1) throw Object.assign(new Error('expired'), { code: 'session_expired' });
        await adapter.start();
      } };
    },
    deliveryFactory: () => ({ start() { deliveries++; }, async stop() {}, event() {} }),
  };
  const runtime = await setupNativePlugin(options);
  t.after(() => runtime.dispose());
  await runtime.connect('one');
  assert.equal(attempts, 2);
  assert.equal(allocations, 1);
  assert.equal(deliveries, 1);
  assert.notEqual(clients[0].identity.client_id, clients[1].identity.client_id);
  const identity = runtime.status('one').client_id;
  await runtime.dispose();
  const reloaded = await setupNativePlugin(options);
  t.after(() => reloaded.dispose());
  await reloaded.connect('one');
  assert.equal(reloaded.status('one').client_id, identity);
  assert.equal(allocations, 1);
});

test('uncertain replacement blocks reconnect in the same plugin instead of allocating repeatedly', async t => {
  const f = await fixture(t);
  await f.runtime.dispose();
  f.settings.broker.registrationVersion = 2;
  let allocations = 0;
  const runtime = await setupNativePlugin({
    ...f.options,
    clientFactory: inbox => ({ inbox, identity: inbox.identity, registrationVersion: 2, expiredIdentityConfirmed: true,
      async createReplacementInbox() { allocations++; throw new Error('storage unavailable'); } }),
    adapterFactory: args => ({ ...f.options.adapterFactory(args),
      async start() { throw Object.assign(new Error('expired'), { code: 'session_expired' }); } }),
  });
  t.after(() => runtime.dispose());
  await assert.rejects(runtime.connect('one'), { code: 'native_incarnation_uncertain' });
  await assert.rejects(runtime.connect('one'), /native_plugin_closed/);
  assert.equal(allocations, 1);
  assert.equal(runtime.status('one').connected, false);
});

test('clean event-stream end fences active sessions and drains the same shutdown before reload', async t => {
  const f = await fixture(t);
  await f.runtime.dispose();
  let endStream, enteredStop, finishStop;
  const streamEnded = new Promise(resolve => { endStream = resolve; });
  const stopping = new Promise(resolve => { enteredStop = resolve; });
  const drained = new Promise(resolve => { finishStop = resolve; });
  const diagnostics = [];
  f.ctx.event.subscribe = async function* () { await streamEnded; };
  const runtime = await setupNativePlugin({ ...f.options,
    onDiagnostic: entry => diagnostics.push(entry.code),
    deliveryFactory: () => ({ start() {}, event() {}, async stop() { enteredStop(); await drained; } }),
  });
  t.after(() => { endStream(); finishStop(); return runtime.dispose(); });
  await runtime.connect('one');
  const identity = runtime.status('one').client_id;
  endStream();
  await Promise.race([stopping, new Promise(resolve => setTimeout(resolve, 50))]);
  assert.ok(diagnostics.includes('native_event_stream_unavailable'));
  assert.equal(await f.states.at(-1).currentBinding(), null);
  assert.equal(runtime.status('one').connected, false);
  await assert.rejects(runtime.connect('two'), /native_plugin_closed/);
  let closed = false;
  const closing = runtime.dispose().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'dispose must join the in-progress event-stream shutdown');
  finishStop();
  await closing;
  assert.equal(f.tools.size, 0);
  assert.equal(f.hooks.size, 0);
  f.ctx.event.subscribe = async function* ({ signal }) {
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  const reloaded = await setupNativePlugin(f.options);
  t.after(() => reloaded.dispose());
  await reloaded.connect('one');
  assert.equal(reloaded.status('one').client_id, identity, 'stream loss never replaces the durable identity');
});

test('event stream ending during setup cannot return an apparently usable plugin', async t => {
  const f = await fixture(t);
  await f.runtime.dispose();
  f.ctx.event.subscribe = async function* () {};
  await assert.rejects(setupNativePlugin(f.options), /native_event_stream_unavailable/);
  assert.equal(f.tools.size, 0);
  assert.equal(f.hooks.size, 0);
});

test('event-stream loss aborts in-flight native admission and preserves uncertainty across reload', async t => {
  const f = await fixture(t);
  await f.runtime.dispose();
  let endStream, entered, lateReceipt, delivery, calls = 0;
  const ending = new Promise(resolve => { endStream = resolve; });
  const submitted = new Promise(resolve => { entered = resolve; });
  f.ctx.event.subscribe = async function* () { await ending; };
  f.ctx.session.synthetic = async input => {
    calls++;
    entered();
    await new Promise(resolve => { lateReceipt = resolve; });
    return { id: input.id, sessionID: input.sessionID, type: 'synthetic', delivery: 'queue',
      payload: { text: input.text, description: input.description, metadata: input.metadata } };
  };
  const options = { ...f.options, deliveryFactory: args => {
    delivery = createNativeDelivery(args);
    return { ...delivery, start() {} };
  } };
  const runtime = await setupNativePlugin(options);
  t.after(() => { endStream(); lateReceipt?.(); return runtime.dispose(); });
  await runtime.connect('one');
  const inbox = f.states.at(-1).client.inbox, identity = inbox.identity, now = Date.now();
  const envelope = { protocol_version: '1', message_id: randomUUID(), recipient_id: identity.client_id, recipient_sequence: 1,
    sender: { client_id: randomUUID(), client_type: 'pi', name: 'peer', model: { provider: null, id: null, source: 'unknown' }, project: null, metadata_revision: 1 },
    origin: 'broker_agent', authority: 'untrusted_agent_input', content: { type: 'text/plain', text: 'Retain this pending message.' },
    accepted_at: new Date(now).toISOString(), expires_at: new Date(now + 86400000).toISOString(), correlation_id: null, reply_to_message_id: null };
  inbox.accept(envelope);
  const ticking = delivery.tick();
  await submitted;
  endStream();
  await new Promise(resolve => setImmediate(resolve));
  await runtime.dispose();
  await ticking;
  lateReceipt();
  f.ctx.event.subscribe = async function* ({ signal }) {
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  const reloaded = await setupNativePlugin(options);
  t.after(() => reloaded.dispose());
  await reloaded.connect('one');
  const recovered = f.states.at(-1).client.inbox;
  assert.deepEqual(recovered.identity, identity);
  assert.equal(recovered.head().message_id, envelope.message_id);
  assert.equal(recovered.head().state, 'uncertain');
  await delivery.tick();
  assert.equal(calls, 1, 'lost event observation or a late receipt cannot authorize a mutation retry');
  assert.equal(recovered.head().state, 'uncertain');
});
