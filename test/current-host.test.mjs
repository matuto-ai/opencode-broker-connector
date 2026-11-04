import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
import { createContainerLauncher } from './host-container.mjs';

for (const approval of [false, true]) test(approval ? 'official OpenCode native setup survives cancel, denial, replacement and restart with real TLS approval' : 'official OpenCode reopens exact native session and unread mailbox without changing selection',
 {skip:!process.env.OPENCODE_BINARY || approval && !process.env.PSST_APPROVAL_BROKER_DIR,timeout:90000},async t=>{
 // Stop native processes before their broker/database and private directories.
 // Run every cleanup even after an assertion or another cleanup fails.
 const cleanups=[],fixtureContext={after:fn=>cleanups.push(fn)};
 t.after(async()=>{const errors=[];for(const cleanup of cleanups.reverse())try{await cleanup();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'native_host_cleanup_failed');});
 let containers;const dir=mkdtempSync(join(tmpdir(),'psst-native-host-'));fixtureContext.after(()=>{if(!containers?.retainEvidence())rmSync(dir,{recursive:true,force:true});});
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
 const routeFile=join(dir,'fixture-route.json'),rpcFile=join(dir,'fixture-rpc.json'),rpcResultFile=join(dir,'fixture-rpc-result.json');
 const driver=join(project,'.opencode','plugins','fixture-driver');mkdirSync(driver,{recursive:true});
 writeFileSync(join(driver,'tui.js'),`import {readFileSync,writeFileSync} from 'node:fs';import {SETUP_RPC} from ${JSON.stringify(pathToFileURL(join(dir,'package','src','setup-rpc.mjs')).href)};export default {id:'fixture.driver',setup:ctx=>{let previous,rpcPrevious,capabilitiesPrevious;const timer=setInterval(()=>{const capabilities=JSON.stringify({layer:typeof ctx.keymap?.layer,prompt:typeof ctx.ui?.dialog?.prompt,confirm:typeof ctx.ui?.dialog?.confirm,commands:ctx.keymap?.commands?.().filter(c=>c.id?.startsWith('psst')).map(c=>({id:c.id,slash:c.slash})),mode:ctx.keymap?.mode?.current?.()});if(capabilities!==capabilitiesPrevious){capabilitiesPrevious=capabilities;writeFileSync(${JSON.stringify(join(dir,'tui-capabilities.json'))},capabilities);}try{const raw=readFileSync(${JSON.stringify(routeFile)},'utf8');if(raw!==previous){previous=raw;ctx.ui.router.navigate(JSON.parse(raw));}}catch{}try{const raw=readFileSync(${JSON.stringify(rpcFile)},'utf8');if(raw!==rpcPrevious){rpcPrevious=raw;const request=JSON.parse(raw);Promise.resolve().then(()=>ctx.client.rpc(SETUP_RPC)[request.method](request.input,{location:ctx.location,signal:AbortSignal.timeout(10000)})).then(result=>writeFileSync(${JSON.stringify(rpcResultFile)},JSON.stringify({id:request.id,result})),error=>writeFileSync(${JSON.stringify(rpcResultFile)},JSON.stringify({id:request.id,error:JSON.stringify(error,Object.getOwnPropertyNames(error))})));}}catch{}},50);return()=>clearInterval(timer);}}`);
 writeFileSync(join(driver,'index.js'),`import {writeFileSync} from 'node:fs';export default {id:'fixture.driver',setup:async ctx=>{await ctx.command.transform(e=>{for(const [name,id] of [['fixture-setup','broker_setup'],['fixture-connect','broker_list_clients']])e.add({name,execute:async({sessionID})=>{const tools=await ctx.tool.list();const tool=tools.find(t=>t.id===id);if(!tool)throw Error('missing native tool');const result=await tool.execute(id==='broker_setup'?{broker_url:${JSON.stringify(url)}}:{},{sessionID,messageID:'msg_fixture',id:'call_fixture',signal:new AbortController().signal,progress:async()=>{}});if(id==='broker_setup')writeFileSync(${JSON.stringify(resultFile)},result.content);}});});}}`);
 writeFileSync(join(project,'opencode.json'),JSON.stringify({permissions:[{action:'fixture_sensitive_action',resource:'*',effect:'ask'}],plugins:[{package:join(dir,'package'),...(approval?{}:{options:{connectionFile:configPath}})}]}));
 containers=process.env.PSST_OPENCODE_DOCKER==='1' ? createContainerLauncher({directory:dir,project,binary:process.env.OPENCODE_BINARY,modules:fileURLToPath(new URL('../node_modules',import.meta.url))}) : null;
 if(containers)fixtureContext.after(()=>containers.cleanup());
 const password=randomBytes(32).toString('base64url');
 const port=await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
 const hostEnv={PATH:process.env.PATH,HOME:join(dir,'home'),XDG_CONFIG_HOME:join(dir,'config'),XDG_DATA_HOME:join(dir,'data'),XDG_CACHE_HOME:join(dir,'cache'),XDG_STATE_HOME:join(dir,'xdg-state'),OPENCODE_SERVER_PASSWORD:password,PSST_OPENCODE_CONFIG_DIR:join(dir,'installation'),NODE_EXTRA_CA_CERTS:cert};
 const extractionDirectory=join(dir,'cache','native-assets');
 hostEnv.BUN_TMPDIR=extractionDirectory;
 const prepareExtraction=()=>{mkdirSync(extractionDirectory,{recursive:true,mode:0o700});assert.equal(statSync(extractionDirectory).mode&0o777,0o700);};
 let child,output='';
 function startServer(){prepareExtraction();const args=['--log-level','debug','--print-logs','serve','--hostname','127.0.0.1','--port',String(port)];const executable=containers?.prepare(args,hostEnv) ?? process.env.OPENCODE_BINARY;child=spawn(executable,args,{cwd:project,env:hostEnv,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);const owned=child;fixtureContext.after(()=>stopHostProcess(owned));}
 startServer();
 const base=`http://127.0.0.1:${port}`;
 async function api(path,body,method=body?'POST':'GET'){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert.ok(r.ok,`${path}: ${r.status} ${await r.clone().text()}`);return r.status===204?null:r.json();}
 async function waitServer(){for(let i=0;i<100;i++){try{if((await api('/api/info')).version==='2.2.5')break;}catch{}if(i===99)assert.fail('OpenCode did not start: '+output.replaceAll(password,'[fixture-secret]'));await delay(100);}}
 await waitServer();
 let plugins;for(let i=0;i<50;i++){plugins=await api('/api/plugin');if(JSON.stringify(plugins).includes('matuto.psst'))break;await delay(100);}assert.match(JSON.stringify(plugins),/matuto.psst/,'actual native plugin manager must load packed root entry: '+JSON.stringify(plugins)+' '+output.replaceAll(password,'[fixture-secret]')+' '+readFileSync(join(dir,'data','opencode','log','opencode.log'),'utf8').replaceAll(password,'[fixture-secret]'));
 const session=(await api('/api/session',{location:{directory:project},title:'Psst OpenCode fixture',agent:'plan',model:{providerID:'fixture',id:'nonexistent'}})).data;
 // Mount the actual pinned TUI in a PTY. No model credentials or permission flags.
 const quote=s=>"'"+s.replaceAll("'", "'\\''")+"'";
 const tuiPidFile=join(dir,'tui.pid');
 let tui,tuiOutput='',stopTui;
 function startTui(){prepareExtraction(); let stopped=false;const executable=containers?.prepare(['--server',base,'--session',session.id,project],hostEnv) ?? process.env.OPENCODE_BINARY; tui=spawn('script',['-q','-f','-c',`stty rows 40 cols 120; echo $$ > ${quote(tuiPidFile)}; exec ${quote(executable)} --server ${quote(base)} --session ${quote(session.id)} ${quote(project)}`,'/dev/null'],{cwd:project,env:hostEnv,detached:true,stdio:['pipe','pipe','pipe']});
tui.stdout.on('data',x=>{tuiOutput=(tuiOutput+x).slice(-16000);});tui.stderr.on('data',x=>{tuiOutput=(tuiOutput+x).slice(-16000);});const owned=tui;stopTui=async()=>{
  if(stopped)return;stopped=true;
  // Give util-linux script its own two-second child-session shutdown window.
  await stopHostProcess(owned,true,3000);
  const pid=Number(readFileSync(tuiPidFile,'utf8').trim());assert.ok(Number.isInteger(pid)&&pid>0);
  // util-linux script owns another session for the shell/TUI. Verify that the
  // native process (or Docker launcher) also exited, not just the PTY recorder.
  // Container mode independently verifies removal of the actual native host.
  const alive=()=>{try{const stat=readFileSync(`/proc/${pid}/stat`,'utf8');return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]);}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  for(let i=0;i<100&&alive();i++)await delay(10);
  assert.equal(alive(),false,'actual native TUI must stop with its PTY recorder');
 };fixtureContext.after(stopTui);
 }
 startTui();
 let reader;for(let i=0;i<150;i++){try{reader=createPresenceReader({directory:presenceDirectory(join(dir,'installation'),{directory:project})});if(reader.selected().has(session.id))break;}catch{}await delay(100);}
 assert.ok(reader?.selected().has(session.id),'mounted official TUI must emit selected-session lease: '+tuiOutput.replaceAll(password,'[fixture-secret]'));
 assert.ok(readdirSync(extractionDirectory).some(name=>/^\.bun-.*\.so$/.test(name)),'actual pinned TUI must extract its native shared library into the private rebuildable cache');
 // Lifecycle checks use the real TUI client RPC transport. Initial setup below
 // separately exercises actual keyboard input and the native URL dialog.
 let rpcSequence=0,enrollmentID,approvedEnrollmentID;

 async function rpc(method,input={}){const id=++rpcSequence;writeFileSync(rpcFile,JSON.stringify({id,method,input:{sessionID:session.id,...input}}));for(let i=0;i<120;i++){let r;try{r=JSON.parse(readFileSync(rpcResultFile,'utf8'));}catch{}if(r?.id===id){assert.equal(r.error,undefined,'native TUI RPC: '+r.error);return r.result;}await delay(100);}assert.fail('native TUI RPC timed out');}
 if(!authority)await api('/api/session/'+session.id+'/command',{name:'fixture-connect',text:''});
 if(authority){
   assert.equal((await peer.listClients({})).clients.filter(c=>c.client_type==='opencode').length,0,'startup does not enroll or connect without approval');
   await delay(500);
   const beforeKeyboard=JSON.parse(readFileSync(join(dir,'tui-capabilities.json'),'utf8'));
   assert.ok(beforeKeyboard.commands.some(c=>c.id==='psst-setup'),'setup command registered before typing: '+JSON.stringify(beforeKeyboard));tuiOutput='';
   tui.stdin.write('/psst-setup');await delay(250);tui.stdin.write('\r');
   const terminalText=()=>tuiOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'');
   for(let i=0;i<60&&!terminalText().includes('Set up Psst');i++)await delay(100);
   assert.match(terminalText(),/Set up Psst/,'actual slash command must open native URL-only setup dialog: '+readFileSync(join(dir,'tui-capabilities.json'),'utf8'));
   assert.match(terminalText(),/HTTPS broker URL/);
   tui.stdin.write(url);await delay(150);tui.stdin.write('\r');
   let result;for(let i=0;i<100;i++){result=await rpc('status',{broker_url:url});if(result.state==='pending')break;await delay(100);}
   assert.equal(result.state,'pending');assert.ok(result.request_id);assert.equal(JSON.stringify(result).includes('connectionFile'),false);assert.equal((await peer.listClients({})).clients.filter(c=>c.client_type==='opencode').length,0);
   const paused=await rpc('cancel');assert.equal(paused.state,'paused');
   const resumed=await rpc('setup',{broker_url:url});assert.equal(resumed.request_id,result.request_id,'cancel/resume retains the same pending enrollment');
   await authority.decide(result.request_id,'deny');
   let denied;for(let i=0;i<60;i++){denied=await rpc('status',{broker_url:url});if(denied.state==='denied')break;await delay(100);}
   assert.equal(denied.state,'denied');
   await api('/api/session/'+session.id+'/command',{name:'fixture-setup',text:''});
   const agentRetry=JSON.parse(readFileSync(resultFile,'utf8'));assert.equal(agentRetry.request_id,result.request_id);assert.equal(agentRetry.replacement_confirmation_required,true,'URL-only agent tool cannot authorize replacement');
   const unconfirmed=await rpc('setup',{broker_url:url});assert.equal(unconfirmed.request_id,result.request_id);assert.equal(unconfirmed.replacement_confirmation_required,true);
   const replacement=await rpc('setup',{broker_url:url,replacement_confirmed:true,replacement_request_id:result.request_id});
   assert.equal(replacement.state,'pending');assert.notEqual(replacement.request_id,result.request_id);enrollmentID=replacement.request_id;
   assert.equal((await peer.listClients({})).clients.filter(c=>c.client_type==='opencode').length,0,'denied and replacement-pending requests grant no connection');
   // Server may restart before the owner TUI reconnects. Restoring selection
   // must resume this exact pending approval with GET only, not require setup.
   const beforePendingRestart=authority.approval.list().length;
   await stopTui();await stopHostProcess(child);containers?.assertRemoved();rmSync(rpcFile,{force:true});
   startServer();await waitServer();
   await authority.decide(replacement.request_id);approvedEnrollmentID=replacement.request_id;
   await delay(700);assert.equal((await peer.listClients({})).clients.filter(c=>c.client_type==='opencode').length,0,'unselected pending owner cannot activate');
   startTui();for(let i=0;i<150&&!reader.selected().has(session.id);i++)await delay(100);
   assert.ok(reader.selected().has(session.id));
   assert.equal(authority.approval.list().length,beforePendingRestart,'pending restart cannot create a new enrollment');
 }
 let recipient;
 for(let i=0;i<180;i++){recipient=(await peer.listClients({})).clients.find(c=>c.client_type==='opencode');if(recipient)break;await delay(50);}
 assert.ok(recipient,'native plugin must establish exact session broker registration: '+output.replaceAll(password,'[fixture-secret]'));
 if(authority){
   let connected;for(let i=0;i<60;i++){connected=await rpc('status');if(connected.connected)break;await delay(100);}assert.equal(connected.connected,true,'candidate registration must finish activation before replacement');
   const selectionPath=join(dir,'installation','installation.json'),selectionBefore=readFileSync(selectionPath,'utf8');
   const pending=await rpc('setup',{broker_url:url,replacement_confirmed:true,replacement_request_id:enrollmentID});
   assert.equal(pending.state,'pending');assert.notEqual(pending.request_id,enrollmentID);assert.equal(pending.connected,true,'existing authorization stays live while replacement waits');
   const paused=await rpc('cancel');assert.equal(paused.state,'paused');assert.equal(paused.connected,true);
   assert.equal(readFileSync(selectionPath,'utf8'),selectionBefore,'cancel cannot replace the live installation');
   const resumed=await rpc('setup',{broker_url:url});assert.equal(resumed.request_id,pending.request_id);
   await authority.decide(pending.request_id,'deny');
   let denied;for(let i=0;i<60;i++){denied=await rpc('status',{broker_url:url});if(denied.state==='denied')break;await delay(100);}
   assert.equal(denied.state,'denied');assert.equal(denied.connected,true);assert.equal(denied.client_id,recipient.client_id);
   assert.equal(readFileSync(selectionPath,'utf8'),selectionBefore,'denied replacement cannot alter the working authorization');
   enrollmentID=pending.request_id;
 }
 await api('/api/session/'+session.id+'/agent',{agent:'build'});
 // Native pending permission is created through the real host API. No command
 // is executed and no model tool-call behavior is simulated.
 const permission=(await api('/api/session/'+session.id+'/permission',{action:'fixture_sensitive_action',resources:['fixture://requires-human-approval']})).data;
 assert.equal(permission.effect,'ask');
 const pendingPermission=(await api('/api/session/'+session.id+'/permission')).data;assert.ok(pendingPermission.some(p=>p.id===permission.id));
 writeFileSync(routeFile,JSON.stringify({type:'home'}));for(let i=0;i<30&&reader.selected().size;i++)await delay(100);assert.equal(reader.selected().size,0,'native router home suspends owner');await delay(700);
 const send=await peer.sendPrepared(peer.prepareSend({recipient_id:recipient.client_id,content:{type:'text/plain',text:'compact OpenCode host fixture'}}));
 await delay(700);assert.equal((await api('/api/session/'+session.id+'/context')).data.some(x=>x.metadata?.broker_message_id===send.message_id),false,'inactive conversation does not receive native wake');
 assert.deepEqual((await api('/api/session/'+session.id+'/permission')).data,pendingPermission,'inactive broker traffic cannot answer a native permission');
 // Close both actual processes while a broker message is unread, then reopen
 // the exact native conversation with unchanged XDG/private installation paths.
 const originalIdentity=recipient.client_id;
 const bindings=()=>readdirSync(dir,{recursive:true}).filter(p=>p.endsWith('/binding.json')).map(p=>JSON.parse(readFileSync(join(dir,p),'utf8')));
 const originalBinding=bindings().find(b=>b.identity.client_id===originalIdentity);assert.ok(originalBinding);
 assert.equal(typeof originalBinding.identity.session_instance_id,'string');
 const enrollmentBefore=enrollmentID;
 await stopTui();await stopHostProcess(child);containers?.assertRemoved();
 rmSync(routeFile,{force:true});rmSync(rpcFile,{force:true});
 // Cached plugin bundles are rebuildable, not a native-history backup.
 rmSync(join(dir,'cache'),{recursive:true,force:true});
 startServer();await waitServer();startTui();
 for(let i=0;i<150&&!reader.selected().has(session.id);i++)await delay(100);
 assert.ok(reader.selected().has(session.id),'reopened actual TUI selects the same native session');
 assert.ok(readdirSync(extractionDirectory).some(name=>/^\.bun-.*\.so$/.test(name)),'reopened TUI rebuilds native extraction after cache deletion');
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
 // OpenCode clears in-memory permission requests on restart. Re-evaluation
 // must still ask: connector delivery cannot silently save an allow decision.
 const permissionAfter=(await api('/api/session/'+session.id+'/permission',{action:'fixture_sensitive_action',resources:['fixture://requires-human-approval']})).data;assert.equal(permissionAfter.effect,'ask');
 const after=(await api('/api/session/'+session.id)).data;assert.equal(after.agent,'build');assert.equal(after.model.id,'nonexistent');
 const tools=await api('/api/plugin');assert.match(JSON.stringify(tools),/matuto.psst/);
 const restored=(await peer.listClients({connected:false})).clients.filter(c=>c.client_type==='opencode');
 assert.equal(restored.length,1,'restart must not register a fresh broker identity');
 assert.equal(restored[0].client_id,originalIdentity);
 assert.deepEqual(bindings().find(b=>b.identity.client_id===originalIdentity),originalBinding);
 if(authority){const status=await rpc('status',{broker_url:url});assert.equal(status.request_id,enrollmentBefore,'restart must not create a new enrollment');assert.equal(status.connected,true);}
 const second=(await api('/api/session',{location:{directory:project},title:'Independent native session',agent:'plan',model:{providerID:'fixture',id:'nonexistent'}})).data;
 writeFileSync(routeFile,JSON.stringify({type:'session',sessionID:second.id}));
 for(let i=0;i<50&&!reader.selected().has(second.id);i++)await delay(100);
 assert.ok(reader.selected().has(second.id));
 await api('/api/session/'+second.id+'/command',{name:'fixture-connect',text:''});
 // Identity is independent of transport liveness: the first TUI is now inactive.
 let independent;for(let i=0;i<100;i++){independent=(await peer.listClients({connected:false})).clients.filter(c=>c.client_type==='opencode');if(independent.length===2)break;await delay(50);}
 assert.equal(independent.length,2,'fresh native session registers independently');
 const secondBinding=bindings().find(b=>b.binding.sessionID===second.id);assert.ok(secondBinding);
 assert.notEqual(secondBinding.identity.client_id,originalIdentity);
 assert.notEqual(secondBinding.identity.session_instance_id,originalBinding.identity.session_instance_id);
 assert.equal((await api('/api/session/'+second.id+'/context')).data.some(x=>x.metadata?.broker_message_id===send.message_id),false,'independent native session cannot adopt the first mailbox');
 const userInput=(await api('/api/session/'+second.id+'/prompt',{text:'Queued fixture user input must survive broker admission',delivery:'queue',resume:false})).data;
 const secondSend=await peer.sendPrepared(peer.prepareSend({recipient_id:secondBinding.identity.client_id,content:{type:'text/plain',text:'Do not discard pending human input'}}));
 let secondItems;
 for(let i=0;i<100;i++){secondItems=[...(await api('/api/session/'+second.id+'/inbox')).data,...(await api('/api/session/'+second.id+'/context')).data];if(secondItems.some(x=>(x.payload?.metadata??x.metadata)?.broker_message_id===secondSend.message_id))break;await delay(50);}
 assert.ok(secondItems.some(x=>(x.payload?.metadata??x.metadata)?.broker_message_id===secondSend.message_id));
 assert.ok(secondItems.some(x=>x.id===userInput.id),'automatic admission cannot discard pending native user input');
 // A real missing-provider failure is a terminal host outcome, not model success.
 let failed;for(let i=0;i<80;i++){failed=(await api('/api/session/'+second.id)).data;if(failed.outcome==='failed')break;await delay(50);}
 assert.equal(failed.outcome,'failed');
 const afterFailure=await peer.sendPrepared(peer.prepareSend({recipient_id:secondBinding.identity.client_id,content:{type:'text/plain',text:'Must not wake a failed execution'}}));
 await delay(1000);
 const stoppedItems=[...(await api('/api/session/'+second.id+'/inbox')).data,...(await api('/api/session/'+second.id+'/context')).data];
 assert.equal(stoppedItems.some(x=>(x.payload?.metadata??x.metadata)?.broker_message_id===afterFailure.message_id),false,'broker traffic cannot restart failed execution');


 if(authority){
   const before=authority.approval.list().length;
   await authority.decide(approvedEnrollmentID,'revoke');
   await api('/api/session/'+second.id+'/command',{name:'fixture-connect',text:''});
   let rejected;for(let i=0;i<60;i++){rejected=await rpc('status',{sessionID:second.id});if(rejected.authorization_state==='rejected')break;await delay(100);}
   assert.equal(rejected.authorization_state,'rejected');assert.equal(rejected.connected,false);
   await delay(2300);assert.equal(authority.approval.list().length,before,'revocation must not trigger automatic enrollment');
 }
 // Selected provider deliberately does not exist: API/admission proof only,
 // never an authenticated model or successful LLM-response qualification.
});
