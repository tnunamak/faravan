import {withoutMaskMarkers} from '../telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {h, render} from 'preact';
import {act} from 'preact/test-utils';
import {Window} from 'happy-dom';
import {Action} from '../shared.jsx';
import {
  Icon, Spinner, Button, IconButton, Status, Card, Avatar, Row, Switch, Select, Field, Banner,
  JobSteps, Command, FileDiff, TabBar, Tabs, Sidebar, Brand, Empty, Sheet,
} from './index.mjs';
import {
  renderFixture, assertNoBannedWords, assertDomOrder, assertLandmark, renderedText,
} from '../render.test-helper.mjs';

const html = (Component, props) => renderFixture(Component, props);
const nav = [
  {page: 'home', label: 'Home', icon: 'home', href: '#/home', count: 2},
  {page: 'jobs', label: 'Jobs', icon: 'jobs', href: '#/jobs'},
];

test('every icon the components reference exists in the sprite', () => {
  const sprite = readFileSync(new URL('../icons.svg', import.meta.url), 'utf8');
  const ids = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  const used = [html(Icon, {name: 'home'}), html(TabBar, {items: nav, current: 'home'}),
    html(Row, {href: '#/x', title: 'a'}), html(Banner, {}), html(Command, {text: 'a'}), html(Brand)]
    .flatMap((out) => [...out.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]))
    .filter((id) => !id.includes('/'));
  assert.ok(used.length >= 5);
  for (const id of used) assert.ok(ids.has(id), 'missing sprite symbol ' + id);
});

test('Icon is hidden from assistive tech unless it has a label', () => {
  assert.match(html(Icon, {name: 'home', size: 'lg'}), /class="i lg"[^>]*aria-hidden="true"/);
  assert.match(html(Icon, {name: 'alert', label: 'Warning'}), /role="img"[^>]*aria-label="Warning"/);
  assert.match(html(Spinner), /class="spinner" aria-hidden="true"/);
});

test('Button renders the variant, size and block classes on a button or a link', () => {
  assert.match(html(Button, {kind: 'primary', size: 'lg', block: true, children: 'Run it'}),
    /^<button class="btn btn-primary btn-lg btn-block" type="button">Run it<\/button>$/);
  assert.match(html(Button, {href: '#/lend', children: 'Review'}), /^<a [^>]*class="btn btn-secondary"[^>]*href="#\/lend"/);
  assert.throws(() => html(Button, {kind:'ink', children:'Old variant'}), /Unsupported button variant/);
});

test('a pending or disabled Button is aria-disabled and never a live link', () => {
  const pending = html(Button, {kind: 'primary', pending: true, children: 'Sending…'});
  assert.match(pending, /aria-disabled="true"/);
  assert.match(pending, /aria-busy="true"/);
  assert.ok(pending.indexOf('spinner') < pending.indexOf('Sending…'));
  const link = html(Button, {href: '#/x', disabled: true, children: 'Turn on lending'});
  assert.match(link, /^<button /);
  assert.doesNotMatch(link, /href=/);
});

test('IconButton needs its label and renders it as the accessible name', () => {
  assert.match(html(IconButton, {label: 'Close', icon: 'x'}), /class="icon-btn" aria-label="Close"/);
});

test('Status shows a word for every kind, with the kind class', () => {
  for (const [kind, word] of [['on', 'On'], ['off', 'Off'], ['wait', 'Waiting'], ['bad', 'Failed'], ['need', 'Waiting for you'], ['run', 'Running']]) {
    const out = html(Status, {kind});
    assert.match(out, new RegExp('class="pill ' + kind + '"'));
    assert.equal(renderedText(out), word);
  }
  assert.equal(renderedText(html(Status, {kind: 'on', word: 'Ready to review'})), 'Ready to review');
});

