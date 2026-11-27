import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import postcss from 'postcss';

// From 600 px up the form card clips its own scrolling content (.cmp-form has overflow hidden), so the card, not the
// viewport, is the sticky footer's scrollport. The viewport offset for the tab bar only works where the card does not clip.
const root = postcss.parse(readFileSync(fileURLToPath(new URL('./compose.css', import.meta.url)), 'utf8'), {from: 'compose.css'});

const matchesWidth = (params, width) => [...params.matchAll(/\((min|max)-width:(\d+)px\)/g)]
  .every(([, kind, px]) => (kind === 'min' ? width >= Number(px) : width <= Number(px)));

// The value a property ends up with at `width`: the last matching declaration in source order.
function effective(selector, prop, width) {
  let value;
  root.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    let node = rule.parent;
    for (; node; node = node.parent) if (node.type === 'atrule' && node.name === 'media' && !matchesWidth(node.params, width)) break;
    if (node) return;
    rule.walkDecls(prop, declaration => { value = declaration.value; });
  });
  return value;
}

test('the composer card clips at 800 px and not on phones, so the evaluator reads the real cascade', () => {
  assert.equal(effective('.cmp-form', 'overflow', 800), 'hidden');
  assert.equal(effective('.cmp-form', 'overflow', 390), 'visible');
  assert.equal(effective('.cmp .cmp-sticky-footer', 'position', 800), 'sticky');
});

test('wherever the card clips, its sticky footer sits on the card bottom (bottom: 0), not at a viewport offset', () => {
  for (const width of [600, 800, 899, 900, 1024]) {
    assert.notEqual(effective('.cmp-form', 'overflow', width), 'visible', `the card should clip at ${width}px`);
    assert.equal(effective('.cmp .cmp-sticky-footer', 'bottom', width), '0',
      `at ${width}px the footer's bottom offset would push it up into the card and leave an empty band`);
  }
});

test('phones keep the footer above the fixed tab bar, where the card does not clip', () => {
  assert.match(effective('.cmp .cmp-sticky-footer', 'bottom', 390), /var\(--bar-h/);
});
