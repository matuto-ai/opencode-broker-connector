import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { verifyPackageArtifact, assertRuntimeVersion } from '../scripts/package-provenance.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'psst-package-drift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), installed = join(dir, 'installed');
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@fixture/connector', version: '7.2.1' }));
  writeFileSync(join(source, 'src/runtime.mjs'), 'export const active = true;');
  cpSync(source, installed, { recursive: true });
  return { source, installed, runtimeDirectories: ['src'], artifact: { name: '@fixture/connector', version: '7.2.1', files: [{ path: 'package.json' }, { path: 'src/runtime.mjs' }] } };
}
// Synthetic metadata cases deliberately cover failure detection, not host health.
test('package guard rejects stale version metadata', t => {
  const f = fixture(t); f.artifact.version = '7.2.0';
  assert.throws(() => verifyPackageArtifact(f), /packed package version/);
});
test('package guard rejects stale code even when package version is unchanged', t => {
  const f = fixture(t); writeFileSync(join(f.source, 'src/runtime.mjs'), 'export const active = false;');
  assert.throws(() => verifyPackageArtifact(f), /differs from checkout/);
});
test('package guard rejects missing runtime files', t => {
  const f = fixture(t); f.artifact.files.pop();
  assert.throws(() => verifyPackageArtifact(f), /runtime file omitted/);
});
test('runtime guard rejects a stale running connector version', () => {
  assert.throws(() => assertRuntimeVersion('7.2.0', '7.2.1'), /running connector version/);
  assertRuntimeVersion('7.2.1', '7.2.1');
});

// The source and artifact can agree with each other while both differ from CI's
// selected commit. This regression prevents that self-consistent false positive.
test('CI package guard binds packaged bytes to the exact selected commit', t => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', f.source, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet'); git('add', '.');
  git('-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'disposable package source');
  const expectedCommit = git('rev-parse', 'HEAD');
  assert.equal(verifyPackageArtifact({ ...f, expectedCommit }).source_commit, expectedCommit);
  assert.throws(() => verifyPackageArtifact({ ...f, expectedCommit: '0'.repeat(40) }), /different CI checkout/);
  for (const root of [f.source, f.installed]) writeFileSync(join(root, 'src/runtime.mjs'), 'export const active = false;');
  assert.throws(() => verifyPackageArtifact({ ...f, expectedCommit }), /changed after checkout/);
});
