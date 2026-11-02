import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const integration = new Set(['current-codemode.test.mjs', 'current-host.test.mjs', 'current-installer.test.mjs', 'current-package.test.mjs', 'current-plugin.test.mjs', 'enrollment.test.mjs', 'reference-pin.test.mjs']);
const mode = process.argv[2] ?? 'all';
if (!['all', 'local', 'integration'].includes(mode)) throw new Error('invalid_test_stage');
const files = readdirSync(new URL('../test/', import.meta.url)).filter(name => name.endsWith('.test.mjs') && (mode === 'all' || integration.has(name) === (mode === 'integration'))).sort().map(name => 'test/' + name);
if (!files.length) throw new Error('empty_test_stage');
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', env: {
  ...process.env,
  BROKER_REFERENCE_DIR: process.env.BROKER_REFERENCE_DIR ?? fileURLToPath(new URL('../vendor/broker', import.meta.url)),
  OPENCODE_TOOL_MODULE: process.env.OPENCODE_TOOL_MODULE ?? fileURLToPath(new URL('../src/tool-schema.mjs', import.meta.url)),
} });
process.exitCode = result.status ?? 1;
