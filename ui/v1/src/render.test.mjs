import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {
  renderFixture, renderedText, assertLandmark, assertHeading,
  assertDomOrder, assertNoBannedWords,
} from './render.test-helper.mjs';

// A screen-shaped fixture, not a replacement for the future request screen.
// UI copy is from EXPERIENCE §7.1; the prompt is user-supplied fixture data.
function RequestFixture({prompt}) {
  return h('main', null,
    h('nav', {'aria-label': 'Main'}, h('a', {href: '#/'}, 'Home')),
    h('h1', null, 'Sam asked for help'),
    h('blockquote', null, prompt),
    h('button', {type: 'button'}, 'Run it'),
    h('button', {type: 'button'}, 'Not now'),
    h('p', null, 'No rush. This request waits until tomorrow, 3:12 PM.'));
}

test('request fixture has landmarks, a heading, prompt-first order and plain copy', () => {
  const prompt = 'Fix <label> & its spacing';
  const html = renderFixture(RequestFixture, {prompt});
  assertLandmark(html, 'main');
  assertLandmark(html, 'navigation');
  assertHeading(html, 'Sam asked for help');
  assertDomOrder(html, [
    renderFixture('blockquote', {children: prompt}),
    renderFixture('button', {type: 'button', children: 'Run it'}),
    renderFixture('button', {type: 'button', children: 'Not now'}),
  ]);
  assertNoBannedWords(html);
  assert.ok(renderedText(html).includes(prompt));
});

test('landmark and heading assertions reject lookalikes and missing content', () => {
  assertLandmark('<div role="main"></div>', 'main');
  assert.throws(() => assertLandmark('<div class="main"></div>', 'main'));
  assert.throws(() => assertLandmark('<main role="presentation"></main>', 'main'));
  assertHeading('<h2>Sam <em>asked</em> for help</h2>', 'Sam asked for help', 2);
  assert.throws(() => assertHeading('<p>Sam asked for help</p>', 'Sam asked for help'));
  assert.throws(() => assertHeading('<h2>Sam asked for help</h2>', 'Sam asked for help'));
});

test('DOM order rejects reversed, absent and ambiguous fragments', () => {
  const html = '<p>Prompt</p><button>Run it</button>';
  assert.throws(() => assertDomOrder(html, ['<button>Run it</button>', '<p>Prompt</p>']));
  assert.throws(() => assertDomOrder(html, ['<button>Not now</button>']));
  assert.throws(() => assertDomOrder(html + html, ['<p>Prompt</p>']));
});

test('banned copy guard covers the design list and accessible labels', () => {
  for (const word of ['Member 2', 'key id', 'fingerprint', 'verdict', 'receipt', 'harness',
    'roster', 'lease', 'claim', 'attempt', 'settled', 'coordinator', 'collective',
    'execution_failed', 'faravan doctor', 'Check setup', 'UNVERIFIED', 'Any available model']) {
    assert.throws(() => assertNoBannedWords(renderFixture('p', {children: word})), word);
    assert.throws(() => assertNoBannedWords(renderFixture('button', {'aria-label': word})), word);
  }
  assert.throws(() => assertNoBannedWords('<p>Member <b>23</b></p>'));
  assert.throws(() => assertNoBannedWords('<p>r&#101;ceipt</p>'));
  assertNoBannedWords('<p class="claim" data-state="settled">Please release the button.</p>');
  assertNoBannedWords('<h1>Security</h1><p>Fingerprint</p>', {security: true});
  assert.throws(() => assertNoBannedWords('<p>receipt</p>', {security: true}));
});
