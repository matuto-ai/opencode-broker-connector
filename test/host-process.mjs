// Only for processes spawned and owned by the disposable native-host tests.
export async function stopHostProcess(child, group = false, graceMs = 2000) {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const signal = value => {
    try {
      if (group) process.kill(-child.pid, value);
      else if (!exited()) child.kill(value);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  let onExit, timer;
  try {
    if (!Number.isInteger(child.pid) || child.pid <= 0) return;
    const exit = exited() ? Promise.resolve() : new Promise(resolve => {
      onExit = resolve;
      child.once('exit', onExit);
    });
    signal('SIGTERM');
    await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, graceMs); })]);
    clearTimeout(timer);
    // A leader's exit is not proof its group exited. Descendants may ignore TERM,
    // and the leader may already have exited before teardown even began.
    if (group || !exited()) signal('SIGKILL');
    await Promise.race([exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native_host_process_did_not_exit')), graceMs);
    })]);
  } finally {
    clearTimeout(timer);
    if (onExit) child.off('exit', onExit);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
