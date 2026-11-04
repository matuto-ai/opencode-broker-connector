import { openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync, lstatSync, realpathSync, renameSync, unlinkSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { privateDirectory } from './config.mjs';
import { readExistingConnection } from './enrollment.mjs';

export function installationDirectory(env = process.env) {
  const directory = env.PSST_OPENCODE_CONFIG_DIR || join(env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode'), 'psst');
  if (!isAbsolute(directory)) throw new Error('psst_private_absolute_directory_required');
  return directory;
}
function read(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192 || process.getuid && stat.uid !== process.getuid()) throw new Error();
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (value?.format !== 'psst-opencode-installation-v1' || typeof value.revision !== 'string'
      || !isAbsolute(value.connectionFile) || Object.keys(value).some(k => !['format', 'revision', 'connectionFile'].includes(k))) throw new Error();
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('psst_installation_invalid'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readSelection(directory = installationDirectory()) {
  try {
    const stat = lstatSync(directory);
    if (!isAbsolute(directory) || !stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077
      || realpathSync(directory) !== directory || process.getuid && stat.uid !== process.getuid()) throw new Error('psst_installation_invalid');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return read(join(directory, 'installation.json'));
}
export async function readInstallation(directory = installationDirectory(), readOptions) {
  const selected = readSelection(directory);
  return selected ? readExistingConnection(selected.connectionFile, readOptions) : undefined;
}
/** No network. Compare-and-swap fences concurrent UI flows; never deletes old bundles/inboxes. */
export async function selectInstallation({ directory = installationDirectory(), connectionFile, expectedRevision, signal, pendingFlowId, verify }) {
  await readExistingConnection(connectionFile); // exact broker approval receipt, type, URL and token binding
  if (verify !== undefined && (typeof verify !== 'function' || !await verify())) throw new Error('psst_setup_binding_changed');
  return withSelectionLock(directory, () => {
  let temp;
  try {
    if (signal?.aborted) throw new Error('psst_setup_cancelled');
    if (pendingFlowId) {
      const pending = readPendingFile(directory);
      if (!pending || pending.paused || pending.flowId !== pendingFlowId) throw new Error('psst_setup_cancelled');
    }
    const previous = readSelection(directory);
    if (pendingFlowId && previous?.connectionFile === connectionFile) {
      writePending(directory, { ...readPendingFile(directory), paused: true });
      return previous; // Reconcile crash after committed selection, not a replacement.
    }
    if ((previous?.revision ?? null) !== expectedRevision) throw new Error('psst_selection_changed');
    const value = { format: 'psst-opencode-installation-v1', revision: randomUUID(), connectionFile };
    temp = join(directory, `.selection-${randomUUID()}`);
    const out = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(out, JSON.stringify(value) + '\n'); fsyncSync(out); } finally { closeSync(out); }
    renameSync(temp, join(directory, 'installation.json')); temp = null;
    const dir = openSync(directory, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
    if (pendingFlowId) writePending(directory, { ...readPendingFile(directory), paused: true });
    return value;
  } finally { if (temp) unlinkSync(temp); }
  });
}

function readPendingFile(directory) {
  let fd;
  try {
    fd = openSync(join(directory, 'pending.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192 || process.getuid && stat.uid !== process.getuid()) throw new Error();
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    const url = new URL(value.brokerUrl);
    if (value.format !== 'psst-opencode-pending-v1' || typeof value.flowId !== 'string' || typeof value.paused !== 'boolean'
      || value.expectedRevision !== null && typeof value.expectedRevision !== 'string'
      || value.requestId !== null && typeof value.requestId !== 'string'
      || value.previousRequestId !== undefined && value.previousRequestId !== null && typeof value.previousRequestId !== 'string'
      || value.owner !== undefined && (!value.owner || Object.keys(value.owner).sort().join(',') !== 'binding,sessionID'
        || typeof value.owner.sessionID !== 'string' || value.owner.sessionID.length > 256
        || typeof value.owner.binding !== 'string' || value.owner.binding.length > 4096)
      || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('psst_pending_invalid'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readPending(directory = installationDirectory()) {
  readSelection(directory); // existing directory ownership/canonical-path check, no creation
  return readPendingFile(directory);
}
function withSelectionLock(directory, action) {
  privateDirectory(directory);
  const lock = join(directory, 'installation-lock.sqlite');
  try { const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); }
  catch (error) { if (error.code !== 'EEXIST') throw new Error('psst_selection_busy'); }
  const stat = lstatSync(lock);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('psst_installation_invalid');
  let db;
  try {
    db = new DatabaseSync(lock); db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    const result = action(); db.exec('COMMIT'); return result;
  } finally { db?.close(); } // OS releases the lock even after a killed process; no stale-lock reset.
}
function writePending(directory, value) {
  const temp = join(directory, `.pending-${randomUUID()}`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, join(directory, 'pending.json'));
  const dir = openSync(directory, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function savePending({ directory = installationDirectory(), brokerUrl, expectedRevision, requestId = null, previousRequestId, owner }) {
  return withSelectionLock(directory, () => {
    readPendingFile(directory); // Explicit setup is not permission to reset corrupt state.
    const value = { format: 'psst-opencode-pending-v1', flowId: randomUUID(), brokerUrl, expectedRevision, requestId, paused: false, ...(owner ? { owner } : {}), ...(previousRequestId ? { previousRequestId } : {}) };
    writePending(directory, value); return value;
  });
}
export function updatePending({ directory = installationDirectory(), flowId, paused, requestId }) {
  return withSelectionLock(directory, () => {
    const value = readPendingFile(directory);
    if (!value || value.flowId !== flowId) return false;
    writePending(directory, { ...value, ...(paused !== undefined ? { paused } : {}), ...(requestId !== undefined ? { requestId } : {}) });
    return true;
  });
}
