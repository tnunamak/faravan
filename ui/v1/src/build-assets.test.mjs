import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {build, mergeConfig} from 'vite';
import config from '../vite.config.mjs';

test('recovery phone overrides follow base layout without duplicate cards', async () => {
  const css = await readFile(new URL('./recovery.css', import.meta.url), 'utf8');
  assert.equal(css.split('@media')[0].match(/\.recovery\s*\{/g)?.length, 1);
  assert.ok(css.lastIndexOf('@media') > css.indexOf('#app{'));
  assert.match(css.slice(css.lastIndexOf('@media')), /#app\{padding:var\(--s-4\)\}/);
});

// App code and fonts stay bundled under a strict CSP; public icons are copied as static files.
test('fonts and the icon sprite are inlined into app.css and app.mjs', async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), 'faravan-ui-assets-'));
  t.after(() => rm(outDir, {recursive: true, force: true}));
  await build(mergeConfig(config, {
    logLevel: 'silent', configFile: false,
    build: {outDir, lib: {entry: resolve(import.meta.dirname, 'fixtures/assets-entry.jsx')}},
  }));
  assert.deepEqual((await readdir(outDir)).sort(), ['app.css', 'app.mjs', 'apple-touch-icon.png', 'favicon.ico',
    'favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'index.html', 'manifest.webmanifest']);
  const css = await readFile(join(outDir, 'app.css'), 'utf8');
  assert.equal(css.match(/url\(data:font\/woff2;base64,/g)?.length, 2, 'only the two used font files are data: URLs');
  assert.match(css, /font-family:"?Source Sans 3"?/);
  assert.match(css, /font-family:"?JetBrains Mono"?/);
  assert.doesNotMatch(css, /font-family:"?(?:Instrument Sans|Young Serif)"?/);
  assert.doesNotMatch(css, /url\(\.\/fonts|url\(\/assets/);
  const js = await readFile(join(outDir, 'app.mjs'), 'utf8');
  for (const id of ['mark', 'home', 'jobs', 'lend', 'circles', 'tray-need']) assert.ok(js.includes('id=\\"' + id + '\\"') || js.includes('id="' + id + '"'), 'sprite lacks ' + id);
  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  assert.match(html, /font-src data:;/);
  assert.match(html, /img-src 'self' blob: data:; manifest-src 'self';/);
  assert.match(html, /style-src blob:/);
  assert.match(bootstrap, /data:font\/woff2;base64,/);
  assert.match(bootstrap, /var\(--text-title1\)/);
  assert.match(bootstrap, /Reconnect to Faravan/);
  // The recovery screen shows the one mark, taken from the sprite's #mark symbol at build time.
  const mark = /<symbol id="mark" (viewBox="[^"]+")>([\s\S]*?)<\/symbol>/.exec(await readFile(new URL('./icons.svg', import.meta.url), 'utf8'));
  assert.ok(bootstrap.includes(JSON.stringify('<svg ' + mark[1] + '>' + mark[2] + '</svg>')), 'the recovery screen lacks #mark');
  assert.ok(bootstrap.includes('Open it again from Faravan on this computer.'));
  assert.match(bootstrap, /Settings → Pairing/);
  assert.doesNotMatch(bootstrap, /Faravan restarted|SESSION ENDED/);
  for (const asset of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'manifest.webmanifest'])
    assert.ok(html.includes(asset), 'app shell lacks ' + asset);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
});
