import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export function verifyTestSource(directory, expectedCommit) {
  assert.match(expectedCommit ?? '', /^[a-f0-9]{40}$/, 'expected source must be a resolved commit');
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  assert.equal(commit, expectedCommit, 'test server checkout differs from resolved current source');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'test server source must be clean');
  const metadata = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  assert.match(metadata.version, /^\d+\.\d+\.\d+/);
  return { repository: 'matuto-ai/psst', source_commit: commit, source_tree: git('rev-parse', 'HEAD^{tree}'),
    package_version: metadata.version, evidence: 'current-source disposable test fixture, not a deployed server' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log('TEST_SOURCE_PROVENANCE ' + JSON.stringify(verifyTestSource(process.argv[2], process.argv[3])));
