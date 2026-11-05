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
 const stored=new Map(),tools=new Map(),hooks=new Map(),states=[],rpc=new Map();
 const settings={stateDirectory:join(dir,'state'),broker:{url:'https://fixture.invalid/'}};
 const ctx={app:{version:'2.2.5'},location:{directory:dir},storage:{get:async k=>stored.get(k),set:async(k,v)=>stored.set(k,v),scan:async({prefix})=>({entries:[...stored].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value}))})},
  session:{get:async({sessionID})=>({id:sessionID,projectID:'project',location:{directory:dir},time:{created:1}}),synthetic:async()=>{},context:async()=>[{id:'msg',type:'assistant',content:['call1','call2'].map(id=>({type:'tool',id,name:'broker_send',time:{created:Date.now()-1000}})),time:{created:Date.now()-1000}}],hook:async(name,fn)=>{hooks.set(name,fn);return{dispose:async()=>hooks.delete(name)};}},
  rpc:{register:async(definition,handlers)=>{rpc.set(definition.id,handlers);return{dispose:async()=>rpc.delete(definition.id)};}},
  tool:{transform:async callback=>{callback({get:name=>tools.get(name),add:definition=>tools.set(definition.name,definition)});return{dispose:async()=>tools.clear()};}},
  event:{async *subscribe({signal}){if(signal.aborted)return;await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}}};
 const options={presenceFactory:()=>({selected:()=>({has:()=>true})}),ctx,reference,tool,setupOptions:{directory:join(dir,'installation')},setupEnabled:false,loadSettings:async()=>settings,clientFactory:inbox=>({inbox}),
  adapterFactory:({client,binding,currentBinding,operationContext})=>{
   const state={identity:client.inbox.identity,binding,currentBinding,operationContext,client};states.push(state);
   return{start:async()=>assert.ok(await currentBinding()),stop:async()=>client.inbox.close(),tools:Object.fromEntries(reference.TOOL_DEFINITIONS.map(d=>[d.name,{execute:async(args,context)=>JSON.stringify({sessionID:binding.sessionID,operation:operationContext(context)})}]))};},
  deliveryFactory:()=>({start(){},stop:async()=>{},event(){}})};
 const runtime=await setupNativePlugin(options);t.after(()=>runtime.dispose());return{dir,ctx,tools,hooks,states,runtime,settings,stored,options,rpc:()=>rpc.get('matuto.psst.setup')};
}
test('native connect/disconnect preserve the mailbox and remain disconnected across reload', async t => {
 const f=await fixture(t), context={signal:new AbortController().signal}, input={sessionID:'one'};
 await f.runtime.connect('one'); await f.runtime.connect('two');
 const identity=f.runtime.status('one').client_id, inbox=f.states[0].client.inbox, now=Date.now();
 const envelope={protocol_version:'1',message_id:randomUUID(),recipient_id:identity,recipient_sequence:1,
  sender:{client_id:randomUUID(),client_type:'pi',name:'peer',model:{provider:null,id:null,source:'unknown'},project:null,metadata_revision:1},
  origin:'broker_agent',authority:'untrusted_agent_input',content:{type:'text/plain',text:'Keep this unread message.'},
  accepted_at:new Date(now).toISOString(),expires_at:new Date(now+86400000).toISOString(),correlation_id:null,reply_to_message_id:null};
 inbox.accept(envelope);
 const disconnected=await f.rpc().disconnect(input,context);
 assert.equal(disconnected.disconnected,true); assert.equal(disconnected.connected,false);
 assert.equal(f.runtime.status('two').connected,true);
 await f.hooks.get('prompt')({sessionID:'one'});
 await assert.rejects(f.runtime.connect('one'),/closed/);
 await f.runtime.dispose();
 const reloaded=await setupNativePlugin(f.options);t.after(()=>reloaded.dispose());
 assert.equal(reloaded.status('one').disconnected,true);assert.equal(reloaded.status('one').connected,false);
 await assert.rejects(reloaded.connect('one'),/closed/);
 const connected=await f.rpc().connect(input,context);
 assert.equal(connected.connected,true);assert.equal(connected.disconnected,false);assert.equal(connected.client_id,identity);
 assert.deepEqual(f.states.at(-1).client.inbox.head().envelope,envelope);
 const count=f.states.length;await f.rpc().connect(input,context);assert.equal(f.states.length,count,'already connected is a no-op');
 await reloaded.dispose();
 const again=await setupNativePlugin(f.options);t.after(()=>again.dispose());
 await again.connect('one');assert.equal(again.status('one').client_id,identity,'successful resume durably clears disconnect');
});

