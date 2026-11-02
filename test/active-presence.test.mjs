import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPresenceWriter, createPresenceReader, presenceDirectory, PRESENCE_TTL } from '../src/active-presence.mjs';
import tui from '../plugin/tui.mjs';
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'active-tui-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
 const directory=presenceDirectory(root,{directory:root},{create:true});let time=Date.now();
 return {root,directory,now:()=>time,advance:ms=>time+=ms};
}
test('private selection union, home, last owner and TTL are non-authoritative local preference',t=>{
 const f=fixture(t),r=createPresenceReader(f),a=createPresenceWriter(f),b=createPresenceWriter(f);
 assert.deepEqual([...r.selected()],[]);a.write('one');b.write('two');assert.deepEqual([...r.selected()].sort(),['one','two']);
 a.write('two');assert.deepEqual([...r.selected()],['two']);a.stop();assert.deepEqual([...r.selected()],['two']);
 b.write(null);assert.deepEqual([...r.selected()],[]);b.write('two');f.advance(PRESENCE_TTL);assert.deepEqual([...r.selected()],[]);
 assert.equal(statSync(f.directory).mode&0o777,0o700);
});
test('malformed, stale sequence, symlink and foreign owner process never activate sessions',t=>{
 const f=fixture(t),r=createPresenceReader(f),w=createPresenceWriter(f),path=join(f.directory,w.owner+'.json');
 w.write('one');const old=readFileSync(path);assert.deepEqual([...r.selected()],['one']);w.write('two');assert.deepEqual([...r.selected()],['two']);
 writeFileSync(path,old);assert.deepEqual([...r.selected()],[]);unlinkSync(path);assert.deepEqual([...r.selected()],[]);writeFileSync(path,old,{mode:0o600});assert.deepEqual([...r.selected()],[]);
 w.write('one');const v=JSON.parse(readFileSync(path));v.start='foreign';writeFileSync(path,JSON.stringify(v));assert.deepEqual([...r.selected()],[]);
 unlinkSync(path);const other=join(f.root,'other');writeFileSync(other,old,{mode:0o600});symlinkSync(other,path);assert.deepEqual([...r.selected()],[]);
});
test('hot reload generation cannot remove successor owner lease',t=>{
 const f=fixture(t),counter={seq:0},a=createPresenceWriter({...f,counter}),b=createPresenceWriter({...f,owner:a.owner,counter}),r=createPresenceReader(f);
 a.write('one');r.selected();b.write('two');a.stop();assert.deepEqual([...r.selected()],['two']);b.stop();assert.deepEqual([...r.selected()],[]);
});
test('official TUI entry observes router only, isolated ephemeral memory, no credentials or RPC',async t=>{
 const f=fixture(t),env=process.env.PSST_OPENCODE_CONFIG_DIR;process.env.PSST_OPENCODE_CONFIG_DIR=f.root;t.after(()=>{if(env===undefined)delete process.env.PSST_OPENCODE_CONFIG_DIR;else process.env.PSST_OPENCODE_CONFIG_DIR=env;});
 let route={type:'session',sessionID:'one'},memory,notices=[];
 const ctx={app:{version:'2.2.5'},location:{directory:f.root},storage:{memory:(key,{initial})=>{memory??=initial;return[memory,fn=>fn(memory)];}},ui:{router:{current:()=>route},toast:{show:x=>notices.push(x)}},client:new Proxy({},{get(){throw Error('no RPC');}})};
 const stop=tui.setup(ctx),r=createPresenceReader({directory:f.directory});t.after(stop);assert.deepEqual([...r.selected()],['one']);
 route={type:'home'};await new Promise(r=>setTimeout(r,300));assert.deepEqual([...r.selected()],[]);stop();assert.equal(notices.length,0);
 const remote=tui.setup({...ctx,location:{directory:'/does-not-exist'}});remote();assert.equal(notices.length,1);
});
test('accumulated expired crash leases do not exhaust active owner capacity',t=>{
 const f=fixture(t);for(let i=0;i<65;i++)createPresenceWriter(f).write('old');f.advance(PRESENCE_TTL+1);
 createPresenceWriter(f).write('current');const r=createPresenceReader(f);assert.deepEqual([...r.selected()],['current']);assert.equal(readdirSync(f.directory).length,1);
});
