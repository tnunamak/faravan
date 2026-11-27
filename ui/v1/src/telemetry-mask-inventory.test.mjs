import {mount, teardown, resetPage} from './mounted.test-helper.mjs';
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import render from 'preact-render-to-string';
import {MASK_CANARIES, MASK_VIEW_FILES, maskCanaryContent, maskViewFixtures} from './telemetry-mask-fixtures.mjs';
import {Disclosure} from './ds/disclosure.jsx';
import {Field} from './ds/form.jsx';
import {Sheet} from './ds/sheet.jsx';
import {Confirm} from './shared.jsx';

afterEach(teardown);
const selector = '.ph-no-capture[data-telemetry-private]';
function assertBoundary(root) {
  assert.ok(root.classList.contains('ph-no-capture'), 'private root needs ph-no-capture');
  assert.match(root.getAttribute('data-telemetry-private') || '', /^[a-z][a-z0-9-]*$/, 'private root needs a fixed region ID');
}
function assertCanariesBlocked(container) {
  for (const el of container.querySelectorAll('*')) {
    const ownText = [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('');
    const values = ownText + [...el.attributes].map(attr => attr.value).join(' ') + (el.value || '');
    if (Object.values(MASK_CANARIES).some(canary => values.includes(canary))) {
      assert.ok(el.closest(selector), 'unblocked canary in ' + el.tagName);
    }
  }
}
const fixtures = await maskViewFixtures();
test('masking inventory covers every view owned by this slice', () => {
  assert.deepEqual([...new Set(fixtures.map(f => f.file))].sort(), [...MASK_VIEW_FILES].sort());
});
for (const fixture of fixtures) {
  test('private view: ' + fixture.file, () => {
    const container = document.createElement('div');
    container.innerHTML = render(h(fixture.Component, fixture.props));
    assert.ok(container.children.length, 'fixture must render a view');
    const roots = [...container.querySelectorAll('[data-telemetry-private], .ph-no-capture')];
    assert.ok(roots.length, 'view needs an explicit privacy boundary');
    assert.ok(container.querySelector('[data-telemetry-private="' + fixture.region + '"]'), 'view must keep its own boundary, even when a child is also private');
    roots.forEach(assertBoundary);
    assertCanariesBlocked(container);
    // Probe every channel within each real boundary, including empty/loading
    // states whose private data arrives later. This is a DOM boundary test;
    // upload decoding belongs to the SDK transport tests.
    for (const root of roots) {
      const probe = document.createElement('div');
      probe.innerHTML = render(maskCanaryContent());
      root.append(probe);
      assertCanariesBlocked(container);
      for (const marker of ['class', 'data-telemetry-private']) {
        const saved = root.getAttribute(marker);
        if (marker === 'class') root.classList.remove('ph-no-capture');
        else root.removeAttribute(marker);
        assert.throws(() => assertBoundary(root), undefined, 'removing ' + marker + ' must fail even with text masking');
        root.setAttribute(marker, saved);
      }
      probe.remove();
    }
    for (const dialog of container.querySelectorAll('dialog')) assertBoundary(dialog);
  });
}
for (const [name, Component, props] of [
  ['sheet', Sheet, {open: true, label: MASK_CANARIES.attribute}],
  ['confirmation', Confirm, {title: MASK_CANARIES.text, confirmLabel: 'Confirm', onClose() {}, onConfirm() {}}],
]) {
  test('mounted ' + name + ' keeps top-layer content inside a marked root', async () => {
    resetPage();
    const view = await mount(h(Component, props, maskCanaryContent()));
    const dialog = view.$('dialog');
    assert.ok(dialog?.hasAttribute('open'));
    assertBoundary(dialog);
    assertCanariesBlocked(document.body);
  });
}

test('mounted Sheet retains its privacy boundary when caller classes change', async () => {
  resetPage();
  const sheet = (className, privateRegion) => h(Sheet, {
    open: true, label: MASK_CANARIES.attribute, class: 'caller-layout', className,
    'data-telemetry-private': privateRegion,
  }, maskCanaryContent());
  const view = await mount(sheet('caller-first', 'caller-sheet'));
  const dialog = view.$('dialog');
  assertBoundary(dialog);
  assert.ok(dialog.classList.contains('caller-first'));
  assert.equal(dialog.getAttribute('data-telemetry-private'), 'caller-sheet');
  await view.rerender(sheet('caller-next', 'caller-sheet'));
  assert.equal(view.$('dialog'), dialog);
  assertBoundary(dialog);
  assert.ok(dialog.classList.contains('caller-layout'));
  assert.ok(dialog.classList.contains('caller-next'));
  assert.equal(dialog.classList.contains('caller-first'), false);
  assertCanariesBlocked(document.body);
  await view.rerender(sheet(undefined, ''));
  assertBoundary(dialog);
  assert.equal(dialog.getAttribute('data-telemetry-private'), 'ds-sheet');
  assertCanariesBlocked(document.body);
});

for (const [file, names, baseProps] of [
  ['ds/card', ['Card', 'Row'], {title: MASK_CANARIES.text}],
  ['ds/swing', ['SwingCard', 'SwingChip', 'SwingSectionLabel', 'SwingLink', 'SwingItemCard'], {title: MASK_CANARIES.text}],
  ['ds/disclosure', ['Disclosure'], {summary: MASK_CANARIES.text}],
  ['ds/button', ['Button', 'IconButton'], {label: MASK_CANARIES.attribute}],
  ['ds/form', ['Switch', 'Select', 'Field', 'Banner'], {label: MASK_CANARIES.attribute, hint: MASK_CANARIES.text}],
  ['ds/sheet', ['Sheet'], {label: MASK_CANARIES.attribute}],
  ['shared', ['Panel', 'Link', 'Note'], {title: MASK_CANARIES.text}],
  ['ds/nav', ['TabBar', 'Tabs', 'Sidebar'], {items: [], label: 'Navigation'}],
]) {
  const module = await import('./' + file + '.jsx');
  for (const name of names) test(name + ' preserves caller private markers', () => {
    const container = document.createElement('div');
    container.innerHTML = render(h(module[name], {...baseProps, class: 'caller-class ph-no-capture', 'data-telemetry-private': 'caller-region'}));
    const root = container.querySelector('[data-telemetry-private="caller-region"]');
    assert.ok(root, 'wrapper must preserve the caller region');
    assertBoundary(root);
    assert.ok(root.classList.contains('caller-class'), 'wrapper must preserve the caller class');
  });
}

test('static shell navigation has no private ancestor', () => {
  const fixture = fixtures.find(f => f.file === 'shell');
  const container = document.createElement('div');
  container.innerHTML = render(h(fixture.Component, fixture.props));
  for (const nav of container.querySelectorAll('nav[aria-label="Main"]')) {
    assert.equal(nav.closest(selector), null);
  }
});

test('support preview content stays inside its private boundary after loading', async () => {
  const {SupportExport} = await import('./support-export.jsx');
  const view = await mount(h(SupportExport, {api: {post: async () => ({entries: [{body: MASK_CANARIES.text}], archiveBase64: btoa('synthetic')})}}));
  const {click} = await import('./mounted.test-helper.mjs');
  await click(view.button('Preview support export'));
  assert.ok(view.$('pre').textContent.includes(MASK_CANARIES.text));
  assertCanariesBlocked(view.container);
});

test('only fixed shell controls are exposed outside private ancestors', () => {
  const fixture = fixtures.find(f => f.file === 'shell');
  const container = document.createElement('div');
  container.innerHTML = render(h(fixture.Component, fixture.props));
  const controls = [...container.querySelectorAll('[data-telemetry-control]')];
  assert.ok(controls.length >= 2);
  for (const control of controls) {
    assert.ok(['open-search', 'open-profile'].includes(control.dataset.telemetryControl));
    assert.equal(control.closest(selector), null);
  }
});

test('legacy markup comparisons ignore only privacy markers', async () => {
  const {withoutMaskMarkers} = await import('./telemetry-mask-fixtures.mjs');
  const original = '<a class="row caller" data-other="keep" title="private" href="https://example.invalid/private">text</a>';
  const marked = '<a class="row caller ph-no-capture" data-telemetry-private="region" data-other="keep" title="private" href="https://example.invalid/private">text</a>';
  assert.equal(withoutMaskMarkers(marked), original);
  assert.equal(withoutMaskMarkers('<p class="" data-other="keep">text</p>'), '<p class="" data-other="keep">text</p>');
  assert.notEqual(withoutMaskMarkers(marked.replace('caller', 'changed')), original);
  assert.notEqual(withoutMaskMarkers(marked.replace('private">text', 'changed">text')), original);
});

test('download links appended outside the view tree carry both markers', async () => {
  const {downloadOutput} = await import('./result-reader.jsx');
  const {downloadSupportArchive} = await import('./support-export.jsx');
  const {installClock} = await import('./mounted.test-helper.mjs');
  installClock();
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, click = window.HTMLAnchorElement.prototype.click;
  const seen = [];
  URL.createObjectURL = () => 'blob:synthetic'; URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {assert.ok(this.isConnected); assertBoundary(this); seen.push(this.download);};
  try {
    await downloadOutput({download: async () => ({blob: new Blob(['synthetic']), filename: MASK_CANARIES.attribute})}, '/api/synthetic');
    downloadSupportArchive({entries: [{body: 'synthetic'}], archiveBase64: btoa('synthetic')});
    assert.deepEqual(seen, [MASK_CANARIES.attribute, 'faravan-support.tar.gz']);
    assert.equal(document.querySelector('a[download]'), null);
  } finally {URL.createObjectURL = create; URL.revokeObjectURL = revoke; window.HTMLAnchorElement.prototype.click = click;}
});

for (const format of ['result', 'patch']) {
  test('mounted Job ' + format + ' download marks its connected anchor', async () => {
    const {Job} = await import('./jobs.jsx');
    const {advance, click, createFakeApi, installClock, window} = await import('./mounted.test-helper.mjs');
    resetPage(); installClock();
    const id = 'sha256:' + 'a'.repeat(64), base = 'jobs/' + encodeURIComponent(id);
    const circle = {id: 'mask-circle', name: 'Synthetic circle', owned: true};
    const changes = format === 'result'
      ? {format: 'files', download_only: true, files: []}
      : {format: 'diff', diff: 'diff --git a/synthetic.js b/synthetic.js\n--- a/synthetic.js\n+++ b/synthetic.js\n@@ -1 +1 @@\n-old\n+new\n', files: [{path: 'synthetic.js', insertions: 1, deletions: 1}], diffstat: {files: 1, insertions: 1, deletions: 1}};
    const api = createFakeApi({
      [base]: {job_digest: id, circle: {id: circle.id}, state: 'result-accepted', status: 'result-accepted',
        result_digest: 'sha256:' + 'b'.repeat(64), borrowerCircle: circle.id,
        current_attempt: {holder: 'other-device', compute_stopped: true},
        local: {title: 'Synthetic job', prompt: MASK_CANARIES.text}},
      [base + '/changes']: changes, [base + '/transcript']: {text: '', live: false}, [base + '/retention']: {},
    });
    const requests = [], anchors = [];
    api.download = async (path, signal) => {
      requests.push({path, signal});
      return {blob: new Blob(['synthetic']), filename: MASK_CANARIES.attribute};
    };
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL, anchorClick = window.HTMLAnchorElement.prototype.click;
    URL.createObjectURL = () => 'blob:synthetic'; URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () {
      assert.ok(this.isConnected, 'inspect the anchor before it leaves the document');
      assertBoundary(this);
      assert.equal(this.dataset.telemetryPrivate, 'jobs-download');
      assert.equal(this.download, MASK_CANARIES.attribute);
      anchors.push(this);
    };
    try {
      const view = await mount(h(Job, {id, requestedCircle: circle.id, circle: circle.id, circles: [circle], api,
        revision: 0, draft: {submission: null}, data: {jobs: [], devices: {fingerprint: 'this-device'}},
        mutate: async () => ({}), setDialog() {}, members: [], refresh: async () => {}}));
      await api.release(); await advance(100); await api.release();
      const button = view.button(format === 'result' ? 'Download all files' : 'Download the patch');
      assert.ok(button, 'real Job must expose the requested download action');
      await click(button);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].path, base + '/result?circle=' + circle.id);
      assert.ok(requests[0].signal instanceof AbortSignal);
      assert.equal(anchors.length, 1, 'the actual download must click exactly one marked anchor');
      assert.equal(anchors[0].isConnected, false, 'the transient anchor is removed after the click');
    } finally {URL.createObjectURL = create; URL.revokeObjectURL = revoke; window.HTMLAnchorElement.prototype.click = anchorClick;}
  });
}

