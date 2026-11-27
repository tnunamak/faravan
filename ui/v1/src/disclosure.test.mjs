import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const css = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');

test('every <details> uses the shared disclosure, never the browser triangle', () => {
  const c = css('./components.css');
  assert.match(c, /details>summary::-webkit-details-marker\{display:none\}/);
  assert.match(c, /details:not\(\.member-menu\):not\(\.jobs-batch\)>summary:not\(\[class\]\)\{list-style:none;display:inline-flex[^}]*font-size:var\(--text-sm\)/);
  assert.match(c, /details\[open\]:not\(\.member-menu\):not\(\.jobs-batch\)>summary:not\(\[class\]\)::before\{transform:rotate\(45deg\)\}/);
});

test('Setup row links use the small type of the rows around them', () => {
  assert.match(css('./setup.css'), /\.setup-row-link\{[^}]*font-size:var\(--text-sm\)/);
});

test('no disclosure draws its own "+" or "−" marker', () => {
  for (const name of ['./components.css', './jobs.css', './compose.css', './lend.css', './setup.css', './home.css'])
    assert.doesNotMatch(css(name), /summary:{1,2}before\{content:'[+−-]'/, name);
});
