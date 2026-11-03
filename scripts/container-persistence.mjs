// Three removed containers; only the private installation survives each restart.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const local=process.env.PSST_CONTAINER_PROCESS_ONLY==='1';
if(!local)assert.equal(spawnSync('docker',['version'],{stdio:'ignore'}).status,0,'Docker required; this gate cannot be skipped');
const {approvalTlsFixture}=await import(pathToFileURL(resolve(process.env.PSST_APPROVAL_DIR ?? join(root,'../psst-approval'),'test/approval-tls-fixture.mjs')));
const image='node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df';
const cleanups=[];
try{
 const f=await approvalTlsFixture({after:fn=>cleanups.push(fn)}),persist=join(f.directory,'persist');
 mkdirSync(persist,{mode:0o700});let posts=0;
 f.app.server.on('request',req=>{if(req.method==='POST'&&req.url==='/v1/enrollment-requests')posts++;});
 async function worker(phase){
  const name='psst-opencode-proof-'+randomUUID();
  const args=['run','--rm','--name',name,'--network','host','--user',`${process.getuid()}:${process.getgid()}`,'--read-only','--tmpfs','/tmp:rw,nosuid,nodev,mode=1777','--mount',`type=bind,src=${root},dst=/app,readonly`,'--mount',`type=bind,src=${persist},dst=/persist`,'--mount',`type=bind,src=${f.certFile},dst=/ca.pem,readonly`,'-e','HOME=/tmp/native-home','-e','NODE_EXTRA_CA_CERTS=/ca.pem','-i',image,'node','/app/scripts/container-persistence-worker.mjs'];
  return new Promise((resolveResult,reject)=>{
   const child=local?spawn(process.execPath,[join(root,'scripts/container-persistence-worker.mjs')],{stdio:['pipe','pipe','pipe'],env:{...process.env,HOME:join(f.directory,'fresh-home-'+phase),NODE_EXTRA_CA_CERTS:f.certFile}}):spawn('docker',args,{stdio:['pipe','pipe','pipe']});
   let buffer='',error='',result,failed,decision=Promise.resolve();
   const stop=()=>{child.kill('SIGKILL');if(!local)spawnSync('docker',['rm','-f',name],{stdio:'ignore',timeout:10000});};
   const timer=setTimeout(()=>{failed=Error('container_gate_timeout');stop();},90000);
   child.stderr.on('data',c=>{error+=c;});
   child.stdout.on('data',c=>{buffer+=c;while(buffer.includes('\n')){const n=buffer.indexOf('\n'),line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const value=JSON.parse(line);if(value.pending)decision=f.decide(value.pending).catch(e=>{failed=e;});if(value.phase)result=value;}catch{failed=Error('invalid_worker_output');}}});
   child.on('error',e=>{clearTimeout(timer);stop();reject(e);});
   child.on('close',async code=>{clearTimeout(timer);await decision;if(failed||code!==0||!result){stop();reject(failed??Error(`container worker failed (${code}): ${error.slice(-2000)}`));}else resolveResult(result);});
   child.stdin.end(JSON.stringify({phase,brokerUrl:f.brokerUrl,...(local?{persist}:{})}));
  });
 }
 const first=await worker(1),second=await worker(2),third=await worker(3);
 for(const next of [second,third]){assert.deepEqual(next.clients,first.clients);assert.equal(next.messageId,first.messageId);assert.equal(next.hostID,first.hostID);}
 assert.equal(second.submissions,1);assert.equal(third.submissions,0);assert.equal(posts,1);
 console.log(`PASS: ${local?'process-only preflight (NOT Docker proof)':'actual Docker remove/recreate'}; installation-only persistence, 30 isolated sessions with identical display names, one HTTPS enrollment POST, pending message retained, no duplicate native admission. Synthetic host, not authenticated model wake.`);
}finally{for(const cleanup of cleanups.reverse())await cleanup();}
