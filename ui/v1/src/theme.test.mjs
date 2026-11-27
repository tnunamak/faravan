import test from 'node:test';
import assert from 'node:assert/strict';
import {THEME_KEY, themeOf, readTheme, saveTheme, applyTheme, themeVM} from './theme.mjs';
import {readFileSync} from 'node:fs';

const memory = (initial = {}) => { const map = new Map(Object.entries(initial)); return {getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k), map}; };

test('theme: only light and dark are overrides; anything else follows the system', () => {
  for (const value of [null, '', 'System', 'blue', undefined]) assert.equal(themeOf(value), 'system');
  assert.equal(readTheme(memory({[THEME_KEY]: 'dark'})), 'dark');
  assert.equal(readTheme({getItem() { throw new Error('blocked'); }}), 'system');
});

test('theme: choosing System removes the stored override instead of saving "system"', () => {
  const storage = memory({[THEME_KEY]: 'dark'});
  assert.equal(saveTheme('system', storage), true);
  assert.equal(storage.map.has(THEME_KEY), false);
  saveTheme('light', storage);
  assert.equal(storage.map.get(THEME_KEY), 'light');
  assert.equal(saveTheme('dark', {setItem() { throw new Error('quota'); }}), false);
});

test('theme: applyTheme sets data-theme for an override and clears it for system', () => {
  const root = {dataset: {}};
  applyTheme('dark', root); assert.equal(root.dataset.theme, 'dark');
  applyTheme('system', root); assert.equal('theme' in root.dataset, false);
});

test('theme: the note says what is shown now and where the choice is kept', () => {
  assert.equal(themeVM('system', {systemDark: true}).note, 'Follows your system. It is dark now.');
  assert.equal(themeVM('light').note, 'Kept light in this browser, whatever the system uses.');
  assert.deepEqual(themeVM('dark').options.map(o => [o.id, o.pressed]), [['system', false], ['light', false], ['dark', true]]);
});

test('theme: the bootstrap applies the stored theme before the stylesheet loads, so a reload never flashes', async () => {
  const source = readFileSync(new URL('./bootstrap.mjs', import.meta.url), 'utf8');
  assert.match(source, /faravan-theme/);
  assert.ok(source.indexOf('faravan-theme') < source.indexOf("load('/app.css'"), 'theme is set before the stylesheet');
});

test('theme: every semantic colour token has the same set in light and in dark', () => {
  const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
  const block = selector => { const at = css.indexOf(selector); return css.slice(at, css.indexOf('}', at)); };
  const names = text => [...text.matchAll(/(--[a-z0-9-]+):/g)].map(m => m[1]).sort();
  assert.deepEqual(names(block('[data-theme=dark]{')), names(block(':root,[data-theme=light]{')));
});
