// Real connector persistence and HTTPS transport; synthetic OpenCode host, no model account.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { beginApproval, pollApproval } from '../vendor/enrollment/approval.mjs';
import { selectInstallation, readInstallation } from '../src/installation.mjs';
import { recoverHostAnchor } from '../src/identity-recovery.mjs';
import { nativeSessionBinding, createNativeDelivery } from '../src/native-delivery.mjs';
import { openNativeInbox } from '../src/native-inbox.mjs';
import { loadBrokerReference } from '../src/reference.mjs';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const {phase,brokerUrl,persist='/persist'}=JSON.parse(input);
mkdirSync(process.env.HOME,{recursive:true,mode:0o700});
const options={brokerUrl,directory:persist,clientType:'opencode'};
if(phase===1){
 let result=await beginApproval(options); console.log(JSON.stringify({pending:result.requestId}));
 for(let i=0;result.state==='pending'&&i<100;i++){await delay(100);result=await pollApproval(options);}
 assert.equal(result.state,'approved');
 await selectInstallation({directory:persist,connectionFile:result.connectionFile,expectedRevision:null});
}
const settings=await readInstallation(persist); assert(settings);
const reference=await loadBrokerReference();
const info=id=>({id,projectID:'container-project',location:{directory:'/project'},time:{created:1}});
// Each fresh host namespace starts empty: durable connector manifests must recover the anchor.
const stored=new Map();
const hostID=await recoverHostAnchor({settings,directory:'/project',storage:{get:async k=>stored.get(k),set:async(k,v)=>stored.set(k,v)},session:{get:async({sessionID})=>info(sessionID)}});
const sessions=[];
try{
 for(const id of ['sender','receiver','unrelated']){
  const binding=nativeSessionBinding(info(id),hostID),inbox=openNativeInbox({reference,settings,binding});
  const client=new reference.BrokerClient({...settings.broker,inbox});
  const metadata={name:id,model:{provider:null,id:null,source:'unknown'},project:null};
  if(phase===1)await client.register(metadata); else await client.reconnect({verifySession:async()=>true,metadata,receiveEnabled:true});
  sessions.push({binding,inbox,client});
 }
 assert.equal(new Set(sessions.map(s=>s.inbox.identity.client_id)).size,3);
 const [sender,receiver,unrelated]=sessions;
 if(phase===1){
  const key=sender.client.prepareSend({recipient_id:receiver.inbox.identity.client_id,content:{type:'text/plain',text:'durable OpenCode container message'}});
  const sent=await sender.client.sendPrepared(key); assert(sent.message_id);
  const claim=await receiver.client.claim(0); assert.equal(claim.envelope.message_id,sent.message_id);
  receiver.inbox.accept(claim.envelope,{serverNow:receiver.client.serverNow()});
  await receiver.client.complete(sent.message_id,{claim_id:claim.claim_id,outcome:'delivered',reason:'none'});
  writeFileSync(join(persist,'proof.json'),JSON.stringify({messageId:sent.message_id,clients:sessions.map(s=>s.inbox.identity.client_id),hostID}),{mode:0o600});
 }
 const proof=JSON.parse(readFileSync(join(persist,'proof.json'),'utf8'));
 assert.deepEqual(sessions.map(s=>s.inbox.identity.client_id),proof.clients); assert.equal(hostID,proof.hostID);
 assert.equal(unrelated.inbox.head(),null); assert.equal(await unrelated.client.claim(0),null);
 let submissions=0;
 if(phase===2){assert.equal(receiver.inbox.head().envelope.message_id,proof.messageId);}
 if(phase>=2){
  const delivery=createNativeDelivery({inbox:receiver.inbox,binding:receiver.binding,signal:new AbortController().signal,verify:async()=>info('receiver'),session:{context:async()=>[],synthetic:async p=>{submissions++;return{id:p.id,sessionID:p.sessionID,type:'synthetic',delivery:p.delivery,payload:{text:p.text,description:p.description,metadata:p.metadata}};}}});
  await delivery.tick(); await delivery.stop(); assert.equal(receiver.inbox.head(),null);
  assert.equal(submissions,phase===2?1:0,'native admission must not repeat after recreation');
 }
 console.log(JSON.stringify({phase,clients:proof.clients,messageId:proof.messageId,hostID,submissions}));
}finally{for(const s of sessions)s.inbox.close();}
