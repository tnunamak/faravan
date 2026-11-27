import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The agent kit images Faravan asks sbx to create sandboxes from. The bare agent
// name (`claude`) makes sbx resolve the floating `docker.io/sbx/<name>:latest`, so
// every upstream publish pulled a new image and assembled a new one beside the old
// ones. A checked-in pin file (lib/sbx-image-pins.json, shipped inside the signed
// release) names each agent kit by content digest instead. An update moves a pin
// only by shipping a new file.
//
// Two ways to hand the pin to sbx are supported, chosen by the file's `form`:
//   digest   `sbx create ... docker.io/sbx/<name>@sha256:...`   (kit reference by digest)
//   template `sbx create ... --template docker.io/sbx/<name>@sha256:... <name>`
// To move a pin, read the new index digest anonymously (an HTTP HEAD of
// https://registry-1.docker.io/v2/sbx/<name>/manifests/latest with a pull-scope token,
// read from Docker-Content-Digest) and ship the edited file in a release.
// The choice lives only in createImageArgs; callers never branch on it.

const PIN_FILE = fileURLToPath(new URL('./sbx-image-pins.json', import.meta.url));
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+$/;
const BY_DIGEST = /^[a-z0-9][a-z0-9._\/:-]*@sha256:[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9-]*$/;

// Agents that are not registry images: a local kit directory, passed with --kit.
// Its own spec pins its base image (kits/<name>/spec.yaml).
const LOCAL_KITS = Object.freeze(['wf-gh-cli', 'wf-pi']);

export const IMAGE_UNPINNED = 'image_unpinned';

export function validatePins(pins) {
  if (!pins || pins.schema !== 1) throw new Error('sbx image pins: unsupported schema');
  if (!['digest', 'template'].includes(pins.form)) throw new Error('sbx image pins: form must be digest or template');
  if (typeof pins.repository !== 'string' || !REPOSITORY.test(pins.repository) || pins.repository.includes(':latest'))
    throw new Error('sbx image pins: repository is invalid');
  if (!pins.agents || typeof pins.agents !== 'object' || Array.isArray(pins.agents)) throw new Error('sbx image pins: agents is missing');
  for (const [name, digest] of Object.entries(pins.agents)) {
    if (!NAME.test(name) || LOCAL_KITS.includes(name)) throw new Error(`sbx image pins: bad agent name ${name}`);
    if (digest !== null && !DIGEST.test(digest)) throw new Error(`sbx image pins: ${name} is not a sha256 digest`);
    if (digest === null && typeof pins.unpinned?.[name] !== 'string') throw new Error(`sbx image pins: unpinned ${name} needs a reason`);
  }
  return pins;
}

let cached;
export function loadImagePins(file = PIN_FILE) {
  if (file !== PIN_FILE) return validatePins(JSON.parse(readFileSync(file, 'utf8')));
  return cached ??= validatePins(JSON.parse(readFileSync(PIN_FILE, 'utf8')));
}

/**
 * The sbx create arguments that name the image for one agent: {flags, positional}.
 * `flags` go before the agent positional. An agent without a checked-in digest
 * fails closed; it is never created from a floating tag.
 */
export function createImageArgs(image, pins = loadImagePins()) {
  if (LOCAL_KITS.includes(image)) return { flags: [], positional: image };
  // A reference that already names its content is as fixed as a pin.
  if (BY_DIGEST.test(image)) return { flags: [], positional: image };
  const digest = Object.hasOwn(pins.agents, image) ? pins.agents[image] : undefined;
  if (!digest) {
    const reason = pins.unpinned?.[image] ?? `Faravan has no pinned image for the agent "${image}".`;
    throw Object.assign(new Error(reason), { code: IMAGE_UNPINNED });
  }
  const ref = `${pins.repository}/${image}@${digest}`;
  return pins.form === 'template' ? { flags: ['--template', ref], positional: image } : { flags: [], positional: ref };
}
