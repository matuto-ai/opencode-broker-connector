import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, appendFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyReference, REFERENCE_COMMIT } from '../src/reference-pin.mjs';

test('exact reviewed reference pin rejects tampered source before import', t => {
  const source = process.env.BROKER_REFERENCE_DIR ?? resolve('../ai-agent-msg-broker');
  assert.equal(REFERENCE_COMMIT, 'f32ddc79ec7b812062ed3f6de7b9a0c12a7128f3');
  verifyReference(source);
  const directory = mkdtempSync(join(tmpdir(), 'reference-pin-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(source, 'reference'), join(directory, 'reference'), { recursive: true });
  cpSync(join(source, 'src'), join(directory, 'src'), { recursive: true });
  verifyReference(directory);
  appendFileSync(join(directory, 'reference/runtime.mjs'), '\n// unexpected source change\n');
  assert.throws(() => verifyReference(directory), /reference_snapshot_mismatch/);
  rmSync(join(directory, 'reference/runtime.mjs'));
  symlinkSync(join(source, 'reference/runtime.mjs'), join(directory, 'reference/runtime.mjs'));
  assert.throws(() => verifyReference(directory), /reference_snapshot_mismatch/);
});