test('disconnect pauses only this chat setup and reconnect does not enroll or resume the wait', async t => {
 const {readPending}=await import('../src/installation.mjs');
 const f=await fixture(t);await f.runtime.dispose();let begins=0;
 const pending={state:'pending',requestId:'same-request'};
 const runtime=await setupNativePlugin({...f.options,setupEnabled:true,setupOptions:{...f.options.setupOptions,
  loadHelper:async()=>({readApprovalState:()=>pending,beginApproval:async()=>{begins++;return pending;},pollApproval:async()=>pending})
 }});t.after(()=>runtime.dispose());
 const context={signal:new AbortController().signal},input={sessionID:'one'};
 await f.rpc().setup({...input,broker_url:'https://fixture.invalid'},context);assert.equal(begins,1);
 await f.rpc().disconnect(input,context);assert.equal(readPending(f.options.setupOptions.directory).paused,true);
 const stopped=await f.rpc().setup({...input,broker_url:'https://fixture.invalid'},context);
 assert.equal(stopped.disconnected,true);assert.equal(begins,1);
 await f.rpc().connect(input,context);assert.equal(begins,1);assert.equal(readPending(f.options.setupOptions.directory).paused,true);
});

test('native connection commands reject inactive, foreign and cancelled contexts without changing access', async t => {
 const f=await fixture(t),context={signal:new AbortController().signal};await f.runtime.connect('one');
 const before=[...f.stored],original=f.ctx.session.get;
 f.ctx.session.get=async({sessionID})=>({id:sessionID,projectID:'foreign',location:{directory:'/tmp'},time:{created:1}});
 for(const name of ['connect','disconnect']) await assert.rejects(f.rpc()[name]({sessionID:'one'},context),/mismatch/);
 f.ctx.session.get=original;
 for(const name of ['connect','disconnect']) await assert.rejects(f.rpc()[name]({sessionID:'one'},{signal:AbortSignal.abort()}));
 assert.deepEqual([...f.stored],before);assert.equal(f.runtime.status('one').connected,true);
 await f.runtime.dispose();
 const runtime=await setupNativePlugin({...f.options,presenceFactory:()=>({selected:()=>new Set()})});t.after(()=>runtime.dispose());
 for(const name of ['connect','disconnect']) await assert.rejects(f.rpc()[name]({sessionID:'one'},context),/not_selected/);
 assert.deepEqual([...f.stored],before);
});

test('failed explicit reconnect retains the durable disconnect and never starts setup', async t => {
 const f=await fixture(t),context={signal:new AbortController().signal},input={sessionID:'one'};
 await f.runtime.connect('one');await f.rpc().disconnect(input,context);await f.runtime.dispose();
 const runtime=await setupNativePlugin({...f.options,loadSettings:async options=>{if(options)return f.settings;throw Error('credential_expired');}});t.after(()=>runtime.dispose());
 await assert.rejects(f.rpc().connect(input,context),/credential_expired/);
 assert.equal(runtime.status('one').disconnected,true);
 assert.equal([...f.stored.values()].find(v=>v?.sessionID==='one').reason,'disconnected');
 assert.equal(f.states.length,1);assert.equal(f.tools.has('broker_setup'),false);
});

