// Manage only children created by this launcher; never act on a saved PID.
export async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise((done) => child.once('exit', done));
  if (child.connected) {
    try {
      child.send({ type: 'shutdown' }, () => {});
    } catch {}
  } else child.kill();
  const timer = setTimeout(() => child.kill(), 3000);
  try {
    await stopped;
  } finally {
    clearTimeout(timer);
  }
}