test('Card, Avatar and Empty render their classes', () => {
  assert.match(withoutMaskMarkers(html(Card, {as: 'section', pad: true, children: 'x'})), /^<section class="card card-pad">x<\/section>$/);
  const sam = html(Avatar, {personName: 'Sam Okoro', id: 'k1'});
  assert.match(withoutMaskMarkers(sam), /class="av c[1-6]" aria-hidden="true">SO</);
  assert.equal(html(Avatar, {personName: 'Sam', id: 'k1'}).match(/c[1-6]/)[0], sam.match(/c[1-6]/)[0], 'the colour follows the id');
  assert.match(withoutMaskMarkers(html(Avatar, {personName: 'Mo', id: 'k2', size: 'lg'})), /class="av c[1-6] lg"/);
  const empty = html(Empty, {icon: 'jobs', title: 'No jobs yet', text: 'Ask for help.', action: h(Button, {kind: 'primary'}, 'New job')});
  assertDomOrder(empty, ['<h2 class="t-title3">No jobs yet</h2>', 'Ask for help.', 'New job']);
});

test('one avatar uses local person initials and a glyph when the person has no name', () => {
  assert.match(html(Avatar, {personName:'Alex Example', id:'account-tessa'}), />AE<\/span>$/);
  assert.match(html(Avatar, {personName:'Alex E. Example'}), />AE<\/span>$/);
  assert.match(html(Avatar, {personName:'Tessa'}), />T<\/span>$/);
  for (const props of [{id:'Tessa laptop'}, {personName:'', id:'account-tessa'}, {name:'Tessa laptop', id:'account-tessa'}]) {
    const out = html(Avatar, props);
    assert.match(out, /href="#user"/, 'an unnamed person gets the person glyph');
    assert.doesNotMatch(out, />TI<|>AC<|>TL</, 'device and account text never supplies letters');
  }
  assert.match(withoutMaskMarkers(html(Avatar, {groupName:'Weekend projects'})), /class="av group c[1-6]"[^>]*>W<\/span>$/);
});

test('Row is one link: avatar, title, status in the meta line, then the pill and chevron', () => {
  const out = html(Row, {href: '#/jobs/1', avatar: h(Avatar, {personName: 'Mo H', id: 'm'}), title: 'Add a dark mode switch',
    meta: 'Ran on Mo’s computer', status: {kind: 'on', word: 'Ready to review'}});
  assert.match(withoutMaskMarkers(out), /^<a class="row" href="#\/jobs\/1">/);
  assertDomOrder(out, ['class="av c', '<div class="row-title">Add a dark mode switch</div>',
    '<span class="st on">Ready to review</span>', '<span class="pill on">', 'href="#chev-r"']);
  assert.doesNotMatch(html(Row, {title: 'x'}), /<a /);
});

test('Switch is a labelled role=switch with its state in aria-checked', () => {
  assert.match(html(Switch, {checked: true, label: 'Lending', size: 'xl'}),
    /class="switch xl" aria-checked="true" aria-label="Lending"/);
  assert.match(html(Switch, {checked: false, label: 'Lending', warn: true}), /class="switch warn" aria-checked="false"/);
  assert.match(html(Switch, {checked: true, label: 'Lending'}), /role="switch"/);
  const held = html(Switch, {checked:true, label:'Lending', disabled:true, 'aria-busy':'true'});
  assert.match(held, /aria-disabled="true"/);
  assert.doesNotMatch(held, /\sdisabled(?:=|\s|>)/);
});

test('Field links its label, hint and error', () => {
  const out = html(Field, {id: 'name', label: 'Your name', hint: 'Shown to your circle', value: 'Ana'});
  assertDomOrder(out, ['<label for="name">Your name</label>', '<input', 'id="name-note"']);
  assert.match(out, /aria-describedby="name-note"/);
  assert.doesNotMatch(out, /aria-invalid/);
  const bad = html(Field, {id: 'n', label: 'Name', error: 'Enter a name', multiline: true});
  assert.match(bad, /<textarea[^>]*class="textarea"[^>]*aria-invalid="true"/);
  assert.match(bad, /Enter a name/);
});

test('Banner is a status, and an alert only for errors', () => {
  assert.match(withoutMaskMarkers(html(Banner, {children: 'Sign in to Docker.'})), /class="banner" role="status"/);
  assert.match(withoutMaskMarkers(html(Banner, {kind: 'bad', children: 'Failed.'})), /class="banner bad" role="alert"/);
});

