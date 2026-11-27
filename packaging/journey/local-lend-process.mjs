const pause = ms => new Promise(resolve => {const timer=setTimeout(resolve, ms);timer.unref();});
export async function closeOwnedApp(app, {shutdownMs=30000, exitMs=10000, termMs=5000}={}) {
  let forced = false;
  if (!app.exited) {
    await Promise.race([app.control('shutdown').catch(()=>{}), pause(shutdownMs)]);
    await Promise.race([app.exit, pause(exitMs)]);
  }
  if (!app.exited) {
    forced = true;
    // This ChildProcess was forked by the runner. Never signal a process group,
    // a process found by name, or the sandbox daemon.
    app.child.kill('SIGTERM');
    await Promise.race([app.exit, pause(termMs)]);
    if (!app.exited) app.child.kill('SIGKILL');
    await app.exit;
  }
  return {stopped:app.exited, code:app.exitCode, forcedTermination:forced};
}
