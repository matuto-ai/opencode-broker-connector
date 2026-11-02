import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Tool} from '@opencode/core/tool';
import {Image} from '@opencode/core/image';
import {Permission} from '@opencode/core/permission';
import {PluginHooks} from '@opencode/core/plugin/hooks';
import {AppNodeBuilder} from '@opencode/core/effect/app-node-builder';
import {LayerNode} from '@opencode/util/effect/layer-node';
import {fromPromise} from '@opencode/plugin/promise/adapter';
import {Effect,Layer} from 'effect';
import {setupNativePlugin} from '../src/native-plugin.mjs';
import {tool} from '../src/tool-schema.mjs';
import {loadBrokerReference} from '../src/reference.mjs';
import {httpFixture,registration} from './broker-fixture/test/helpers.mjs';

// Actual official 2.2.5 registry + Promise plugin adapter + CodeMode executor.
// Only unrelated image/permission services are mocked; no CLI/model is installed.
const registryLayer=AppNodeBuilder.build(LayerNode.group([Tool.node,PluginHooks.node]),[
 Image.node.replace(Layer.mock(Image.Service,{normalize:()=>Effect.die('unexpected image')})),
 Permission.node.replace(Layer.mock(Permission.Service,{close:Effect.void})),
]);

test('official CodeMode-enabled catalog routes send/resend directly while other broker tools execute inside CodeMode',async t=>{
 const f=await httpFixture(t),root=mkdtempSync(join(tmpdir(),'psst-codemode-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const tokenFile=join(root,'token');writeFileSync(tokenFile,f.b.token,{mode:0o600});const reference=await loadBrokerReference(),stored=new Map(),tools=new Map(),calls=new Map(),clients=[];
 const ctx={app:{version:'2.2.5'},location:{directory:root},storage:{get:async k=>stored.get(k),set:async(k,v)=>stored.set(k,v),scan:async({prefix})=>({entries:[...stored].filter(([k])=>k.startsWith(prefix)).map(([key,value])=>({key,value}))})},
  session:{get:async({sessionID})=>({id:sessionID,projectID:'project',location:{directory:root},time:{created:1}}),synthetic:async()=>{throw Error('unexpected synthetic');},context:async()=>[{id:'msg',type:'assistant',content:[...calls].map(([id,{name,at}])=>({id,name,type:'tool',time:{created:at}}))}],hook:async()=>({dispose:async()=>{}})},
  tool:{transform:async cb=>{cb({get:n=>tools.get(n),add:d=>tools.set(d.name,d)});return{dispose:async()=>tools.clear()};}},event:{async *subscribe({signal}){if(signal.aborted)return;await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}}};
 const settings={stateDirectory:join(root,'state'),broker:{url:f.base,tokenFile,insecureDevelopment:true}};
 const options={presenceFactory:()=>({selected:()=>({has:()=>true})}),ctx,reference,tool,setupOptions:{directory:join(root,'installation')},setupEnabled:false,loadSettings:async()=>settings,deliveryFactory:()=>({start(){},stop:async()=>{},event(){}}),clientFactory:inbox=>{inbox.now=()=>f.now;const client=new reference.BrokerClient({...settings.broker,inbox,now:()=>f.now,maxAttempts:1});clients.push(client);return client;}};
 let runtime=await setupNativePlugin(options);t.after(()=>runtime.dispose());await runtime.connect('native');
 const peers=[registration('pi'),registration('claude-code'),registration('antigravity-cli')];for(const peer of peers)assert.equal((await f.request('/v1/sessions',{method:'POST',body:peer})).status,200);
 const run=callback=>Effect.runPromise(Effect.gen(function*(){
   const registry=yield*Tool.Service;
   // The official Promise bridge receives the same definitions/options registered
   // by our native plugin. Unused host domains are deliberately inert fixture APIs.
   const unused=new Proxy(()=>Effect.void,{get:()=>unused});
   const host=new Proxy({tool:registry,app:ctx.app,location:ctx.location},{get:(target,key)=>key in target?target[key]:unused});
   yield*fromPromise({id:'fixture.registry',setup:async promiseCtx=>{await promiseCtx.tool.transform(editor=>{for(const definition of tools.values())editor.add(definition);});}}).effect(host);
   const snapshot=yield*registry.snapshot([]); // CodeMode enabled; no permission changes.
   return yield*Effect.promise(()=>callback(snapshot));
 }).pipe(Effect.scoped,Effect.provide(registryLayer)));
 const invoke=(snapshot,id,name,input)=>Effect.runPromise(snapshot.execute({sessionID:'native',agent:'build',messageID:'msg',call:{type:'tool-call',id,name,input}}));
 const json=result=>JSON.parse(result.content.find(c=>c.type==='text').text);
 let accepted;
 await run(async snapshot=>{
   assert.deepEqual(snapshot.definitions.map(x=>x.name).sort(),['broker_resend','broker_send','execute']);
   const catalog=JSON.stringify(snapshot.codeModeCatalog);assert.match(catalog,/broker_list_clients/);assert.doesNotMatch(catalog,/broker_send|broker_resend/);
   calls.set('list-wrapper',{name:'execute',at:f.now});
   const listed=await invoke(snapshot,'list-wrapper','execute',{code:'return await tools.broker_list_clients({})'});assert.equal(listed.output.error,undefined);const listedIDs=new Set(JSON.parse(listed.output.output).clients.map(c=>c.client_id));for(const peer of peers)assert.ok(listedIDs.has(peer.client_id));
   const body={recipient_id:peers[0].client_id,text:'same intentional text'};
   calls.set('first',{name:'broker_send',at:f.now});accepted=json(await invoke(snapshot,'first','broker_send',body));assert.ok(accepted.message_id);
   const previousGet=ctx.session.get;ctx.session.get=async args=>({...await previousGet(args),model:{providerID:'fixture-provider',id:'changed-native'}});
   const ids=['parallel-same','parallel-other','parallel-third'];for(const id of ids)calls.set(id,{name:'broker_send',at:f.now});
   const parallel=await Promise.all(ids.map((id,index)=>invoke(snapshot,id,'broker_send',{...body,recipient_id:peers[index].client_id}).then(json)));
   assert.equal(new Set([accepted,...parallel].map(x=>x.message_id)).size,4);assert.deepEqual(clients.at(-1).inbox.getState('metadata').model,{provider:'fixture-provider',id:'changed-native',source:'observed'});for(const result of parallel)assert.ok(result.message_id,JSON.stringify(result));
   assert.equal(json(await invoke(snapshot,'first','broker_send',{...body,text:'changed'})).error.code,'send_conflict');
   calls.set('bad-wrapper',{name:'execute',at:f.now});const rejected=await invoke(snapshot,'bad-wrapper','execute',{code:`return await tools.broker_send(${JSON.stringify(body)})`});assert.equal(rejected.output.error,true);assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,4);
   // A stale wrapper executor must still not invent a child timestamp/ID.
   assert.equal(JSON.parse((await tools.get('broker_send').execute(body,{sessionID:'native',messageID:'msg',id:'bad-wrapper',signal:new AbortController().signal})).content).error.code,'session_mismatch');
 });
 await runtime.dispose();runtime=await setupNativePlugin(options);await runtime.connect('native');
 await run(async snapshot=>{
   const body={recipient_id:peers[0].client_id,text:'same intentional text'};
   assert.equal(json(await invoke(snapshot,'first','broker_send',body)).message_id,accepted.message_id);
   calls.set('resend',{name:'broker_resend',at:f.now});const resent=json(await invoke(snapshot,'resend','broker_resend',{message_id:accepted.message_id}));assert.ok(resent.message_id,JSON.stringify(resent));assert.equal(json(await invoke(snapshot,'resend','broker_resend',{message_id:accepted.message_id})).message_id,resent.message_id);
   f.advance(86400001);assert.ok(clients.at(-1).inbox.collect().removed_sends>=5);
   assert.equal(json(await invoke(snapshot,'first','broker_send',body)).error.code,'retry_window_elapsed');
   assert.equal(f.store.db.prepare('SELECT count(*) n FROM messages').get().n,5);
 });
});
