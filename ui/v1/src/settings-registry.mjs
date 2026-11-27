// The settings registry: one row per setting the app shows, wherever its control lives. Controls stay in context
// (limits on Limits, lending on Lending); the registry is what lets Search and the Settings map find them, say where a
// setting applies, and name its reset honestly. Research: PRODUCT-UX-FIELD-RESEARCH §9.
//
// Row fields:
//   key        stable id, also the palette item id ('setting:' + key)
//   label      the control's own label, so search lands on the words the page uses
//   group      a SETTINGS_GROUPS id
//   href       the page that holds the control; focus is a selector on that page to land on the field
//   words      synonyms people type ("quota", "allowance", "approval")
//   scope      where the value applies: 'browser' (this browser only), 'computer' (this computer), 'circle', 'account'
//   storage    where it is kept, for the integrator and for honest copy ('browser storage', 'this computer', ...)
//   effect     when a change takes effect
//   reset      the honest reset verb, or null when the app cannot reset it (then resetNote says who can)
//   authority  true when it gives this computer's resources or access away; authority never syncs between devices
//   reserved   true for a destination another module supplies; it is listed only once that module says it is ready
//   owner      the module that owns the control and its copy (the page file family: 'limits' → limits.jsx)
//   risk       'low' (cosmetic, this browser), 'medium' (changes how much is lent or what is kept), 'high' (gives access
//              or this computer's agents to other people)
//   default    the value a new install starts with, as words; 'unknown' when it comes from the install or provider
//              (for example how this copy is updated), null when there is no single value (a list, a page of actions)
// `href` is the target: the page that holds the control.

import {ROUTES, routeFromHash} from './helpers.mjs';

export const SETTINGS_GROUPS = Object.freeze([
  {id: 'you', label: 'You'},
  {id: 'computer', label: 'This computer'},
  {id: 'circles', label: 'Circles'},
  {id: 'advanced', label: 'Advanced and recovery'},
].map(Object.freeze));

const row = value => Object.freeze({words: [], reset: null, authority: false, reserved: false, ...value, words: Object.freeze(value.words ?? [])});

