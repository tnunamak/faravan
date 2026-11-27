// Helpers for the V1 browser lane: the harness, fixtures that patch real API responses, and one function
// per check. Every check returns {ok, reason} and never opens a headed browser.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {freshLink} from '../helpers/fresh-link.mjs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRequestAdmission } from '../../lib/v1/request-admission.mjs';
import { adaptLegacyJob, projectLendingState } from '../../lib/v1/state-projection.mjs';
import { jobStatusContract } from '../../lib/v1/status-contract.mjs';

export const OUT = 'test-artifacts/browser-verify';
const harnessPath = fileURLToPath(new URL('../e2e-browser/v1-harness.mjs', import.meta.url));

/** Starts the real app (owner, lender, guest) on a temporary home, with the fake sandbox. Returns {urls, stop}. */
export async function startHarness() {
  const home = await mkdtemp(join(tmpdir(), 'browser-fixture-home-'));
  await mkdir(join(home, '.tmp'));
  const child = spawn(process.execPath, [harnessPath], {stdio: ['ignore', 'pipe', 'inherit'],
    // Folder browsing and provider discovery must stay inside this synthetic computer's home.
    env: {...process.env, HOME:home, CODEX_HOME:join(home,'codex'), CLAUDE_CONFIG_DIR:join(home,'claude'),
      XDG_CONFIG_HOME:join(home,'config'), XDG_DATA_HOME:join(home,'data'), XDG_CACHE_HOME:join(home,'cache'),
      FARAVAN_NO_BROWSER: '1', DISPLAY: '', WAYLAND_DISPLAY: ''}});
  const stop = async () => {
    try { if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited=once(child,'exit'); if (child.kill('SIGTERM')) await exited;
    } }
    finally { await rm(home,{recursive:true,force:true}); }
  };
  try {
    const urls = JSON.parse(await Promise.race([
      once(createInterface({input: child.stdout}), 'line').then(([line]) => line),
      once(child, 'exit').then(([code]) => { throw new Error('harness exited early: ' + code); }),
    ]));
    return {urls, link: name => freshLink(urls[name], urls.tokens[name]), stop};
  } catch (error) { await stop(); throw error; }
}

// ---- fixtures: real responses with a few fields replaced, so a screen can be put in any state ----
export async function patchJson(page, pattern, patch) {
  await page.route(pattern, async route => {
    try {
      const response = await route.fetch();
      let body; try { body = await response.json(); } catch { return await route.fulfill({response}); }
      return await route.fulfill({response, json: patch(structuredClone(body))});
    } catch { /* the page closed while this request was in flight */ }
  });
}

/** Patch the real Home response while projecting explicitly supplied domain evidence. */
export async function patchHome(page, evidence, patch = body => body) {
  const effective = evidence?.effective;
  if (!effective || !Object.hasOwn(effective, 'intent') || !Object.hasOwn(effective, 'execution') ||
      ![true, false, null].includes(evidence.dailyLimitReached)) {
    throw new TypeError('patchHome requires explicit intent, execution, and daily-limit evidence');
  }
  const lendingProjection = projectLendingState(evidence);
  await patchJson(page, '**/api/home', body => ({...patch(body), lendingProjection}));
}

/** Build the job projection and status contract returned by the current local job API from explicit job facts. */
export function projectJobFixture(job, {observedAt = new Date().toISOString()} = {}) {
  if (!job || typeof job !== 'object' || Array.isArray(job) || !Number.isFinite(Date.parse(observedAt))) {
    throw new TypeError('projectJobFixture requires a job record and a valid observation time');
  }
  const projection = adaptLegacyJob(job, {observedAt});
  const semantic = {phase:projection.phase,reasonCode:projection.reasonCode,result:projection.result,
    application:projection.application,evidence:projection.evidence,actionHints:projection.actionHints,
    version:projection.version && typeof projection.version === 'object' ? projection.version : {}};
  const jobProjection = {...projection,version:{...(projection.version ?? {}),
    semanticDigest:createHash('sha256').update(JSON.stringify(semantic)).digest('hex')}};
  const view = {...job,jobProjection};
  return {...view,statusContract:jobStatusContract(view,{
    now:Date.parse(observedAt),
    harnesses:job.job?.payload?.requirements?.harness ?? null,
    wallSeconds:job.job?.payload?.requirements?.limits?.wall_seconds ?? null,
  })};
}

