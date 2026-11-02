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
