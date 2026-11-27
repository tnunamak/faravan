import test from 'node:test';
import assert from 'node:assert/strict';
import { FOUNDATION_PROMPT } from '../foundation-walk/account-and-send.mjs';

// Partial contract regression only, NOT a completed W04-W06 walk.
// Required dependency: fv-outcome-walk-graphical-actions-1114.
// No provider, result receipt, signature verdict, transport success or login
// is fabricated here. The real accepted operation/result boundary is missing.
test('W05 requests the exact W06 downloadable filename and expected message', () => {
  assert.equal(FOUNDATION_PROMPT,
    'Return exactly FOUNDATION_OK in your final message. Create foundation-result.txt containing FOUNDATION_OK.');
});
