import './helpers/no-browser.mjs';
// Register the shared live seam tests as well as this measured acceptance file.
import './v1-rule-seam-acceptance.test.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import {decide} from "../lib/v1/rules/fluid-protection.mjs";
const state=(dial=.75)=>({now_h:1,dial,windows:[{id:'week',length_h:168,reset_h:168,used_lo:0,used_hi:0,borrower_used:0,inflight_gross:0}],history:[],job:{gross:{week:1.2296},duration_h:4/15}});

// Entirely synthetic evidence and effect handlers. No provider, browser, or network.

// These acceptance tests intentionally stay red for known candidate/seam gaps.
// Unit/lifecycle passes above are not product acceptance.
// Reuse the unchanged M1 experiment; target assertions are deliberately not
// relaxed to the research candidate's own envelope.

// Explicit paired quota-only counterexamples, not prevalence estimates or real traces.
for (const family of ['elastic owner', 'late burst']) {
  // A known impossibility, kept visible as todo: with no setup signal, no rule can tell
  // these owners from a light owner on this prefix (setup-signal.md, charter 3.3).
  test(`fluid ${family}: preserves paired owner service on an indistinguishable prefix`,
    {todo:'cold-start obstruction: needs the setup signal (stream Q)'}, t => {
    const s=state(.75), r=decide(s);
    assert.equal(r.admit,true);
    const lent=s.job.gross.week;
    const baselineOwner=100, owner=Math.min(100,100-lent), harm=baselineOwner-owner;
    t.diagnostic(JSON.stringify({family,lent,owner,baselineOwner,harm,dial:s.dial}));
    assert.equal(harm,0,'known candidate shortfall, not hidden by changing rule or oracle');
  });
}

// Measured bound: the same journey, closed by its durable deadline. The rule provenance survives cleanup and the reopen, and is
// still on the resources once the deadline has released the hold.

test('recent owner burn protects a margin and lends only the remaining weekly room', () => {
  const now = 50;
  const decision = rate => decide({now_h:now,dial:.10,
    windows:[{id:'week',length_h:168,reset_h:168,used_lo:39,used_hi:39,
      borrower_used:0,inflight_gross:0,recentMeterRate:rate}],
    history:[],
    job:{gross:{week:1},duration_h:1}});
  assert.equal(decision(.3).admit,true);
  assert.equal(decision(.6).admit,false);
});
