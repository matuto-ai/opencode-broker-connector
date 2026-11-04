import test from 'node:test';
import assert from 'node:assert/strict';
import { containerArgs, HOST_IMAGE, presenceProbeSource } from './host-container.mjs';
const config = { directory: '/tmp/psst-native-host-fixture', project: '/tmp/psst-native-host-fixture/project',
  binary: '/runner/verified/opencode', modules: '/runner/node_modules', moduleSource: '/actual/node_modules', uid: 1001, gid: 1001, runID: 'fixture', serverContainerID: 'a'.repeat(64) };
const env = { HOME: config.directory + '/home', XDG_DATA_HOME: config.directory + '/data',
  NODE_EXTRA_CA_CERTS: '/tmp/authority/cert.pem', OPENCODE_SERVER_PASSWORD: 'synthetic-private-password',
  BUN_TMPDIR: config.directory + '/cache/native-assets',
  GITHUB_TOKEN: 'must-not-forward', TERM: 'xterm-256color' };
test('real-host container launcher uses explicit test-only mounts, UID and pinned image', () => {
  const args = containerArgs(config, 'owned-name', ['serve', '--hostname', '127.0.0.1'], env);
  assert.ok(args.includes(HOST_IMAGE));
  assert.equal(args[args.indexOf('--user') + 1], '1001:1001');
  assert.ok(args.includes('/tmp:rw,nosuid,nodev,noexec,mode=1777'));
  assert.ok(args.includes('--read-only')); assert.ok(args.includes('--cap-drop'));
  assert.equal(args.includes('--tty'), false);assert.equal(args.includes('--pid'), false);
  const mounts = args.flatMap((x, i) => x === '--mount' ? [args[i + 1]] : []);
  assert.deepEqual(mounts, [
    `type=bind,src=${config.directory},dst=${config.directory}`,
    'type=bind,src=/actual/node_modules,dst=/runner/node_modules,readonly',
    'type=bind,src=/runner/verified/opencode,dst=/usr/local/bin/opencode,readonly',
    'type=bind,src=/tmp/authority/cert.pem,dst=/tmp/authority/cert.pem,readonly',
  ]);
  assert.equal(args.includes('GITHUB_TOKEN'), false);
  assert.equal(JSON.stringify(args).includes('synthetic-private-password'), false);
  assert.equal(JSON.stringify(args).includes('docker.sock'), false);
});
test('real TUI receives its own container PTY and only allowlisted environment names', () => {
  const args = containerArgs(config, 'owned-name', ['--server', 'http://127.0.0.1:1234', '--session', 'ses_fixture'], env);
  assert.ok(args.includes('--interactive')); assert.ok(args.includes('--tty'));
  assert.equal(args[args.indexOf('--pid')+1], 'container:'+'a'.repeat(64));
  assert.equal(args.includes('host') && args[args.indexOf('--pid')+1] === 'host', false);
  const names = args.flatMap((x, i) => x === '--env' ? [args[i + 1]] : []);
  assert.deepEqual(names.sort(), ['BUN_TMPDIR','COLUMNS=120','HOME','LINES=40','NODE_EXTRA_CA_CERTS','OPENCODE_SERVER_PASSWORD','TERM','XDG_DATA_HOME'].sort());
});

// Executable failure/cleanup preflight only. This Docker-shaped subprocess uses
// files as its state; it is NOT evidence that real Docker or a native PTY works.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPresenceWriter, presenceDirectory } from '../src/active-presence.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createContainerLauncher } from './host-container.mjs';

