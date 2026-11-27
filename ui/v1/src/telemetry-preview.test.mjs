import {mount, click, flush, teardown} from './mounted.test-helper.mjs';
import {h} from 'preact';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {previewModel, downloadName} from './telemetry-preview.mjs';
import {TelemetryPreview} from './telemetry-ui.jsx';
import {routeFromHash, ROUTES} from './helpers.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';

const state = (over = {}) => ({level: 'on', effective: 'on', reason: {kind: 'choice'}, region: null, notice: {shown: true, pending: false}, uploadable: true, endpoint_configured: true,
  version: '0.1.0', queued: {counts: 2, diagnostics: 0, quota: 1}, queued_bytes: 2048, upload: {}, ...over});
// Bodies are kept as exact text, including spacing a JSON formatter would change.
const BODY_A = '{"schema":"faravan-telemetry","schema_version":1,  "stream":"counts"}';
const BODY_B = '{"stream":"quota",\n"records":[]}';
const output = (over = {}) => ({state: state(), items: [
  {stream: 'counts', state: 'queued', at: '2026-10-21T10:00:00.000Z', bytes: 412, status: null, body: BODY_A},
  {stream: 'quota', state: 'sent', at: '2026-10-20T09:30:00.000Z', bytes: 2048, status: 202, body: BODY_B},
  {stream: 'counts', state: 'rejected', at: '2026-10-19T08:00:00.000Z', bytes: 10, status: 400, body: '{}'},
], ...over});
const fixedTime = at => 'T(' + at + ')';

test('the page model keeps every body byte for byte and in order', () => {
  const model = previewModel(output(), {format: fixedTime});
  assert.deepEqual(model.items.map(item => item.body), [BODY_A, BODY_B, '{}']);
  assert.deepEqual(model.items.map(item => item.stateLabel), ['Waiting to send', 'Sent', 'Rejected']);
  assert.equal(model.items[0].statusLabel, 'no answer yet');
  assert.equal(model.items[1].statusLabel, '202');
  assert.equal(model.items[1].time, 'T(2026-10-20T09:30:00.000Z)');
  assert.match(model.items[0].line, /^Counts · Waiting to send · T\(.*\) · 412 bytes · no answer yet$/);
  assert.equal(model.sentence, 'On. Include usage, model, plan, computer and allowance data.');
  assert.equal(model.queuedLine, 'Waiting to send: 2 counts, 0 diagnostics, 1 allowance weeks (2.0 KB).');
  assert.equal(model.emptyLine, null);
});

test('the page renders the header, the queued counts, each item and the exact body in a <pre>', () => {
  const html = renderFixture(TelemetryPreview, {output: output()});
  const text = renderedText(html);
  assert.match(text, /^Your data See what we send On\./);
  assert.match(text, /Waiting to send: 2 counts/);
  assert.match(text, /Counts · Waiting to send/);
  assert.match(text, /Allowance week · Sent .* status 202/);
  assert.match(text, /Counts · Rejected .* status 400/);
  const bodies = [...html.matchAll(/<pre[^>]*>([^]*?)<\/pre>/g)].map(match => match[1].replace(/&quot;/g, '"'));
  assert.deepEqual(bodies, [BODY_A, BODY_B, '{}']);
  assert.equal((html.match(/>Copy</g) || []).length, 3);
  assert.equal((html.match(/>Download</g) || []).length, 3);
});

test('off: empty retained evidence makes no historical sending claim', () => {
  const off = {state: state({level: 'off', effective: 'off', queued: {counts: 0, diagnostics: 0, quota: 0}, queued_bytes: 0}), items: []};
  const model = previewModel(off, {format: fixedTime});
  assert.match(model.sentence, /^Off\. Send nothing\./);
  assert.equal(model.off, true);
  assert.equal(model.queuedLine, 'Nothing is waiting to send.');
  assert.equal(model.emptyLine, 'No locally retained reports to show.');
  const text = renderedText(renderFixture(TelemetryPreview, {output: off}));
  assert.match(text, /Off\. Send nothing\./);
  assert.doesNotMatch(text, /<pre/);
});

