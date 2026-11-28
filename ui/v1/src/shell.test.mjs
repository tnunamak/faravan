import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const storedPass = {id:'test-run',state:'passed',at:'2026-10-19T09:12:00Z',current:{runId:'test-run',at:'2026-10-19T09:12:00Z',
  configuration:{versions:{faravan:'0.12.0',sbx:'0.48.0',probe:{version:1,digest:'fixture'},adapters:{}},agents:['claude-code-subscription','codex']}}};
import {h} from 'preact';
import {Shell} from './shell.jsx';
import {renderFixture, assertLandmark, assertDomOrder, assertNoBannedWords, renderedText} from './render.test-helper.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';

const home = {lending: {enabled: true, circle: 'weekend', status: 'idle', paused: false, current: null},attention: [],
  lendingPolicy: {accounts: [{provider: 'codex', decision: {availability: {admitted: true}}}]}};
const devices = {name: "Ana's MacBook", ownerName: 'Ana Ruiz'};
const circles = [{id: 'weekend', name: 'Weekend projects'}, {id: 'crew', name: 'Booking site crew'}];
const shell = (props = {}) => renderFixture(Shell, {
  route: {page: 'home'}, home, devices, readiness:{ready:true,checks:[]}, agents:[{id:'codex',useForLending:true,installed:true,signedIn:true}], approvals: [], circles, children: h('main', null, props.title ? null : h('h1', null, 'Home')), ...props,
});
const links = (html) => [...html.matchAll(/<a [^>]*href="(#\/[^"]*)"[^>]*>/g)].map((m) => m[1]);

test('the shell has the four destinations in order, in the sidebar and in the tab bar', () => {
  const out = shell();
  assertLandmark(out, 'complementary');
  assert.equal((out.match(/<nav [^>]*aria-label="Main"/g) || []).length, 2, 'sidebar and tab bar');
  const sidebar = out.slice(out.indexOf('<aside'), out.indexOf('</aside>')),
    tabs = out.slice(out.indexOf('<nav class="tabbar"'));
  assertDomOrder(sidebar, ['side-link" href="#/home"', 'side-link" href="#/jobs"', 'side-link" href="#/lend"', 'side-link" href="#/circles"']);
  assertDomOrder(tabs, ['<a href="#/home"', '<a href="#/jobs"', '<a href="#/lend"', '<a href="#/circles"']);
  assert.deepEqual(['Home', 'Jobs', 'Lending', 'Circles'].map((label) => sidebar.includes('</svg>' + label)), [true, true, true, true]);
});

test('the shell has no circle picker, no connection line and no footer', () => {
  const out = shell();
  assert.doesNotMatch(out, /<select/);
  assert.doesNotMatch(out, /<footer/);
  assert.doesNotMatch(renderedText(out), /Live updates|Closing this page/);
});

test('the Home badge equals the needs-you count, and is absent at zero', () => {
  assert.doesNotMatch(withoutMaskMarkers(shell()), /class="count"|class="badge"/);
  const two = shell({approvals: [{id: 'a'}, {id: 'b'}]});
  assert.match(withoutMaskMarkers(two), /<span class="count" role="img" aria-label="2 need you">2<\/span>/);
  assert.match(withoutMaskMarkers(two), /<span class="badge" role="img" aria-label="2 need you">2<\/span>/);
  const attention = shell({approvals: [{id: 'a'}], home: {...home, attention: [{label: 'Sign in to Claude Code again.'}]}});
  assert.match(attention, /aria-label="2 need you">2</);
  const listed = shell({approvals: [{id: 'a'}], home: {...home, attention: [{label: 'This job needs your review', approvalId: 'a'}]}});
  assert.match(listed, /aria-label="1 needs you">1</, 'an approval the status list already holds counts once');
  assert.equal((two.match(/2 need you/g) || []).length, 2, 'only Home has a badge');
});

test('the current page is marked in both navs and a detail page marks its parent', () => {
  const current = (page, id) => (shell({route: {page, id}}).match(/aria-current="page"/g) || []).length;
  assert.equal(current('lend'), 2);
  assert.equal(current('job', 'x'), 2);
  assert.match(shell({route: {page: 'job', id: 'x'}}), /href="#\/jobs" aria-current="page"/);
  assert.equal(current('circle', 'crew'), 3, 'Circles in both navs, and the circle row');
});

test('the You links mark Settings as current on desktop and in both phone headers', () => {
  for (const title of [undefined, 'Settings']) {
    for (const page of ['settings', 'home']) {
      const out = shell({route:{page},title});
      const profiles = out.match(/<a [^>]*href="#\/you"[^>]*>/g);
      assert.equal(profiles.length, 2);
      assert.ok(profiles.some(link => link.includes('class="side-link"')));
      assert.ok(profiles.some(link => link.includes(title ? 'class="hit"' : 'class="phone-profile-link"')));
      for (const link of profiles) assert.equal(link.includes('aria-current="page"'), page === 'settings', link);
      if (page === 'settings') assert.equal((out.match(/aria-current="page"/g) || []).length, 2);
    }
  }
});

test('the sidebar names the circles and this computer, and the shell stays plain', () => {
  const out = shell();
  assert.deepEqual(links(out).filter((href) => href.startsWith('#/circle/')), ['#/circle/weekend', '#/circle/crew']);
  const sidebar = out.slice(out.indexOf('<aside'), out.indexOf('</aside>'));
  assertDomOrder(sidebar, ['Your circles', 'Weekend projects', "Ana's MacBook", 'Ready for requests', '>You<']);
  assert.match(out, /class="phone-brand" aria-label="Faravan home"/);
  assert.match(out, /class="phone-profile-link"[\s\S]*?class="sr">You<\/span>/);
  assert.match(withoutMaskMarkers(out), /<a class="machine" href="#\/lend">/);
  assertNoBannedWords(out);
  assert.doesNotMatch(shell({circles: []}), /Your circles/);
});

