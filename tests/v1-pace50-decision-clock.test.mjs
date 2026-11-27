import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createOwnerSettings} from '../lib/v1/owner-settings.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

const HAIKU = 'claude-haiku-5-5';
const ACCOUNT = 'synthetic-account';
const WEEK = 'synthetic-week-1';
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: null, budget_v1: {max_list_usd: 1.33}};

// A real probe takes time and stamps its readings when it finishes. The admission decision must be made after that stamp: a
// decision time taken before the probe places every reading after the decision, and the policy refuses each one as stale.
test('a probe that takes time does not make its own reading stale at admission', {timeout: 30000}, async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'decision-clock-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let now = Date.UTC(2026, 9, 23, 12, 0, 0);
  const synthetic = createSyntheticPace50Source({start: now});
  const slowProbe = {
    observe: async ({provider}) => {
      now += 40000; // the probe takes forty seconds, then stamps its readings with the time it finished
      return synthetic.observe({provider, now});
    },
    // The conversion is the synthetic source's own: the probe's delay is the only thing under test here.
    convertUsage: (args) => synthetic.convertUsage(args),
  };
  const ownerSettings = createOwnerSettings({directory: join(dir, 'owner-settings')});
  ownerSettings.set({by: 'owner', reason: 'test limit', now, maxJobUsd: 2});
  const opened = createPace50Candidate({directory: dir, now: () => now, account: ACCOUNT, account_week_id: WEEK,
    source: slowProbe, ownerSettings});
  const out = await opened.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: HAIKU, job,
    automatic: true, ownerAbsent: true});
  assert.notEqual(out.policyReason, 'reading_stale', JSON.stringify(out));
});