test('JobSteps shows the four words, marks earlier steps done, the lit one now or failed', () => {
  const working = html(JobSteps, {at: 2});
  assert.match(working, /aria-label="Progress: Working"/);
  assert.match(working, />Asked<.*>Approved<.*>Working<.*>Ready</);
  assert.equal((working.match(/<li class="done"/g) || []).length, 2);
  assert.equal((working.match(/<li class="now"/g) || []).length, 1);
  assert.match(html(JobSteps, {at: 2, fail: true}), /<li class="fail">Working</);
  assert.equal((html(JobSteps, {done: true, at: 3}).match(/<li class="done"/g) || []).length, 4);
  assert.match(html(JobSteps, {at: null}), /aria-label="Progress: not started"/);
});

test('Command brightens the emphasised token and has a labelled copy button', () => {
  const out = html(Command, {text: 'faravan apply 3f9c', emphasis: 'apply'});
  assert.match(out, /<code>faravan <span class="em">apply<\/span> 3f9c<\/code>/);
  assert.match(out, /<button type="button" class="copy" aria-label="Copy command"/);
  assert.doesNotMatch(out, />Copied</);
});

test('Command waits for the old physical clipboard write before copying replacement text', async () => {
  const window = new Window(), saved = new Map(), writes = [];
  let contents;
  const clipboard={writeText:text=>new Promise(resolve=>writes.push({text,finish:()=>{contents=text;resolve();}}))};
  for (const [key,value] of Object.entries({window,document:window.document,navigator:{clipboard}})) {
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const root=window.document.createElement('div');
  window.document.body.append(root);
  const click=()=>root.querySelector('button').dispatchEvent(new window.Event('click',{bubbles:true}));
  const message=()=>root.querySelector('[role=status]').textContent;
  try {
    await act(()=>render(h(Command,{text:'faravan first'}),root));
    await act(click);
    await act(()=>render(h(Command,{text:'faravan second'}),root));
    await act(click);
    assert.deepEqual(writes.map(write=>write.text),['faravan first']);
    assert.equal(message(),'');
    await act(async()=>writes[0].finish());
    assert.equal(contents,'faravan first');
    assert.equal(message(),'','the old completion cannot announce the replacement');
    await act(click);
    assert.equal(writes[1].text,'faravan second');
    await act(async()=>writes[1].finish());
    assert.equal(contents,'faravan second');
    assert.equal(message(),'Copied');
  } finally {
    for(const write of writes)write.finish();
    await act(()=>render(null,root));
    root.remove(); window.happyDOM.abort();
    for(const [key,descriptor] of saved) {
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
    }
  }
});

test('FileDiff has a labelled region with add and delete lines', () => {
  const out = html(FileDiff, {file: 'login.js', lines: [{kind: 'hunk', text: '@@ -1 +1 @@'},
    {kind: 'del', n: 1, text: 'old'}, {kind: 'add', n: 1, text: 'new'}]});
  assert.match(out, /role="region" aria-label="Changes in login.js"/);
  assert.match(out, /class="ln del"/);
  assert.match(out, /class="ln add"/);
});

test('TabBar and Sidebar are Main navigation with the current page and a spoken badge', () => {
  const tabs = html(TabBar, {items: nav, current: 'jobs'});
  assertLandmark(tabs, 'navigation');
  assert.match(tabs, /<nav class="tabbar" aria-label="Main">/);
  assert.match(tabs, /href="#\/jobs" aria-current="page"/);
  assert.match(withoutMaskMarkers(tabs), /<span class="badge" role="img" aria-label="2 need you">2<\/span>/);
  const side = html(Sidebar, {items: nav, current: 'home', brand: h(Brand), foot: h('p', null, 'foot')});
  assertLandmark(side, 'complementary');
  assert.match(side, /class="side-link" href="#\/home" aria-current="page"/);
  assert.match(withoutMaskMarkers(side), /<span class="count" role="img" aria-label="2 need you">2<\/span>/);
  assertDomOrder(side, ['class="brand-name">Faravan</span>', '<nav aria-label="Main"', 'class="side-foot"']);
});

test('section tabs use one labelled tablist and one selected ink underline', () => {
  const out = html(Tabs, {idPrefix:'circle-tab', label:'Circle sections', panelId:'circle-tab-panel',
    items:[{value:'members',label:'Members'},{value:'activity',label:'Activity'}],current:'activity',onChange:()=>{}});
  assert.match(out, /class="section-tabs" role="tablist" aria-label="Circle sections"/);
  assert.match(out, /id="circle-tab-activity" role="tab" aria-selected="true" aria-controls="circle-tab-panel" tabindex="0"/);
  assert.match(out, /id="circle-tab-members" role="tab" aria-selected="false" aria-controls="circle-tab-panel" tabindex="-1"/);
});

test('Sheet is a labelled dialog with a grab handle', () => {
  assert.match(withoutMaskMarkers(html(Sheet, {label: 'Stop this job', children: 'Keep'})),
    /<dialog[^>]*class="sheet-dialog"[^>]*aria-label="Stop this job"[^>]*><div class="sheet"><div class="grab"/);
});

test('the components add no banned words of their own', () => {
  for (const out of [html(TabBar, {items: nav, current: 'home'}), html(Banner, {children: 'x'}),
    html(Command, {text: 'x'}), html(Sheet, {label: 'x'})]) assertNoBannedWords(out);
});

test('disabled controls visibly describe their reason, including legacy callers', () => {
  for (const Component of [Action, Button, Switch, Select]) {
    for (const disabledReason of ['Choose an agent first.', undefined]) {
      const out = html(Component, {disabled:true, disabledReason, label:'Control', children:'Control'});
      const id = out.match(/aria-describedby="([^"]+)"/)?.[1];
      assert.ok(id, Component.name + ' must describe why it is disabled');
      assert.ok(out.includes('id="' + id + '"'));
      assert.ok(renderedText(out).includes(disabledReason || 'This control is unavailable right now.'));
    }
  }
});