export const SETTINGS = Object.freeze([
  row({key: 'updates.earlyBuilds', owner: 'updates', risk: 'low', default: 'Off', label: 'Get early builds', group: 'computer', href: '#/setup', focus: '#early-builds',
    words: ['candidate', 'preview', 'updates'], scope: 'computer', storage: 'this computer', effect: 'after restarting Faravan'}),
  row({key: 'profile.ownerName', owner: 'profile', risk: 'low', default: 'Your computer account’s full name', label: 'Your name', group: 'you', href: '#/you/profile', focus: '#setting-ownerName',
    words: ['name', 'display name', 'nickname', 'profile'], scope: 'computer', storage: 'this computer, shown to your circles',
    effect: 'when you save', reset: {kind: 'discard', verb: 'Discard unsaved changes'}}),
  row({key: 'appearance.theme', owner: 'theme', risk: 'low', default: 'System', label: 'Theme', group: 'you', href: '#/you/appearance', focus: '#setting-theme',
    words: ['appearance', 'dark mode', 'light mode', 'colour', 'color', 'night'], scope: 'browser', storage: 'this browser',
    effect: 'at once', reset: {kind: 'default', verb: 'Use system theme'}}),
  row({key: 'notifications.desktop', owner: 'notifications', risk: 'low', default: 'History on; desktop on for everything except circle activity', label: 'Desktop notifications and history', group: 'you', href: '#/you/notifications', focus: '#notification-settings-title',
    words: ['notify', 'alerts', 'tray', 'do not disturb', 'job ready', 'requests', 'history'], scope: 'computer', storage: 'this computer',
    effect: 'when you save', help: 'Changes apply after Save.', reset: {kind: 'discard', verb: 'Discard unsaved changes'}}),
  row({key: 'notifications.browser', owner: 'notifications', risk: 'low', default: 'Off until you allow it in this browser', label: 'Browser notifications', group: 'you', href: '#/you/notifications',
    words: ['alerts', 'notify', 'bell', 'sound'], scope: 'browser', storage: 'your browser’s site settings', effect: 'at once',
    resetNote: 'Only your browser’s site settings can turn notifications off again.'}),
  row({key: 'data.yours', owner: 'settings', risk: 'medium', default: null, label: 'Your data', group: 'you', href: '#/you/data',
    words: ['privacy', 'what is shared', 'delete', 'export'], scope: 'computer', storage: 'this computer', effect: 'at once'}),
  row({key: 'data.telemetry', owner: 'telemetry', risk: 'medium', default: 'Counts and diagnostics where the law does not ask first; otherwise off until you choose', label: 'Help improve Faravan', group: 'you', href: '#/you/data', focus: '#telemetry-title',
    words: ['telemetry', 'privacy', 'problem reports', 'analytics', 'diagnostics', 'counts', 'usage', 'tracking', 'random id', 'what we send'], scope: 'computer', storage: 'this computer, reports go to the people who make Faravan',
    effect: 'at once; a change to Off also deletes what is waiting to be sent'}),
  row({key: 'profile.computerName', owner: 'profile', risk: 'low', default: 'This computer’s hostname', label: 'Computer name', group: 'computer', href: '#/you/profile', focus: '#setting-name',
    words: ['computer', 'device name', 'machine', 'rename'], scope: 'computer', storage: 'this computer, shown to your circles',
    effect: 'when you save', reset: {kind: 'discard', verb: 'Discard unsaved changes'}}),
  row({key: 'lending.enabled', owner: 'lending', risk: 'high', default: 'Off', label: 'Lending on or off', group: 'computer', href: '#/lend',
    words: ['lend', 'pause', 'resume', 'turn off', 'stop lending'], scope: 'computer', storage: 'this computer',
    effect: 'at once; a running job finishes first', help: 'Stops new jobs. A running job finishes first.', authority: true}),
  row({key: 'lending.agents', owner: 'lending', risk: 'high', default: 'None', label: 'Agents you lend', group: 'computer', href: '#/lend', focus: '#lend-agents',
    words: ['agent', 'claude', 'codex', 'model', 'effort'], scope: 'computer', storage: 'this computer', effect: 'for the next job',
    authority: true}),
  row({key: 'lending.mode', owner: 'limits', risk: 'high', default: 'Automatic', label: 'Who runs without asking', group: 'computer', href: '#/lend/limits', focus: '#lending-who',
    words: ['approval', 'approve', 'ask me', 'automatic', 'auto'], scope: 'computer', storage: 'this computer', effect: 'when you save a rule',
    authority: true}),
  row({key: 'limits.protectionPosition', owner: 'limits', risk: 'medium', default: 'Keep more for me', label: 'How much to lend', group: 'computer', href: '#/lend/limits', focus: 'input[name="protectionPosition"]:checked',
    words: ['quota', 'allowance', 'usage', 'subscription', 'share', 'keep more for me', 'protection'], scope: 'computer', storage: 'this computer',
    effect: 'from the next job', authority: true, reset: {kind: 'discard', verb: 'Discard unsaved changes'}}),
  row({key: 'limits.perJobPct', owner: 'limits', risk: 'medium', default: '10%', label: 'Per-job cap', group: 'computer', href: '#/lend/limits', focus: 'input[aria-label="Per-job cap, percent of weekly allowance"]',
    words: ['per-job', 'cap', 'weekly', 'allowance', 'percent'], scope: 'computer', storage: 'this computer',
    effect: 'from the next job', authority: true, reset: {kind: 'discard', verb: 'Discard unsaved changes'}}),
  row({key: 'limits.schedule', owner: 'limits', risk: 'medium', default: 'Any time', label: 'Lending hours', group: 'computer', href: '#/lend/limits', focus: '[aria-label="Only lend in set hours"]',
    words: ['schedule', 'hours', 'night', 'weekend', 'days', 'time zone'], scope: 'computer', storage: 'this computer',
    effect: 'from the next job', authority: true, reset: {kind: 'discard', verb: 'Discard unsaved changes'}}),
  row({key: 'limits.stopOnReturn', owner: 'limits', risk: 'high', default: 'Off', label: 'Stop a running job when I return', group: 'computer', href: '#/lend/limits', focus: '[role="switch"][aria-label="Stop a running job when I return"]',
    words: ['away', 'return', 'owner present', 'stop on return'], scope: 'computer', storage: 'this computer',
    effect: 'when you save', authority: true, reset: {kind: 'discard', verb: 'Discard unsaved changes'}}),
  row({key: 'updates', owner: 'updates', risk: 'medium', default: 'unknown', label: 'Updates', group: 'computer', href: '#/you/updates',
    words: ['version', 'upgrade', 'restart', 'release'], scope: 'computer', storage: 'this computer', effect: 'between jobs',
    reserved: true}),
  row({key: 'devices', owner: 'circles', risk: 'high', default: null, label: 'Your computers', group: 'computer', href: '#/devices',
    words: ['devices', 'other computer', 'connect a computer', 'link'], scope: 'account', storage: 'your circles', effect: 'at once'}),
  row({key: 'phone', owner: 'access', risk: 'high', default: 'Not paired', label: 'Pairing', group: 'computer', href: '#/you/phone',
    words: ['mobile', 'pair', 'pairing', 'pair a device', 'remove a device', 'qr', 'remote', 'iphone', 'android', 'phone'], scope: 'computer', storage: 'this computer', effect: 'at once',
    authority: true, reserved: true}),
  row({key: 'circles', owner: 'circles', risk: 'high', default: null, label: 'Your circles', group: 'circles', href: '#/circles',
    words: ['circle', 'members', 'invite', 'invitation', 'join', 'leave', 'people'], scope: 'circle', storage: 'each circle’s host',
    effect: 'at once'}),
  row({key: 'circles.host', owner: 'host', risk: 'high', default: 'Not hosting', label: 'Host a circle', group: 'circles', href: '#/circles/host',
    words: ['host', 'start a circle', 'private', 'public', 'address'], scope: 'computer', storage: 'this computer', effect: 'at once',
    authority: true}),
  row({key: 'setup.checks', owner: 'setup', risk: 'low', default: null, label: 'Setup checks', group: 'advanced', href: '#/setup/details',
    words: ['setup', 'docker', 'sandbox', 'diagnostics', 'troubleshoot', 'sign in'], scope: 'computer',
    storage: 'this computer', effect: 'at once'}),
  row({key: 'connections.chatgpt', owner: 'chatgpt', risk: 'high', default: 'Not connected', label: 'ChatGPT connection', group: 'advanced', href: '/connect/chatgpt',
    words: ['chatgpt', 'openai', 'connect', 'disconnect', 'app', 'mcp'], scope: 'account', storage: 'this computer', effect: 'at once',
    authority: true}),
]);

