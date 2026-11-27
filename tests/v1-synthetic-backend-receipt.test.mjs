import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syntheticBackend} from './helpers/v1-app-fixture.mjs';

// The lender records scratch cleanup debt for any attempt whose destroy receipt lacks scratch_removed: true, and then
// refuses every new claim until that debt is proven gone. The synthetic backend must return the full CleanupReceipt.
test('synthetic destroy returns a complete CleanupReceipt, with the scratch it removed reported as removed', async () => {
  const backend = syntheticBackend(await mkdtemp(join(tmpdir(), 'synthetic-receipt-')), {});
  const handle = await backend.prepare({entrypoint: 'true'});
  const receipt = await backend.destroy(handle);
  assert.equal(receipt.removed, true);
  assert.equal(receipt.scratch_removed, true);
});
