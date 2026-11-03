import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
function hostStage(env) {
  return spawnSync(process.execPath, ['scripts/test.mjs', 'host'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, ...env },
  });
}

test('mandatory host stage fails before testing when a prerequisite is absent', t => {
  const dir = mkdtempSync(join(tmpdir(), 'psst-host-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [env, error] of [
    [{}, /host_stage_requires_absolute_OPENCODE_BINARY/],
    [{ OPENCODE_BINARY: 'opencode' }, /host_stage_requires_absolute_OPENCODE_BINARY/],
    [{ OPENCODE_BINARY: process.execPath }, /host_stage_requires_PSST_APPROVAL_BROKER_DIR/],
    [{ OPENCODE_BINARY: join(dir, 'absent'), PSST_APPROVAL_BROKER_DIR: dir }, /ENOENT/],
    [{ OPENCODE_BINARY: process.execPath, PSST_APPROVAL_BROKER_DIR: dir }, /approval-tls-fixture\.mjs/],
  ]) {
    const result = hostStage(env);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, error);
    assert.equal(result.stdout, '', 'must not run an optional/skipped test stage');
  }
  const nonExecutable = join(dir, 'not-executable');
  writeFileSync(nonExecutable, 'fixture only', { mode: 0o600 });
  const result = hostStage({ OPENCODE_BINARY: nonExecutable, PSST_APPROVAL_BROKER_DIR: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EACCES/);
});

test('CI runs official host tests in a bounded parallel job with verified fixtures', () => {
  const workflow = readFileSync(new URL('../.github/workflows/verify.yaml', import.meta.url), 'utf8');
  const job = workflow.split('\n  official-host:\n')[1];
  assert.ok(job, 'official-host job must exist');
  assert.match(job, /timeout-minutes: 3/);
  assert.doesNotMatch(job, /continue-on-error:|\n    needs:|\n    if:/);
  assert.match(job, /npm ci --ignore-scripts --omit=dev --omit=peer --no-audit --no-fund/);
  assert.match(job, /https:\/\/github\.com\/anomalyco\/opencode\/releases\/download\/v2\.2\.5\/opencode-linux-x64\.tar\.gz/);
  assert.match(job, /09f44302c10fd036912f59c81fd1aef5df45dd06f649197f9dfc9bbe2a79614e  opencode-linux-x64\.tar\.gz/);
  assert.match(job, /sha256sum --check --strict/);
  assert.ok(job.indexOf('sha256sum --check --strict') < job.indexOf('tar --extract'));
  assert.match(job, /ref: 72f5d2d1b834e02cfb6b2f7dc11c6f1a55729344/);
  assert.match(job, /run: node scripts\/test\.mjs host/);
  assert.match(job, /OPENCODE_BINARY: \$\{\{ runner\.temp \}\}\/opencode-host\/opencode/);
  assert.match(job, /PSST_APPROVAL_BROKER_DIR: \$\{\{ github\.workspace \}\}\/\.test-fixtures\/psst-approval/);
  assert.doesNotMatch(job, /secrets\.|NODE_TLS_REJECT_UNAUTHORIZED/);
});
