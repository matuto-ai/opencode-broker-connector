import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeSessionBinding } from '../src/native-delivery.mjs';
import { openNativeInbox } from '../src/native-inbox.mjs';
import { recoverHostAnchor, assertExistingBinding } from '../src/identity-recovery.mjs';
import { loadBrokerReference } from '../src/reference.mjs';
const reference=await loadBrokerReference();
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'psst-identity-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const stored=new Map(),settings={stateDirectory:join(directory,'state'),broker:{url:'https://fixture.invalid/'}};
 const info=id=>({id,projectID:'project',location:{directory},time:{created:1}});
 const options={settings,directory,storage:{get:async k=>stored.get(k),set:async(k,v)=>stored.set(k,v)},session:{get:async({sessionID})=>info(sessionID)}};
 const add=(sessionID,hostID)=>{const binding=nativeSessionBinding(info(sessionID),hostID),inbox=openNativeInbox({reference,settings,binding}),identity=inbox.identity,path=inbox.directory;inbox.close();return{binding,identity,path};};
 return{directory,stored,settings,info,options,add};
}
const absent=id=>Object.assign(new Error('missing'),{_tag:'SessionNotFoundError',sessionID:id});

test('fresh namespace creates one anchor; existing native private files are read without rewriting',async t=>{
 const f=fixture(t),first=await recoverHostAnchor(f.options);assert.equal(await recoverHostAnchor(f.options),first);
 const old=f.add('one',first),snapshot=Object.fromEntries(readdirSync(old.path).map(name=>[name,readFileSync(join(old.path,name))]));
 f.stored.clear();assert.equal(await recoverHostAnchor(f.options),first);
 for(const[name,bytes]of Object.entries(snapshot))assert.deepEqual(readFileSync(join(old.path,name)),bytes);
 const inbox=openNativeInbox({reference,settings:f.settings,binding:old.binding});assert.deepEqual(inbox.identity,old.identity);inbox.close();
});

test('shared installation keeps unrelated native host manifests without blocking a saved or uniquely proven anchor',async t=>{
 const f=fixture(t),own=f.add('own','host-own'),foreign=f.add('foreign','host-foreign');
 f.options.session.get=async({sessionID})=>{if(sessionID==='foreign')throw absent(sessionID);return f.info(sessionID);};
 assert.equal(await recoverHostAnchor(f.options),'host-own');
 f.options.session.get=async()=>{throw new Error('must not probe saved anchor');};
 assert.equal(await recoverHostAnchor(f.options),'host-own');
 assertExistingBinding(f.settings,own.binding);assert.deepEqual(JSON.parse(readFileSync(join(foreign.path,'binding.json'))).identity,foreign.identity);
});

test('ambiguous, unproven and failed native ownership never mint a replacement host or inbox',async t=>{
 for(const mode of ['ambiguous','unknown','changed','partial-changed','empty','archived','child','wrong-not-found']){
  const f=fixture(t);f.add('one','host-one');f.add('two','host-two');const names=readdirSync(f.settings.stateDirectory);
  if(mode==='unknown')f.options.session.get=async()=>{throw new Error('network incomplete');};
  if(mode==='changed'||mode==='partial-changed')f.options.session.get=async({sessionID})=>({...f.info(sessionID),time:{created:mode==='partial-changed'&&sessionID==='one'?1:2}});
  if(mode==='empty')f.options.session.get=async()=>undefined;
  if(mode==='archived')f.options.session.get=async({sessionID})=>({...f.info(sessionID),time:{created:1,archived:2}});
  if(mode==='child')f.options.session.get=async({sessionID})=>({...f.info(sessionID),parentID:'parent'});
  if(mode==='wrong-not-found')f.options.session.get=async()=>{throw absent('different-session');};
  await assert.rejects(()=>recoverHostAnchor(f.options),/identity_recovery_/);assert.equal(f.stored.size,0);assert.deepEqual(readdirSync(f.settings.stateDirectory),names);
 }
});

