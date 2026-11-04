import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Inbox, newSessionIdentity } from '../vendor/broker/reference/inbox.mjs';
import { createNativeDelivery, nativeSessionBinding } from '../src/native-delivery.mjs';
import { presencePayload } from '../src/presence-notices.mjs';
const event = () => ({event_id:randomUUID(),type:'recipient_offline',recipient_id:randomUUID(),last_heartbeat_at:'2026-11-01T10:00:00Z',created_at:'2026-11-01T10:10:00Z',observed_at:'2026-11-01T10:11:00Z',presence_state:'disconnected',messages:[{message_id:randomUUID(),delivery_state:'claimed',delivery_uncertain:true}],has_more_messages:false});
function fixture(t, { requestTimeout = 30 } = {}) {
 const directory=mkdtempSync(join(tmpdir(),'psst-notice-')),identity=newSessionIdentity('opencode');let inbox=new Inbox({directory,identity});
 const info={id:'ses_test',projectID:'project',location:{directory},time:{created:1}},binding=nativeSessionBinding(info,'host');
 const controller=new AbortController(), submitted=[], context=[],acks=[],polls=[];let clock=0,selected=true,delivery;
 const client={policy:{presence_events:true},events:[event()],presenceEvents:async filters=>{polls.push(filters);return {events:client.events,next_cursor:null};},acknowledgePresenceEvent:async id=>{acks.push(id);return {event_id:id,acknowledged:true};}};
 const session={synthetic:async input=>{submitted.push(input);return {id:input.id,sessionID:input.sessionID,type:'synthetic',delivery:'queue',payload:{text:input.text,description:input.description,metadata:input.metadata}};},context:async()=>context};
 const make=()=>createNativeDelivery({session,inbox,binding,client,signal:controller.signal,verify:async()=>info,available:()=>selected,noticeNow:()=>clock,requestTimeout});delivery=make();
 t.after(async()=>{controller.abort();await delivery.stop();inbox.close();rmSync(directory,{recursive:true,force:true});});
 return {client,session,submitted,context,acks,polls,info,controller,get inbox(){return inbox;},get delivery(){return delivery;},set selected(value){selected=value;},
 async tick(){clock+=60000;await delivery.tick();},promote(i=0){const p=submitted[i];context.push({id:p.id,type:'synthetic',text:p.text,description:p.description,metadata:p.metadata});},
 async reopen(){await delivery.stop();inbox.close();inbox=new Inbox({directory,identity});delivery=make();}};
}
test('notice queues as synthetic, exact promoted context only permits ACK, restart deduplicates',async t=>{
 const f=fixture(t);await f.tick();assert.equal(f.submitted.length,1);assert.equal(f.acks.length,0);
 const p=f.submitted[0];assert.equal(p.agent,undefined);assert.equal(p.model,undefined);assert.equal(p.resume,true);assert.match(p.text,/not a reply timeout/);assert.match(p.text,/delivery_uncertain/);
 await f.reopen();await f.tick();assert.equal(f.submitted.length,1);assert.equal(f.acks.length,0);
 f.promote();await f.tick();assert.deepEqual(f.acks,[f.client.events[0].event_id]);await f.reopen();await f.tick();assert.equal(f.submitted.length,1);assert.equal(f.acks.length,1);
});
test('lost submission remains pinned, exact context reconciles without mutation retry',async t=>{
 const f=fixture(t),original=f.session.synthetic;f.session.synthetic=async p=>{await original(p);throw Error('lost');};await f.tick();await f.reopen();await f.tick();assert.equal(f.submitted.length,1);assert.equal(f.acks.length,0);
 f.promote();f.context[0].text+='changed';await f.tick();assert.equal(f.acks.length,0);f.context.pop();f.promote();await f.tick();assert.equal(f.acks.length,1);
});
test('ACK failure retries after durable presentation without native duplication',async t=>{
 const f=fixture(t);await f.tick();f.promote();const original=f.client.acknowledgePresenceEvent;f.client.acknowledgePresenceEvent=async()=>{throw Error('lost');};await f.tick();await f.reopen();f.context.length=0;f.client.acknowledgePresenceEvent=original;await f.tick();assert.equal(f.acks.length,1);assert.equal(f.submitted.length,1);
});
test('feature gate, deselection, failed state and cancellation prevent notices',async t=>{
 const f=fixture(t);f.client.policy={};await f.tick();assert.equal(f.polls.length,0);f.client.policy.presence_events=true;
 f.selected=false;await f.tick();f.selected=true;f.info.outcome='failed';await f.tick();delete f.info.outcome;
 f.delivery.event({type:'session.execution.interrupted',data:{sessionID:'ses_test'}});await f.reopen();await f.tick();assert.equal(f.submitted.length,0);
 f.delivery.event({type:'session.execution.started',data:{sessionID:'ses_test'}});await f.tick();assert.equal(f.submitted.length,1);
});
test('cancellation at durable write fences the deferred dispatch and does not ACK',async t=>{
 const f=fixture(t);let fired=false;f.inbox.failurePoint=point=>{if(point==='after_commit'&&!fired){fired=true;queueMicrotask(()=>f.delivery.event({type:'session.execution.interrupted',data:{sessionID:'ses_test'}}));}};
 await f.tick();assert.equal(f.submitted.length,0);assert.equal(f.acks.length,0);assert.equal(f.inbox.db.prepare('SELECT count(*) n FROM v2_presence_notices').get().n,0);
});
test('bounded pages follow empty continuations and restart scan; ordinary tick does not poll every 250ms',async t=>{
 const f=fixture(t);f.client.presenceEvents=async filters=>{f.polls.push(filters);return {events:[],next_cursor:filters.cursor?null:'100'};};
 await f.tick();await f.delivery.tick();assert.equal(f.polls.length,1);await f.tick();await f.tick();assert.deepEqual(f.polls,[{limit:10},{limit:10,cursor:'100'},{limit:10}]);
});
test('invalid or oversized event fails closed and text content is never copied',async t=>{
 const f=fixture(t);f.client.events[0].messages[0].delivery_state='delivered';await f.tick();assert.equal(f.submitted.length,0);
 const e=event();e.body='secret message body';e.instructions='resend';assert.doesNotMatch(presencePayload(e).text,/secret message body|instructions/);
 for(const invalid of [{...e,messages:Array(11).fill(e.messages[0])},{...e,event_id:'bad'},{...e,observed_at:'bad'}])assert.throws(()=>presencePayload(invalid));
});
test('failed durable intent does not submit; obsolete event disappearing is not submitted or acknowledged',async t=>{
 const f=fixture(t);f.inbox.failurePoint=point=>{if(point==='before_commit')throw Error('disk');};await f.tick();assert.equal(f.submitted.length,0);f.inbox.failurePoint=()=>{};f.client.events=[];await f.tick();assert.equal(f.submitted.length,0);assert.equal(f.acks.length,0);
});

