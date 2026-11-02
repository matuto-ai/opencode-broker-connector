import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory } from './config.mjs';
import { canonical } from '../vendor/broker/src/protocol.mjs';

// Availability preference, NOT authentication. Processes with the same UID can
// forge this signal. It never supplies a binding, credential or tool authority.
export const PRESENCE_TTL = 5000;
const validID = s => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(s);
const ownerID = s => typeof s === 'string' && /^[a-f0-9-]{36}$/.test(s);
export function processIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('native_selection_invalid');
  if (process.platform !== 'linux') { process.kill(pid, 0); return { pid, start: null, boot: null }; }
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return { pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}
function checkedDirectory(path) {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.mode & 0o077 || process.getuid && s.uid !== process.getuid() || realpathSync(path) !== path) throw new Error('native_selection_path_unsafe');
  return path;
}
export function presenceDirectory(root, location, { create = false } = {}) {
  checkedDirectory(root);
  const directory = realpathSync(location.directory);
  const key = createHash('sha256').update(canonical({ directory, workspaceID: location.workspaceID ?? null })).digest('hex');
  const path = join(root, 'active-tui-' + key);
  if (create) privateDirectory(path);
  return checkedDirectory(path);
}
function read(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.mode & 0o077 || process.getuid && s.uid !== process.getuid() || s.size > 2048) throw new Error('native_selection_invalid');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
export function createPresenceWriter({ directory, owner = randomUUID(), counter = { seq: 0 }, now = Date.now }) {
  checkedDirectory(directory);
  if (!ownerID(owner)) throw new Error('native_selection_invalid');
  const identity = processIdentity(), path = join(directory, owner + '.json');
  const generation = randomUUID();
  let stopped = false;
  return {
    owner,
    write(sessionID) {
      if (stopped || sessionID !== null && !validID(sessionID)) throw new Error('native_selection_invalid');
      checkedDirectory(directory);
      const value = { version: 1, owner, ...identity, generation, seq: ++counter.seq, issued: now(), sessionID };
      const temp = join(directory, `.${owner}-${randomUUID()}.tmp`);
      let fd;
      try {
        fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, JSON.stringify(value)); closeSync(fd); fd = undefined;
        renameSync(temp, path);
      } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
    },
    stop() { stopped = true; try { checkedDirectory(directory); if (read(path).generation === generation) unlinkSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
  };
}
export function createPresenceReader({ directory, now = Date.now }) {
  const seen = new Map();
  return {
    selected() {
      checkedDirectory(directory);
      const names = readdirSync(directory).filter(n => n.endsWith('.json'));
      if (names.length > 4096) throw new Error('native_selection_owner_limit');
      const selected = new Set(); let liveOwners = 0;
      for (const [id, value] of seen) if (value.expires <= now()) seen.delete(id);
      for (const name of names) {
        try {
          const v = read(join(directory, name)), time = now();
          // Dedicated ephemeral files only; never remove bindings or journals.
          if (v.version === 1 && ownerID(v.owner) && name === v.owner + '.json' && Number.isSafeInteger(v.issued) && time - v.issued >= PRESENCE_TTL) {
            if (canonical(read(join(directory, name))) === canonical(v)) unlinkSync(join(directory, name));
            continue;
          }
          if (v.version !== 1 || !ownerID(v.owner) || name !== v.owner + '.json' || !Number.isSafeInteger(v.seq) || v.seq < 1
            || !Number.isSafeInteger(v.issued) || v.issued > time || time - v.issued >= PRESENCE_TTL
            || v.sessionID !== null && !validID(v.sessionID)) continue;
          const identity = processIdentity(v.pid);
          if (identity.start !== v.start || identity.boot !== v.boot) continue;
          const previous = seen.get(v.owner);
          if (previous && (v.seq < previous.seq || v.seq === previous.seq && canonical(v) !== previous.value)) continue;
          liveOwners++;
          if (!seen.has(v.owner) && seen.size >= 128) continue;
          seen.set(v.owner, { seq: v.seq, value: canonical(v), expires: v.issued + PRESENCE_TTL });
          if (v.sessionID) selected.add(v.sessionID);
        } catch { /* A malformed/stale owner is not a reason to activate anything. */ }
      }
      for (const [id, value] of seen) if (value.expires <= now()) seen.delete(id);
      if (liveOwners > 64) throw new Error('native_selection_owner_limit');
      return selected;
    },
  };
}
