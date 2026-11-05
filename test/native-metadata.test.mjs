import test from 'node:test';import assert from 'node:assert/strict';import {nativeMetadata} from '../src/native-metadata.mjs';
const info={location:{directory:'/work/repository'},model:{providerID:'provider',id:'native-model'}};
test('native model wins over explicit managed fallback and project resolution uses only one chosen env',()=>{
 assert.deepEqual(nativeMetadata(info,{project:'Explicit'}, {AI_AGENTS_SANDBOX_PROJECT_NAME:'Default',OPENCODE_MANAGED_MODEL:'other/fallback'}),{name:'OpenCode',project:'Explicit',model:{provider:'provider',id:'native-model',source:'observed'}});
 assert.equal(nativeMetadata(info,{projectEnv:'CUSTOM'},{CUSTOM:'custom',AI_AGENTS_SANDBOX_PROJECT_NAME:'default'}).project,'custom');
 assert.equal(nativeMetadata(info,{projectEnv:'CUSTOM'},{PSST_PROJECT_ENV:'OVERRIDE',OVERRIDE:'override',CUSTOM:'custom'}).project,'override');
 assert.equal(nativeMetadata(info,{},{}).project,'repository');
 const unknown={location:info.location};assert.deepEqual(nativeMetadata(unknown,{},{}).model,{provider:null,id:null,source:'unknown'});
 assert.deepEqual(nativeMetadata(unknown,{}, {OPENCODE_MANAGED_MODEL:'provider/fallback'}).model,{provider:'provider',id:'fallback',source:'configured'});
 const reads=[];const env=new Proxy({PSST_PROJECT_ENV:'ONLY',ONLY:'project'}, {get:(o,k)=>{reads.push(k);return o[k];}});nativeMetadata(info,{},env);assert.deepEqual(reads,['PSST_PROJECT_ENV','ONLY']);
});
const clientID='11111111-1111-4111-8111-111111111111';
test('native title names retain explicit overrides and use only a short stable client suffix',()=>{
 assert.equal(nativeMetadata({...info,title:' Review '},{},{},clientID).name,'Review [11111111]');
 assert.equal(nativeMetadata({...info,title:'Review'},{name:'Configured'},{},clientID).name,'Configured');
 assert.equal(nativeMetadata({...info,title:'Review'},{},{},'22222222-2222-4222-8222-222222222222').name,'Review [22222222]');
 assert.equal(nativeMetadata({...info,title:'Renamed'},{},{},clientID).name,'Renamed [11111111]');
 assert.equal(nativeMetadata(info,{},{},clientID).name,'OpenCode [11111111]');
});
test('unsafe/path-shaped/missing titles fall back, long safe Unicode titles remain bounded and well formed',()=>{
 for(const title of [undefined,'','  ','bad\x1b[2J','bad\u202ename','\ud800','/private/project','C:\\private\\project','x'.repeat(8193)])
  assert.equal(nativeMetadata({...info,title},{},{},clientID).name,'OpenCode [11111111]');
 const name=nativeMetadata({...info,title:'😀'.repeat(300)},{},{},clientID).name;
 assert.equal([...name].length,128);assert.equal(name.isWellFormed(),true);assert.ok(name.endsWith(' [11111111]'));
 assert.equal(nativeMetadata({...info,title:'Review'},{},{},'/private/client-secret').name,'Review');
 const observed={...info,title:'Review',get transcript(){assert.fail('names must not inspect transcripts');}};
 assert.equal(nativeMetadata(observed,{},{},clientID).project,'repository');
});
