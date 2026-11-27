import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { codexWindows } from '../lib/faravan-guard.mjs';

const reading = (minutes, limit_id) => ({...(limit_id === undefined ? {} : {limit_id}),
  primary:{used_percent:12.3456, window_minutes:minutes, resets_at:1790000000}});

test('same-length Codex limit buckets retain distinct identities', () => {
  assert.deepEqual(['alpha','beta'].map(id => codexWindows(reading(300, id))[0].window_id),
    ['codex:alpha:300','codex:beta:300']);
});
test('bucketed 299 and 300 minute readings share a canonical identity and duration', () => {
  assert.deepEqual(codexWindows(reading(299, 'alpha')), codexWindows(reading(300, 'alpha')));
  assert.equal(codexWindows(reading(299, 'alpha'))[0].window_minutes, 300);
});
test('bucketed 10079 minutes canonicalizes to the 10080-minute week', () => {
  const [row] = codexWindows(reading(10079, 'alpha'));
  assert.equal(row.window_id, 'codex:alpha:10080');
  assert.equal(row.window_minutes, 10080);
});
test('45 minutes outside an hourly anchor tolerance remains exact', () => {
  const [row] = codexWindows(reading(45, 'alpha'));
  assert.equal(row.window_id, 'codex:alpha:45');
  assert.equal(row.window_minutes, 45);
});
test('no-limit_id legacy 299 remains exactly codex:299', () => {
  const [row] = codexWindows(reading(299));
  assert.equal(row.window_id, 'codex:299');
  assert.equal(row.window_minutes, 299);
  assert.equal(row.used_pct, 12.346);
  assert.equal(row.resets_at, new Date(1790000000 * 1000).toISOString());
});
test("the main bucket (limit_id 'codex') keeps the legacy series and exact minutes", () => {
  assert.equal(codexWindows(reading(10080, 'codex'))[0].window_id, 'codex:10080');
  assert.equal(codexWindows(reading(299, 'codex'))[0].window_id, 'codex:299');
  assert.equal(codexWindows(reading(299, 'codex'))[0].window_minutes, 299);
});
test('bucket readings the importer cannot read back are not emitted', () => {
  assert.deepEqual(codexWindows(reading(300, 'alpha:beta')), []);
  assert.deepEqual(codexWindows(reading(45.5, 'alpha')), []);
  assert.equal(codexWindows(reading(299.5, 'alpha'))[0].window_id, 'codex:alpha:300');
});
test('2 percent anchor boundary is inclusive, but outside it stays exact', () => {
  assert.equal(codexWindows(reading(294, 'alpha'))[0].window_id, 'codex:alpha:300');
  assert.equal(codexWindows(reading(293, 'alpha'))[0].window_id, 'codex:alpha:293');
  assert.equal(codexWindows(reading(306, 'alpha'))[0].window_id, 'codex:alpha:300');
  assert.equal(codexWindows(reading(307, 'alpha'))[0].window_id, 'codex:alpha:307');
});
test('both primary and secondary windows use the same limit bucket', () => {
  const value = reading(299, 'alpha');
  value.secondary = {used_percent:23, window_minutes:10079, resets_at:1790000001};
  assert.deepEqual(codexWindows(value).map(row => row.window_id), ['codex:alpha:300','codex:alpha:10080']);
});
test('legacy secondary readings retain existing duration identity', () => {
  const value = reading(299);
  value.secondary = {used_percent:23, window_minutes:10079, resets_at:1790000001};
  assert.deepEqual(codexWindows(value).map(row => row.window_id), ['codex:299','codex:10079']);
});