/** Attach the same per-card projection as GET /api/approvals, from explicit quota evidence. */
export function withRequestAdmission(card, evidence) {
  const wallSeconds = card?.job?.requirements?.limits?.wall_seconds;
  if (!Number.isSafeInteger(wallSeconds) || wallSeconds < 0 || !evidence ||
      !['usage', 'accountedMilliseconds', 'dailyMinutes', 'now'].every(key => Object.hasOwn(evidence, key))) {
    throw new TypeError('withRequestAdmission requires signed wall-time and explicit quota evidence');
  }
  return {...card, requestAdmission:projectRequestAdmission({...evidence, wallSeconds})};
}

export const READINESS = {
  windows: {ready: false, protection: {}, checks: [
    {name: 'sbx_install', ok: true, label: 'Docker Sandboxes is installed.', remedy: ''},
    {name: 'hypervisor_platform', ok: false, label: 'The Windows Hypervisor Platform is off.', remedy: 'Turn on Windows Hypervisor Platform in Windows Features, then restart.'},
    {name: 'docker_login', ok: false, label: 'Not signed in.', remedy: 'Sign in to Docker.'}]},
  linux: {ready: false, protection: {}, checks: [
    {name: 'sbx_install', ok: true, label: 'Docker Sandboxes is installed.', remedy: ''},
    {name: 'kvm_access', ok: false, label: 'No access to /dev/kvm.', remedy: 'sudo usermod -aG kvm $USER && newgrp kvm'}]},
};
export const JOBS = [
  {job_digest: 'sha256:' + 'a'.repeat(64), status: 'Ready to review', circle: {id: 'c1', name: 'Weekend projects'}, local: {title: 'Fix parser', prompt: 'Fix the parser.'},
    waitingTiming: {submittedAt: new Date(Date.now() - 3600e3).toISOString(), expiresAt: new Date(Date.now() + 86400e3).toISOString()}},
  {job_digest: 'sha256:' + 'b'.repeat(64), status: 'Waiting', circle: {id: 'c1', name: 'Weekend projects'}, local: {title: 'Add dark mode', prompt: 'Add dark mode.'},
    waitingTiming: {submittedAt: new Date(Date.now() - 86400e3 * 1.5).toISOString(), expiresAt: new Date(Date.now() + 86400e3).toISOString()}},
];

// ---- opening a page ----
export async function open(browser, urls, slice, contextOptions = {}) {
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, ...contextOptions});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.errors = errors;
  // Console errors (a CSP refusal, a failed load) are defects on any page, so every check can see them.
  page.consoleErrors = [];
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const pathname=URL.parse(message.location().url)?.pathname;
    page.consoleErrors.push(message.text().slice(0,200)+(pathname?' ('+pathname+')':''));
  });
  page.findings = []; // problems a slice's task notes without stopping (the task goes on)
  await page.addInitScript(() => {
    // Counts pointer input: a keyboard-only task must leave it at zero.
    window.__pointer = 0;
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) addEventListener(type, () => { window.__pointer++; }, true);
  });
  await slice.fixtures?.(page);
  const actor = slice.actor ?? 'lender';
  await page.goto((await freshLink(urls[actor], urls.tokens[actor])) + slice.hash);
  await slice.ready(page);
  return {context, page};
}

export async function shot(page, name) {
  await mkdir(OUT, {recursive: true});
  const path = join(OUT, name + '.png');
  await page.screenshot({path, fullPage: true}).catch(() => {});
  return path;
}

// ---- the checks. Each takes (browser, urls, slice) and returns {ok, reason, shots[]}. ----
const ok = () => ({ok: true});
// problems: a string, or an array of strings (one per distinct problem, so a known failure cannot hide a new one).
const fail = (problems, shots = []) => { const list = [problems].flat(); return {ok: false, problems: list, reason: list.join('; '), shots}; };