test('connect without saved authorization enables setup but never enrolls', async t => {
 const f=await fixture(t),context={signal:new AbortController().signal},input={sessionID:'one'};
 await f.rpc().disconnect(input,context);await f.runtime.dispose();
 const runtime=await setupNativePlugin({...f.options,loadSettings:async()=>undefined});t.after(()=>runtime.dispose());
 const result=await f.rpc().connect(input,context);
 assert.equal(result.state,'setup_needed');assert.equal(result.connected,false);assert.equal(result.disconnected,false);assert.equal(f.states.length,0);
});

test('disconnect drains transport even if persisting the stop fails', async t => {
 const f=await fixture(t),context={signal:new AbortController().signal};await f.runtime.connect('one');
 const set=f.ctx.storage.set;f.ctx.storage.set=async(k,v)=>{if(v.reason==='disconnected')throw Error('storage unavailable');return set(k,v);};
 await assert.rejects(f.rpc().disconnect({sessionID:'one'},context),/storage unavailable/);
 assert.equal(f.runtime.status('one').connected,false);assert.equal(f.runtime.status('one').disconnected,true);
 assert.equal(await f.states[0].currentBinding(),null);await assert.rejects(f.runtime.connect('one'),/closed/);
});

test('disconnect cancels an in-flight explicit connect before allowing another connection command', async t => {
 const f=await fixture(t);await f.runtime.dispose();let entered;
 const ready=new Promise(resolve=>{entered=resolve;});
 const runtime=await setupNativePlugin({...f.options,adapterFactory:args=>({ ...f.options.adapterFactory(args),
  start:async()=>{entered();await new Promise(resolve=>args.binding.signal.addEventListener('abort',resolve,{once:true}));throw Error('connection cancelled');}
 })});t.after(()=>runtime.dispose());
 const context={signal:new AbortController().signal},input={sessionID:'one'};
 const connecting=f.rpc().connect(input,context);const rejected=assert.rejects(connecting,/cancelled/);await ready;
 const result=await f.rpc().disconnect(input,context);await rejected;
 assert.equal(result.disconnected,true);assert.equal(result.connected,false);
 await assert.rejects(runtime.connect('one'),/closed/);
});