test('all control events paint pending synchronously and gate re-entry until settled', async () => {
  const window = new Window(), saved = new Map();
  for (const [key, value] of Object.entries({window, document:window.document, requestAnimationFrame:()=>0})) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  const root = document.createElement('div'); document.body.append(root);
  try {
    for (const Component of [Action, Button, Switch, Select]) {
      let resolve, count = 0, selected;
      const work = new Promise(done => {resolve = done;});
      const eventType = Component === Select ? 'change' : 'click';
      const run = event => {
        count++; selected = event?.currentTarget?.value;
        root.querySelector('button,select').dispatchEvent(new window.Event(eventType,{bubbles:true}));
        return work;
      };
      await act(() => render(h(Component,{run,onClick:run,onChange:run,label:'Control',value:'a'},
        Component === Select ? [h('option',{value:'a'},'A'), h('option',{value:'b'},'B')] : 'Control'),root));
      const control = root.querySelector('button,select');
      if (Component === Select) control.value = 'b';
      control.dispatchEvent(new window.Event(eventType,{bubbles:true}));
      // No act, tick, or promise between dispatch and these assertions.
      assert.equal(control.getAttribute('aria-busy'),'true', Component.name);
      assert.match(root.textContent,/Working…/);
      assert.equal(count,1, 're-entry from the callback is gated');
      control.dispatchEvent(new window.Event(eventType,{bubbles:true}));
      assert.equal(count,1,'same-tick second event is gated');
      if (Component === Select) assert.equal(selected,'b','read before the controlled rerender');
      await act(async () => {resolve(); await work;});
      assert.equal(root.querySelector('button,select').getAttribute('aria-busy'),null);
      await act(() => render(null,root));
    }
  } finally {
    render(null,root); root.remove(); window.happyDOM.abort();
    for (const [key,descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
    }
  }
});

test('disabled design-system controls in compose and lend declare disabledReason', () => {
  for (const file of ['compose.jsx','lend.jsx']) {
    const source = readFileSync(new URL('../'+file,import.meta.url),'utf8');
    // Opening tags only; JSX expressions may contain arrows, quotes and nested braces.
    for (const match of source.matchAll(/<(Action|Button|Switch|Select)\b/g)) {
      let end = match.index + match[0].length, braces = 0, quote = '';
      for (; end < source.length; end++) {
        const c = source[end];
        if (quote) { if(c === '\\') end++; else if(c === quote) quote = ''; continue; }
        if(c === '"' || c === "'" || c === '`') {quote=c;continue;}
        if(c === '{') braces++; else if(c === '}') braces--;
        else if(c === '>' && !braces) break;
      }
      const tag = source.slice(match.index,end);
      if (/\bdisabled\s*=/.test(tag)) assert.match(tag,/\bdisabledReason\s*=/,file+': '+tag);
    }
  }
});
