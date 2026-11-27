// THE OWNERSHIP RULE. An image or cache may be removed only when BOTH hold:
//   1. the ledger records it as ours (lib/disk-ledger.mjs `owned`) with the exact image id it
//      was made as, and
//   2. it is in our namespace: an image whose repository is exactly
//      `docker.io/library/sandbox-kit-assembled` in the app's own sbx HOME; a cache that is a
//      digest-named child of the app's own guest-runtime directory. No suffix or look-alike
//      match: `other.example/x/sandbox-kit-assembled` is never ours.
// A record is made one way only: by the create that produced the item, with the store's gate
// held from before the create until the record is written.
//   - images: sbx reports no image id for a create and no link from a request to an image (the
//     assembled tag is a hash sbx computes from the kit). So the create path holds the gate,
//     lists the assembled images before it dispatches, and lists them again after the create
//     succeeded. Every writer of this store takes the gate, so every image that is new in
//     that pair of listings is this create's. A failed create, an image that was already there, or an unreadable listing records
//     nothing: the images stay unowned and are never removed. Time is never used.
//   - caches: recorded when the app writes the runtime directory.
// There is no adoption: what older versions left, and anything unrecorded, stays unowned. It is
// reported as unknown and not touched.
import path from 'node:path';
import { isAssembledImage } from './disk-sweep-plan.mjs';

export const CREATED_REASON = 'created';
const DIGEST_DIR = /^[0-9a-f]{64}$/;

export const isCacheDir = (root, dir) => typeof dir === 'string' && typeof root === 'string' && path.dirname(dir) === root && DIGEST_DIR.test(path.basename(dir));

const imageKey = image => `${image.ref}|${image.imageId}`;
// What the create path remembers about the store before it dispatches.
export const imagesBefore = images => images.filter(isAssembledImage).map(imageKey);

// Records every assembled image that is new between `before` (imagesBefore) and `images`. One
// create makes several references (the kit's tag and its `-kit-N` and `-template` forms), and the
// gate was held for the whole pair of listings, so all of them are this create's. A new reference
// with no image id cannot be proved and is left unowned.
export function ownCreatedImages({ ledger, before, images, generation = null }) {
  const seen = new Set(before);
  const fresh = images.filter(image => isAssembledImage(image) && typeof image.imageId === 'string' && image.imageId && !seen.has(imageKey(image)));
  if (fresh.length === 0) {
    if (generation) ledger.recordKitImages(generation.digests, generation.inputDigest, []);
    return 0;
  }
  const entries = fresh.map(image => ({ ref: image.ref, imageId: image.imageId }));
  if (generation) ledger.ownImages(entries, CREATED_REASON, generation);
  else ledger.ownImages(entries, CREATED_REASON);
  return fresh.length;
}

// A ledger record names an image by its reference AND by the immutable image it was made as. A tag
// that now names a different image is not the one we recorded. A record with no id owns nothing.
export const ownsImage = (record, image) => Boolean(record) && typeof record.imageId === 'string' && record.imageId !== '' && record.imageId === image.imageId;
