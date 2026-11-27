import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import postcss from 'postcss';

const directory = fileURLToPath(new URL('.', import.meta.url));
const literalSize = /(?<![\w-])-?(?:\d*\.)?\d+(?:px|rem|em|pt|vw|vh|%)(?![\w-])/;
const spacing = /^(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?$/;

// These optical and dock offsets have specific layout reasons beside their rules.
const exceptions = new Map([
  ['components.css|.row-meta|margin-top|1px', 'align the metadata baseline to the row title'],
  ['components.css|.ctx>.i|margin-top|1px', 'align the icon to the first text line'],
  ['shell.css|body[data-dock] .page|padding-bottom|200px', 'reserve the dock area on short phone pages'],
]);

// The lead swing reference uses pixel-exact optical values for its named shared primitives.
// Keep those values scoped to the foundation while the rest of the UI stays on the token scale.
const swingRules = (filename, selector) =>
  (filename === 'components.css' && selector.startsWith('.swing-')) ||
  (filename === 'shell.css' && selector.startsWith('.swing-app'));

function violations(filename, css) {
  const found = [];
  postcss.parse(css, {from:filename}).walkDecls(declaration => {
    const isType = declaration.prop === 'font-size' || declaration.prop === 'font';
    if (!isType && !spacing.test(declaration.prop)) return;
    if (!literalSize.test(declaration.value)) return;
    const selector = declaration.parent.selector;
    if (swingRules(filename, selector)) return;
    const key = [filename, selector, declaration.prop, declaration.value].join('|');
    if (!exceptions.has(key)) found.push(`${filename}:${declaration.source.start.line} ${selector} ${declaration.prop}: ${declaration.value}`);
  });
  return found;
}

test('CSS type and spacing use the token scale, with only documented exceptions', () => {
  const files = readdirSync(directory).filter(name => name.endsWith('.css') && name !== 'tokens.css');
  const actual = files.flatMap(name => violations(name, readFileSync(join(directory, name), 'utf8')));
  assert.deepEqual(actual, []);
  assert.match(violations('new.css', '.new{font-size:17px;padding:9px}').join('\n'), /font-size: 17px/);
  assert.match(violations('new.css', '.new{font-size:17px;padding:9px}').join('\n'), /padding: 9px/);
});

test('caption and micro type stay within the readable scale', () => {
  const tokens = readFileSync(join(directory, 'tokens.css'), 'utf8');
  const pixels = name => {
    const value = tokens.match(new RegExp(`--${name}:([\\d.]+)rem`))?.[1];
    assert.ok(value, `missing ${name}`);
    return Number(value) * 16;
  };
  for (const name of ['text-xs', 'text-sm', 'text-micro', 'text-avatar-xs']) {
    assert.ok(pixels(name) >= 12, `${name} is smaller than 12px`);
    assert.ok(pixels(name) <= pixels('text-body'), `${name} is larger than body text`);
  }
});

test('buttons never use a marigold border or outline', () => {
  const findings = [];
  const scan = (name, css) => {
    postcss.parse(css).walkRules(rule => {
      if (!/(?:button|\.btn\b|\.button\b)/.test(rule.selector)) return;
      rule.walkDecls(declaration => {
        const tabUnderline = rule.selector.includes('.section-tabs button') &&
          declaration.prop === 'border-bottom-color' && declaration.value === 'var(--indicator)';
        if (!tabUnderline && /^(?:border|outline)(?:-|$)/.test(declaration.prop) &&
          /--m-|--brand\b|--indicator\b|#(?:ffb800|ffc21a|e6a200)/i.test(declaration.value)) {
          findings.push(`${name}:${declaration.source.start.line} ${rule.selector} ${declaration.prop}`);
        }
      });
    });
  };
  for (const name of readdirSync(directory).filter(file => file.endsWith('.css'))) {
    scan(name, readFileSync(join(directory, name), 'utf8'));
  }
  assert.deepEqual(findings, []);
  scan('new.css', '.btn{border:1px solid var(--indicator)}');
  assert.match(findings.join('\n'), /new\.css:1 \.btn border/);
});

// A var() with no fallback whose property nothing defines makes the declaration invalid, so the rule silently does
// nothing. The redesign removed --tabbar-height, and the Limits save bar then stopped sticking below 900px.
function undefinedTokens(sources) {
  const used = new Map(), defined = new Set();
  for (const [name, text] of sources) {
    for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1]);
    // Components set measured values such as --bar-h from script.
    if (!name.endsWith('.css')) for (const match of text.matchAll(/['"`](--[\w-]+)['"`]/g)) defined.add(match[1]);
    else for (const match of text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) used.set(match[1], name);
  }
  return [...used].filter(([token]) => !defined.has(token)).map(([token, name]) => `${name} ${token}`);
}

test('every CSS custom property read without a fallback is defined', () => {
  const sources = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(css|jsx|mjs)$/.test(entry.name) && !entry.name.endsWith('.test.mjs')) sources.push([path.slice(directory.length), readFileSync(path, 'utf8')]);
    }
  };
  walk(directory);
  assert.deepEqual(undefinedTokens(sources), []);
  assert.deepEqual(undefinedTokens([['new.css', '.x{bottom:var(--gone)}']]), ['new.css --gone']);
  assert.deepEqual(undefinedTokens([['new.css', '.x{bottom:var(--gone,4px)}']]), []);
});