test('known same-session binding conflict and corrupt private manifests remain fail-closed',async t=>{
 const f=fixture(t),old=f.add('one','host-one');f.add('one','host-two');assert.throws(()=>assertExistingBinding(f.settings,old.binding),/conflict/);
 writeFileSync(join(old.path,'binding.json'),'{');await assert.rejects(()=>recoverHostAnchor(f.options));assert.equal(f.stored.size,0);assert.equal(readFileSync(join(old.path,'binding.json'),'utf8'),'{');
});

test('migration proofs are bounded even when the public API ignores its signal',async t=>{
 const f=fixture(t);for(let i=0;i<12;i++)f.add('session-'+i,'host');let calls=0;
 f.options.session.get=()=>{calls++;return new Promise(()=>{});};const keepAlive=setInterval(()=>{},1000),start=Date.now();
 try{await assert.rejects(()=>recoverHostAnchor(f.options),/incomplete/);}finally{clearInterval(keepAlive);}
 assert.equal(calls,4);assert.ok(Date.now()-start<4000);assert.equal(f.stored.size,0);
});


test('unbound classic journals block fresh identity allocation without altering bytes or an existing proven anchor',async t=>{
 const f=fixture(t),legacy=join(f.settings.stateDirectory,'opencode-old-run');mkdirSync(legacy,{recursive:true,mode:0o700});
 const file=join(legacy,'inbox.sqlite');writeFileSync(file,'unread private journal',{mode:0o600});
 await assert.rejects(()=>recoverHostAnchor(f.options),/identity_legacy_migration_required/);assert.equal(f.stored.size,0);assert.equal(readFileSync(file,'utf8'),'unread private journal');
 f.stored.set('psst-v2-host-id','already-proven');assert.equal(await recoverHostAnchor(f.options),'already-proven');
});


test('conclusively absent native history permits a fresh anchor without rewriting old mailboxes',async t=>{
 const f=fixture(t),old=f.add('old-session','old-host');
 const snapshot=Object.fromEntries(readdirSync(old.path).map(name=>[name,readFileSync(join(old.path,name))]));
 const calls=[];
 f.options.session.get=async({sessionID})=>{calls.push(sessionID);throw absent(sessionID);};
 const fresh=await recoverHostAnchor(f.options);
 assert.notEqual(fresh,old.binding.hostID);assert.deepEqual(calls,['old-session']);
 assert.equal(await recoverHostAnchor(f.options),fresh);assert.deepEqual(calls,['old-session']);
 assert.deepEqual(readdirSync(f.settings.stateDirectory),[old.path.split('/').at(-1)]);
 for(const[name,bytes]of Object.entries(snapshot))assert.deepEqual(readFileSync(join(old.path,name)),bytes);
 const inbox=openNativeInbox({reference,settings:f.settings,binding:old.binding});
 try{assert.deepEqual(inbox.identity,old.identity);}finally{inbox.close();}
});

test('only other directories or workspaces permit a fresh host without probing unrelated history',async t=>{
 for(const scope of ['directory','workspace']){
  const f=fixture(t),old=f.add('foreign','foreign-host');
  if(scope==='directory')f.options.directory=join(f.directory,'other-project');
  else f.options.workspaceID='other-workspace';
  f.options.session.get=async()=>{assert.fail('unrelated native history must not be queried');};
  const host=await recoverHostAnchor(f.options);assert.notEqual(host,old.binding.hostID);
  assert.deepEqual(JSON.parse(readFileSync(join(old.path,'binding.json'))).identity,old.identity);
 }
});

test('classic journals still block fresh allocation when all v2 candidates are positively absent',async t=>{
 const f=fixture(t);f.add('old-native','old-host');
 const legacy=join(f.settings.stateDirectory,'opencode-old-run');mkdirSync(legacy,{mode:0o700});
 writeFileSync(join(legacy,'inbox.sqlite'),'unread classic data',{mode:0o600});
 f.options.session.get=async({sessionID})=>{throw absent(sessionID);};
 await assert.rejects(()=>recoverHostAnchor(f.options),/identity_legacy_migration_required/);
 assert.equal(f.stored.size,0);assert.equal(readFileSync(join(legacy,'inbox.sqlite'),'utf8'),'unread classic data');
});

