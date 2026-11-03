import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const binary=process.env.OPENCODE_BINARY,spec=process.env.PSST_OPENCODE_PACKAGE_SPEC;
test('official OpenCode plugin manager installs the exact npm package and preserves global configuration',
 {skip:!binary||!spec,timeout:180000},t=>{
 assert.match(spec,/^@matuto-ai\/opencode-psst-connector@0\.6\.\d+$/,'installer proof requires a published exact npm version');
 const dir=mkdtempSync(join(tmpdir(),'psst-native-installer-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const configDir=join(dir,'config','opencode');mkdirSync(configDir,{recursive:true});mkdirSync(join(dir,'project'));mkdirSync(join(dir,'home'));
 const configFile=join(configDir,'opencode.json');writeFileSync(configFile,JSON.stringify({plugins:['-fixture.disabled']}));
 // Never inherit user auth/config, Git credentials, provider env or host paths.
 const env={PATH:process.env.PATH,HOME:join(dir,'home'),XDG_CONFIG_HOME:join(dir,'config'),XDG_DATA_HOME:join(dir,'data'),XDG_CACHE_HOME:join(dir,'cache'),XDG_STATE_HOME:join(dir,'state'),GIT_TERMINAL_PROMPT:'0',GIT_SSH_COMMAND:'false'};
 const version=spawnSync(binary,['--version'],{cwd:join(dir,'project'),env,encoding:'utf8',timeout:10000});assert.equal(version.status,0,version.stderr);assert.equal(version.stdout.trim(),'opencode v2.2.5');
 for(let i=0;i<2;i++){
  const installed=spawnSync(binary,['plugin','add',spec],{cwd:join(dir,'project'),env,encoding:'utf8',timeout:75000,maxBuffer:1024*1024});assert.equal(installed.status,0,installed.stderr);
  const config=JSON.parse(readFileSync(configFile,'utf8'));assert.ok(config.plugins.includes('-fixture.disabled'));assert.equal(config.plugins.filter(p=>(typeof p==='string'?p:p.package)===spec).length,1);
  // Exact 2.2.5 registry cache contract: inspect the installed artifact,
  // not merely the configured package spec.
  const cache=join(dir,'cache','opencode','npm',spec);
  const generations=readdirSync(cache).filter(x=>/^\d+$/.test(x)).sort((a,b)=>Number(a)-Number(b));assert.ok(generations.length>0&&generations.length<=2);
  const generation=join(cache,generations.at(-1)),name='@matuto-ai/opencode-psst-connector',location=join(generation,'node_modules',name);
  const manifest=JSON.parse(readFileSync(join(location,'package.json'),'utf8'));assert.equal(manifest.name,name);assert.deepEqual(manifest.exports,{'.':'./plugin/index.mjs','./server':'./plugin/index.mjs','./tui':'./plugin/tui.mjs'});
  assert.deepEqual(manifest.dependencies,{zod:'4.1.8'});
  const lock=JSON.parse(readFileSync(join(generation,'package-lock.json'),'utf8'));assert.deepEqual(Object.keys(lock.packages[''].dependencies),[name]);
  assert.match(lock.packages['node_modules/'+name].resolved,/^https:\/\/registry\.npmjs\.org\//);
  const imported=spawnSync(process.execPath,['--input-type=module','-e',`import p from ${JSON.stringify(pathToFileURL(join(location,'plugin','index.mjs')).href)};if(p.id!=='matuto.psst'||typeof p.setup!=='function')throw Error('wrong native entry');`],{cwd:join(dir,'project'),env,encoding:'utf8',timeout:10000});assert.equal(imported.status,0,imported.stderr);
  assert.equal(existsSync(join(configDir,'cli.json')),false,'same-package TUI must not require a separate cli.json installation');
 }
});
