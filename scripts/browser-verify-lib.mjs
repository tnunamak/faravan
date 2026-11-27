// Pure checks on a Playwright JSON report, shared by the V1 report printer and the release gates.
// A release report proves the lane ran: at least one test executed, none skipped, none retried, none failed.
// Nothing here reads files or prints; the callers decide what to do with the problems.
// The JSON reporter writes here (playwright.verify.config.mjs). The wrapper deletes it before each run.
export const RESULTS_FILE = 'test-artifacts/browser-verify/results.json';

function* testsIn(suite) {
  for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) yield { title: spec.title, test };
  for (const child of suite.suites ?? []) yield* testsIn(child);
}

// An expected failure is a test declared with test.fail(): Playwright reports it as "expected" even though the
// product assertion failed. It is not a product pass; only a named (known) expected failure is allowed.
export function isExpectedFailure(test) {
  return test.status === 'expected' && test.expectedStatus !== undefined && test.expectedStatus !== 'passed';
}

// Returns one line per reason the report does not prove a clean, complete, first-attempt run. [] means it does.
export function releaseProblems(report) {
  const problems = [];
  let executed = 0;
  for (const suite of report?.suites ?? []) for (const { title, test } of testsIn(suite)) {
    const attempts = (test.results ?? []).map(result => result.status);
    if (test.status === 'skipped' || attempts.length === 0) problems.push(`not run: ${title}`);
    else executed++;
    if (test.status === 'unexpected') problems.push(`failed: ${title} (attempts: ${attempts.join(', ')})`);
    if (test.status === 'flaky' || attempts.length > 1) problems.push(`retried: ${title} (attempts: ${attempts.join(', ')})`);
    const known = (test.annotations ?? []).some(x => x.type === 'known');
    if (isExpectedFailure(test) && !known) problems.push(`expected failure without a known annotation: ${title}`);
  }
  if (executed === 0) problems.unshift('no test executed (empty report)');
  return problems;
}
