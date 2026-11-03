import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createConnectionLoader, readExistingConnection, ENROLLMENT_SHA256 } from '../src/enrollment.mjs';
import * as helper from '../vendor/enrollment/enrollment.mjs';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'psst-opencode-pair-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const pairingFile=join(root,'pairing.json'),secret=randomBytes(32).toString('base64url');writeFileSync(pairingFile,JSON.stringify({format:'psst-pairing-v1',broker_url:'https://broker.example',pairing_secret:secret,client_type:'opencode',expires_at:new Date(Date.now()+60000).toISOString()}),{mode:0o600});return {root,pairingFile,secret};}
test('shared enrollment helper remains byte-identical to reviewed source',()=>{
 assert.equal(createHash('sha256').update(readFileSync(new URL('../vendor/enrollment/enrollment.mjs',import.meta.url))).digest('hex'),ENROLLMENT_SHA256);
});
test('explicit pairing creates one private credential per native session and sanitized receipt',async t=>{
 const f=fixture(t),requests=[];
 const api={...helper,connectPairingFile:input=>helper.connectPairingFile(input,{transport:async(url,secret,body)=>{assert.equal(secret,f.secret);requests.push(JSON.parse(body));return {status:201,body:{protocol_version:'1',credential_id:'enrolled-'+randomUUID(),adapter_id:'installation-'+randomUUID(),client_type:'opencode',scopes:['psst'],expires_at:new Date(Date.now()+3600000).toISOString()}};}})};
 const load=createConnectionLoader({directory:f.root,stateHome:join(f.root,'state'),loadHelper:async()=>api});
 const first=await load(f.pairingFile,{clientType:'opencode',sessionID:'ses_one'});const repeat=await load(f.pairingFile,{clientType:'opencode',sessionID:'ses_one'});
 assert.deepEqual(requests[0],requests[1],'retry request is stable');assert.equal(first.broker.tokenFile,repeat.broker.tokenFile);assert.equal(first.enrollment.credentialId.startsWith('enrolled-'),true);
 assert.equal(JSON.stringify(first).includes(f.secret),false);assert.equal(JSON.stringify(first).includes(readFileSync(first.broker.tokenFile,'utf8').trim()),false);
 await load(f.pairingFile,{clientType:'opencode',sessionID:'ses_other'});assert.notEqual(requests[0].enrollment_id,requests[2].enrollment_id);assert.notEqual(requests[0].token_sha256,requests[2].token_sha256);
 const bundle=join(dirname(first.broker.tokenFile),'connection.json');assert.ok((await load(bundle,{clientType:'opencode',sessionID:'ses_one'})).enrollment);
 assert.ok((await readExistingConnection(bundle)).enrollment);rmSync(join(dirname(first.broker.tokenFile),'enrollment.json'));await assert.rejects(readExistingConnection(bundle),{code:'invalid_enrollment_receipt'});await assert.rejects(load(bundle,{clientType:'opencode',sessionID:'ses_one'}),{code:'invalid_enrollment_receipt'});
});
test('private file and client type restrictions prevent issuance',async t=>{
 const f=fixture(t);let calls=0;const load=createConnectionLoader({directory:f.root,stateHome:join(f.root,'state'),loadHelper:async()=>({...helper,connectPairingFile:async input=>{calls++;return helper.connectPairingFile(input,{transport:async()=>{throw new Error('network must not happen');}});}})});
 await assert.rejects(load(f.secret,{clientType:'opencode',sessionID:'ses_one'}));assert.equal(calls,0);
 chmodSync(f.pairingFile,0o644);await assert.rejects(load(f.pairingFile,{clientType:'opencode',sessionID:'ses_one'}));
 await assert.rejects(load(f.pairingFile,{clientType:'pi',sessionID:'ses_one'}));
});
test('enrollment marker requires exact basename and fatal receipt type/origin/token binding',async t=>{
 const f=fixture(t);const api={...helper,connectPairingFile:input=>helper.connectPairingFile(input,{transport:async()=>({status:201,body:{protocol_version:'1',credential_id:'enrolled-'+randomUUID(),adapter_id:'installation-'+randomUUID(),client_type:'opencode',scopes:['psst'],expires_at:new Date(Date.now()+3600000).toISOString()}})})};
 const load=createConnectionLoader({directory:f.root,stateHome:join(f.root,'state'),loadHelper:async()=>api});const config=await load(f.pairingFile,{clientType:'opencode',sessionID:'ses_one'});
 const base=dirname(config.broker.tokenFile),bundlePath=join(base,'connection.json'),receiptPath=join(base,'enrollment.json');
 const bundle=JSON.parse(readFileSync(bundlePath,'utf8')),receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
 assert.equal(bundle.enrollment_receipt_file,'enrollment.json');
 for(const patch of [{client_type:'pi'},{broker_url:'https://other.example'},{token_sha256:'0'.repeat(64)}]){writeFileSync(receiptPath,JSON.stringify({...receipt,...patch}));await assert.rejects(load(bundlePath,{clientType:'opencode',sessionID:'ses_one'}),{code:'invalid_enrollment_receipt'});}
 writeFileSync(receiptPath,JSON.stringify(receipt));writeFileSync(bundlePath,JSON.stringify({...bundle,enrollment_receipt_file:'../enrollment.json'}));await assert.rejects(load(bundlePath,{clientType:'opencode',sessionID:'ses_one'}));
});

test('expired authorization allows validated identity-only inspection, never connection or corrupt-receipt recovery',async t=>{
 const f=fixture(t);const api={...helper,connectPairingFile:input=>helper.connectPairingFile(input,{transport:async()=>({status:201,body:{protocol_version:'1',credential_id:'enrolled-'+randomUUID(),adapter_id:'installation-'+randomUUID(),client_type:'opencode',scopes:['psst'],expires_at:new Date(Date.now()+3600000).toISOString()}})})};
 const load=createConnectionLoader({directory:f.root,stateHome:join(f.root,'state'),loadHelper:async()=>api});const config=await load(f.pairingFile,{clientType:'opencode',sessionID:'ses_one'}),base=dirname(config.broker.tokenFile),bundle=join(base,'connection.json'),path=join(base,'enrollment.json');
 const expired={...JSON.parse(readFileSync(path,'utf8')),expires_at:new Date(Date.now()-1000).toISOString()};writeFileSync(path,JSON.stringify(expired));
 await assert.rejects(readExistingConnection(bundle),{code:'credential_expired'});const recovered=await readExistingConnection(bundle,{identityRecovery:true});assert.equal(recovered.authorizationExpired,true);assert.equal(recovered.enrollment,undefined);assert.equal(recovered.stateDirectory,config.stateDirectory);
 for(const patch of [{client_type:'pi'},{broker_url:'https://wrong.example'},{token_sha256:'0'.repeat(64)}]){writeFileSync(path,JSON.stringify({...expired,...patch}));await assert.rejects(readExistingConnection(bundle,{identityRecovery:true}),{code:'invalid_enrollment_receipt'});}
 rmSync(path);await assert.rejects(readExistingConnection(bundle,{identityRecovery:true}),{code:'invalid_enrollment_receipt'});
});
