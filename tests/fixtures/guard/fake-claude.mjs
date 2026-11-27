#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json`. FAKE_MODE picks the behaviour.
// It writes `edit.txt` in its cwd before it waits, so a test can see that work survives a stop.
import { writeFileSync } from 'node:fs';

const mode = process.env.FAKE_MODE || 'finish';
const line = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const rateLimit = (status = 'allowed', isUsingOverage = false) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status, resetsAt: 1792513200, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage,
    unifiedWindows: { five_hour: { utilization: 0.24, resetsAt: 1792513200 }, seven_day: { utilization: 0.37, resetsAt: 1792720800 } } },
});
const assistant = (id, output) => ({ type: 'assistant', message: { id, model: 'claude-haiku-4-5', usage: {
  input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: output } } });
const result = (subtype, isError, cost) => ({ type: 'result', subtype, is_error: isError, total_cost_usd: cost, num_turns: 2,
  usage: { input_tokens: 20, output_tokens: 30 }, modelUsage: { 'claude-haiku-4-5': {} } });

line({ type: 'system', subtype: 'init' });
line(rateLimit(mode === 'rejected' ? 'rejected' : 'allowed'));
line(assistant('m1', 7));
line(assistant('m1', 9));
writeFileSync('edit.txt', 'partial\n');

if (mode === 'finish') { line(result('success', false, 0.01)); process.exit(0); }
if (mode === 'budget') { line(result('error_max_budget_usd', true, 0.051)); process.exit(1); }
if (mode === 'fail') { process.stderr.write('real failure\n'); process.exit(2); }
if (mode === 'forge') {
  // A hostile agent plants a stop record, then exits normally.
  writeFileSync(process.env.FAKE_FORGE_PATH, JSON.stringify({ schema: 'faravan.stop.v1', stop_reason: 'budget' }));
  line(result('success', false, 0.01)); process.exit(0);
}

process.on('SIGINT', () => {
  if (mode === 'ignore-sigint') return;
  writeFileSync('interrupted.txt', 'SIGINT\n');
  line(result('error_during_execution', true, 0.02));
  process.exit(130);
});
process.on('SIGTERM', () => { writeFileSync('terminated.txt', 'SIGTERM\n'); process.exit(143); });
setInterval(() => {}, 1000);