function fakeDocker(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'psst-native-host-lifecycle-'));
  const bin = join(directory, 'bin'), state = join(directory, 'fake-state'), project = join(directory, 'project'), modules = join(directory, 'modules');
  for (const path of [bin, state, project, modules]) mkdirSync(path);
  const executable = join(directory, 'official-binary');writeFileSync(executable, 'fixture', { mode: 0o700 });
  const original = { PATH: process.env.PATH, FAKE_DOCKER_STATE: process.env.FAKE_DOCKER_STATE, FAKE_DOCKER_MODE: process.env.FAKE_DOCKER_MODE };
  process.env.PATH = bin + ':' + process.env.PATH;
  process.env.FAKE_DOCKER_STATE = state;delete process.env.FAKE_DOCKER_MODE;
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key];else process.env[key] = value; }rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
import { existsSync,readFileSync,writeFileSync,appendFileSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const args=process.argv.slice(2),root=process.env.FAKE_DOCKER_STATE,mode=process.env.FAKE_DOCKER_MODE;
appendFileSync(join(root,'calls.jsonl'),JSON.stringify(args)+'\\n');
const file=name=>join(root,name+'.json');
if(args[0]==='version'||args[0]==='image'){console.log('{}');}
else if(args[0]==='container'&&args[1]==='inspect'){
 const path=file(args[2]);if(!existsSync(path)){console.error('Error: No such container: '+args[2]);process.exit(1);}console.log('['+readFileSync(path,'utf8')+']');
}else if(args[0]==='create'){
 writeFileSync(join(root,'env-forwarded'),String(process.env.OPENCODE_SERVER_PASSWORD==='fixture-launch-password'));
 const name=args[args.indexOf('--name')+1],pair=args[args.indexOf('--label')+1].split('='),id=createHash('sha256').update(name).digest('hex');
 // A failed create can still have produced an owned container.
 const record=JSON.stringify({Id:id,State:{Running:false},Config:{Labels:{[pair[0]]:mode==='foreign'?'not-this-fixture':pair[1]}}});
 if(mode==='late-create'||mode==='unresolved-create'){
  writeFileSync(join(root,'create-started'),name);
  if(mode==='late-create')spawn(process.execPath,['--input-type=module','-e',\"import {writeFileSync} from 'node:fs';setTimeout(()=>writeFileSync(process.argv[1],process.argv[2]),2500);\",file(name),record],{detached:true,stdio:'ignore'}).unref();
  setTimeout(()=>{},20000);
 }else{writeFileSync(file(name),record);
 if(mode==='uncertain-create'){console.error('fixture lost create response');process.exit(19);}console.log(id);}
}else if(args[0]==='start'){
 const name=args.at(-1);const current=JSON.parse(readFileSync(file(name),'utf8'));current.State.Running=true;writeFileSync(file(name),JSON.stringify(current));writeFileSync(join(root,'attached'),name);
 if(mode==='blocked'){const timer=setInterval(()=>{if(!existsSync(file(name))){clearInterval(timer);process.exit(137);}},20);}
 else if(mode==='failed-start')process.exit(23);
}else if(args[0]==='exec'){console.log('[\"ses_probe_fixture\"]');
}else if(args[0]==='rm'){
 writeFileSync(join(root,'removal-started'),mode??'normal');
 if(mode==='failed-remove'){console.error('fixture removal rejected');process.exit(24);}
 if(mode==='timed-remove'){setTimeout(()=>{},20000);}else{const path=file(args.at(-1));if(existsSync(path))unlinkSync(path);}
}else{console.error('unimplemented fake Docker operation');process.exit(98);}
`, { mode: 0o700 });
  const launcher = createContainerLauncher({ directory, project, modules, binary: executable, ...options });
  t.after(() => rmSync(launcher.evidenceReceipt, { force: true }));
  const env = () => ({ ...process.env, HOME: join(directory, 'home'), NODE_EXTRA_CA_CERTS: join(directory, 'ca.pem'), BUN_TMPDIR: join(directory,'cache','native-assets'), OPENCODE_SERVER_PASSWORD: 'fixture-launch-password' });
  writeFileSync(join(directory, 'ca.pem'), 'fixture-only');
  const remaining = () => readdirSync(state).filter(name => name.startsWith('psst-real-host-'));
  const calls = () => readFileSync(join(state, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const run = () => spawnSync(launcher.prepare(['serve'], env()), ['serve'], { env: env(), encoding: 'utf8', timeout: 10000 });
  return { directory, state, launcher, env, remaining, calls, run };
}

test('generated extensionless Node wrapper executes, removes containers, and records fresh IDs', t => {
  const f = fakeDocker(t);
  for (let i = 0; i < 2; i++) { const result = f.run();assert.equal(result.status, 0, result.stderr);assert.deepEqual(f.remaining(), []); }
  assert.equal(readFileSync(join(f.state,'env-forwarded'),'utf8'),'true','parent-owned create receives only explicitly forwarded test credentials');
  f.launcher.assertRemoved();f.launcher.cleanup();
  assert.equal(f.calls().filter(args => args[0] === 'create').length, 2);
  assert.equal(f.calls().filter(args => args[0] === 'rm').length, 2);
});

for (const mode of ['failed-start']) test(`wrapper reconciles owned container after ${mode}`, t => {
  const f = fakeDocker(t);process.env.FAKE_DOCKER_MODE = mode;
  const result = f.run();assert.notEqual(result.status, 0, 'failed Docker operation cannot pass');
  assert.equal(result.error, undefined, 'wrapper must finish without test timeout');
  assert.deepEqual(f.remaining(), []);
  const records = readFileSync(join(f.directory, 'containers.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 1, 'owned name is journaled before even uncertain creation');
  assert.ok(f.calls().some(args => args[0] === 'rm' && args.at(-1) === records[0].name));
});

test('SIGTERM removes the owned running container and terminates attached wrapper', async t => {
  const f = fakeDocker(t);process.env.FAKE_DOCKER_MODE = 'blocked';
  const child = spawn(f.launcher.prepare(['serve'], f.env()), ['serve'], { env: f.env(), stdio: ['ignore','pipe','pipe'] });
  let output = '';child.stderr.on('data', chunk => output += chunk);
  const exit = new Promise((resolve, reject) => { child.once('error', reject);child.once('exit', (code, signal) => resolve({ code, signal })); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  for (let i = 0; i < 100 && !f.calls().some(args => args[0] === 'start'); i++) await delay(20);
  assert.ok(f.calls().some(args => args[0] === 'start'), 'wrapper must attach before signal');
  child.kill('SIGTERM');
  let timer;const result = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('wrapper_signal_cleanup_timeout')), 5000); })]).finally(() => clearTimeout(timer));
  assert.deepEqual(result, { code: 0, signal: null }, output);
  assert.deepEqual(f.remaining(), []);
});

test('foreign-label container is refused by both wrapper and outer cleanup', t => {
  const f = fakeDocker(t);process.env.FAKE_DOCKER_MODE = 'foreign';
  const result = f.run();assert.notEqual(result.status, 0);
  assert.equal(f.remaining().length, 1);
  assert.equal(f.calls().some(args => args[0] === 'rm'), false, 'wrapper must not remove a foreign owner');
  assert.throws(() => f.launcher.cleanup(), /real_host_container_cleanup_failed/);
  assert.equal(f.calls().some(args => args[0] === 'rm'), false, 'outer cleanup must not remove a foreign owner');
});


test('failed create with committed owned state is reconciled before throwing', t => {
  const f = fakeDocker(t);process.env.FAKE_DOCKER_MODE = 'uncertain-create';
  assert.throws(() => f.run(), /Docker create failed/);
  assert.deepEqual(f.remaining(), []);assert.equal(f.launcher.retainEvidence(), false);
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('opencode-container-')), false, 'no killable wrapper exists before confirmed creation');
});

// Leave room for loaded Node startup; the fake daemon/operation delays, not
// process startup, must be the reason these bounded operations time out.
test('timed-out create reconciles late daemon commit, with no wrapper to kill during creation', t => {
  const f = fakeDocker(t, { operationTimeoutMs: 1000, reconcileMs: 5000 });process.env.FAKE_DOCKER_MODE = 'late-create';
  assert.throws(() => f.run(), error => error.code === 'ETIMEDOUT');
  assert.ok(readFileSync(join(f.state, 'create-started'), 'utf8'), 'fake create reached its intentional stall before timing out');
  assert.deepEqual(f.remaining(), [], 'late daemon-created container must be removed before returning');
  assert.equal(f.launcher.retainEvidence(), false);
  assert.equal(f.calls().some(args => args[0] === 'start'), false, 'attachment cannot race incomplete creation');
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('opencode-container-')), false);
  assert.ok(f.calls().some(args => args[0] === 'rm'));
});

test('unresolved create retains external private ownership evidence and cannot pass cleanup', t => {
  const f = fakeDocker(t, { operationTimeoutMs: 1000, reconcileMs: 250 });process.env.FAKE_DOCKER_MODE = 'unresolved-create';
  assert.throws(() => f.run(), error => /private ownership receipt retained/.test(error.message) && error.cause?.code === 'ETIMEDOUT');
  assert.ok(readFileSync(join(f.state, 'create-started'), 'utf8'), 'unresolved create reached its intentional stall');
  assert.equal(f.launcher.retainEvidence(), true);
  assert.equal(f.launcher.evidenceReceipt.startsWith(f.directory + '/'), false);
  const receipt = JSON.parse(readFileSync(f.launcher.evidenceReceipt, 'utf8'));
  assert.equal(receipt.names.length, 1);assert.equal(receipt.directory, f.directory);
  assert.throws(() => f.launcher.cleanup(), /uncertain container creation/);
  assert.equal(f.calls().some(args => args[0] === 'rm'), false, 'absence is not a completed create or authorization to delete foreign state');
});

test('SIGKILL of attach wrapper cannot interrupt create; outer cleanup removes confirmed leftover', async t => {
  const f = fakeDocker(t);assert.equal(f.run().status, 0);
  process.env.FAKE_DOCKER_MODE = 'blocked';
  const executable = f.launcher.prepare(['serve'], f.env());
  const created = readFileSync(join(f.directory, 'container-ids.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(created.length, 2, 'both Docker create responses precede killable wrappers');
  const child = spawn(executable, ['serve'], { env: f.env(), stdio: 'ignore' });
  const exit = new Promise((resolve, reject) => { child.once('error', reject);child.once('exit', resolve); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  for (let i = 0; i < 100 && f.calls().filter(args => args[0] === 'start').length < 2; i++) await delay(20);
  child.kill('SIGKILL');await exit;
  assert.throws(() => f.launcher.cleanup(), /wrapper shutdown leaked containers/);
  assert.deepEqual(f.remaining(), []);
  assert.equal(f.launcher.retainEvidence(), false, 'no create remains in flight after the wrapper is killed');
});

for (const mode of ['failed-remove', 'timed-remove']) test(`outer cleanup retains ownership evidence after ${mode}`, t => {
  const f = fakeDocker(t, { operationTimeoutMs: 1000 });
  f.launcher.prepare(['serve'], f.env());
  process.env.FAKE_DOCKER_MODE = mode;
  assert.throws(() => f.launcher.cleanup(), error => /real_host_container_cleanup_failed; ownership receipt retained/.test(error.message)
    && (mode !== 'timed-remove' || error.errors[0]?.code === 'ETIMEDOUT'));
  assert.equal(readFileSync(join(f.state, 'removal-started'), 'utf8'), mode, 'intended removal branch ran after successful preparation');
  assert.equal(f.launcher.retainEvidence(), true);
  assert.equal(f.remaining().length, 1);
  const receipt = JSON.parse(readFileSync(f.launcher.evidenceReceipt, 'utf8'));
  assert.equal(receipt.names.length, 1);
  assert.ok(f.calls().some(args => args[0] === 'rm' && args.at(-1) === receipt.names[0]));
});

test('container extraction environment refuses inherited or external asset paths', () => {
  assert.throws(() => containerArgs(config, 'owned-name', ['serve'], { ...env, BUN_TMPDIR: '/tmp' }), /owned extraction directory/);
});


test('TUI joins only the confirmed running owned server, never host or unrelated PID namespace', t => {
  const f = fakeDocker(t), args = ['--server','http://127.0.0.1:1234'];
  assert.throws(() => f.launcher.prepare(args,f.env()), /requires an owned server/);
  f.launcher.prepare(['serve'],f.env());
  const record=JSON.parse(readFileSync(join(f.directory,'containers.jsonl'),'utf8').trim());
  const path=join(f.state,record.name+'.json'), original=JSON.parse(readFileSync(path,'utf8'));
  assert.throws(() => f.launcher.prepare(args,f.env()), /must be running/);
  writeFileSync(path,JSON.stringify({...original,Id:'f'.repeat(64),State:{Running:true}}));
  assert.throws(() => f.launcher.prepare(args,f.env()), /identity changed/);
  writeFileSync(path,JSON.stringify({...original,State:{Running:true},Config:{Labels:{'io.matuto.psst.real-host-fixture':'foreign'}}}));
  assert.throws(() => f.launcher.prepare(args,f.env()), /foreign container/);
  assert.equal(f.calls().filter(a=>a[0]==='create').length,1,'invalid targets never create a TUI container');
  writeFileSync(path,JSON.stringify({...original,State:{Running:true}}));
  f.launcher.prepare(args,f.env());
  const create=f.calls().filter(a=>a[0]==='create').at(-1);
  assert.equal(create[create.indexOf('--pid')+1], 'container:'+original.Id);
  const reader=f.launcher.presenceReader({installation:join(f.directory,'installation'),location:{directory:join(f.directory,'project')}});
  assert.deepEqual([...reader.selected()],['ses_probe_fixture']);
  const probe=f.calls().find(a=>a[0]==='exec');
  assert.equal(probe[1],original.Id);assert.deepEqual(probe.slice(2,5),['node','--input-type=module','-e']);
  assert.match(probe[5],/createPresenceReader/);assert.doesNotMatch(probe[5],/processAlive/);
  assert.throws(()=>f.launcher.cleanup(),/wrapper shutdown leaked containers/);
  assert.deepEqual(f.remaining(),[]);
  assert.throws(()=>reader.selected(),/server has been removed/,'removed generation cannot supply an old observation');
});

test('namespace observer executes unmodified production PID/start/boot reader, rejecting invalid and dead owners', t => {
  const root=mkdtempSync(join(tmpdir(),'psst-native-observer-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const installation=join(root,'installation'),project=join(root,'project');mkdirSync(installation,{mode:0o700});mkdirSync(project);
  const location={directory:project},directory=presenceDirectory(installation,location,{create:true});
  const moduleURL=new URL('../src/active-presence.mjs',import.meta.url).href;
  const source=presenceProbeSource(moduleURL,installation,location);
  const probe=()=>{const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
  const writer=createPresenceWriter({directory});writer.write('ses_live');
  assert.deepEqual(probe(),['ses_live']);
  const file=join(directory,writer.owner+'.json'),lease=JSON.parse(readFileSync(file,'utf8'));
  writeFileSync(file,JSON.stringify({...lease,start:'not-the-live-process-start'}));
  assert.deepEqual(probe(),[],'raw lease contents cannot bypass live process identity');
  writeFileSync(file,JSON.stringify({...lease,boot:'not-the-current-boot'}));
  assert.deepEqual(probe(),[],'boot identity validation remains active');
  writer.write('ses_live');writer.stop();assert.deepEqual(probe(),[]);
  const dead=spawnSync(process.execPath,['--input-type=module','-e',`import {createPresenceWriter} from ${JSON.stringify(moduleURL)};createPresenceWriter({directory:${JSON.stringify(directory)}}).write('ses_dead');`],{encoding:'utf8'});
  assert.equal(dead.status,0,dead.stderr);assert.deepEqual(probe(),[],'terminated TUI cannot satisfy a fresh namespace probe');
});
