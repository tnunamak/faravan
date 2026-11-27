import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planSweep, watermarkStep, digestHex, imageMatchesDigests, parseTemplateListing, isAssembledImage, parseFullImageListing, kitImageReport,
  SWEEP_MIN_AGE_MS, SANDBOX_MIN_AGE_MS, WATERMARK_START_FREE_BYTES, WATERMARK_STOP_FREE_BYTES,
} from '../lib/disk-sweep-plan.mjs';

const hex = c => c.repeat(64);
const CUR = hex('a'), PREV = hex('b'), OLD = hex('c');
const NOW = 1_000_000_000_000;
const OLD_ENOUGH = NOW - 3 * SANDBOX_MIN_AGE_MS;
const image = (tag, digest, extra = {}) => ({ id: `image:docker.io/library/sandbox-kit-assembled:${tag}`, kind: 'image', ref: `docker.io/library/sandbox-kit-assembled:${tag}`, imageId: digest.slice(0, 12), createdAt: OLD_ENOUGH, bytes: 100, ...extra });
const sandbox = (name, status, extra = {}) => ({ id: `sandbox:${name}`, kind: 'sandbox', ref: name, status, pin: null, createdAt: OLD_ENOUGH, bytes: 10, ...extra });
const roots = (extra = {}) => ({ current: new Set([CUR]), previous: new Set([PREV]), sandboxes: new Map(), referenced: new Set(), cacheKeep: new Set(), ...extra });
// Image ids are only trusted once one listed image matches a digest known to be in use.
const anchor = () => image('aaaaaaaaaaaaaaaa', CUR);
const verdict = (plan, id) => [...plan.delete.map(i => ['delete', i]), ...plan.keep.map(i => ['keep', i])].find(([, i]) => i.id === id);

test('an image of the current pin and one of the previous pin are roots; an older one is removed', () => {
  const plan = planSweep({ owned: [image('1111111111111111', CUR), image('2222222222222222', PREV), image('3333333333333333', OLD)], roots: roots(), now: NOW });
  assert.deepEqual(plan.delete.map(i => i.ref.split(':').pop()), ['3333333333333333']);
  assert.equal(verdict(plan, 'image:docker.io/library/sandbox-kit-assembled:1111111111111111')[1].reason, 'current_pin');
  assert.equal(verdict(plan, 'image:docker.io/library/sandbox-kit-assembled:2222222222222222')[1].reason, 'previous_pin');
  assert.equal(plan.delete[0].reason, 'unreachable');
});

test('a running sandbox and a stopped one both keep the image they were made from', () => {
  const owned = [image('3333333333333333', OLD), sandbox('wf-0000000000000001', 'running', { pin: OLD }), sandbox('wf-0000000000000002', 'stopped', { pin: OLD })];
  const present = new Map([['wf-0000000000000001', { pin: OLD, status: 'running' }], ['wf-0000000000000002', { pin: OLD, status: 'stopped' }]]);
  const plan = planSweep({ owned, roots: roots({ sandboxes: present, referenced: new Set(['wf-0000000000000002']) }), now: NOW });
  assert.equal(verdict(plan, owned[0].id)[0], 'keep');
  assert.equal(verdict(plan, owned[0].id)[1].reason, 'used_by_sandbox');
  assert.equal(verdict(plan, owned[1].id)[1].reason, 'running');
  assert.equal(verdict(plan, owned[2].id)[1].reason, 'referenced_by_job_or_journal');
  assert.deepEqual(plan.delete, []);
});

test('a sandbox of unknown image keeps every image whose use cannot be excluded', () => {
  const owned = [image('3333333333333333', OLD), anchor()];
  const present = new Map([['wf-0000000000000003', { pin: null, status: 'running' }]]);
  const plan = planSweep({ owned, roots: roots({ sandboxes: present }), now: NOW });
  assert.equal(verdict(plan, owned[0].id)[1].reason, 'sandbox_of_unknown_image');
  assert.deepEqual(plan.delete, []);
});

test('an image whose identity is unknown is kept', () => {
  const plan = planSweep({ owned: [image('3333333333333333', OLD, { imageId: null })], roots: roots(), now: NOW });
  assert.equal(plan.keep[0].reason, 'identity_unknown');
});

test('an item younger than the minimum age is kept even when nothing roots it', () => {
  const owned = [image('3333333333333333', OLD, { createdAt: NOW - SWEEP_MIN_AGE_MS + 1000 }), sandbox('wf-0000000000000004', 'stopped', { createdAt: NOW - SANDBOX_MIN_AGE_MS + 1000 }), anchor()];
  const plan = planSweep({ owned, roots: roots(), now: NOW });
  assert.deepEqual(plan.keep.slice(0, 2).map(i => i.reason), ['too_new', 'too_new']);
  assert.deepEqual(plan.delete, []);
});

