// The graceful-shutdown contract for the macOS smoke: the app's own SIGTERM handler ran to completion. lib/v1/cli.mjs
// closes the app and then exits 0, and the discovery record app.json is removed on close. Any other exit, including a
// signal, is a failure the smoke names instead of passing. Pure: the caller reads the child exit and the record.
export function gracefulShutdownProblems({exitCode, exitSignal, recordRemoved}) {
  const problems = [];
  if (exitSignal !== null && exitSignal !== undefined) problems.push(`exited by signal ${exitSignal}`);
  else if (exitCode !== 0) problems.push(`exited with code ${exitCode}`);
  if (!recordRemoved) problems.push('discovery record app.json was not removed');
  return problems;
}
