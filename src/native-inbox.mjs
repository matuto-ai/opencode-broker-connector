import { createHash } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync, constants, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../vendor/broker/src/protocol.mjs';
import { privateDirectory } from './config.mjs';

/** Reopen only this installation + native server store + exact native session.
 * Exclusive Inbox ownership protects concurrent owners. Never reset a partial,
 * foreign or unreadable manifest: its broker/native effects may be unknown.
 */
export function openNativeInbox({ reference, settings, binding, incarnationOwner = false }) {
  const key = createHash('sha256').update(canonical({ binding, broker: settings.broker.url })).digest('hex');
  const directory = privateDirectory(join(privateDirectory(settings.stateDirectory), 'opencode-v2-' + key));
  if (!incarnationOwner) {
    try { lstatSync(join(directory, 'current-incarnation.json')); throw new Error('native_incarnation_required'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const path = join(directory, 'binding.json');
  let fd;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, canonical({ version: 1, binding, broker: settings.broker.url, identity: reference.newSessionIdentity('opencode') }) + '\n');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    const parent = openSync(directory, constants.O_RDONLY); try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
  fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192 || process.getuid && stat.uid !== process.getuid()) throw new Error('native_binding_unavailable');
    manifest = JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
  if (manifest.version !== 1 || manifest.broker !== settings.broker.url || canonical(manifest.binding) !== canonical(binding)
    || Object.keys(manifest).sort().join(',') !== 'binding,broker,identity,version') throw new Error('native_binding_mismatch');
  return new reference.Inbox({ directory, identity: manifest.identity });
}
