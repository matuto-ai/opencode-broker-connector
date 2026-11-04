import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyTestSource } from '../scripts/test-source.mjs';

test('source guard accepts resolved checkout and rejects stale commit or modified files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'psst-source-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '7.2.1' }));
  git('add', 'package.json');
  git('-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'disposable fixture');
  const head = git('rev-parse', 'HEAD');
  assert.equal(verifyTestSource(dir, head).package_version, '7.2.1');
  assert.throws(() => verifyTestSource(dir, '0'.repeat(40)), /differs from resolved/);
  assert.throws(() => verifyTestSource(dir, 'main'), /resolved commit/);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '7.2.2' }));
  assert.throws(() => verifyTestSource(dir, head), /must be clean/);
});
