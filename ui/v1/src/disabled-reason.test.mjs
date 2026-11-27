import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

// A disabled Button or Action prints its reason beside itself. Without disabledReason it falls back to the
// generic "This control is unavailable right now.", which tells the person nothing. Our own code must never reach it.
const dir = new URL('.', import.meta.url).pathname;
const files = (base) => readdirSync(base, {withFileTypes: true}).flatMap(entry => entry.isDirectory()
  ? files(join(base, entry.name)) : entry.name.endsWith('.jsx') ? [join(base, entry.name)] : []);

// The text of one JSX opening tag: from after the name to the closing `>`, skipping braces and quotes.
function openingTag(source, from) {
  let depth = 0, quote = '';
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return source.slice(from, i);
  }
  return source.slice(from);
}
// Props at the top level of the tag only: braces and strings are blanked so a nested `disabled=` is not counted.
const topLevel = tag => { let depth = 0, out = ''; for (const c of tag) { if (c === '{') depth++; if (depth === 0) out += c; if (c === '}') depth--; } return out; };

export function disabledWithoutReason(source) {
  const hits = [];
  for (const match of source.matchAll(/<(Button|Action)\b/g)) {
    const props = topLevel(openingTag(source, match.index + match[0].length));
    if (/\sdisabled=/.test(props) && !/\sdisabledReason=/.test(props) && !/\{\.\.\./.test(props)) {
      hits.push(source.slice(0, match.index).split('\n').length);
    }
  }
  return hits;
}

test('the scan finds a disabled Button with no reason', () => {
  assert.deepEqual(disabledWithoutReason('<Button disabled={x}>Go</Button>'), [1]);
  assert.deepEqual(disabledWithoutReason('<Action\n  run={() => a > b}\n  disabled={!x}>Go</Action>'), [1]);
  assert.deepEqual(disabledWithoutReason('<Button disabled={x} disabledReason="Wait">Go</Button>'), []);
  assert.deepEqual(disabledWithoutReason('<Button onClick={() => y(disabled=1)}>Go</Button>'), []);
});

test('every disabled Button or Action in the app says why', () => {
  const found = [];
  for (const file of files(dir)) for (const line of disabledWithoutReason(readFileSync(file, 'utf8'))) found.push(file.slice(dir.length) + ':' + line);
  assert.deepEqual(found, [], 'add a short, true disabledReason to each');
});
