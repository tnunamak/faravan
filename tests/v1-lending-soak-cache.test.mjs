import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rig,MINUTE} from './helpers/lending-soak.mjs';
import {soakProviders,START} from './helpers/lending-soak-providers.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {join} from 'node:path';

for (const provider of ['claude','codex']) test(`I3 ${provider}: real cache admits after failed background probe`, async t => {
  const f = rig(t);f.clock.at = START;
  const meter = soakProviders(f.directory,f.clock);
  await meter.refresh();f.clock.at += 3*MINUTE;
  await meter.assertCachedFailure(provider);
  const pace = createPace50Candidate({directory:join(f.directory,'real-cache'),account:'synthetic-account',
    account_week_id:meter.week(provider),source:meter.source,now:() => f.clock.at,
    effectOverrides:{arm_cessation_deadline:async () => () => {}}});
  try {
    const args = f.args('real-cache',{provider,model:provider === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-sol'});
    args.job.budget_v1.max_list_usd = 2;
    assert.equal(meter.clearQuota(provider),true);
    const grant = await pace.candidate.reserve(args);
    assert.equal(grant.ok,true,JSON.stringify(grant));
    assert.equal((await pace.candidate.admitStart(args.attemptId)).ok,true);
  } finally {await pace.adapter.close();await meter.probe.close();}
});
