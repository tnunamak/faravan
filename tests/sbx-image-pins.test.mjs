import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createImageArgs, loadImagePins, validatePins, IMAGE_UNPINNED } from '../lib/sbx-image-pins.mjs';
import { HARNESS_ADAPTERS } from '../lib/harnesses/index.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const pins = loadImagePins();

test('the shipped pin file validates and holds only content digests', () => {
  validatePins(pins);
  for (const [name, digest] of Object.entries(pins.agents)) {
    if (digest === null) assert.equal(typeof pins.unpinned[name], 'string', `${name} says why it has no pin`);
    else assert.match(digest, DIGEST);
  }
  assert.doesNotMatch(JSON.stringify(pins), /latest/);
});

test('every registry agent a harness installs is in the pin file, pinned or explicitly unpinned', () => {
  for (const adapter of HARNESS_ADAPTERS) {
    const install = adapter.spec.install;
    if (['wf-gh-cli', 'wf-pi'].includes(install)) continue;
    assert.ok(Object.hasOwn(pins.agents, install), `${install} is in lib/sbx-image-pins.json`);
  }
});

test('digest form: the positional is the repository, agent and digest', () => {
  const { flags, positional } = createImageArgs('claude', pins);
  assert.deepEqual(flags, []);
  assert.equal(positional, `docker.io/sbx/claude@${pins.agents.claude}`);
});

test('template form: the digest goes to --template and the agent name stays the positional', () => {
  const { flags, positional } = createImageArgs('codex', { ...pins, form: 'template' });
  assert.deepEqual(flags, ['--template', `docker.io/sbx/codex@${pins.agents.codex}`]);
  assert.equal(positional, 'codex');
});

test('an unpinned or unknown agent fails closed with a stable code', () => {
  for (const name of ['gemini', 'nonesuch', 'claude:latest', '__proto__'])
    assert.throws(() => createImageArgs(name, pins), error => error.code === IMAGE_UNPINNED, name);
});

test('a reference that already names its content, and the local GitHub kit, pass through', () => {
  const ref = 'registry.example/team/guest@sha256:' + 'a'.repeat(64);
  assert.equal(createImageArgs(ref, pins).positional, ref);
  assert.equal(createImageArgs('wf-gh-cli', pins).positional, 'wf-gh-cli');
});

test('a pin file with a floating or malformed entry is rejected', () => {
  assert.throws(() => validatePins({ ...pins, agents: { claude: 'latest' } }));
  assert.throws(() => validatePins({ ...pins, agents: { claude: 'sha256:abc' } }));
  assert.throws(() => validatePins({ ...pins, form: 'tag' }));
  assert.throws(() => validatePins({ ...pins, repository: 'docker.io/sbx:latest' }));
  assert.throws(() => validatePins({ ...pins, agents: { gemini: null }, unpinned: {} }));
});

test('no shipped kit names a base image by tag alone', () => {
  for (const kit of readdirSync(path.join(root, 'kits'))) {
    const text = readFileSync(path.join(root, 'kits', kit, 'spec.yaml'), 'utf8');
    const images = [...text.matchAll(/^\s*image:\s*"?([^"\s#]+)"?/gm)].map(m => m[1]);
    // A mixin composes onto the agent's own pinned image, so it must not name a base image at all.
    if (/^kind:\s*mixin\s*$/m.test(text)) { assert.deepEqual(images, [], `${kit} is a mixin and names no image`); continue; }
    assert.ok(images.length > 0, `${kit} declares an image`);
    for (const image of images) assert.match(image, /@sha256:[0-9a-f]{64}$/, `${kit}: ${image}`);
  }
});

test('lib never builds a create command from the bare job image or a :latest tag', () => {
  const source = readFileSync(path.join(root, 'lib', 'docker-backend.mjs'), 'utf8');
  assert.doesNotMatch(source, /validatedJob\.image,\s*\.\.\.\(handle\._mountless/);
  assert.doesNotMatch(source, /sbx\/[a-z-]+:latest/);
});
