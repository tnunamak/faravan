#!/usr/bin/env node
// A stand-in for `codex exec --json`: prints thread.started and appends token_count events to its rollout file
// under $HOME/.codex/sessions, as Codex 0.149 does. quiet/missing/stale stop reporting fresh usage.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.FAKE_MODE || 'run';
const threadId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const dir = join(process.env.HOME, '.codex', 'sessions', '2026', '10', '20');
mkdirSync(dir, { recursive: true });
const rollout = join(dir, `rollout-2026-10-20T15-46-00-${threadId}.jsonl`);
const record = (payload) => mode==='missing'?undefined:appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: payload.type === 'turn_context' ? 'turn_context' : 'event_msg', payload }) + '\n');

process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n');
// Codex 0.149 writes {type:'turn_context', payload:{model, effort, …}}: the type is on the record, not the payload.
if(mode!=='missing')appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: 'turn_context', payload: { cwd: process.cwd(), model: 'gpt-6-luna', effort: 'low' } }) + '\n');
writeFileSync('edit.txt', 'partial\n');
let step = 0;
const spend = () => {
  step += 1;
  record({ type: 'token_count',
    info: { total_token_usage: { input_tokens: 1000 * step, cached_input_tokens: 600 * step, output_tokens: 100 * step, reasoning_output_tokens: 40 * step, total_tokens: 1100 * step },
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 40, total_tokens: 1100 }, model_context_window: 272000 },
    rate_limits: { limit_id: 'codex', plan_type: 'pro', primary: { used_percent: 33, window_minutes: 10080, resets_at: 1793082726 }, secondary: null,
      credits: { has_credits: false, balance: '17' }, rate_limit_reached_type: null } });
};
spend();
if (mode === 'crash') process.exit(3);
if (mode === 'finish') {
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 100 } }) + '\n');
  process.exit(0);
}
process.on('SIGINT', () => {
  writeFileSync('interrupted.txt', 'SIGINT\n');
  process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'interrupted' } }) + '\n');
  process.exit(1);
});
setInterval(mode==='quiet'||mode==='missing'?()=>{}:mode==='stale'?()=>record({type:'token_count',rate_limits:null}):spend, 100);