test('the shell is honest before the status loads', () => {
  const out = shell({home: undefined, devices: undefined});
  assert.match(renderedText(out), /This computer Checking this computer… Checking/);
  assert.match(out, /href="#\/you"/);
});

test('the sidebar has the search field and circle avatars are rounded squares (U2b)', () => {
  const out = shell();
  const sidebar = out.slice(out.indexOf('<aside'), out.indexOf('</aside>'));
  assertDomOrder(sidebar, ['Faravan', 'side-search', 'Search or jump to…', '⌘K', 'side-link" href="#/home"']);
  assert.equal((withoutMaskMarkers(sidebar).match(/class="av group c\d sm"/g) || []).length, 2, 'one group avatar per circle');
  assert.doesNotMatch(withoutMaskMarkers(sidebar), /class="av c\d sm"[^>]*>W/, 'a circle is never a round person avatar');
});

test('this computer shows a status dot with the word for screen readers, and no pill (U2b)', () => {
  const out = shell();
  assert.match(out, /<span class="st on"><span class="sr">On<\/span><\/span>/);
  assert.doesNotMatch(withoutMaskMarkers(out).slice(withoutMaskMarkers(out).indexOf('class="machine"')), /^[^]*?class="pill/);
});

test('the page head is one h1 with the avatar link for phones only (U2b)', () => {
  const out = shell({title: 'Lending', subtitle: "Ana's MacBook · this computer"});
  assert.equal((out.match(/<h1/g) || []).length, 1, 'the fixture child has no h1 here');
  const head = out.slice(out.indexOf('<header class="page-head"'), out.indexOf('</header>'));
  assertDomOrder(head, ['<h1', 'Lending', 'page-sub', 'phone-only', 'class="sr">You</span>']);
});

test('You uses the local person name on desktop and phone, or a person glyph', () => {
  const named = shell({title:'Home', devices:{name:'Tessa laptop', ownerName:'Alex Example', fingerprint:'account-tessa'}});
  assert.equal((named.match(/>AE<\/span>/g) || []).length, 2);
  const unnamed = shell({title:'Home', devices:{name:'Tessa laptop', fingerprint:'account-tessa'}});
  assert.equal((unnamed.match(/href="#user"/g) || []).length, 2);
  assert.doesNotMatch(unnamed, />TI<|>TL<|>AC</);
});

test('the machine chip says "Needs you" while a blocker stops lending, even with lending on', () => {
  const blocked=withLendingProjection({...home,intent:{on:true,state:'blocked',reason:'docker_signed_out'},lending:{enabled:true}},
    {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'docker_signed_out'});
  const out = shell({home: blocked, readiness: {ready: false, checks: [{name: 'docker_login', ok: false}]}, agents: [{id: 'codex', useForLending: true, installed: true, signedIn: true}]});
  assert.match(renderedText(out), /Needs you/);
  assert.doesNotMatch(renderedText(out), /Ready for requests/);
});

test('Circles keeps the computer link when lending is blocked', () => {
  const unavailable = withLendingProjection({...home, lending:{enabled:true}},
    {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'docker_signed_out'});


  for (const route of [{page:'circles'}, {page:'circle',id:'crew'}]) {
    const unknownBlocker = shell({route, home:unavailable});
    assert.doesNotMatch(renderedText(unknownBlocker), /Needs you|Raise limit/i);
    assert.match(renderedText(unknownBlocker), /Ana's MacBook/);

  }
});

test('a generic computer blocker does not become job attention', () => {
  const blocked=withLendingProjection({...home,lending:{enabled:true}},
    {intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'docker_signed_out'});
  for (const [page,show] of [['jobs',false],['home',false]]) {
    const out=shell({route:{page},home:blocked});
    assert.equal(/Needs you/.test(renderedText(out)),show);
    assert.match(renderedText(out), /Ana's MacBook/);
  }
});

test('F5 short phone layouts never suppress the only primary navigation by height',()=>{
 const css=readFileSync(new URL('./shell.css',import.meta.url),'utf8');
 assert.doesNotMatch(css,/@media[^{}]*max-height:560px[^{}]*\{\.tabbar\{display:none\}/);
 assert.doesNotMatch(css,/@media[^{}]*max-height:560px[^{}]*\{\.swing-app \.main\{padding-bottom/);
 const html=shell();
 for(const destination of ['#/home','#/jobs','#/lend','#/circles'])assert.ok(html.includes(destination),destination);
});

test('the swing desktop gutter matches the sidebar, so a taller page leaves no block under it',()=>{
 const css=readFileSync(new URL('./shell.css',import.meta.url),'utf8');
 const swing=css.match(/@media\(min-width:900px\)\{\.swing-app\.app\{background:linear-gradient\(([^}]*)\)\}\}/);
 assert.ok(swing,'the swing gutter rule is missing');
 assert.doesNotMatch(swing[1],/--bg-sunk/);
 assert.match(css,/\.swing-app \.sidebar\{[^}]*background:var\(--bg\)/);
 assert.match(css,/\.sidebar\{position:sticky;top:0;height:100vh;height:100dvh;[^}]*overflow:auto/);
});
