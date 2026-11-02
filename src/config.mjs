import { openSync, closeSync, readFileSync, fstatSync, constants, mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, dirname, resolve } from 'node:path';
const fail = () => { throw new Error('psst_configuration_invalid'); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function readConfig(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail();
  let fd, marked = false;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16384 || process.getuid && stat.uid !== process.getuid()) fail();
    let value = JSON.parse(readFileSync(fd, 'utf8'));
    if (value?.format === 'broker-client-bundle-v1') {
      const allowed = ['format', 'protocol_version', 'broker_url', 'token_file', 'file_paths_relative_to', 'authorization_header', 'authorization_scheme', 'insecure_development', 'allowed_client_types', 'scope', 'ca_file', 'enrollment_receipt_file', 'registration_version'];
      if (Object.keys(value).some(key => !allowed.includes(key)) || value.protocol_version !== '1'
        || value.registration_version !== undefined && ![1,2].includes(value.registration_version)
        || value.file_paths_relative_to !== 'connection_file_directory' || value.authorization_header !== 'Authorization'
        || value.authorization_scheme !== 'Bearer' || value.insecure_development !== false
        || !Array.isArray(value.allowed_client_types) || value.allowed_client_types.length !== 1 || value.allowed_client_types[0] !== 'opencode'
        || value.enrollment_receipt_file !== undefined && value.enrollment_receipt_file !== 'enrollment.json'
        || value.token_file !== 'token' || typeof value.scope !== 'string') fail();
      marked = value.enrollment_receipt_file === 'enrollment.json';
      const base = dirname(realpathSync(path));
      value = { broker: { url: value.broker_url, tokenFile: resolve(base, value.token_file),
        ...(value.registration_version !== undefined ? { registrationVersion: value.registration_version } : {}),
        ...(value.ca_file ? { caFile: resolve(base, value.ca_file) } : {}) }, stateDirectory: resolve(base, 'state') };
    }
    if (!plain(value) || Object.keys(value).some(key => !['broker', 'stateDirectory', 'name', 'project', 'projectEnv'].includes(key))
      || !plain(value.broker) || Object.keys(value.broker).some(key => !['url', 'tokenFile', 'caFile', 'registrationVersion'].includes(key))
      || typeof value.stateDirectory !== 'string' || !isAbsolute(value.stateDirectory)
      || value.broker.registrationVersion !== undefined && ![1, 2].includes(value.broker.registrationVersion)
      || typeof value.broker.tokenFile !== 'string' || !isAbsolute(value.broker.tokenFile)
      || value.broker.caFile !== undefined && (typeof value.broker.caFile !== 'string' || !isAbsolute(value.broker.caFile))
      || value.project !== undefined && (typeof value.project !== 'string' || !value.project.trim() || [...value.project].length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(value.project))
      || value.projectEnv !== undefined && (typeof value.projectEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.projectEnv))
      || value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || /[\x00-\x1f\x7f]/.test(value.name))) fail();
    const url = new URL(value.broker.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail();
    if (marked) Object.defineProperty(value, 'enrollmentReceiptRequired', { value: true });
    return value;
  } catch { fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || realpathSync(path) !== path
    || process.getuid && stat.uid !== process.getuid()) fail();
  return path;
}