/** Interactive elements that are visible but outside the horizontal viewport, and any sideways scroll. */
export async function overflowProblems(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth, problems = [];
    const scroll = document.documentElement.scrollWidth - width;
    if (scroll > 1) problems.push('the page scrolls sideways by ' + scroll + 'px');
    for (const element of document.querySelectorAll('a[href],button,input,select,textarea,[role=switch],[role=radio],[tabindex]')) {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      if (style.visibility === 'hidden' || style.display === 'none' || rect.width === 0 || rect.height === 0 || element.closest('[hidden],[inert]')) continue;
      // Chromium still lays out the content of a closed details (off the page), but nobody can see or reach it.
      if (element.closest('details:not([open])') && !element.closest('summary')) continue;
      if (rect.right < -500) continue; // the skip link waits off screen until it is focused
      // A row that scrolls sideways on purpose (chips, tabs) is reachable; only what it cannot reach is a problem.
      let scroller = element.parentElement, inScroller = false;
      while (scroller && scroller !== document.body) { if (['auto', 'scroll'].includes(getComputedStyle(scroller).overflowX) && scroller.scrollWidth > scroller.clientWidth) { inScroller = true; break; } scroller = scroller.parentElement; }
      if (inScroller) continue;
      if (rect.left < -1 || rect.right > width + 1) {
        problems.push((element.getAttribute('aria-label') || element.textContent || element.tagName).trim().slice(0, 40) + ' is cut off (' + Math.round(rect.left) + '..' + Math.round(rect.right) + ' of ' + width + ')');
      }
    }
    return problems.slice(0, 5);
  });
}
/** Text that a fixed-size box cuts off. */
export async function clippedText(page) {
  return page.evaluate(() => {
    const problems = [];
    for (const element of document.querySelectorAll('body *')) {
      const style = getComputedStyle(element);
      // Native closed details hide descendants without changing each descendant's computed display.
      if (element.closest('details:not([open])') && !element.closest('summary')) continue;
      if (!element.childNodes.length || ![...element.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (element.clientWidth <= 2 || element.clientHeight <= 2 || (style.position === 'absolute' && style.clip !== 'auto')) continue; // visually hidden text for screen readers
      if (element.matches('a,button,[role=switch],[role=option]') && element.scrollHeight > element.clientHeight + 3) { problems.push((element.textContent || '').trim().slice(0, 40) + ' spills out of its box'); continue; }
      const hidesX = ['hidden', 'clip'].includes(style.overflowX) && style.textOverflow !== 'ellipsis', hidesY = ['hidden', 'clip'].includes(style.overflowY);
      if ((hidesX && element.scrollWidth > element.clientWidth + 2) || (hidesY && element.scrollHeight > element.clientHeight + 2 && element.clientHeight > 0))
        problems.push((element.textContent || '').trim().slice(0, 40) + ' is clipped');
    }
    return problems.slice(0, 5);
  });
}

/** Every control has a name, and the page has one h1 and one main landmark. */
async function nameProblems(page) {
  return page.evaluate(() => {
    const problems = [], text = el => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const nameOf = el => el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && text(document.getElementById(el.getAttribute('aria-labelledby').split(' ')[0]))) ||
      (el.id && text(document.querySelector('label[for="' + CSS.escape(el.id) + '"]'))) || text(el.closest('label')) || el.getAttribute('title') || el.getAttribute('alt') ||
      (el.tagName === 'INPUT' && ['submit', 'button'].includes(el.type) ? el.value : '') || text(el) || [...el.querySelectorAll('img,svg')].map(i => i.getAttribute('aria-label') || i.getAttribute('alt') || '').join('');
    for (const el of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=switch],[role=radio],[role=option]')) {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (rect.right < -500 || style.display === 'none' || style.visibility === 'hidden' || el.closest('[hidden]')) continue;
      if (!nameOf(el).trim()) problems.push('a ' + (el.getAttribute('role') || el.tagName.toLowerCase()) + ' has no name (' + (el.className || el.outerHTML.slice(0, 40)) + ')');
    }
    if (document.querySelectorAll('h1').length !== 1) problems.push(document.querySelectorAll('h1').length + ' h1 headings');
    if (document.querySelectorAll('main,[role=main]').length !== 1) problems.push(document.querySelectorAll('main,[role=main]').length + ' main landmarks');
    return problems.slice(0, 5);
  });
}

export async function checkKeyboard(browser, urls, slice) {
  const {context, page} = await open(browser, urls, slice);
  try {
    await slice.task(page);
    if (slice.reloads) await slice.ready(page); // the task reloads the page, so wait for it to be back
    const names = [...page.findings, ...await nameProblems(page), ...(await slice.labels?.(page) ?? [])];
    if (names.length) return fail(names, [await shot(page, slice.id + '-keyboard')]);
    const pointer = await page.evaluate(() => window.__pointer);
    if (pointer) return fail('the task needed the mouse (' + pointer + ' pointer events)', [await shot(page, slice.id + '-keyboard')]);
    return ok();
  } catch (error) {
    return fail(String(error.message).split('\n')[0], [await shot(page, slice.id + '-keyboard')]);
  } finally { await context.close(); }
}

