import { readFileSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
export const REFERENCE_COMMIT = '92f84f1fda7453000272e2b4fac0725a55bd3556';
const HASHES = Object.freeze({
  "reference/inbox.mjs": "fbf0fa6096996cb9bc3f928e55f3eca496420880a03460e993dda3417b32ad88",
  "reference/client.mjs": "bb965e7d0bb697b2548a461e956ba68aa72e3c8ba8ed329f9989a5001079b0da",
  "reference/runtime.mjs": "f48e62feadc17993787906ce58e064c36bce66bfb0db8ffaa519f52bedbe76c9",
  "reference/tools.mjs": "e1836d5c33ed80a9e15c1ca9d07888c9db3caf40aeb2a115c813f74a45077c6e",
  "reference/mcp-stdio.mjs": "88c61c995f9285ef7e22c401d7f0cf50fefc7dd6c76ae79c6bcc94097a33a5c3",
  "reference/errors.mjs": "85b0d0736c5a439f7c66697c3b1ce6cee998cda744dd3169c856ebf2b82bd2a7",
  "src/protocol.mjs": "651f7d99987b58621070c5f24107ac621a09e325880506bc2e73cfe998d5b6aa"
});
/** Verify reviewed source bytes before importing any trusted local module. */
export function verifyReference(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('absolute_reference_required');
  for (const [file, digest] of Object.entries(HASHES)) {
    const path = join(directory, file), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || createHash('sha256').update(readFileSync(path)).digest('hex') !== digest) throw new Error('reference_snapshot_mismatch');
  }
}
