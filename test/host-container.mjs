// Test-only launcher: the official server and real interactive TUI each run in
// newly created containers. The runner/broker stay outside; no Docker socket,
// user home, checkout, or credentials from the runner are mounted inside.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const HOST_IMAGE = 'node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df';
const label = 'io.matuto.psst.real-host-fixture';
const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'PSST_OPENCODE_CONFIG_DIR', 'NODE_EXTRA_CA_CERTS', 'OPENCODE_SERVER_PASSWORD', 'TERM', 'BUN_TMPDIR'];
function docker(args, timeout = 10000, env = process.env) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout, env });
  if (r.error) throw r.error;
  return r;
}
function checked(args, timeout = 10000) {
  const r = docker(args, timeout);
  assert.equal(r.status, 0, `Docker ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function inspect(name) {
  const r = docker(['container', 'inspect', name]);
  if (r.status === 0) return JSON.parse(r.stdout)[0];
  assert.match(r.stderr, /No such (?:object|container)/i, 'Docker inspection failed rather than proving removal');
  return null;
}
export function containerArgs(config, name, args, env = process.env) {
  const tty = args.includes('--server');
  const extraction = join(config.directory, 'cache', 'native-assets');
  assert.equal(env.BUN_TMPDIR, extraction, 'Bun embedded assets must use the owned extraction directory');
  const mount = (source, target = source) => `type=bind,src=${source},dst=${target},readonly`;
  return ['create', '--name', name, '--label', `${label}=${config.runID}`, '--init', '--network', 'host',
    '--user', `${config.uid}:${config.gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,mode=1777', '--interactive', ...(tty ? ['--tty'] : []),
    '--mount', `type=bind,src=${config.directory},dst=${config.directory}`,
    '--mount', mount(config.moduleSource, config.modules), '--mount', mount(config.binary, '/usr/local/bin/opencode'),
    // The authority's temporary directory is NOT mounted; only its public CA.
    ...(env.NODE_EXTRA_CA_CERTS.startsWith(config.directory + '/') ? [] : ['--mount', mount(env.NODE_EXTRA_CA_CERTS)]),
    '--workdir', config.project,
    ...envKeys.filter(k => env[k] !== undefined).flatMap(k => ['--env', k]),
    '--env', 'COLUMNS=120', '--env', 'LINES=40', HOST_IMAGE, '/usr/local/bin/opencode', ...args];
}
export function createContainerLauncher({ directory, project, binary, modules, operationTimeoutMs = 10000, reconcileMs = 10000 }) {
  directory = realpathSync(directory); project = realpathSync(project);
  assert.match(basename(directory), /^psst-native-host-/);
  assert.ok(project.startsWith(directory + '/'));
  checked(['version']); checked(['image', 'inspect', HOST_IMAGE]); // CI pulls once, before timed startup.
  const config = { directory, project, binary: realpathSync(binary), modules, moduleSource: realpathSync(modules),
    uid: process.getuid(), gid: process.getgid(), runID: randomUUID(), ledger: join(directory, 'containers.jsonl'), identities: join(directory, 'container-ids.jsonl') };
  writeFileSync(config.ledger, '', { mode: 0o600 });
  writeFileSync(config.identities, '', { mode: 0o600 });
  assert.ok(Number.isInteger(operationTimeoutMs) && operationTimeoutMs >= 100 && operationTimeoutMs <= 10000);
  assert.ok(Number.isInteger(reconcileMs) && reconcileMs >= 100 && reconcileMs <= 10000);
  const uncertain = new Set();
  const evidenceReceipt = join(tmpdir(), `psst-real-host-uncertain-${config.runID}.json`);
  const retainEvidence = () => uncertain.size > 0;
  const saveUncertainty = () => {
    if (uncertain.size) writeFileSync(evidenceReceipt, JSON.stringify({ runID: config.runID, directory, names: [...uncertain] }), { mode: 0o600 });
    else rmSync(evidenceReceipt, { force: true });
  };
  const records = () => readFileSync(config.ledger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const owned = record => {
    assert.match(record.name, new RegExp(`^psst-real-host-${config.runID}-[a-f0-9-]{36}$`));
    const info = inspect(record.name);
    if (info) assert.equal(info.Config.Labels[label], config.runID, 'refuse to touch a foreign container');
    return info;
  };
  return {
    retainEvidence, evidenceReceipt,
    prepare(args, env) {
      // Creation belongs to this supervising runner, never the short-grace PTY
      // wrapper. A wrapper cannot exist until Docker confirms the immutable ID.
      const name = `psst-real-host-${config.runID}-${randomUUID()}`;
      appendFileSync(config.ledger, JSON.stringify({ name }) + '\n');
      uncertain.add(name);saveUncertainty();
      let id;
      try {
        const result = docker(containerArgs(config, name, args, env), operationTimeoutMs, { ...process.env, ...env });
        assert.equal(result.status, 0, `Docker create failed: ${result.stderr}`);
        id = result.stdout.trim();assert.match(id, /^[a-f0-9]{64}$/);
      } catch (error) {
        // A timeout/failed response may have committed. Reconcile a positively
        // observed owned container; absence is NOT proof the create was aborted.
        const deadline = Date.now() + reconcileMs;
        do {
          const info = owned({ name });
          if (info) { checked(['rm', '--force', name]);uncertain.delete(name);saveUncertainty();break; }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        } while (Date.now() < deadline);
        if (retainEvidence()) throw new Error(`uncertain Docker create; private ownership receipt retained at ${evidenceReceipt}; fixture retained at ${directory}`, { cause: error });
        throw error;
      }
      appendFileSync(config.identities, JSON.stringify({ name, id }) + '\n');
      uncertain.delete(name);saveUncertainty();
      const launcher = join(directory, `opencode-container-${id}`);
      writeFileSync(launcher, `#!${process.execPath}\nimport { runContainerCLI } from ${JSON.stringify(import.meta.url)};\nawait runContainerCLI(${JSON.stringify(config)},${JSON.stringify(name)});\n`, { mode: 0o700 });
      return launcher;
    },
    assertRemoved() {
      assert.equal(retainEvidence(), false, `uncertain container creation; evidence retained at ${directory}`);
      const all = records();
      assert.ok(all.length >= 2, 'both real server and TUI must have created containers');
      assert.equal(new Set(all.map(r => r.name)).size, all.length, 'every launch uses a fresh name');
      const created = readFileSync(config.identities, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.deepEqual(created.map(r => r.name).sort(), all.map(r => r.name).sort(), 'every launch must create a real container');
      assert.equal(new Set(created.map(r => r.id)).size, all.length, 'reopened host must have new Docker container IDs');
      for (const record of all) assert.equal(owned(record), null, `container still exists: ${record.name}`);
    },
    cleanup() {
      const failures = [], leftovers = [];
      for (const record of records()) try { if (owned(record)) { leftovers.push(record.name); checked(['rm', '--force', record.name], operationTimeoutMs); } } catch (e) { uncertain.add(record.name);saveUncertainty();failures.push(e); }
      if (failures.length) throw new AggregateError(failures, `real_host_container_cleanup_failed; ownership receipt retained at ${evidenceReceipt}; fixture retained at ${directory}`);
      this.assertRemoved();
      assert.deepEqual(leftovers, [], 'wrapper shutdown leaked containers; outer cleanup removed them');
    },
  };
}
export async function runContainerCLI(config, name) {
  let child, stopped = false;
  const remove = () => {
    const info = inspect(name);
    if (info) { assert.equal(info.Config.Labels[label], config.runID); checked(['rm', '--force', name]); }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // Termination intentionally removes this container, never merely restarts
    // its process. Durable native and connector roots are the only survivors.
    try { remove(); } catch { process.exitCode = 1; }
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
  try {
    child = spawn('docker', ['start', '--attach', '--interactive', name], { stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (!stopped) process.exitCode = code ?? 1;
  } finally {
    remove();
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(signal, stop);
  }
}
