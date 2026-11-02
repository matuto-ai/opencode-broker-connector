import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Host } from '@opencode/plugin/host';
const root=fileURLToPath(new URL('../',import.meta.url));

test('root npm manifest has one current native server and registry-only production dependency',()=>{
 const pkg=JSON.parse(readFileSync(join(root,'package.json'))),lock=JSON.parse(readFileSync(join(root,'package-lock.json')));
 assert.equal(pkg.name,'@matuto-ai/opencode-broker-connector');assert.equal(pkg.version,'0.5.1');
 assert.deepEqual(pkg.exports,{'.':'./plugin/index.mjs','./server':'./plugin/index.mjs'});assert.equal(pkg.main,pkg.exports['.']);
 assert.deepEqual(pkg.dependencies,{zod:'4.1.8'});assert.deepEqual(lock.packages[''].dependencies,pkg.dependencies);
 assert.equal(pkg.bin,undefined);assert.equal(existsSync(join(root,'v2')),false);
 for(const entry of Object.values(lock.packages))if(entry.resolved)assert.match(entry.resolved,/^https:\/\/registry\.npmjs\.org\//);
 assert.equal(Object.keys(lock.packages).some(p=>p.endsWith('node_modules/@opencode/cli')||p.includes('node_modules/opencode-linux')),false);
});

test('actual root tarball installs without Git and the official loader selects only matuto.psst',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'psst-root-package-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const packed=spawnSync('npm',['pack','--json','--ignore-scripts','--pack-destination',dir],{cwd:root,encoding:'utf8'});assert.equal(packed.status,0,packed.stderr);
 const artifact=JSON.parse(packed.stdout)[0];assert.equal(artifact.name,'@matuto-ai/opencode-broker-connector');
 assert.equal(artifact.files.some(x=>/(^|\/)(v2|node_modules|test)\//.test(x.path)),false);
 const consumer=join(dir,'consumer'),bin=join(dir,'bin'),gitLog=join(dir,'git-invoked');mkdirSync(consumer);mkdirSync(bin);
 writeFileSync(join(consumer,'package.json'),'{"name":"isolated-consumer","private":true,"type":"module"}');
 writeFileSync(join(bin,'git'),`#!/bin/sh\nprintf attempted > '${gitLog}'\nexit 97\n`,{mode:0o700});
 const installed=spawnSync('npm',['install','--ignore-scripts','--omit=dev','--no-audit','--no-fund',join(dir,artifact.filename)],{cwd:consumer,encoding:'utf8',timeout:30000,env:{...process.env,PATH:bin+':'+process.env.PATH,GIT_TERMINAL_PROMPT:'0'}});assert.equal(installed.status,0,installed.stderr);assert.equal(existsSync(gitLog),false,'no Git invocation is allowed');
 const directory=join(consumer,'node_modules','@matuto-ai','opencode-broker-connector');
 const entries=Host.resolve({directory,name:artifact.name});assert.match(entries.server,/plugin\/index\.mjs$/);assert.equal(entries.tui,undefined);assert.equal(entries.rpc,undefined);assert.equal(entries.gui,undefined);
 const module=await Host.load(entries.server),plugin=module.default??module;assert.equal(plugin.id,'matuto.psst');assert.equal(typeof plugin.setup,'function');
 const {loadBrokerReference}=await import(new URL('../src/reference.mjs',import.meta.url));await loadBrokerReference(join(directory,'vendor','broker'));
 assert.deepEqual(readdirSync(join(consumer,'node_modules')).filter(x=>!x.startsWith('.')).sort(),['@matuto-ai','zod']);
 assert.equal(existsSync(join(directory,'plugin','tui.mjs')),false);assert.equal(existsSync(join(directory,'v2')),false);
});
