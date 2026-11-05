import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectStorage } from '../src/doctor.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'psst-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDirectory = join(root, 'state'), tokenFile = join(root, 'token');
  mkdirSync(stateDirectory, { mode: 0o700 });
  for (const file of ['installation.json', 'pending.json', 'installation-lock.sqlite', 'token'])
    writeFileSync(join(root, file), 'Not JSON or a database. Do not open.', { mode: 0o600 });
  return { root, options: { installation: root, stateDirectory, tokenFile } };
}
test('doctor inspects path metadata without parsing files, databases, creating paths or changing modes', t => {
  const f = fixture(t), before = readdirSync(f.root).map(name => [name, statSync(join(f.root, name)).mode]);
  assert.ok(inspectStorage(f.options).every(check => check.code === 'ok'));
  assert.deepEqual(readdirSync(f.root).map(name => [name, statSync(join(f.root, name)).mode]), before);
  const missing = join(f.root, 'absent');
  const result = inspectStorage({ installation: missing });
  assert.equal(result[0].code, 'missing'); assert.equal(result.at(-1).code, 'not_configured');
  assert.deepEqual(readdirSync(f.root).map(name => [name, statSync(join(f.root, name)).mode]), before);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(f.root));
});
test('doctor distinguishes insecure modes, wrong kinds, symlink targets and missing descendants of a symlink', t => {
  const f = fixture(t);
  chmodSync(f.options.tokenFile, 0o644);
  assert.equal(inspectStorage(f.options).at(-1).code, 'private_mode_required');
  assert.equal(inspectStorage({ ...f.options, stateDirectory: f.options.tokenFile })[4].code, 'wrong_path_type');
  const link = join(f.root, 'link'); symlinkSync(f.options.stateDirectory, link);
  assert.equal(inspectStorage({ ...f.options, stateDirectory: link })[4].code, 'path_symlink');
  assert.equal(inspectStorage({ ...f.options, stateDirectory: join(link, 'missing') })[4].code, 'path_symlink');
  assert.equal(inspectStorage({ ...f.options, stateDirectory: join(f.options.tokenFile, 'child') })[4].code, 'wrong_path_type');
  assert.equal(inspectStorage({ installation: 'relative/private-secret' })[0].code, 'invalid_path');
});
test('doctor reports unavailable inspection without exposing the failing path or error', t => {
  if (process.getuid?.() === 0) return;
  const f = fixture(t), opaque = join(f.root, 'private-secret');
  mkdirSync(opaque, { mode: 0o700 }); chmodSync(opaque, 0);
  try {
    assert.deepEqual(inspectStorage({ ...f.options, stateDirectory: join(opaque, 'child') })[4], { role: 'state_directory', code: 'inspection_unavailable' });
  } finally { chmodSync(opaque, 0o700); }
});
test('doctor reports wrong ownership with only the public role and fixed code', t => {
  if (!process.getuid) return;
  const f = fixture(t), uid = process.getuid();
  t.mock.method(process, 'getuid', () => uid + 1);
  assert.deepEqual(inspectStorage(f.options)[0], { role: 'installation_directory', code: 'wrong_owner' });
});