test('a live lease protects an item that nothing else protects; an expired lease does not', () => {
  const owned = [image('3333333333333333', OLD), anchor()];
  const live = planSweep({ owned, roots: roots(), leases: [{ id: 'l1', item: 'image:*', expiresAt: NOW + 1000 }], now: NOW });
  assert.equal(verdict(live, owned[0].id)[1].reason, 'create_in_flight');
  assert.deepEqual(live.delete, []);
  const named = planSweep({ owned, roots: roots(), leases: [{ id: 'l2', item: owned[0].id, expiresAt: NOW + 1000 }], now: NOW });
  assert.equal(verdict(named, owned[0].id)[1].reason, 'leased');
  const expired = planSweep({ owned, roots: roots(), leases: [{ id: 'l3', item: 'image:*', expiresAt: NOW - 1 }, { id: 'l4', item: owned[0].id, expiresAt: NOW }], now: NOW });
  assert.equal(expired.delete.length, 1, 'a lease is ignored from the moment it expires');
});

test('while no listed image matches a digest known to be in use, no image is removed: the id reading is unconfirmed', () => {
  const owned = [image('3333333333333333', OLD), image('4444444444444444', hex('d'))];
  const plan = planSweep({ owned, roots: roots(), now: NOW });
  assert.deepEqual(plan.delete, []);
  assert.deepEqual(plan.keep.map(i => i.reason), ['mapping_unverified', 'mapping_unverified']);
  const confirmed = planSweep({ owned: [...owned, anchor()], roots: roots(), now: NOW });
  assert.equal(confirmed.delete.length, 2);
});

test('a stopped sandbox nobody references is an eligible orphan; a referenced or running one is not', () => {
  const owned = [sandbox('wf-0000000000000005', 'stopped'), sandbox('wf-0000000000000006', 'stopped'), sandbox('wf-0000000000000007', 'running')];
  const plan = planSweep({ owned, roots: roots({ referenced: new Set(['wf-0000000000000006']) }), now: NOW });
  assert.deepEqual(plan.delete.map(i => i.ref), ['wf-0000000000000005']);
  assert.equal(plan.delete[0].reason, 'stopped_orphan_sandbox');
});

test('a superseded cache directory is eligible and the current one is a root', () => {
  const cache = (name, extra = {}) => ({ id: `cache:/c/${name}`, kind: 'cache', ref: `/c/${name}`, createdAt: OLD_ENOUGH, bytes: 5, ...extra });
  const plan = planSweep({ owned: [cache('now'), cache('old')], roots: roots({ cacheKeep: new Set(['/c/now']) }), now: NOW });
  assert.deepEqual(plan.delete.map(i => i.ref), ['/c/old']);
  assert.equal(plan.delete[0].reason, 'superseded_cache');
});

test('the plan is a pure function: same input, same answer, input untouched', () => {
  const owned = [image('3333333333333333', OLD), image('1111111111111111', CUR)];
  const frozen = JSON.stringify(owned);
  const a = planSweep({ owned, roots: roots(), now: NOW });
  const b = planSweep({ owned, roots: roots(), now: NOW });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(owned), frozen);
  assert.deepEqual(a.reasons, { current_pin: 1, unreachable: 1 });
});

test('pressure never makes a rooted or leased item eligible: the plan has no pressure input', () => {
  assert.equal(planSweep.length, 1);
  const owned = [image('1111111111111111', CUR), image('2222222222222222', PREV), image('3333333333333333', OLD, { createdAt: NOW })];
  const plan = planSweep({ owned, roots: roots(), now: NOW, pressure: true, freeBytes: 0 });
  assert.deepEqual(plan.delete, []);
});

test('watermarks: collecting starts below the high mark and stops only at the low mark', () => {
  const GiB = 1024 ** 3;
  assert.ok(WATERMARK_STOP_FREE_BYTES > WATERMARK_START_FREE_BYTES, 'a gap between the two marks is the hysteresis');
  let state = false;
  const step = free => { state = watermarkStep({ freeBytes: free, collecting: state }); return state; };
  assert.equal(step(WATERMARK_START_FREE_BYTES + GiB), false, 'above the start mark: idle');
  assert.equal(step(WATERMARK_START_FREE_BYTES - 1), true, 'crossing below it starts collecting');
  assert.equal(step(WATERMARK_START_FREE_BYTES + GiB), true, 'between the marks it keeps collecting');
  assert.equal(step(WATERMARK_STOP_FREE_BYTES - 1), true);
  assert.equal(step(WATERMARK_STOP_FREE_BYTES), false, 'reaching the stop mark ends it');
  assert.equal(step(WATERMARK_START_FREE_BYTES + GiB), false, 'and it does not restart between the marks');
});

