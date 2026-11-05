import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';

// Metadata only: never open a file, database, credential or network connection.
function inspect(path, role, kind) {
  if (path === undefined) return { role, code: 'not_configured' };
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || normalize(path) !== path) return { role, code: 'invalid_path' };
  try {
    let target;
    for (let current = path; ; current = dirname(current)) {
      let stat;
      try { stat = lstatSync(current); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat?.isSymbolicLink()) return { role, code: 'path_symlink' };
      if (current !== path && stat && !stat.isDirectory()) return { role, code: 'wrong_path_type' };
      if (current === path) target = stat;
      if (dirname(current) === current) break;
    }
    if (!target) return { role, code: 'missing' };
    if (kind === 'directory' ? !target.isDirectory() : !target.isFile()) return { role, code: 'wrong_path_type' };
    if (process.getuid && target.uid !== process.getuid()) return { role, code: 'wrong_owner' };
    if (target.mode & 0o077) return { role, code: 'private_mode_required' };
    return { role, code: 'ok' };
  } catch (error) { return { role, code: error.code === 'ENOTDIR' ? 'wrong_path_type' : 'inspection_unavailable' }; }
}
export function inspectStorage({ installation, stateDirectory, tokenFile }) {
  return [inspect(installation, 'installation_directory', 'directory'),
    ...['installation.json', 'pending.json', 'installation-lock.sqlite'].map((file, index) =>
      inspect(typeof installation === 'string' && isAbsolute(installation) ? join(installation, file) : undefined,
        ['selection_file', 'pending_setup_file', 'selection_lock'][index], 'file')),
    inspect(stateDirectory, 'state_directory', 'directory'), inspect(tokenFile, 'credential_file', 'file')];
}
export const DOCTOR_ROLES = ['installation_directory', 'selection_file', 'pending_setup_file', 'selection_lock', 'state_directory', 'credential_file'];
export const DOCTOR_CODES = ['ok', 'not_configured', 'invalid_path', 'missing', 'path_symlink', 'wrong_path_type', 'wrong_owner', 'private_mode_required', 'inspection_unavailable'];