test('environment switch: the header names the variable', () => {
  const env = {state: state({level: null, effective: 'off', reason: {kind: 'env', env: 'DO_NOT_TRACK'}, queued: {counts: 0, diagnostics: 0, quota: 0}}), items: []};
  const model = previewModel(env);
  assert.equal(model.sentence, 'Off on this computer because DO_NOT_TRACK is set.');
  assert.equal(model.env, true);
  assert.match(renderedText(renderFixture(TelemetryPreview, {output: env})), /Off on this computer because DO_NOT_TRACK is set\./);
});

test('empty while on: a plain line, no items', () => {
  const empty = {state: state({effective: 'on', level: 'on', queued: {counts: 0, diagnostics: 0, quota: 0}}), items: []};
  const model = previewModel(empty);
  assert.equal(model.emptyLine, 'No locally retained reports to show.');
  assert.match(model.sentence, /^On\./);
  assert.deepEqual(previewModel(null).items, []);
});

test('download names carry the stream, time and snapshot ordinal with an optional index', () => {
  assert.equal(downloadName({stream: 'counts', at: '2026-10-21T10:00:00.000Z'}), 'faravan-report-counts-2026-10-21T10-00-00-000Z-1.json');
});

test('the page has its own route, #/you/data/telemetry', () => {
  assert.deepEqual(routeFromHash('#/you/data/telemetry'), {page: 'telemetry', id: null});
  assert.deepEqual(routeFromHash('#/settings/data/telemetry'), {page: 'telemetry', id: null});
  assert.equal(ROUTES.telemetry, 'What we send');
  for (const hash of ['#/you/data/other', '#/you/notifications/telemetry', '#/you/data/telemetry/x', '#/you/telemetry']) assert.equal(routeFromHash(hash).page, 'not-found', hash);
  assert.deepEqual(routeFromHash('#/you/data'), {page: 'settings', id: 'data'});
});

afterEach(teardown);

test('preview retries a failed GET with the same api and clears its error', async () => {
  let calls = 0, finish;
  const api = {get:(path, signal) => {
    assert.equal(path, 'telemetry/preview');
    assert.equal(signal.aborted, false);
    if (++calls === 1) return Promise.reject(new Error('offline'));
    return new Promise(resolve => { finish = resolve; });
  }};
  const view = await mount(h(TelemetryPreview, {api}));
  await flush();
  assert.match(view.text(), /offline/);
  assert.ok(view.button('Retry'));
  await click(view.button('Retry'));
  assert.equal(calls, 2);
  assert.equal(view.$('[role="alert"]'), null);
  assert.match(view.text(), /Loading/);
  finish(output()); await flush();
  assert.match(view.text(), /Waiting to send: 2 counts/);
  assert.equal(view.button('Retry'), null);
});

test('empty history leaves queue information to queuedLine, including partial previews', () => {
  for (const effective of ['off', 'on']) {
    const model = previewModel({state:state({effective}), items:[]});
    assert.match(model.queuedLine, /Waiting to send: 2 counts/);
    assert.doesNotMatch(model.emptyLine, /waiting/i);
    const empty = previewModel({state:state({effective, queued:{}}), items:[]});
    assert.equal(empty.queuedLine, 'Nothing is waiting to send.');
    assert.doesNotMatch(empty.emptyLine, /waiting/i);
  }
});

test('same counts stream and millisecond keep distinct snapshot names without changing bodies', () => {
  // Producer-supported counts rows can share an append timestamp; no durable identity is inferred.
  const at = '2026-10-21T10:00:00.000Z';
  const bodies = [
    '{"name":"op.count","period":"2026-10-21T10","attrs":{"op":"none","surface":"ui","ok":true},"value":1}',
    '{"name":"op.count","period":"2026-10-21T10","attrs":{"op":"none","surface":"ui","ok":true},"value":2}',
  ];
  const data = {state: state(), items: bodies.map(body => ({stream: 'counts', state: 'queued', at,
    bytes: Buffer.byteLength(body), status: null, body}))};
  const before = structuredClone(data);
  const model = previewModel(data);
  assert.deepEqual(model.items.map(item => item.body), bodies);
  assert.deepEqual(model.items.map(item => item.filename), [
    'faravan-report-counts-2026-10-21T10-00-00-000Z-1.json',
    'faravan-report-counts-2026-10-21T10-00-00-000Z-2.json',
  ]);
  assert.equal(downloadName(data.items[1], 1), model.items[1].filename);
  assert.deepEqual(previewModel(data).items, model.items);
  assert.deepEqual(data, before);
});

