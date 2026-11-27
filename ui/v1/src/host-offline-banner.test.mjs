import test from 'node:test';
import assert from 'node:assert/strict';
import {hostOfflineBanner} from './view-models.mjs';

test('an owned circle whose server is not answering names Circles → Host a circle and links to it', () => {
  const banner = hostOfflineBanner({hosted: true, name: 'Faravan demo'}, 'Faravan demo', {now: Date.parse('2026-11-01T12:00:00Z'), zone: 'UTC'});
  assert.match(banner.text, /Start it again from Circles → Host a circle on this computer\./);
  assert.doesNotMatch(banner.text, /Settings → Host a circle/);
  assert.equal(banner.href, '#/circles/host');
  assert.equal(banner.linkLabel, 'Host a circle');
});
