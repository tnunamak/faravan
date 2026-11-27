// A check is an observation made in a workspace the agent could change.
const text = value => typeof value === 'string' ? value.trim() : '';
const overclaim = /\b(?:verified|independent|proof|proves)\b/i;
const safeCopy = value => overclaim.test(text(value)) ? '' : text(value);

const measuredTime = ms => {
  if(!Number.isSafeInteger(ms)||ms<0)return '';
  const minutes=Math.floor(ms/60000),seconds=(ms%60000)/1000;
  return (minutes?minutes+' min':'')+(seconds||!minutes?(minutes?' ':'')+seconds+' s':'');
};

export function checkLineVM(check = {}) {
  const c = check ?? {}, cmd = safeCopy(c.cmd) || 'the check command';
  const sandbox = (c.observed_by ?? c.observedBy) === 'sandbox';
  const timedOut = c.timed_out ?? c.timedOut;
  const summary = safeCopy(c.summary ?? c.outputSays);
  const skipped=Boolean(text(c.skipped));
  const skippedReason=skipped ? safeCopy(c.skipped).slice(0,160) || 'The check could not run.' : '';
  const timeout=measuredTime(c.timeout_ms), elapsed=measuredTime(c.duration_ms);
  const outcome = skipped ? `Didn't run: ${skippedReason}`
    : timedOut ? 'timed out'+(timeout?' after '+timeout:'')
    : Number.isInteger(c.exit) ? `exit ${c.exit}${summary ? ' · ' + summary : ''}`
    : 'ended without an exit code';
  const prefix = sandbox ? 'Faravan ran ' : 'The agent says it ran ';
  const suffix = sandbox ? ` after the agent finished: ${outcome}${elapsed?' · '+elapsed:''}` : summary ? ': ' + summary : '';
  const fallback = "The agent could change the project's test files and tools.";
  const suppliedNote = safeCopy(c.check_context?.note);
  // Older receipts repeat the observed command here. Keep the limitation once.
  const note = skipped ? "The check didn't run, so nothing was verified."
    : /^Faravan ran /i.test(suppliedNote) ? fallback : suppliedNote || fallback;
  const changedTests = (Array.isArray(c.changed_test_files ?? c.agentChangedTests) ? c.changed_test_files ?? c.agentChangedTests : [])
    .map(safeCopy).filter(Boolean);
  return {cmd, prefix, suffix, skipped, skippedReason, text: skipped?outcome:prefix + '`' + cmd + '`' + suffix, note, changedTests,
    icon:'terminal', tone:sandbox ? c.exit === 0 && !c.skipped && !timedOut ? 'ok' : 'warn' : 'info',
    by:note};
}
