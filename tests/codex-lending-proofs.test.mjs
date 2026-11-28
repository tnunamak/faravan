import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {guestProbeScript} from "../lib/v1/lending-probe.mjs";

// Codex lending needs the same proofs as Claude: the enrolled account, subscription-only funding, the weekly window and a
// conversion. The usage reply (wham/usage) carries the account, the plan and the windows; the guest prints only hashes.

test('the Codex guest probe hashes the account id and e-mail from the usage reply, never printing them', () => {
  const script = guestProbeScript('codex');
  assert.match(script, /=="codex" and status==200/);
  assert.match(script, /\("account_sha256_16","account_id"\),\("email_sha256_16","email"\)/);
  assert.doesNotMatch(script, /print\([^)]*account_id/);
});