export async function checkDialog(browser, urls, slice) {
  const {context, page} = await open(browser, urls, slice);
  try {
    const d = slice.dialog;
    await d.open(page);
    const dialog = page.locator(d.selector).first();
    await dialog.waitFor({state: 'visible'});
    // A native modal <dialog> makes the page inert: Tab past its last control moves to the browser's own bar (the
    // document then has no focused element), which is fine and the next Tab comes back in. Nothing behind it is reachable.
    const inside = () => page.evaluate(selector => {
      const active = document.activeElement, dialog = document.querySelector(selector);
      return !!active?.closest(selector) || (!!dialog?.matches(':modal') && (!active || active === document.body));
    }, d.selector);
    await page.waitForFunction(selector => !!document.activeElement?.closest(selector), d.selector, {timeout: 1500}).catch(() => {}); // focus moves in an effect, just after it opens
    if (!await inside()) return fail('focus did not move into the dialog when it opened', [await shot(page, slice.id + '-dialog')]);
    // Tab and Shift+Tab many more times than the dialog has controls: focus must never leave it.
    for (const [key, count] of [['Tab', 14], ['Shift+Tab', 14]]) {
      for (let i = 0; i < count; i++) {
        await page.keyboard.press(key);
        if (!await inside()) return fail(key + ' moved focus out of the dialog (press ' + (i + 1) + ')', [await shot(page, slice.id + '-dialog')]);
      }
    }
    await page.keyboard.press('Escape');
    if (await dialog.isVisible().catch(() => false)) return fail('Escape did not close the dialog', [await shot(page, slice.id + '-dialog')]);
    // Focus goes back in the effect that runs just after the dialog unmounts, so give it a moment (this flaked under load).
    let returned = false;
    for (let i = 0; i < 15 && !returned; i++) {
      returned = await page.locator(d.openerSelector).first().evaluate(el => el === document.activeElement || el.contains(document.activeElement)).catch(() => false);
      if (!returned) await page.waitForTimeout(100);
    }
    if (!returned) return fail('focus did not return to the control that opened the dialog', [await shot(page, slice.id + '-dialog')]);
    return ok();
  } catch (error) {
    return fail(String(error.message).split('\n')[0], [await shot(page, slice.id + '-dialog')]);
  } finally { await context.close(); }
}

export async function checkHistory(browser, urls, slice) {
  const {context, page} = await open(browser, urls, slice);
  try {
    const start = await page.evaluate(() => location.hash), title = await page.getByRole('heading', {level: 1}).first().textContent().catch(() => '');
    await page.evaluate(() => { location.hash = '#/circles'; });
    await page.getByRole('heading', {level: 1, name: 'Circles'}).waitFor();
    await page.goBack();
    await page.waitForFunction(h => location.hash === h, start);
    await slice.ready(page);
    const back = await page.getByRole('heading', {level: 1}).first().textContent().catch(() => '');
    if (back !== title) return fail('Back came back to "' + back + '", not "' + title + '"', [await shot(page, slice.id + '-history')]);
    await page.goForward();
    await page.getByRole('heading', {level: 1, name: 'Circles'}).waitFor();
    // A dialog closes with Back instead of leaving a dead page behind it.
    if (slice.dialog) {
      await page.goBack();
      await slice.ready(page);
      await slice.dialog.open(page);
      await page.locator(slice.dialog.selector).first().waitFor({state: 'visible'});
      await page.evaluate(() => { location.hash = '#/circles'; });
      await page.getByRole('heading', {level: 1, name: 'Circles'}).waitFor();
      if (await page.locator(slice.dialog.selector).first().isVisible().catch(() => false)) return fail('the dialog stayed open after navigating away', [await shot(page, slice.id + '-history')]);
    }
    return ok();
  } catch (error) {
    return fail(String(error.message).split('\n')[0], [await shot(page, slice.id + '-history')]);
  } finally { await context.close(); }
}

