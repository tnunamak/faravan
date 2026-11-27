import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RUNNING_JOB} from '../../../lib/v1/lending-status-copy.mjs';

// The lend page says that running work continues within its saved limits. No sentence on the page
// promises that a job completes. This reads the page source; the render is covered by the lend page tests.
const source = readFileSync(new URL('./lend.jsx', import.meta.url), 'utf8');

test('the shared running-job wording preserves work and its limits', () => {
  assert.equal(RUNNING_JOB, 'Running jobs continue within their saved limits.');
});

test('the lend page takes its running-job sentences from the shared wording', () => {
  assert.match(source, /import \{RUNNING_JOB\} from '\.\.\/\.\.\/\.\.\/lib\/v1\/lending-status-copy\.mjs';/);
  assert.equal(source.split('RUNNING_JOB').length - 1, 5,
    'the import, the toast, the pause sheet and the two execution lines');
});

test('no sentence on the lend page promises that a running job finishes', () => {
  assert.doesNotMatch(source, /may finish|must finish|finishes\.|finish first|already running finishes/i);
});

test('the circle instruction is not a promise that running work will finish', () => {
  // Quoted text on one line, and text between tags. Code such as vm.exec.finishing sits outside both, and it is state, not copy.
  const quoted = source.match(/(['"`])[^'"`\n]*\1/g) ?? [];
  const elementText = source.match(/>[^<>{}\n]+</g) ?? [];
  assert.deepEqual(quoted.filter((text) => /finish/i.test(text) && text !== "'Turn lending off and let the running job finish before you choose another circle.'"), [], 'only the explicit circle-change instruction may mention finish');
  assert.deepEqual(elementText.filter((text) => /finish/i.test(text) && text !== '>View finished jobs <'), [], 'no element text says finishing; the idle link to finished-job history is a destination name, not a promise');
});
