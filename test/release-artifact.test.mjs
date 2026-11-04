import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('release publishes the artifact saved by successful installed-package verification', () => {
  const workflow = readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8');
  assert.match(workflow, /PSST_VERIFIED_PACKAGE_OUTPUT_DIR: \$\{\{ runner\.temp \}\}\/verified-package/);
  assert.match(workflow, /sha256sum --check --strict SHA256SUMS/);
  assert.match(workflow, /npm publish \.\/\*\.tgz --ignore-scripts --access public --provenance/);
  assert.doesNotMatch(workflow, /npm publish --/);
});
