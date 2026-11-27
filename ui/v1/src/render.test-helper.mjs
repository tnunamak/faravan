import assert from 'node:assert/strict';
import {h} from 'preact';
import renderToString from 'preact-render-to-string';

// Hermetic screen fixtures: use h(Component, props), with no browser or effects.
export function renderFixture(Component, props = {}) {
  return renderToString(h(Component, props));
}

const escapePattern = value => value.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
const normalize = value => value.replace(/\s+/g, ' ').trim();
function decode(value) {
  const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()];
    const number = entity[1].toLowerCase() === 'x'
      ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : whole;
  });
}

export function renderedText(html) {
  return normalize(decode(html.replace(/<!--[^]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[^]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ')));
}

// Checks native landmarks or explicit ARIA roles, not arbitrary class names.
export function assertLandmark(html, role) {
  const native = {main: 'main', navigation: 'nav', complementary: 'aside'};
  const tags = html.match(/<[a-z][^>]*>/gi) || [];
  assert.ok(tags.some(tag => {
    const explicit = tag.match(/\srole="([^"]*)"/i);
    if (explicit) return explicit[1].split(/\s+/).includes(role);
    return native[role] && new RegExp('^<' + native[role] + '(?:\\s|>)', 'i').test(tag);
  }), 'Missing landmark: ' + role);
}

export function assertHeading(html, text, level = 1) {
  assert.ok(Number.isInteger(level) && level >= 1 && level <= 6, 'Heading level must be 1–6');
  const headings = [...html.matchAll(new RegExp('<h' + level + '\\b[^>]*>([^]*?)<\\/h' + level + '>', 'gi'))];
  assert.ok(headings.some(match => renderedText(match[1]) === normalize(text)),
    'Missing h' + level + ': ' + text);
}

// Pass unique rendered HTML fragments (e.g. renderToString(h('button', …))).
// Raw text alone is ambiguous when the same copy appears in another element.
export function assertDomOrder(html, fragments) {
  let previous = -1;
  for (const fragment of fragments) {
    assert.ok(typeof fragment === 'string' && fragment.length, 'Order fragment must be non-empty');
    const index = html.indexOf(fragment);
    assert.notEqual(index, -1, 'Missing order fragment: ' + fragment);
    assert.equal(html.indexOf(fragment, index + 1), -1, 'Ambiguous order fragment: ' + fragment);
    assert.ok(index > previous, 'Wrong DOM order: ' + fragment);
    previous = index;
  }
}

// DESIGN-SYSTEM §5. Allow fingerprint only in a dedicated Security fixture.
// Scan copy, including accessible labels, rather than internal class names/URLs.
export function assertNoBannedWords(html, {security = false} = {}) {
  const labels = [...html.matchAll(/\s(?:aria-label|title|alt|placeholder)="([^"]*)"/gi)]
    .map(match => decode(match[1]));
  const copy = normalize([renderedText(html), ...labels].join(' '));
  const banned = [
    /\bMember\s+\d+\b/i, /\bkey\s+id\b/i,
    ...['verdict', 'receipt', 'harness', 'roster', 'lease', 'claim', 'attempt',
      'settled', 'coordinator', 'collective', 'execution_failed', 'UNVERIFIED']
      .map(word => new RegExp('\\b' + escapePattern(word) + '\\b', 'i')),
    /\bfaravan\s+doctor\b/i, /\bCheck\s+setup\b/i, /\bAny\s+available\s+model\b/i,
    ...(security ? [] : [/\bfingerprint\b/i]),
  ];
  for (const pattern of banned) assert.doesNotMatch(copy, pattern, 'Banned UI copy: ' + pattern);
}