export const SCOPE_WORDS = Object.freeze({browser: 'This browser', computer: 'This computer', circle: 'Each circle', account: 'Your account'});

// "Notifications: this browser" vs "Lending computer: sandpiper". A browser-scoped value must never claim the computer.
export function scopeLabel(scope, {computer = ''} = {}) {
  const name = String(computer ?? '').trim();
  if (scope === 'computer') return name ? 'This computer · ' + name : SCOPE_WORDS.computer;
  return SCOPE_WORDS[scope] ?? '';
}

// Reserved destinations appear only when their module is mounted (`ready` lists their keys).
export const visibleSettings = (ready = []) => SETTINGS.filter(item => !item.reserved || ready.includes(item.key));

const fold = text => String(text ?? '').toLocaleLowerCase('en').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').trim();

// Search over labels and synonyms: a label match outranks a synonym match, a prefix outranks a word inside.
export function searchSettings(query, {ready = [], limit = 6} = {}) {
  const q = fold(query);
  if (!q) return [];
  const score = item => {
    const label = fold(item.label);
    if (label.startsWith(q)) return 4;
    if (label.split(/\s+/).some(word => word.startsWith(q))) return 3;
    if (item.words.some(word => fold(word).startsWith(q))) return 2;
    if (q.length > 2 && [label, ...item.words.map(fold)].some(text => text.includes(q))) return 1;
    return 0;
  };
  return visibleSettings(ready).map((item, order) => ({item, order, score: score(item)})).filter(x => x.score)
    .sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(x => x.item);
}

// The Settings map: every group with its rows, filtered by a query when there is one.
// A group states its usual scope once; a row names its scope only when it differs (the "You" group is mixed, so
// every row there says where it applies).
const GROUP_SCOPE = {computer: 'computer', circles: 'circle', advanced: 'computer'};
export function settingsMapVM({query = '', ready = [], computer = ''} = {}) {
  const matches = String(query).trim() ? new Set(searchSettings(query, {ready, limit: SETTINGS.length})) : null;
  const notes = {computer: 'Most settings here apply only to this computer. Items marked Your account apply across your account.'};
  const groups = SETTINGS_GROUPS.map(group => ({...group, scope: scopeLabel(GROUP_SCOPE[group.id], {computer}), note: notes[group.id] ?? '',
    items: visibleSettings(ready).filter(item => item.group === group.id && (!matches || matches.has(item)))
      .map(item => ({key: item.key, label: item.label, href: item.href, focus: item.focus ?? null, scope: scopeLabel(item.scope, {computer}),
        meta: item.scope === GROUP_SCOPE[group.id] ? '' : scopeLabel(item.scope, {computer}),
        default: item.default, storage: item.storage, effect: item.effect, help: item.help ?? null,
        authority: item.authority, reset: item.reset?.verb ?? null}))}))
    .filter(group => group.items.length);
  return {groups, count: groups.reduce((n, g) => n + g.items.length, 0),
    empty: matches && !matches.size ? 'No setting matches “' + String(query).trim() + '”.' : ''};
}

// The page a setting lives on, as search shows it: "How much to lend · What you lend".
export function settingPlace(href = '') {
  if (href.startsWith('#/you')) return ROUTES.settings;
  if (href.startsWith('#/')) return ROUTES[routeFromHash(href).page] ?? '';
  return href.startsWith('/connect/chatgpt') ? 'ChatGPT' : '';
}
