import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));

export function assertRuntimeVersion(actual, expected) {
  assert.equal(actual, expected, 'running connector version differs from the built package');
}

// Compare actual installed bytes, not just two copies of a version string. A
// source edit without a version bump must invalidate an older packaged result.
export function verifyPackageArtifact({ source, installed, artifact, archive, runtimeDirectories, expectedCommit = process.env.GITHUB_SHA }) {
  const sourcePackage = json(join(source, 'package.json'));
  const installedPackage = json(join(installed, 'package.json'));
  assert.match(sourcePackage.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(artifact.name, sourcePackage.name, 'packed package name');
  assert.equal(artifact.version, sourcePackage.version, 'packed package version');
  assert.equal(installedPackage.name, sourcePackage.name, 'installed package name');
  assert.equal(installedPackage.version, sourcePackage.version, 'installed package version');
  const paths = artifact.files.map(file => file.path);
  assert.equal(new Set(paths).size, paths.length, 'duplicate artifact path');
  assert.ok(paths.includes('package.json'), 'package metadata missing');
  const required = [];
  const visit = path => {
    for (const entry of readdirSync(join(source, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), `runtime symlink is not a reproducible source: ${child}`);
      if (entry.isDirectory()) visit(child); else required.push(child);
    }
  };
  for (const directory of runtimeDirectories) visit(directory);
  for (const path of required) assert.ok(paths.includes(path), `runtime file omitted from artifact: ${path}`);
  const files = {};
  for (const path of paths) {
    assert.ok(!isAbsolute(path) && !path.split('/').some(part => !part || part === '..' || part === '.'), 'unsafe artifact path');
    assert.ok(lstatSync(join(installed, path)).isFile(), `not a regular installed file: ${path}`);
    const expected = sha256(readFileSync(join(source, path)));
    assert.equal(sha256(readFileSync(join(installed, path))), expected, `installed artifact differs from checkout: ${path}`);
    files[path] = expected;
  }
  const git = args => {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const commit = git(['rev-parse', 'HEAD']);
  if (expectedCommit) {
    assert.equal(commit, expectedCommit, 'artifact built from a different CI checkout');
    const tracked = new Set((git(['ls-files', '-z', '--', ...paths]) ?? '').split('\0'));
    for (const path of paths) assert.ok(tracked.has(path), `packaged source is not committed: ${path}`);
    const diff = spawnSync('git', ['-C', source, 'diff', '--exit-code', 'HEAD', '--', ...paths], { encoding: 'utf8' });
    assert.equal(diff.status, 0, 'packaged source changed after checkout');
  }
  return { name: sourcePackage.name, version: sourcePackage.version, source_commit: commit,
    source_dirty: git(['status', '--porcelain', '--untracked-files=all']) !== '',
    archive_sha256: archive ? sha256(readFileSync(archive)) : null,
    files_sha256: files, evidence: 'installed-package component check; not authenticated native-host or production acceptance' };
}
