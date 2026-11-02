import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '../src/tool-schema.mjs';
import { setupNativePlugin } from '../src/native-plugin.mjs';
import { openNativeInbox } from '../src/native-inbox.mjs';
import { loadBrokerReference } from '../src/reference.mjs';
const [i,c,r,ts,st,e]=await Promise.all(['inbox','client','runtime','tools','mcp-stdio','errors'].map(n=>import('../vendor/broker/reference/'+n+'.mjs')));
const reference={Inbox:i.Inbox,newSessionIdentity:i.newSessionIdentity,BrokerClient:c.BrokerClient,AdapterRuntime:r.AdapterRuntime,createTools:ts.createTools,invokeTool:ts.invokeTool,TOOL_DEFINITIONS:st.TOOL_DEFINITIONS,LocalError:e.LocalError,safeError:e.safeError};
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

test('v2 real HTTP native plugin rebuilds expired selected conversation and reloads new journal without replay',async t=>{
 const {httpFixture}=await import('./broker-v2-fixture/test/helpers.mjs');
 const base='../vendor/broker/reference/';
 const [i,c,r,tools,errors]=await Promise.all(['inbox.mjs','client.mjs','runtime.mjs','tools.mjs','errors.mjs'].map(p=>import(base+p)));
 const sdk={...reference,Inbox:i.Inbox,newSessionIdentity:i.newSessionIdentity,BrokerClient:c.BrokerClient,AdapterRuntime:r.AdapterRuntime,createTools:tools.createTools,invokeTool:tools.invokeTool,LocalError:errors.LocalError,safeError:errors.safeError};
 const broker=await httpFixture(t,{requireRegistrationV2:true,limits:{session_retention_seconds:172800}}),f=await fixture(t);await f.runtime.dispose();
 const tokenFile=join(f.dir,'token');writeFileSync(tokenFile,broker.b.token,{mode:0o600});f.settings.broker={url:broker.base,tokenFile,insecureDevelopment:true,registrationVersion:2};
 const clients=[];const options={...f.options,reference:sdk,presenceFactory:()=>({selected:()=>new Set(['one'])}),clientFactory:inbox=>{const client=new c.BrokerClient({...f.settings.broker,inbox,now:()=>broker.now});clients.push(client);return client;}};delete options.adapterFactory;delete options.deliveryFactory;
 const first=await setupNativePlugin(options);await first.connect('one');const old=first.status('one').client_id,oldDirectory=clients.at(-1).inbox.directory;
 const originalCallAt=broker.now;
 const oldInbox=clients.at(-1).inbox;oldInbox.db.prepare('INSERT INTO v2_state VALUES(?,?)').run('uncertain_probe',JSON.stringify({native_id:'pending-old'}));
 await first.dispose();broker.advance(172800000);broker.store.sweep();
 const second=await setupNativePlugin(options);t.after(()=>second.dispose());await second.connect('one');const fresh=second.status('one').client_id;assert.ok(fresh);assert.notEqual(fresh,old);assert.equal(second.status('one').connected,true);
 assert.notEqual(clients.at(-1).inbox.directory,oldDirectory);assert.equal(clients.at(-1).inbox.db.prepare("SELECT value FROM v2_state WHERE key='uncertain_probe'").get(),undefined);
 // A resumed old native tool call must not become a new operation merely
 // because retention selected an empty replacement journal.
 const replacement=clients.at(-1);let outgoingRequests=0;
 for(const method of ['sendPrepared','resendPrepared']){const original=replacement[method].bind(replacement);replacement[method]=(...args)=>{outgoingRequests++;return original(...args);};}
 f.ctx.session.context=async()=>[{id:'old-msg',type:'assistant',content:[{type:'tool',id:'old-send',name:'broker_send',time:{created:originalCallAt}},{type:'tool',id:'old-resend',name:'broker_resend',time:{created:originalCallAt}}]}];
 for(const [name,id,args] of [['broker_send','old-send',{recipient_id:fresh,text:'must not replay'}],['broker_resend','old-resend',{message_id:fresh}]]){
   const result=JSON.parse((await f.tools.get(name).execute(args,{sessionID:'one',messageID:'old-msg',id,signal:new AbortController().signal})).content);
   assert.equal(result.error.code,'retry_window_elapsed');
 }
 assert.equal(outgoingRequests,0);assert.equal(replacement.inbox.db.prepare('SELECT count(*) n FROM outgoing').get().n,0);

 await second.dispose();const third=await setupNativePlugin(options);t.after(()=>third.dispose());await third.connect('one');assert.equal(third.status('one').client_id,fresh);
});

for(const failure of ['rename','child-fsync','helper-storage']) test(`pointer ${failure} uncertainty blocks automatic restore rather than allocating on every selection tick`,async t=>{
 const {httpFixture}=await import('./broker-v2-fixture/test/helpers.mjs');const {mkdirSync,readdirSync}=await import('node:fs');
 const broker=await httpFixture(t,{requireRegistrationV2:true,limits:{session_retention_seconds:172800}}),f=await fixture(t);await f.runtime.dispose();
 const tokenFile=join(f.dir,'token');writeFileSync(tokenFile,broker.b.token,{mode:0o600});f.settings.broker={url:broker.base,tokenFile,insecureDevelopment:true,registrationVersion:2};
 const clients=[],options={...f.options,reference,presenceFactory:()=>({selected:()=>new Set(['one'])}),clientFactory:inbox=>{const client=new reference.BrokerClient({...f.settings.broker,inbox,now:()=>broker.now});clients.push(client);return client;}};delete options.adapterFactory;delete options.deliveryFactory;
 const first=await setupNativePlugin(options);await first.connect('one');const root=clients.at(-1).inbox.directory;await first.dispose();broker.advance(172800000);broker.store.sweep();
 if(failure==='helper-storage'){const factory=options.clientFactory;options.clientFactory=inbox=>{const client=factory(inbox);client.createReplacementInbox=async({directory})=>{mkdirSync(directory,{mode:0o700});throw Object.assign(new Error('injected partial journal'),{code:'storage_unavailable'});};return client;};}
 const nativeGet=f.ctx.session.get;let calls=0;f.ctx.session.get=async args=>{if(++calls===2&&failure==='rename')mkdirSync(join(root,'current-incarnation.json'));return nativeGet(args);};
 const fs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module');const original=fs.fsyncSync;let faulted=false;
 if(failure==='child-fsync'){fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory()){faulted=true;throw Object.assign(new Error('injected child fsync error'),{code:'EIO'});}return original(fd);};syncBuiltinESMExports();}
 const restore=()=>{fs.fsyncSync=original;syncBuiltinESMExports();};t.after(restore);
 const second=await setupNativePlugin(options);restore();if(failure==='child-fsync')assert.equal(faulted,true);t.after(()=>second.dispose());await assert.rejects(second.connect('one'),/native_plugin_closed/);
 const directories=()=>readdirSync(root).filter(n=>n.startsWith('incarnation-'));assert.equal(directories().length,1);await new Promise(r=>setTimeout(r,1100));assert.equal(directories().length,1);assert.equal(broker.store.db.prepare('SELECT count(*) n FROM sessions').get().n,0);
});
test('native catalog deliberately omits reviewed presence tools and rejects every unknown addition',async()=>{
 const {nativeToolDefinitions}=await import('../src/opencode-adapter.mjs');assert.equal(nativeToolDefinitions(reference.TOOL_DEFINITIONS).length,9);assert.throws(()=>nativeToolDefinitions([...reference.TOOL_DEFINITIONS,{name:'unreviewed_extra'}]),/catalog changed/);
});
