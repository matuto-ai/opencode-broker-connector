import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const packed=spawnSync('npm',['pack','--dry-run','--json','--ignore-scripts'],{encoding:'utf8'});assert.equal(packed.status,0,packed.stderr);
const artifact=JSON.parse(packed.stdout)[0],files=artifact.files.map(x=>x.path);
assert.equal(artifact.name,'@matuto-ai/opencode-broker-connector');assert.equal(artifact.version,'0.5.1');
for(const file of ['plugin/index.mjs','src/native-plugin.mjs','src/native-delivery.mjs','src/message-preview.mjs','src/native-setup.mjs','src/native-inbox.mjs','src/identity-recovery.mjs','src/tool-schema.mjs','src/installation.mjs','vendor/enrollment/approval.mjs','vendor/broker/reference/inbox.mjs','vendor/broker/LICENSE','README.md','LICENSE'])assert.ok(files.includes(file),`Missing ${file}`);
assert.equal(files.some(path=>/(^|\/)(test|node_modules|\.github|v2|bin|examples)(\/|$)|\.token$|\.sqlite$|connection\.json$|plugin\/(tui|v2|owned-run)\./.test(path)),false);
console.log(`Verified ${files.length} packaged files; one current server entry, no Git wrapper, tests, credentials or state.`);
