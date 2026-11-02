import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {httpFixture,registration} from './broker-v2-fixture/test/helpers.mjs';
import {Inbox,newSessionIdentity} from '../vendor/broker/reference/inbox.mjs';
import {BrokerClient} from '../vendor/broker/reference/client.mjs';
import {openNativeIncarnation} from '../src/native-incarnation.mjs';
import {openNativeInbox} from '../src/native-inbox.mjs';
import {nativeSessionBinding} from '../src/native-delivery.mjs';
const reference={Inbox,newSessionIdentity,BrokerClient};
const R=172800000;
async function fixture(t){const f=await httpFixture(t,{requireRegistrationV2:true,limits:{session_retention_seconds:R/1000}});const tokenFile=join(f.dir,'token');writeFileSync(tokenFile,f.a.token,{mode:0o600});const settings={stateDirectory:join(f.dir,'native'),broker:{url:f.base,tokenFile,insecureDevelopment:true,registrationVersion:2,now:()=>f.now}};const binding=nativeSessionBinding({id:'one',projectID:'p',location:{directory:f.dir},time:{created:1}},'host');const options={reference,settings,binding};return{...f,f,settings,binding,options,client:inbox=>new BrokerClient({...settings.broker,inbox})};}
test('real HTTP expiry rotates empty journal, preserves pending native data, keeps original root ownership and reloads pointer',async t=>{
 const x=await fixture(t),{f,options}=x;let owner=openNativeIncarnation(options);t.after(()=>owner.close());const root=owner.inbox,first=root.identity.client_id,c=x.client(root);await c.register(registration().metadata);
 root.db.exec('CREATE TABLE v2_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)');root.db.prepare('INSERT INTO v2_state VALUES(?,?)').run('uncertain','old-native-operation');root.setState('claim_pending',{key:'old-claim'});
 await c.disconnectSession();f.advance(R);f.store.sweep();await assert.rejects(c.reconnect({verifySession:()=>true}),e=>e.code==='session_expired');root.close(); // Adapter stop cannot release the root owner.
 assert.throws(()=>openNativeIncarnation(options),e=>e.code==='owner_conflict');
 const next=await owner.replace({client:c,verifySession:()=>true});assert.notEqual(next.identity.client_id,first);assert.equal(next.getState('claim_pending'),null);assert.equal(next.db.prepare("SELECT name FROM sqlite_master WHERE name='v2_state'").get(),undefined);assert.equal(root.db.prepare('SELECT value FROM v2_state').get().value,'old-native-operation');
 assert.throws(()=>new Inbox({directory:root.directory,identity:root.identity}),e=>e.code==='owner_conflict');
 assert.throws(()=>openNativeInbox(options),/native_incarnation_required/);
 const second=next.identity.client_id;await x.client(next).register(registration().metadata);owner.close();owner=openNativeIncarnation(options);assert.equal(owner.inbox.identity.client_id,second);await x.client(owner.inbox).reconnect({verifySession:()=>true});
});
test('missing proof, native mismatch and corrupted pointer fail closed',async t=>{
 const x=await fixture(t),owner=openNativeIncarnation(x.options);t.after(()=>owner.close());const c=x.client(owner.inbox);await c.register(registration().metadata);await assert.rejects(owner.replace({client:c,verifySession:()=>true}),/unavailable/);await c.disconnectSession();x.f.advance(R);x.f.store.sweep();await assert.rejects(c.reconnect({verifySession:()=>true}),e=>e.code==='session_expired');await assert.rejects(owner.replace({client:c,verifySession:()=>false}),e=>e.code==='session_mismatch');const root=owner.inbox.directory;owner.close();writeFileSync(join(root,'current-incarnation.json'),'{',{mode:0o600});assert.throws(()=>openNativeIncarnation(x.options));assert.throws(()=>openNativeInbox(x.options),/native_incarnation_required/);
});
test('a committed pointer never silently recreates a missing child journal',async t=>{
 const {unlinkSync,existsSync}=await import('node:fs');const x=await fixture(t),owner=openNativeIncarnation(x.options);t.after(()=>owner.close());const c=x.client(owner.inbox);await c.register(registration().metadata);await c.disconnectSession();x.f.advance(R);x.f.store.sweep();await assert.rejects(c.reconnect({verifySession:()=>true}),e=>e.code==='session_expired');const next=await owner.replace({client:c,verifySession:()=>true}),path=join(next.directory,'inbox.sqlite');owner.close();unlinkSync(path);assert.throws(()=>openNativeIncarnation(x.options));assert.equal(existsSync(path),false);
});
test('uncertain pointer publish fences subsequent allocation and concurrent renewal is single-flight',async t=>{
 const {mkdirSync,readdirSync}=await import('node:fs');const x=await fixture(t),owner=openNativeIncarnation(x.options);t.after(()=>owner.close());const c=x.client(owner.inbox);await c.register(registration().metadata);await c.disconnectSession();x.f.advance(R);x.f.store.sweep();await assert.rejects(c.reconnect({verifySession:()=>true}),e=>e.code==='session_expired');const root=owner.inbox.directory;
 let release,entered;const ready=new Promise(r=>entered=r);const pending=owner.replace({client:c,verifySession:async()=>{entered();await new Promise(r=>release=r);return true;}});await ready;await assert.rejects(owner.replace({client:c,verifySession:()=>true}),/unavailable/);
 // Inject a real rename failure; the pointer path cannot be replaced by a file.
 mkdirSync(join(root,'current-incarnation.json'));// Verification is called twice; release both safely.
 release();const tick=setInterval(()=>release?.(),5);try{await assert.rejects(pending);}finally{clearInterval(tick);}
 const names=readdirSync(root);assert.throws(()=>owner.inbox,/unavailable/);await assert.rejects(owner.replace({client:c,verifySession:()=>true}),/unavailable/);assert.deepEqual(readdirSync(root),names);
});