test('same recipient new absence episode gets distinct notice; repeated event snapshot keeps immutable payload',async t=>{
 const f=fixture(t);await f.tick();const original=f.submitted[0].text;f.client.events[0].observed_at='2026-11-01T10:12:00Z';f.client.events[0].messages=[];
 // Invalid changed snapshot is not an excuse to mutate/replay prior admission.
 await f.tick();assert.equal(f.submitted.length,1);f.client.events[0].messages=[{message_id:randomUUID(),delivery_state:'queued',delivery_uncertain:false}];f.promote();await f.tick();assert.equal(f.acks.length,1);assert.equal(f.context[0].text,original);
 f.client.events[0].event_id=randomUUID();await f.tick();assert.equal(f.submitted.length,2);
});
test('late exact context after cancellation cannot ACK or revive execution',async t=>{
 const f=fixture(t);await f.tick();f.promote();f.session.context=async()=>{f.delivery.event({type:'session.execution.interrupted',data:{sessionID:'ses_test'}});return f.context;};
 await f.tick();assert.equal(f.acks.length,0);await f.reopen();await f.tick();assert.equal(f.acks.length,0);assert.equal(f.submitted.length,1);
});
test('capacity fails closed rather than evicting dedupe; page and payload byte/count limits are enforced',async t=>{
 const f=fixture(t);f.inbox.transaction(()=>{const add=f.inbox.db.prepare('INSERT INTO v2_presence_notices(event_id,native_id,payload,acknowledged) VALUES(?,?,?,1)');for(let i=0;i<10000;i++)add.run(randomUUID(),'msg_'+i,'{}');});
 await f.tick();assert.equal(f.submitted.length,0);assert.equal(f.inbox.db.prepare('SELECT count(*) n FROM v2_presence_notices').get().n,10000);
 const g=fixture(t);g.client.events=Array.from({length:11},event);await g.tick();assert.equal(g.submitted.length,0);
 g.client.events=[{...event(),body:'x'.repeat(65536)}];await g.tick();assert.equal(g.submitted.length,0);
});
test('stalled notice call stops on abort without ACK and does not replay after reload',async t=>{
 const f=fixture(t);f.session.synthetic=async p=>{f.submitted.push(p);return new Promise(()=>{});};const pending=f.tick();await new Promise(r=>setTimeout(r,10));f.controller.abort();await f.delivery.stop();await pending;
 assert.equal(f.submitted.length,1);assert.equal(f.acks.length,0);assert.equal(f.inbox.db.prepare('SELECT count(*) n FROM v2_presence_notices').get().n,1);
});
test('lost applied ACK reconciles outside event pages; obsolete 404 does not block later notice',async t=>{
 const f=fixture(t);await f.tick();f.promote();let ackCalls=0;const first=f.client.events[0];
 f.client.acknowledgePresenceEvent=async id=>{ackCalls++;if(ackCalls===1){f.client.events=[];throw Error('response lost');}return {event_id:id,acknowledged:true};};
 await f.tick();await f.reopen();await f.tick();assert.equal(ackCalls,2);assert.equal(f.inbox.db.prepare('SELECT acknowledged FROM v2_presence_notices WHERE event_id=?').get(first.event_id).acknowledged,1);assert.equal(f.submitted.length,1);
 const g=fixture(t);await g.tick();g.promote();g.client.events.push(event());g.client.acknowledgePresenceEvent=async()=>{throw Object.assign(Error('gone'),{code:'message_not_found',status:404});};
 await g.tick();assert.equal(g.submitted.length,2);assert.equal(g.inbox.db.prepare('SELECT acknowledged FROM v2_presence_notices WHERE event_id=?').get(g.client.events[0].event_id).acknowledged,1);
});
test('confirmed old tombstones prune but uncertain entries and permission failures remain',async t=>{
 const f=fixture(t),old=randomUUID(),uncertain=randomUUID();f.inbox.transaction(()=>{
 const insert=f.inbox.db.prepare('INSERT INTO v2_presence_notices(event_id,native_id,payload,presented,acknowledged,acknowledged_at) VALUES(?,?,?,?,?,?)');
 insert.run(old,'msg_old','{}',1,1,-9*86400000);insert.run(uncertain,'msg_uncertain','{}',0,0,null);
 });await f.tick();assert.equal(f.inbox.db.prepare('SELECT * FROM v2_presence_notices WHERE event_id=?').get(old),undefined);assert.ok(f.inbox.db.prepare('SELECT * FROM v2_presence_notices WHERE event_id=?').get(uncertain));
 f.promote();f.client.acknowledgePresenceEvent=async()=>{throw Object.assign(Error('denied'),{code:'forbidden',status:403});};await f.tick();assert.equal(f.inbox.db.prepare('SELECT acknowledged FROM v2_presence_notices WHERE event_id=?').get(f.client.events[0].event_id).acknowledged,0);
});
