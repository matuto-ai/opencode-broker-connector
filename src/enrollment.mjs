import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';

export const ENROLLMENT_SHA256 = 'afeab00d7c2d6768d3537bd7c350e249768897bf81eff9b4ae9796f7c3f9dbe9';
async function helper() {
  const path = fileURLToPath(new URL('../vendor/enrollment/enrollment.mjs', import.meta.url));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536
    || createHash('sha256').update(readFileSync(path)).digest('hex') !== ENROLLMENT_SHA256) throw new Error('enrollment_snapshot_mismatch');
  return import('../vendor/enrollment/enrollment.mjs');
}

/** Legacy environment mode may load an existing bundle, never issue credentials. */
export async function readExistingConnection(path, { identityRecovery = false } = {}) {
  const settings = readConfig(path);
  if (settings.enrollmentReceiptRequired) {
    try { settings.enrollment = (await helper()).readEnrollmentReceipt({ connectionFile: path, clientType: 'opencode' }); }
    catch (error) {
      // The pinned helper checks receipt/token/type/origin integrity before its
      // final expiry check. This mode is only for existing identity discovery,
      // never connection, activation, selection or enrollment.
      if (!identityRecovery || error.code !== 'credential_expired') throw error;
      settings.authorizationExpired = true;
    }
  }
  return settings;
}

/** Only the native explicit-connect command calls this. No model tool accepts a secret. */
export function createConnectionLoader({ directory, stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
  loadHelper = helper } = {}) {
  if (!isAbsolute(directory) || !isAbsolute(stateHome)) throw new Error('private_directory_required');
  return async function connectFile(path, { clientType, sessionID }) {
    if (clientType !== 'opencode' || typeof path !== 'string' || !isAbsolute(path)
      || /[\x00-\x1f\x7f]/.test(path) || typeof sessionID !== 'string' || !sessionID) throw new Error('private_file_required');
    let settings;
    try { settings = readConfig(path); } catch { /* The shared helper independently validates pairing files. */ }
    if (settings) {
      // The explicit bundle marker makes missing/corrupt receipts fatal.
      if (settings.enrollmentReceiptRequired) {
        const api = await loadHelper();
        settings.enrollment = api.readEnrollmentReceipt({ connectionFile: path, clientType });
      }
    } else {
      const api = await loadHelper();
      const key = createHash('sha256').update(JSON.stringify([resolve(directory), sessionID])).digest('hex');
      const result = await api.connectPairingFile({ pairingFile: path,
        directory: join(stateHome, 'psst', 'opencode', key), clientType });
      settings = readConfig(result.connectionFile);
      settings.enrollment = api.readEnrollmentReceipt({ connectionFile: result.connectionFile, clientType });
    }
    if (settings.enrollment && Date.parse(settings.enrollment.expiresAt) <= Date.now()) throw new Error('credential_expired');
    return settings;
  };
}