test('unavailable facade placeholders are not known off or known empty queue evidence', () => {
  // Exact unavailable().preview() public shape from the owning telemetry facade.
  const unavailable = {state: {level: null, effective: 'off', reason: {kind: 'unavailable'},
    region: null, notice: {shown: false, pending: false}, uploadable: false,
    endpoint_configured: false, version: null, queued: {counts: 0, diagnostics: 0, quota: 0},
    queued_bytes: 0, upload: {halted: false, backoff_until: null, last_status: null}}, items: []};
  const model = previewModel(unavailable);
  assert.equal(model.unavailable, true);
  assert.equal(model.off, false);
  assert.equal(model.env, false);
  assert.equal(model.sentence, 'Report information is unavailable on this computer.');
  assert.equal(model.queuedLine, 'Queue information is unavailable.');
  assert.equal(model.emptyLine, 'Locally retained reports could not be read.');
  const text = renderedText(renderFixture(TelemetryPreview, {output: unavailable}));
  for (const line of [model.sentence, model.queuedLine, model.emptyLine]) assert.ok(text.includes(line));
  assert.doesNotMatch(text, /Off\.|Nothing is waiting|sent nothing|No locally retained/);
  // Unuploadable alone is not the unavailable reason: preserve real env/policy presentation.
  for (const kind of ['choice', 'env', 'policy_unreadable']) {
    const data = {state: {...unavailable.state, reason: {kind, env: 'DO_NOT_TRACK'}}, items: []};
    const current = previewModel(data);
    assert.equal(current.unavailable, false);
    assert.equal(current.off, true);
    assert.equal(current.env, kind === 'env');
    assert.equal(current.sentence, kind === 'env'
      ? 'Off on this computer because DO_NOT_TRACK is set.' : 'Off. Send nothing.');
    assert.equal(current.emptyLine, 'No locally retained reports to show.');
  }
});

test('opaque whitespace and Unicode bodies reach pre, clipboard and download Blob unchanged', async () => {
  // Body transparency is independent of wire-schema validation; the preview must never parse these bytes.
  const bodies = [' \n{"text":"سلام ☃","n":1}\t\n', '\t{"text":"é 😀","n":2} \r\n'];
  const at = '2026-10-21T10:00:00.000Z';
  const data = {state: state(), items: bodies.map(body => ({stream: 'counts', state: 'sent', at,
    bytes: Buffer.byteLength(body), status: 202, body}))};
  const copied = [], blobs = [], downloads = [], revoked = [];
  const restores = [];
  const replace = (object, key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, {configurable: true, writable: true, value});
    restores.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : delete object[key]);
  };
  try {
    const view = await mount(h(TelemetryPreview, {output: data}));
    replace(navigator, 'clipboard', {writeText: async body => { copied.push(body); }});
    replace(URL, 'createObjectURL', blob => { blobs.push(blob); return 'blob:preview-' + blobs.length; });
    replace(URL, 'revokeObjectURL', url => { revoked.push(url); });
    const createElement = document.createElement.bind(document);
    replace(document, 'createElement', (...args) => {
      const element = createElement(...args);
      if (args[0] === 'a') element.click = () => { downloads.push(element.download); };
      return element;
    });
    assert.deepEqual(previewModel(data).items.map(item => item.body), bodies);
    for (let i = 0; i < bodies.length; i++) {
      const prefix = '.telemetry-item:nth-child(' + (i + 1) + ') ';
      assert.equal(view.$(prefix + 'pre').textContent, bodies[i]);
      await click(view.$(prefix + 'button:nth-child(1)'));
      await click(view.$(prefix + 'button:nth-child(2)'));
    }
    assert.deepEqual(copied, bodies);
    assert.deepEqual(await Promise.all(blobs.map(blob => blob.text())), bodies);
    assert.deepEqual(downloads, previewModel(data).items.map(item => item.filename));
    assert.equal(new Set(downloads).size, 2);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(revoked, ['blob:preview-1', 'blob:preview-2']);
  } finally {
    // Drain the component's owned URL-revocation timers before restoring the spies.
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const restore of restores.reverse()) restore();
  }
});
