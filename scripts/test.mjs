import { accessSync, constants, readdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const integration = new Set(['current-codemode.test.mjs', 'current-installer.test.mjs', 'current-package.test.mjs', 'current-plugin.test.mjs', 'enrollment.test.mjs', 'reference-pin.test.mjs']);
const host = new Set(['current-host.test.mjs']);
const mode = process.argv[2] ?? 'all';
if (!['all', 'local', 'integration', 'host'].includes(mode)) throw new Error('invalid_test_stage');
if (mode === 'host') {
  const binary = process.env.OPENCODE_BINARY;
  const approval = process.env.PSST_APPROVAL_BROKER_DIR;
  if (!binary || !isAbsolute(binary)) throw new Error('host_stage_requires_absolute_OPENCODE_BINARY');
  if (!approval) throw new Error('host_stage_requires_PSST_APPROVAL_BROKER_DIR');
  accessSync(binary, constants.X_OK);
  accessSync(resolve(approval, 'test/approval-tls-fixture.mjs'), constants.R_OK);
}
const files = readdirSync(new URL('../test/', import.meta.url)).filter(name => name.endsWith('.test.mjs') && (mode === 'all' || (mode === 'host' ? host.has(name) : !host.has(name) && integration.has(name) === (mode === 'integration')))).sort().map(name => 'test/' + name);
if (!files.length) throw new Error('empty_test_stage');
const result = spawnSync(process.execPath, ['--test', ...(mode === 'host' ? ['--test-reporter=tap'] : []), ...files], { cwd: root, stdio: 'inherit', env: {
  ...process.env,
  BROKER_REFERENCE_DIR: process.env.BROKER_REFERENCE_DIR ?? fileURLToPath(new URL('../vendor/broker', import.meta.url)),
  OPENCODE_TOOL_MODULE: process.env.OPENCODE_TOOL_MODULE ?? fileURLToPath(new URL('../src/tool-schema.mjs', import.meta.url)),
} });
process.exitCode = result.status ?? 1;