async function sizeCheck(browser, urls, slice, name, viewport, extra = {}) {
  const {context, page} = await open(browser, urls, slice, {viewport, ...extra});
  try {
    await page.waitForTimeout(300);
    const problems = [...await overflowProblems(page)];
    if (extra.clip) problems.push(...await clippedText(page));
    if (page.errors.length) problems.push('page error: ' + page.errors[0]);
    return problems.length ? fail(problems, [await shot(page, slice.id + '-' + name)]) : ok();
  } finally { await context.close(); }
}
export const checkNarrow = (b, u, s) => sizeCheck(b, u, s, 'narrow320', {width: 320, height: 640});
// 200% browser zoom on a 1280 px window is 640 CSS px wide; headless Chromium has no zoom control, so the viewport stands in.
export const checkZoom = (b, u, s) => sizeCheck(b, u, s, 'zoom200', {width: 640, height: 400}, {clip: true});

export async function checkText130(browser, urls, slice) {
  const problems = [], shots = [];
  for (const viewport of [{width: 1280, height: 800}, {width: 390, height: 844}]) {
    const {context, page} = await open(browser, urls, slice, {viewport});
    try {
      await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; }); // CSSOM, so the page's CSP allows it
      await page.waitForTimeout(300);
      const found = [...await overflowProblems(page), ...await clippedText(page)];
      if (found.length) { problems.push(...found.map(f => viewport.width + ' px: ' + f)); shots.push(await shot(page, slice.id + '-text130-' + viewport.width)); }
    } finally { await context.close(); }
  }
  return problems.length ? fail(problems, shots) : ok();
}

export async function checkMotion(browser, urls, slice) {
  const {context, page} = await open(browser, urls, slice, {reducedMotion: 'reduce'});
  try {
    await page.waitForTimeout(300);
    const moving = await page.evaluate(() => {
      const seconds = value => Math.max(0, ...String(value).split(',').map(v => parseFloat(v) * (v.includes('ms') ? 0.001 : 1) || 0));
      const found = [];
      for (const element of document.querySelectorAll('body, body *')) {
        const s = getComputedStyle(element);
        if (s.animationName !== 'none' && seconds(s.animationDuration) > 0.05) found.push('animation ' + s.animationName + ' on ' + (element.className || element.tagName));
        if (s.transitionProperty !== 'none' && s.transitionProperty !== 'all' && seconds(s.transitionDuration) > 0.05) found.push('transition on ' + (element.className || element.tagName));
        if (s.scrollBehavior === 'smooth') found.push('smooth scrolling');
      }
      return [...new Set(found)].slice(0, 5);
    });
    return moving.length ? fail(moving.map(m => 'motion remains with reduced motion: ' + m), [await shot(page, slice.id + '-motion')]) : ok();
  } finally { await context.close(); }
}

export async function checkOffline(browser, urls, slice) {
  const {context, page} = await open(browser, urls, slice);
  const problems = [];
  try {
    await slice.draft?.type(page);
    await context.setOffline(true);
    // 1. The screen says so, and a network action is held rather than failing silently.
    const told = await page.locator('.offline').first().waitFor({state: 'visible', timeout: 20_000}).then(() => true, () => false);
    if (!told) problems.push('offline: the page never says it cannot reach Faravan');
    const offlineShot = told ? null : await shot(page, slice.id + '-offline-before-reload');
    if (slice.heldAction) {
      const held = await slice.heldAction(page);
      if (!held) problems.push('offline: "' + slice.heldActionName + '" is still offered as if it would work');
    }
    // 2. Reload while offline: the app still opens, and what the person typed is still there.
    const reloaded = await page.reload({timeout: 8_000}).then(() => true, () => false);
    if (!reloaded) problems.push('reload offline: the browser shows its own error page, because nothing caches the app');
    else {
      await slice.ready(page).catch(() => problems.push('reload offline: the screen did not come back'));
      if (slice.draft && !await slice.draft.kept(page)) problems.push('reload offline: the draft was lost');
    }
    return problems.length ? fail(problems, [offlineShot, await shot(page, slice.id + '-offline')].filter(Boolean)) : ok();
  } catch (error) {
    return fail(String(error.message).split('\n')[0], [await shot(page, slice.id + '-offline')]);
  } finally { await context.close(); }
}

