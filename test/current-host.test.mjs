import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './broker-fixture/test/helpers.mjs';
import { createBrokerServer } from './broker-fixture/src/server.mjs';
import { createPresenceReader, presenceDirectory } from '../src/active-presence.mjs';
import { loadBrokerReference } from '../src/reference.mjs';

import { stopHostProcess } from './host-process.mjs';

for (const approval of [false, true]) test(approval ? 'official OpenCode URL-only native setup awaits real TLS admin approval before automatic delivery' : 'official OpenCode loads packed root native plugin and automatically admits broker message without changing selection',
 {skip:!process.env.OPENCODE_BINARY || approval && !process.env.PSST_APPROVAL_BROKER_DIR,timeout:60000},async t=>{
 // Stop native processes before their broker/database and private directories.
 // Run every cleanup even after an assertion or another cleanup fails.
 const cleanups=[],fixtureContext={after:fn=>cleanups.push(fn)};
 t.after(async()=>{const errors=[];for(const cleanup of cleanups.reverse())try{await cleanup();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'native_host_cleanup_failed');});
 const dir=mkdtempSync(join(tmpdir(),'psst-native-host-'));fixtureContext.after(()=>rmSync(dir,{recursive:true,force:true}));
 const packed=spawnSync('npm',['pack','--json','--ignore-scripts','--pack-destination',dir,'--cache',join(dir,'npm-cache')],{encoding:'utf8',cwd:fileURLToPath(new URL('../',import.meta.url))});assert.equal(packed.status,0,packed.stderr);
 const tar=spawnSync('tar',['-xzf',join(dir,JSON.parse(packed.stdout)[0].filename),'-C',dir],{encoding:'utf8'});assert.equal(tar.status,0,tar.stderr);
 symlinkSync(fileURLToPath(new URL('../node_modules',import.meta.url)),join(dir,'package','node_modules'));
 const key=join(dir,'tls.key');let cert=join(dir,'tls.crt');
 const ssl=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{encoding:'utf8'});assert.equal(ssl.status,0,ssl.stderr);
 const authority=approval ? await (await import(pathToFileURL(join(process.env.PSST_APPROVAL_BROKER_DIR,'test','approval-tls-fixture.mjs')).href)).approvalTlsFixture(fixtureContext) : null;
 const f=approval ? null : fixture(fixtureContext),app=approval ? null : createBrokerServer({store:f.store,auth:f.auth,host:'127.0.0.1',port:0,tls:{keyFile:key,certFile:cert},pollIntervalMs:10});
 const address=app ? await app.listen() : null;if(app)fixtureContext.after(()=>app.close());const url=authority?.brokerUrl ?? `https://127.0.0.1:${address.port}/`;if(authority)cert=authority.certFile;
 const ref=await loadBrokerReference(),peerInbox=new ref.Inbox({directory:join(dir,'peer'),identity:ref.newSessionIdentity('pi')});fixtureContext.after(()=>peerInbox.close());
 const peerToken=join(dir,'peer.token'),token=join(dir,'token');if(authority){ const opts={brokerUrl:url,directory:join(dir,'peer-installation'),clientType:'pi'};const p=await authority.helper('beginApproval',opts);await authority.decide(p.requestId);const a=await authority.helper('pollApproval',opts);writeFileSync(peerToken,readFileSync(join(a.connectionFile,'..','token')),{mode:0o600}); }else{writeFileSync(peerToken,f.a.token,{mode:0o600});writeFileSync(token,f.b.token,{mode:0o600});}
 const peer=new ref.BrokerClient({url,tokenFile:peerToken,caFile:cert,inbox:peerInbox,maxAttempts:1});await peer.register({name:'Fixture peer',model:{provider:null,id:null,source:'unknown'},project:null});
 const configPath=join(dir,'connection.json');writeFileSync(configPath,JSON.stringify({broker:{url,tokenFile:token,caFile:cert},stateDirectory:join(dir,'state'),name:'OpenCode fixture'}),{mode:0o600});
 const project=join(dir,'project');mkdirSync(project);mkdirSync(join(dir,'home'));
 const resultFile=join(dir,'setup-result.json');
 const routeFile=join(dir,'fixture-route.json');
 const driver=join(project,'.opencode','plugins','fixture-driver');mkdirSync(driver,{recursive:true});
 writeFileSync(join(driver,'tui.js'),`import {readFileSync} from 'node:fs';export default {id:'fixture.driver',setup:ctx=>{let previous;const timer=setInterval(()=>{try{const raw=readFileSync(${JSON.stringify(routeFile)},'utf8');if(raw===previous)return;previous=raw;ctx.ui.router.navigate(JSON.parse(raw));}catch{}},50);return()=>clearInterval(timer);}}`);
 writeFileSync(join(driver,'index.js'),`import {writeFileSync} from 'node:fs';export default {id:'fixture.driver',setup:async ctx=>{await ctx.command.transform(e=>{for(const [name,id] of [['fixture-setup','broker_setup'],['fixture-connect','broker_list_clients']])e.add({name,execute:async({sessionID})=>{const tools=await ctx.tool.list();const tool=tools.find(t=>t.id===id);if(!tool)throw Error('missing native tool');const result=await tool.execute(id==='broker_setup'?{broker_url:${JSON.stringify(url)}}:{},{sessionID,messageID:'msg_fixture',id:'call_fixture',signal:new AbortController().signal,progress:async()=>{}});if(id==='broker_setup')writeFileSync(${JSON.stringify(resultFile)},result.content);}});});}}`);
 writeFileSync(join(project,'opencode.json'),JSON.stringify({plugins:[{package:join(dir,'package'),...(approval?{}:{options:{connectionFile:configPath}})}]}));
 const password=randomBytes(32).toString('base64url');
 const port=await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
 const child=spawn(process.env.OPENCODE_BINARY,['--log-level','debug','--print-logs','serve','--hostname','127.0.0.1','--port',String(port)],{cwd:project,env:{PATH:process.env.PATH,HOME:join(dir,'home'),XDG_CONFIG_HOME:join(dir,'config'),XDG_DATA_HOME:join(dir,'data'),XDG_CACHE_HOME:join(dir,'cache'),XDG_STATE_HOME:join(dir,'xdg-state'),OPENCODE_SERVER_PASSWORD:password,PSST_OPENCODE_CONFIG_DIR:join(dir,'installation'),NODE_EXTRA_CA_CERTS:cert},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 fixtureContext.after(()=>stopHostProcess(child));
 const base=`http://127.0.0.1:${port}`;
 async function api(path,body,method=body?'POST':'GET'){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert.ok(r.ok,`${path}: ${r.status} ${await r.clone().text()}`);return r.status===204?null:r.json();}
 for(let i=0;i<100;i++){try{if((await api('/api/info')).version==='2.2.5')break;}catch{}if(i===99)assert.fail('OpenCode did not start: '+output.replaceAll(password,'[fixture-secret]'));await delay(100);}
 let plugins;for(let i=0;i<50;i++){plugins=await api('/api/plugin');if(JSON.stringify(plugins).includes('matuto.psst'))break;await delay(100);}assert.match(JSON.stringify(plugins),/matuto.psst/,'actual native plugin manager must load packed root entry: '+JSON.stringify(plugins)+' '+output.replaceAll(password,'[fixture-secret]')+' '+readFileSync(join(dir,'data','opencode','log','opencode.log'),'utf8').replaceAll(password,'[fixture-secret]'));
 const session=(await api('/api/session',{location:{directory:project},title:'Psst OpenCode fixture',agent:'plan',model:{providerID:'fixture',id:'nonexistent'}})).data;
 // Mount the actual pinned TUI in a PTY. No model credentials or permission flags.
 const quote=s=>"'"+s.replaceAll("'", "'\\''")+"'";
 const tuiPidFile=join(dir,'tui.pid');
 const tui=spawn('script',['-q','-f','-c',`stty rows 40 cols 120; echo $$ > ${quote(tuiPidFile)}; exec ${quote(process.env.OPENCODE_BINARY)} --server ${quote(base)} --session ${quote(session.id)} ${quote(project)}`,'/dev/null'],{cwd:project,env:{PATH:process.env.PATH,TERM:'xterm-256color',HOME:join(dir,'home'),XDG_CONFIG_HOME:join(dir,'config'),XDG_DATA_HOME:join(dir,'data'),XDG_CACHE_HOME:join(dir,'cache'),XDG_STATE_HOME:join(dir,'xdg-state'),OPENCODE_SERVER_PASSWORD:password,PSST_OPENCODE_CONFIG_DIR:join(dir,'installation'),NODE_EXTRA_CA_CERTS:cert},detached:true,stdio:['pipe','pipe','pipe']});
 let tuiOutput='';tui.stdout.on('data',x=>{tuiOutput=(tuiOutput+x).slice(-16000);});tui.stderr.on('data',x=>{tuiOutput=(tuiOutput+x).slice(-16000);});fixtureContext.after(async()=>{
  // Give util-linux script its own two-second child-session shutdown window.
  await stopHostProcess(tui,true,3000);
  const pid=Number(readFileSync(tuiPidFile,'utf8').trim());assert.ok(Number.isInteger(pid)&&pid>0);
  // util-linux script owns another session for the shell/TUI. Verify that the
  // actual native process also exited, not only the PTY recorder's leader.
  const alive=()=>{try{const stat=readFileSync(`/proc/${pid}/stat`,'utf8');return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]);}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  for(let i=0;i<100&&alive();i++)await delay(10);
  assert.equal(alive(),false,'actual native TUI must stop with its PTY recorder');
 });
 let reader;for(let i=0;i<150;i++){try{reader=createPresenceReader({directory:presenceDirectory(join(dir,'installation'),{directory:project})});if(reader.selected().has(session.id))break;}catch{}await delay(100);}
 assert.ok(reader?.selected().has(session.id),'mounted official TUI must emit selected-session lease: '+tuiOutput.replaceAll(password,'[fixture-secret]'));
 if(!authority)await api('/api/session/'+session.id+'/command',{name:'fixture-connect',text:''});
 if(authority){
   assert.equal((await peer.listClients({})).clients.filter(c=>c.client_type==='opencode').length,0,'startup does not enroll or connect without approval');
   await api('/api/session/'+session.id+'/command',{name:'fixture-setup',text:''});
   const result=JSON.parse(readFileSync(resultFile,'utf8'));assert.equal(result.state,'pending');assert.ok(result.request_id);assert.equal(JSON.stringify(result).includes('connectionFile'),false);assert.equal((await peer.listClients({})).clients.filter(c=>c.client_type==='opencode').length,0);
   await authority.decide(result.request_id);
 }
 let recipient;
 for(let i=0;i<180;i++){recipient=(await peer.listClients({})).clients.find(c=>c.client_type==='opencode');if(recipient)break;await delay(50);}
 assert.ok(recipient,'native plugin must establish exact session broker registration: '+output.replaceAll(password,'[fixture-secret]'));
 await api('/api/session/'+session.id+'/agent',{agent:'build'});
 writeFileSync(routeFile,JSON.stringify({type:'home'}));for(let i=0;i<30&&reader.selected().size;i++)await delay(100);assert.equal(reader.selected().size,0,'native router home suspends owner');await delay(700);
 const send=await peer.sendPrepared(peer.prepareSend({recipient_id:recipient.client_id,content:{type:'text/plain',text:'compact OpenCode host fixture'}}));
 await delay(700);assert.equal((await api('/api/session/'+session.id+'/context')).data.some(x=>x.metadata?.broker_message_id===send.message_id),false,'inactive conversation does not receive native wake');
 writeFileSync(routeFile,JSON.stringify({type:'session',sessionID:session.id}));
 let admitted;
 for(let i=0;i<150;i++){
   const pending=(await api('/api/session/'+session.id+'/inbox')).data;
   const context=(await api('/api/session/'+session.id+'/context')).data;
   admitted=[...pending,...context].find(x=>(x.payload?.metadata??x.metadata)?.broker_message_id===send.message_id);
   if(admitted)break;await delay(50);
 }
 assert.ok(admitted,'actual native automatic path must reach synthetic native inbox/context: '+output.replaceAll(password,'[fixture-secret]'));
 assert.equal(admitted.type,'synthetic');const payload=admitted.payload??admitted;assert.match(payload.text,/compact OpenCode host fixture/);assert.doesNotMatch(payload.text,/authority|not a human/);
 const after=(await api('/api/session/'+session.id)).data;assert.equal(after.agent,'build');assert.equal(after.model.id,'nonexistent');
 const tools=await api('/api/plugin');assert.match(JSON.stringify(tools),/matuto.psst/);
 // Selected provider deliberately does not exist: API/admission proof only,
 // never an authenticated model or successful LLM-response qualification.
});