test('digest helpers and the sbx template listing', () => {
  assert.equal(digestHex(`docker.io/sbx/claude@sha256:${CUR}`), CUR);
  assert.equal(digestHex('docker.io/sbx/claude:latest'), null);
  assert.equal(imageMatchesDigests('aaaaaaaaaaaa', new Set([CUR])), true);
  assert.equal(imageMatchesDigests(`sha256:${CUR}`, new Set([CUR])), true);
  assert.equal(imageMatchesDigests('bbbbbbbbbbbb', new Set([CUR])), false);
  assert.equal(imageMatchesDigests('abc', new Set([CUR])), null, 'too short to identify');
  assert.equal(imageMatchesDigests(null, new Set([CUR])), null);
  const rows = parseTemplateListing({ code: 0, stdout: JSON.stringify([
    { repository: 'docker.io/library/sandbox-kit-assembled', tag: '02a9a25c25947565', image_id: 'fac568b01d33', size: 1234, created: '2026-11-05T10:00:00Z' },
    { repository: 'myorg/app', tag: 'v1', image_id: 'deadbeef0000', size: '2.5 GB' },
    { repository: 'docker.io/docker/sandbox-templates', tag: '<none>', image_id: 'x' },
  ]) });
  assert.equal(rows.length, 2, 'a row with no usable tag cannot be named, so it is dropped');
  assert.equal(rows[0].ref, 'docker.io/library/sandbox-kit-assembled:02a9a25c25947565');
  assert.equal(rows[0].bytes, 1234);
  assert.equal(rows[0].createdAt, Date.parse('2026-11-05T10:00:00Z'));
  assert.equal(rows[1].bytes, 2.5 * 1000 ** 3);
  assert.equal(isAssembledImage(rows[0]), true);
  assert.equal(isAssembledImage(rows[1]), false);
  assert.equal(parseTemplateListing({ code: 1, stdout: '' }), null);
  assert.equal(parseTemplateListing({ code: 0, stdout: 'not json' }), null);
  assert.equal(parseTemplateListing({ code: 0, stdout: '{"unexpected":1}' }), null, 'an unrecognised shape fails closed');
});

test('parseTemplateListing reads the shape a live sbx store returns', () => {
  const stdout = JSON.stringify([
    { id: '4a94d9144a70', repository: 'docker.io/docker/sandbox-templates', tag: 'claude-code-docker', flavor: 'claude-code-docker', created_at: '2026-10-21T14:09:01Z', size: 1132775636 },
    { id: '611f52fac7bf', repository: 'docker.io/library/sandbox-kit-assembled', tag: '88e84ab0d5c78593', flavor: 'claude', created_at: '2026-11-05T18:22:53Z', size: 365660532 },
  ]);
  const rows = parseTemplateListing({ code: 0, stdout, stderr: '' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], {
    id: 'image:docker.io/library/sandbox-kit-assembled:88e84ab0d5c78593', kind: 'image',
    ref: 'docker.io/library/sandbox-kit-assembled:88e84ab0d5c78593', imageId: '611f52fac7bf',
    createdAt: Date.parse('2026-11-05T18:22:53Z'), bytes: 365660532,
  });
  assert.deepEqual(rows.map(isAssembledImage), [false, true], 'the sbx-owned template is not a kit assembly');
  assert.equal(imageMatchesDigests(rows[1].imageId, ['611f52fac7bfc5fac443802588b490dda463d219b5d35e0b7087156e29d1ef10']), true, 'the 12-hex id is the head of the pinned digest');
});

test('strict cap inventory refuses short or mixed IDs without expanding them', () => {
  const row = (tag, id) => ({repository:'docker.io/library/sandbox-kit-assembled',tag,id});
  const listing = rows => ({code:0,stdout:JSON.stringify(rows)});
  assert.equal(parseFullImageListing(listing([row('short',CUR.slice(0,12))])), null);
  assert.equal(parseFullImageListing(listing([row('full',CUR),row('short',PREV.slice(0,12))])), null);
  assert.deepEqual(parseFullImageListing(listing([row('full',CUR),row('previous',PREV)])).map(row=>row.imageId), [CUR,PREV]);
});

test('the report requires exact ownership and a complete idle inventory', () => {
  const images = [CUR,PREV,OLD,hex('d'),hex('e')].map((id,i)=>
    image(String(i),id,{imageId:id,createdAt:NOW-(10-i)*86_400_000}));
  const digest = hex('f');
  const owned = Object.fromEntries(images.map(({ref,imageId})=>[ref,{imageId,kitInputDigest:digest}]));
  const generation = imageId => ({digests:[digest],images:[{imageId,inputDigest:digest}]});
  const input = {images,owned,generations:{current:generation(CUR),previous:generation(PREV)},complete:true,now:NOW};
  const report = kitImageReport(input);
  assert.equal(report.reportOnly,true);
  assert.deepEqual(report.images.filter(row=>row.eligible).map(row=>row.imageId),[OLD]);
  assert.equal(kitImageReport({...input,complete:false}).eligible,0);
  const ref = images[2].ref;
  const shortOwned = {...owned,[ref]:{...owned[ref],imageId:OLD.slice(0,12)}};
  const unproven = kitImageReport({...input,owned:shortOwned});
  assert.equal(unproven.images.find(row=>row.ref===ref)?.reason,'not_owned');
  assert.equal(unproven.eligible,0);
});
