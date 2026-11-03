import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { stopHostProcess } from './host-process.mjs';

// Linux matches the real PTY CI runner. Zombies cannot write or retain sockets;
// the sandbox's init may reap orphan grandchildren after this assertion.
function alive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

for (const leaderAlreadyExited of [false, true]) {
  test(`owned group cleanup kills TERM-resistant descendant when leader ${leaderAlreadyExited ? 'already exited' : 'exits on TERM'}`, {
    skip: process.platform !== 'linux', timeout: 5000,
  }, async t => {
    const source = `
      const {spawn} = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], {stdio:['ignore','ignore','ignore','ipc']});
      grandchild.once('message',()=>{process.stdout.write(grandchild.pid+'\\n');${leaderAlreadyExited ? 'process.exit(0)' : "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"}});
    `;
    const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => stopHostProcess(child, true, 100));
    const exit = once(child, 'exit');
    const [bytes] = await once(child.stdout, 'data');
    const descendant = Number(String(bytes).trim());
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    assert.equal(alive(descendant), true);
    if (leaderAlreadyExited) await exit;
    await stopHostProcess(child, true, 100);
    for (let i = 0; i < 50 && alive(descendant); i++) await delay(10);
    assert.equal(alive(descendant), false, 'a leader exit must not leave its process group running');
  });
}

test('direct TERM-resistant child is killed and reaped within the bounded grace period', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stopHostProcess(child, false, 100));
  await once(child.stdout, 'data');
  await stopHostProcess(child, false, 100);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('actual PTY recorder terminates its separate TERM-resistant native session', {
  skip: process.platform !== 'linux', timeout: 7000,
}, async t => {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const source = "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});process.stdout.write('NATIVE_PID='+process.pid+'\\n');setInterval(()=>{},1000)";
  const child = spawn('script', ['-q', '-f', '-c', `exec ${quote(process.execPath)} -e ${quote(source)}`, '/dev/null'], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => stopHostProcess(child, true, 3000));
  let output = '';
  const nativePID = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', bytes => {
      output += bytes;
      const match = /NATIVE_PID=(\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
  });
  assert.equal(alive(nativePID), true);
  await stopHostProcess(child, true, 3000);
  for (let i = 0; i < 100 && alive(nativePID); i++) await delay(10);
  assert.equal(alive(nativePID), false, 'the native session must not survive the PTY recorder');
});
