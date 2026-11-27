import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// WCAG 2.2 contrast of the semantic token pairs, read from tokens.css itself so the
// test fails when a token changes. Port of docs/design/experience/mockups/contrast.mjs.
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const body = (opening) => {
  const start = css.indexOf(opening);
  assert.ok(start >= 0, 'tokens.css lacks ' + opening);
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
};
const declarations = (text) => Object.fromEntries(
  [...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
const primitives = declarations(body(':root{'));
const light = declarations(body(':root,[data-theme=light]{'));
const dark = declarations(body('[data-theme=dark]{'));
const media = declarations(body('@media (prefers-color-scheme:dark){'));

const resolve = (theme, name) => {
  let value = theme[name] ?? primitives[name];
  for (let hop = 0; /^var\(/.test(value ?? ''); hop++) {
    assert.ok(hop < 5, 'var() loop at ' + name);
    value = (theme[value.slice(4, -1)] ?? primitives[value.slice(4, -1)]);
  }
  if (/^#[0-9a-f]{3}$/i.test(value ?? '')) value = '#' + [...value.slice(1)].map((c) => c + c).join('');
  assert.match(value ?? '', /^#[0-9a-f]{6}$/i, name + ' does not resolve to a hex colour');
  return value;
};
const channels = (hex) => hex.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255);
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => { const [r, g, b] = channels(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const pairs = [ // [foreground token or hex, background token, minimum ratio, label]
  ['--text', '--bg', 4.5, 'body text'], ['--text-2', '--bg', 4.5, 'secondary text'],
  ['--text-2', '--surface', 4.5, 'secondary text on card'], ['--text-3', '--bg', 4.5, 'tertiary text'],
  ['--text-3', '--surface', 4.5, 'tertiary text on card'], ['--text-on-brand', '--brand', 4.5, 'primary button label (ink on marigold)'],
  ['--ink-btn-text', '--ink-btn', 4.5, 'ink button label'], ['--need-text', '--need-soft', 4.5, 'needs-you pill and banner'],
  ['--on-text', '--on-soft', 4.5, 'on pill'], ['--wait-text', '--wait-soft', 4.5, 'waiting pill'],
  ['--bad-text', '--bad-soft', 4.5, 'failed pill'], ['--run-text', '--run-soft', 4.5, 'running pill'],
  ['--line-input', '--surface', 3, 'input border'], ['--line-input', '--surface-2', 3, 'input on sunk row'],
  ['--ink-btn', '--surface', 3, 'switch on (ink track on light, paper track on dark)'], ['--indicator', '--surface', 3, 'current-tab dot and sidebar bar'],
  ['--indicator', '--bg', 3, 'indicator on the page'], ['--need-dot', '--need-soft', 3, 'needs-you dot on its pill'], ['--focus', '--bg', 3, 'focus ring'],
];
// Avatar initials: 45% hue + 55% text on a 20% hue tint of the surface (components.css .av).
const avatars = {c1: '#e0a100', c2: '#2a9d8f', c3: '#6a5acd', c4: '#d1495b', c5: '#3b74d6', c6: '#8a6d3b'};
const mix = (a, b, p) => '#' + channels(a).map((v, i) => Math.round((v * p + channels(b)[i] * (1 - p)) * 255).toString(16).padStart(2, '0')).join('');

for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
  test('every token pair meets WCAG in the ' + themeName + ' theme', () => {
    for (const [fg, bg, min, label] of pairs) {
      const found = ratio(resolve(theme, fg), resolve(theme, bg));
      assert.ok(found >= min, label + ' is ' + found.toFixed(2) + ':1, needs ' + min + ':1');
    }
  });
}

for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
  test('avatar initials meet 4.5:1 in the ' + themeName + ' theme', () => {
    for (const [name, hue] of Object.entries(avatars)) {
      const surface = resolve(theme, '--surface'), text = resolve(theme, '--text');
      const found = ratio(mix(hue, text, 0.45), mix(hue, surface, 0.2));
      assert.ok(found >= 4.5, 'avatar ' + name + ' is ' + found.toFixed(2) + ':1');
    }
  });
}

test('the prefers-color-scheme block and [data-theme=dark] define the same dark tokens', () => {
  assert.deepEqual(media, dark);
});

test('the contrast function matches known values', () => {
  assert.equal(ratio('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(ratio('#15161d', '#ffb800').toFixed(1), '10.4');
});