test('archive and unarchive cannot clear a durable explicit disconnect', async t => {
 const {EventEmitter,on}=await import('node:events');
 const f=await fixture(t);await f.runtime.dispose();const emitter=new EventEmitter();
 f.ctx.event.subscribe=async function*({signal}){for await(const [event] of on(emitter,'event',{signal}))yield event;};
 const runtime=await setupNativePlugin(f.options);t.after(()=>runtime.dispose());await runtime.connect('one');
 await f.rpc().disconnect({sessionID:'one'},{signal:new AbortController().signal});
 const key=[...f.stored.keys()].find(k=>k.startsWith('psst-v2-session:'));
 for(const type of ['session.archived','session.unarchived']) {
  emitter.emit('event',{type,data:{sessionID:'one'}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.stored.get(key).enabled,false);assert.equal(f.stored.get(key).reason,'disconnected');
 }
 await runtime.dispose();const next=await setupNativePlugin(f.options);t.after(()=>next.dispose());
 assert.equal(next.status('one').disconnected,true);await assert.rejects(next.connect('one'),/closed/);
});

test('explicit reconnect cannot lift unknown disabled-session tombstones', async t => {
 const f=await fixture(t);await f.runtime.connect('one');await f.runtime.dispose();
 const key=[...f.stored.keys()].find(k=>k.startsWith('psst-v2-session:'));f.stored.set(key,{sessionID:'one',enabled:false});
 const runtime=await setupNativePlugin(f.options);t.after(()=>runtime.dispose());
 for(const name of ['connect','disconnect']) await assert.rejects(f.rpc()[name]({sessionID:'one'},{signal:new AbortController().signal}),/closed/);
 assert.deepEqual(f.stored.get(key),{sessionID:'one',enabled:false});assert.equal(f.states.length,1);
});

test('OpenCode registers automatic-only lifecycle tools, preserves drafts and isolates native session identities',async t=>{
 const f=await fixture(t);assert.equal(f.tools.size,8);assert.equal(f.tools.has('broker_receive'),false);assert.equal(f.tools.has('broker_acknowledge'),false);
 const prompt={sessionID:'one',messageID:'human',prompt:{text:'keep my draft'}};await f.hooks.get('prompt')(prompt);await f.runtime.connect('one');await f.runtime.connect('two');assert.equal(f.states.length,2);assert.notEqual(f.states[0].identity.client_id,f.states[1].identity.client_id);assert.equal(prompt.prompt.text,'keep my draft');
});
test('native reauthorization RPC checks endpoint without granting model replacement authority',async t=>{
 const {mkdirSync,readFileSync}=await import('node:fs');
 const {readPending,readSelection}=await import('../src/installation.mjs');
 const {SETUP_RPC}=await import('../src/setup-rpc.mjs');
 const f=await fixture(t);await f.runtime.dispose();
 const directory=f.options.setupOptions.directory,connectionFile=candidateFile(f,'old');
 mkdirSync(directory,{mode:0o700,recursive:true});
 writeFileSync(join(directory,'installation.json'),JSON.stringify({format:'psst-opencode-installation-v1',revision:'old-revision',connectionFile}),{mode:0o600});
 const oldSelection=readFileSync(join(directory,'installation.json'));
 let handlers,begins=0,saved={state:'revoked',requestId:'old'};
 f.ctx.rpc={register:async(definition,methods)=>{assert.equal(definition,SETUP_RPC);handlers=methods;return{dispose:async()=>{}};}};
 const runtime=await setupNativePlugin({...f.options,setupEnabled:true,presenceFactory:()=>({selected:()=>new Set(['one'])}),setupOptions:{directory,
  loadHelper:async()=>({readApprovalState:()=>saved,beginApproval:async options=>{begins++;assert.equal(options.brokerUrl,'https://fixture.invalid/');assert.equal(options.replaceRequestId,'old');return saved={state:'pending',requestId:'new'};},pollApproval:async()=>saved})
 }});t.after(()=>runtime.dispose());
 const context={signal:new AbortController().signal};
 const input={sessionID:'one',broker_url:'https://different.invalid',reauthorize:true,replacement_confirmed:true,replacement_request_id:'old',selection_revision:'old-revision'};
 const mismatch=await handlers.setup(input,context);
 assert.equal(mismatch.code,'broker_endpoint_mismatch');assert.equal(begins,0);assert.equal(readPending(directory),null);
 assert.deepEqual(readFileSync(join(directory,'installation.json')),oldSelection);
 await assert.rejects(()=>handlers.setup({...input,sessionID:'foreign'},context),/native_session_not_selected/);
 const matching={...input,broker_url:'https://fixture.invalid'};
 const stale=await handlers.setup({...matching,selection_revision:'stale-revision'},context);
 assert.equal(stale.state,'setup_blocked');assert.equal(begins,0);assert.equal(readPending(directory),null);
 const changed=await handlers.setup({...matching,replacement_request_id:'changed'},context);
 assert.equal(changed.replacement_confirmation_required,true);assert.equal(begins,0);
 const cancelled=await handlers.setup(matching,{signal:AbortSignal.abort()});
 assert.equal(cancelled.state,'setup_blocked');assert.equal(begins,0);assert.equal(readPending(directory),null);
 const unconfirmed=await handlers.setup({...matching,replacement_confirmed:false},context);
 assert.equal(unconfirmed.replacement_confirmation_required,true);assert.equal(begins,0);
 const initialOnly=await f.tools.get('broker_setup').execute({broker_url:matching.broker_url},{sessionID:'one',signal:context.signal});
 assert.equal(JSON.parse(initialOnly.content).replacement_confirmation_required,true);assert.equal(begins,0);
 const model=await f.tools.get('broker_setup').execute({broker_url:matching.broker_url,reauthorize:true},{sessionID:'one',signal:context.signal});
 assert.equal(JSON.parse(model.content).state,'setup_blocked');assert.equal(begins,0);
 assert.equal((await handlers.setup(matching,context)).request_id,'new');
 assert.equal((await handlers.setup(matching,context)).request_id,'new');assert.equal(begins,1);
 await handlers.cancel({sessionID:'one'},context);assert.equal(readPending(directory).paused,true);
 assert.equal(readSelection(directory).connectionFile,connectionFile);
 assert.deepEqual(readFileSync(join(directory,'installation.json')),oldSelection);
});

test('native reauthorization command keeps RPC fences and recovers lost replies and failed attachment without dialogs', async t => {
 const { mkdirSync, readFileSync } = await import('node:fs');
 const { readPending, readSelection } = await import('../src/installation.mjs');
 const { presenceDirectory } = await import('../src/active-presence.mjs');
 const { SETUP_RPC } = await import('../src/setup-rpc.mjs');
 const { default: tui } = await import('../plugin/tui.mjs');
 const f = await fixture(t); await f.runtime.dispose();
 const directory = f.options.setupOptions.directory, oldFile = candidateFile(f, 'old'), candidate = candidateFile(f);
 mkdirSync(directory, { mode: 0o700, recursive: true });
 writeFileSync(join(directory, 'installation.json'), JSON.stringify({ format: 'psst-opencode-installation-v1', revision: 'old-revision', connectionFile: oldFile }), { mode: 0o600 });
 const selectionBefore = readFileSync(join(directory, 'installation.json')), tokenBefore = readFileSync(join(f.dir, 'old.token'));
 let handlers, saved = { state: 'revoked', requestId: 'old' }, replacements = 0, failAttachment = false;
 f.ctx.rpc = { register: async (definition, methods) => { assert.equal(definition, SETUP_RPC); handlers = methods; return { dispose: async () => {} }; } };
 const runtime = await setupNativePlugin({ ...f.options, setupEnabled: true,
  adapterFactory: args => {
   const adapter = f.options.adapterFactory(args);
   return { ...adapter, start: async metadata => { if (failAttachment) { failAttachment = false; throw Error('candidate_unavailable'); } await adapter.start(metadata); } };
  },
  setupOptions: { directory, loadHelper: async () => ({
   readApprovalState: () => saved, pollApproval: async () => saved,
   beginApproval: async options => {
    if (options.replaceRequestId) { assert.equal(options.replaceRequestId, 'old'); replacements++; saved = { state: 'pending', requestId: 'new' }; }
    return saved;
   },
  }) },
 });
 t.after(() => runtime.dispose());
 await runtime.connect('one'); const original = runtime.status('one').client_id;
 const oldJournal = f.states[0].client.inbox.directory, oldBinding = readFileSync(join(oldJournal, 'binding.json'));
 const prior = process.env.PSST_OPENCODE_CONFIG_DIR;
 process.env.PSST_OPENCODE_CONFIG_DIR = directory;
 t.after(() => { if (prior === undefined) delete process.env.PSST_OPENCODE_CONFIG_DIR; else process.env.PSST_OPENCODE_CONFIG_DIR = prior; });
 presenceDirectory(directory, f.ctx.location, { create: true });
 let commands, denied = true, loseReply = true;
 const toasts = [], setupInputs = [];
 const stop = tui.setup({ app: f.ctx.app, location: f.ctx.location,
  storage: { memory: (_key, { initial }) => [initial, mutate => mutate(initial)] },
  keymap: { layer: factory => { commands = factory().commands; } },
  ui: { router: { current: () => ({ type: 'session', sessionID: 'one' }) }, toast: { show: toast => toasts.push(toast) },
   dialog: { prompt: () => assert.fail('Explicit endpoint needs no prompt'), confirm: () => assert.fail('Command intent needs no confirmation') } },
  client: { rpc: definition => {
   assert.equal(definition, SETUP_RPC);
   return Object.fromEntries(['status', 'setup', 'cancel'].map(name => [name, async (input, options) => {
    if (denied && name === 'setup') throw Error('host_permission_denied');
    if (name === 'setup') setupInputs.push(input);
    const result = await handlers[name](input, { signal: options.signal });
    if (name === 'setup' && loseReply) { loseReply = false; throw Error('reply_lost'); }
    return result;
   }]));
  } },
 });
 t.after(stop);
 const reauthorize = () => commands.find(command => command.id === 'psst-reauthorize').run('https://fixture.invalid');
 await reauthorize(); assert.equal(replacements, 0); assert.equal(readPending(directory), null);
 denied = false;
 await reauthorize(); assert.equal(replacements, 1); assert.match(toasts.at(-1).message, /request=unknown/);
 assert.equal(setupInputs[0].replacement_request_id, 'old'); assert.equal(setupInputs[0].selection_revision, 'old-revision');
 assert.equal(setupInputs[0].replacement_confirmed, true);
 await reauthorize(); assert.equal(replacements, 1); assert.equal(readPending(directory).requestId, 'new');
 assert.equal(setupInputs.at(-1).replacement_confirmed, undefined);
 assert.deepEqual(readFileSync(join(directory, 'installation.json')), selectionBefore);
 await commands.find(command => command.id === 'psst-cancel-setup').run(); assert.equal(readPending(directory).paused, true);
 saved = { state: 'approved', requestId: 'new', connectionFile: candidate }; failAttachment = true;
 await reauthorize(); assert.equal(runtime.status('one').client_id, original); assert.equal(readPending(directory).paused, true);
 assert.deepEqual(readFileSync(join(directory, 'installation.json')), selectionBefore);
 assert.match(toasts.at(-1).message, /approved candidate is not connected yet/);
 await reauthorize(); assert.equal(replacements, 1); assert.equal(readSelection(directory).connectionFile, candidate);
 assert.notEqual(runtime.status('one').client_id, original); assert.equal(runtime.status('one').connected, true);
 assert.equal(readPending(directory).requestId, 'new');
 assert.deepEqual(readFileSync(join(f.dir, 'old.token')), tokenBefore);
 assert.deepEqual(readFileSync(join(oldJournal, 'binding.json')), oldBinding);
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


test('doctor inspects cached storage roles without reconnecting, reading configuration again or changing state', async t => {
 const f=await fixture(t);await f.runtime.dispose();let reads=0,fail=false;
 const runtime=await setupNativePlugin({...f.options,loadSettings:async()=>{reads++;if(fail)throw Error('doctor must not load configuration');return f.settings;}});t.after(()=>runtime.dispose());
 const before=[...f.stored],priorReads=reads;fail=true;
 const result=await f.rpc().doctor({sessionID:'one'},{signal:new AbortController().signal});
 assert.equal(result.connector_version,'0.8.0');assert.equal(result.host_version,'2.2.5');assert.equal(result.node_version,process.versions.node);
 assert.ok(result.checks.some(check=>check.role==='state_directory'));assert.equal(reads,priorReads);assert.equal(f.states.length,0);assert.deepEqual([...f.stored],before);
 assert.doesNotMatch(JSON.stringify(result),/tokenFile|stateDirectory|\/tmp\//);
 await assert.rejects(f.rpc().doctor({sessionID:'one'},{signal:AbortSignal.abort()}));
 const original=f.ctx.session.get;f.ctx.session.get=async()=>{throw Error('foreign native context');};
 await assert.rejects(f.rpc().doctor({sessionID:'one'},{signal:new AbortController().signal}));f.ctx.session.get=original;
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
