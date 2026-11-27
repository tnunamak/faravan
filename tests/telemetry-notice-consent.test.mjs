import './helpers/no-browser.mjs';
// The one-line "no reports are sent" variant of the setup notice is not the notice. A build that cannot upload must
// not record the notice as shown: a later build with an upload destination still has to show the full notice, with its
// choice, before reports turn on (docs/design/TELEMETRY.md §4.6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsent } from '../lib/v1/telemetry/consent.mjs';

const open = (dir, uploadable) => createConsent({dir, base: dir, uploadable, bytes: n => Buffer.alloc(n, 7)});

test('a build that cannot upload does not record the notice as shown; the next build that can upload still asks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-notice-consent-'));
  try {
    const offline = open(dir, false);
    offline.markNoticeShown();
    assert.equal(offline.current().noticeShown, false);
    assert.equal(existsSync(join(dir, 'policy.json')), false, 'nothing is written');
    const later = open(dir, true);
    assert.equal(later.current().noticeShown, false);
    assert.deepEqual([later.current().effective, later.current().reason.kind], ['off', 'notice_pending'], 'nothing is sent before the notice');
    later.markNoticeShown();
    assert.deepEqual([later.current().effective, later.current().reason.kind], ['on', 'default'], 'the full notice, once shown, turns the default on');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('an explicit choice in a build that cannot upload still counts as a choice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-notice-consent-'));
  try {
    const offline = open(dir, false);
    offline.choose({level: 'off'});
    assert.equal(open(dir, true).current().level, 'off');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
