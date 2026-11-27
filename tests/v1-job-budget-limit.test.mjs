import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {borrowerBudgetWarning, ownerModelLimitSummary} from '../lib/v1/lender-pace50.mjs';
for (const cap of [2,4]) test(`borrower sees their $${cap} Sonnet job limit and the whole-dollar minimum`, () => {
  const job = {requirements:{harness:['claude-code-subscription'],model:{any_of:['claude-sonnet-5-5']}},budget_v1:{max_list_usd:cap}};
  assert.equal(borrowerBudgetWarning(job),`Your job's $${cap.toFixed(2)} limit is below what one Claude Sonnet 5.5 call can cost ($5.29). Raise the job limit to at least $6.`);
  job.budget_v1.max_list_usd = 6;
  assert.equal(borrowerBudgetWarning(job),null);
});
test('the saved small-cap summary names all fitting models without duplicate names', () => {
  assert.equal(ownerModelLimitSummary(2), 'At $2.00 Claude Haiku 4.5, Claude Haiku 5.5 jobs fit. Claude Sonnet 5.5 jobs need at least $5.29.');
  assert.equal(ownerModelLimitSummary(null), null);
  assert.equal(ownerModelLimitSummary(5.29), null);
});
