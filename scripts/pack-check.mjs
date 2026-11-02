import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const packed=spawnSync('npm',['pack','--dry-run','--json','--ignore-scripts'],{encoding:'utf8'});assert.equal(packed.status,0,packed.stderr);
const artifact=JSON.parse(packed.stdout)[0],files=artifact.files.map(x=>x.path);
assert.equal(artifact.name,'@matuto-ai/opencode-psst-connector');assert.equal(artifact.version,'0.6.0');
for(const file of ['plugin/tui.mjs','src/active-presence.mjs','src/native-metadata.mjs','src/project-metadata.mjs','plugin/index.mjs','src/native-plugin.mjs','src/native-delivery.mjs','src/message-preview.mjs','src/native-setup.mjs','src/native-inbox.mjs','src/identity-recovery.mjs','src/tool-schema.mjs','src/installation.mjs','vendor/enrollment/approval.mjs','vendor/broker/reference/inbox.mjs','vendor/broker/LICENSE','README.md','LICENSE'])assert.ok(files.includes(file),`Missing ${file}`);
assert.equal(files.some(path=>/(^|\/)(test|node_modules|\.github|v2|bin|examples)(\/|$)|\.token$|\.sqlite$|connection\.json$|plugin\/(v2|owned-run)\./.test(path)),false);
console.log(`Verified ${files.length} packaged files; same-package server and TUI entries, no Git wrapper, tests, credentials or state.`);