// Real private manifests and SQLite journals, with a scoped native-API fixture.
// This is binding/persistence coverage, not a real host or container acceptance test.
test('30 concurrently open same-label sessions retain independent addresses and unread journals across host recovery',async t=>{
 const f=fixture(t),hosts=[],opened=new Set();
 t.after(()=>{for(const inbox of opened)inbox.close();});
 const close=inbox=>{inbox.close();opened.delete(inbox);};
 const open=binding=>{const inbox=openNativeInbox({reference,settings:f.settings,binding});opened.add(inbox);return inbox;};
 // Five independent native stores share the same installation and project path;
 // each store contains six independent sessions bearing the same display title.
 for(let h=0;h<5;h++){
  const stored=new Map(),history=new Map(),lookups=[];
  const options={...f.options,storage:{get:async k=>stored.get(k),set:async(k,v)=>stored.set(k,v)},session:{get:async({sessionID})=>{
   lookups.push(sessionID);if(!history.has(sessionID))throw absent(sessionID);return history.get(sessionID);
  }}};
  const hostID=await recoverHostAnchor(options),sessions=[];
  for(let n=0;n<6;n++){
   const info={...f.info(`session-${h}-${n}`),title:'Same session label'};history.set(info.id,info);
   const binding=nativeSessionBinding(info,hostID);assertExistingBinding(f.settings,binding);
   const inbox=open(binding),now=Date.now(),message={protocol_version:'1',message_id:randomUUID(),recipient_id:inbox.identity.client_id,recipient_sequence:1,
    sender:{client_id:randomUUID(),client_type:'pi',name:'same peer',model:{provider:null,id:null,source:'unknown'},project:null,metadata_revision:1},
    origin:'broker_agent',authority:'untrusted_agent_input',content:{type:'text/plain',text:`private message ${h}/${n}`},accepted_at:new Date(now).toISOString(),
    expires_at:new Date(now+86400000).toISOString(),correlation_id:null,reply_to_message_id:null};
   inbox.accept(message);sessions.push({binding,inbox,identity:inbox.identity,message});
  }
  hosts.push({stored,options,hostID,sessions,lookups});
 }
 const sessions=hosts.flatMap(host=>host.sessions);
 assert.equal(opened.size,30);assert.equal(new Set(hosts.map(host=>host.hostID)).size,5);
 assert.equal(new Set(sessions.map(s=>s.identity.client_id)).size,30);
 assert.equal(new Set(sessions.map(s=>s.identity.session_instance_id)).size,30);
 assert.equal(new Set(sessions.map(s=>s.inbox.directory)).size,30);
 for(let i=0;i<sessions.length;i++){
  const own=sessions[i],foreign=sessions[(i+1)%sessions.length];
  assert.throws(()=>own.inbox.accept(foreign.message));
  assert.equal(own.inbox.head().message_id,own.message.message_id);assert.equal(own.inbox.stats().pending_count,1);
  close(own.inbox);
 }
 // Recreate all plugin storage namespaces while retaining native history and
 // shared mailbox files: exact native proofs must recover all five old hosts.
 for(const host of hosts){host.stored.clear();host.lookups.length=0;}
 assert.deepEqual(await Promise.all(hosts.map(host=>recoverHostAnchor(host.options))),hosts.map(host=>host.hostID));
 for(const host of hosts){
  assert.equal(host.lookups.length,30);
  host.options.session.get=async()=>{assert.fail('a saved anchor must not probe native history');};
  assert.equal(await recoverHostAnchor(host.options),host.hostID);
  for(const session of host.sessions){
   assertExistingBinding(f.settings,session.binding);
   const inbox=open(session.binding);assert.deepEqual(inbox.identity,session.identity);
   assert.deepEqual(inbox.head().envelope,session.message);assert.equal(inbox.head().state,'pending');assert.equal(inbox.stats().pending_count,1);
  }
 }
 assert.equal(opened.size,30);assert.equal(readdirSync(f.settings.stateDirectory).length,30);
 for(const inbox of [...opened])close(inbox);
});