test('each static shell control keeps its fixed ID in both header layouts', () => {
  const fixture = fixtures.find(f => f.file === 'shell');
  for (const title of ['Synthetic heading', '']) {
    const container = document.createElement('div');
    container.innerHTML = render(h(fixture.Component, {...fixture.props, title}));
    for (const [selector, id] of [
      ['.side-search', 'open-search'], ['.side-foot a[href="#/you"]', 'open-profile'],
      [title ? '.page-head-actions .hit' : '.phone-profile-link', 'open-profile'],
    ]) {
      const control = container.querySelector(selector);
      assert.ok(control, 'expected shell control must exist');
      assert.equal(control.getAttribute('data-telemetry-control'), id);
      assert.equal(control.closest('.ph-no-capture, [data-telemetry-private]'), null);
    }
  }
});

test('blank Field region falls back after a mounted rerender', async () => {
  const field = (region,error) => h(Field,{label:'Synthetic field',hint:'Synthetic hint',error,
    class:'caller-field','data-telemetry-private':region,multiline:!!error});
  const view = await mount(field('custom-region'));
  const root = view.$('.field'), id = root.querySelector('input').id;
  assert.equal(root.getAttribute('data-telemetry-private'),'custom-region');
  assert.ok(root.classList.contains('ph-no-capture'));
  await view.rerender(field('','Synthetic error'));
  assert.equal(root,view.$('.field'));
  assert.ok(root.classList.contains('ph-no-capture'));
  assert.equal(root.querySelector('textarea').id,id);
  assert.equal(root.querySelector('textarea').getAttribute('aria-invalid'),'true');
  assert.equal(root.getAttribute('data-telemetry-private'),'ds-form-field');
});
test('Disclosure preserves both caller class forms and the privacy marker', async () => {
  const widget = className => h(Disclosure,{summary:'Synthetic summary',class:'caller-detail',className},'Synthetic body');
  const view = await mount(widget('layout-before'));
  const root = view.$('details');
  root.open = true;
  await view.rerender(widget('layout-next'));
  assert.equal(view.$('details'),root);
  assert.equal(root.open,true);
  assert.deepEqual(['disc','caller-detail','layout-next','ph-no-capture'].filter(name=>!root.classList.contains(name)),[]);
  assert.equal(root.classList.contains('layout-before'),false);
  assert.equal(root.getAttribute('data-telemetry-private'),'ds-disclosure');
});