const KEYBOARD_HEIGHT = 336;
export async function checkPhone(browser, urls, slice) {
  const phone = {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'};
  const {context, page} = await open(browser, urls, slice, phone);
  try {
    const problems = [...await overflowProblems(page)];
    await slice.phoneSetup?.(page);
    const input = slice.phoneInput ? page.locator(slice.phoneInput).first() : null;
    if (input) {
      await input.focus();
      // The virtual keyboard covers the bottom of the screen: the visual viewport gets shorter.
      await page.setViewportSize({width: 390, height: 844 - KEYBOARD_HEIGHT});
      await input.scrollIntoViewIfNeeded();
      const hit = await input.evaluate(el => {
        const rect = el.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        return {covered: !(top === el || el.contains(top) || top?.contains(el)), by: top ? (top.getAttribute('aria-label') || top.className || top.tagName) : 'nothing',
          inView: rect.top >= 0 && rect.bottom <= innerHeight};
      });
      if (hit.covered) problems.push('with the keyboard up, the focused field is covered by ' + hit.by);
      else if (!hit.inView) problems.push('with the keyboard up, the focused field is not fully visible after scrolling to it');
      // The tab bar must not sit on top of the keyboard-shrunk page content.
      const bar = await page.evaluate(() => { const b = document.querySelector('.tabbar,.tab-bar,nav[aria-label=Main]'); const r = b?.getBoundingClientRect(); const s = b && getComputedStyle(b); return r && s.position === 'fixed' ? {top: r.top, bottom: r.bottom, height: r.height} : null; });
      if (bar && bar.height > (844 - KEYBOARD_HEIGHT) * 0.2) problems.push('with the keyboard up, a fixed bar takes ' + Math.round(bar.height) + ' px of the ' + (844 - KEYBOARD_HEIGHT) + ' px that are left');
    }
    return problems.length ? fail(problems, [await shot(page, slice.id + '-phone')]) : ok();
  } finally { await context.close(); }
}

// A page must load clean: no console error and no uncaught exception while it opens and settles.
export async function checkConsole(browser, urls, slice) {
  const {context, page} = await open(browser, urls, slice);
  try {
    await page.waitForTimeout(1200);
    const problems = [...page.consoleErrors.map(text => 'console error: ' + text), ...page.errors.map(text => 'uncaught: ' + text)];
    return problems.length ? fail(problems, [await shot(page, slice.id + '-console')]) : ok();
  } finally { await context.close(); }
}

// §6.4 is a user-facing rule, so inspect the text Chromium actually renders. innerText
// omits hidden sprite symbols and script/style contents that textContent would include.
const BANNED_COPY = [
  ['verdict', /\bverdict\b/i],
  ['Member N', /\bmember\s+(?:n|\d+)\b/i],
  ['bare Key', /(?<!\bAPI\s)\bkey\b/i],
  ['fingerprint', /\bfingerprint\b/i],
  ['sha256', /\bsha256\b/i],
  ['long hex digest', /(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/i],
  ['UUID', /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i],
  ['Faravan server', /\bfaravan\s+server\b/i],
  ['Untitled job', /\buntitled\s+job\b/i],
  ['Job from another member', /\bjob\s+from\s+another\s+member\b/i],
  ['Check setup', /\bcheck\s+setup\b/i],
];

export function bannedCopyProblems(text) {
  return BANNED_COPY.filter(([, pattern]) => pattern.test(text))
    .map(([name]) => 'rendered page contains banned copy: ' + name);
}

export async function checkBannedVocabulary(browser, urls, slice) {
  const {context, page} = await open(browser, urls, slice);
  try {
    await page.waitForTimeout(300);
    const text = await page.locator('body').evaluate(element => element.innerText || '');
    const found = bannedCopyProblems(text);
    return found.length ? fail(found, [await shot(page, slice.id + '-vocabulary')]) : ok();
  } finally { await context.close(); }
}

export const CHECKS = [
  {id: 'keyboard', title: 'Keyboard only', run: checkKeyboard},
  {id: 'dialog', title: 'Dialog focus', run: checkDialog, needs: s => s.dialog, na: 'no dialog on this screen'},
  {id: 'history', title: 'Back / Forward', run: checkHistory},
  {id: 'narrow320', title: '320 px', run: checkNarrow},
  {id: 'zoom200', title: '200% zoom', run: checkZoom},
  {id: 'text130', title: '130% text', run: checkText130},
  {id: 'motion', title: 'Reduced motion', run: checkMotion},
  {id: 'offline', title: 'Offline + reload', run: checkOffline},
  {id: 'console', title: 'Clean console', run: checkConsole},
  {id: 'vocabulary', title: 'Banned vocabulary', run: checkBannedVocabulary},
  {id: 'phone', title: 'Phone keyboard', run: checkPhone, needs: s => s.phoneInput, na: 'no text field on this screen'},
];
