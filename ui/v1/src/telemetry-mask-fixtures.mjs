import {h} from 'preact';

// Synthetic values only. These channels cover the attributes that text/input
// masking cannot protect; consumers can also reuse them in recorder tests.
export const MASK_CANARIES = Object.freeze({
  text: 'MASK_CANARY_TEXT_91db', input: 'MASK_CANARY_INPUT_91db',
  attribute: 'MASK_CANARY_ATTRIBUTE_91db', link: 'MASK_CANARY_LINK_91db',
  hidden: 'MASK_CANARY_HIDDEN_91db', svg: 'MASK_CANARY_SVG_91db',
});
export function maskCanaryContent() {
  const c = MASK_CANARIES;
  return h('div', {'data-mask-probe': ''},
    h('p', null, c.text), h('input', {value: c.input}),
    h('span', {title: c.attribute, 'aria-label': c.attribute}, 'Attribute probe'),
    h('a', {href: 'https://example.invalid/' + c.link}, 'Link probe'),
    h('div', {hidden: true}, c.hidden),
    h('svg', {'aria-label': c.svg}, h('text', null, c.svg)));
}

export const MASK_VIEW_FILES = Object.freeze([
  'home', 'compose', 'project-picker', 'source-choice', 'saved-request', 'request-rows',
  'request', 'jobs', 'job-view', 'job-parent', 'job-thread', 'transcript-feed',
  'agent-question', 'check-line', 'result-reader', 'result-workspace', 'result-actions',
  'apply-sheet', 'image-preview', 'circles', 'circle-activity', 'invitations', 'people',
  'local-name', 'profile', 'info', 'shell', 'palette', 'lend', 'lending-policy-view',
  'limits', 'host', 'member-host', 'member-address', 'start-circle', 'phone', 'signin', 'command-line-tool',
  'blockers', 'setup', 'shared', 'ds/card', 'ds/facts', 'ds/job', 'ds/form',
  'ds/disclosure', 'ds/nav', 'ds/swing', 'ds/button', 'ds/sheet', 'job-timeline',
  'onboarding', 'shell-states', 'updates', 'support-export', 'main', 'telemetry-ui',
]);

const c = MASK_CANARIES.text, noop = () => {}, api = {get: async () => ({}), post: async () => ({})};
const circle = {id: 'mask-circle', name: c, owned: true};
const data = {devices: {ownerName: c, name: c, fingerprint: 'mask-device'}, home: {lending: {}}, approvals: [], circles: [circle], agents: []};
// Representative states use the real exported views, including initial states.
// Additional states below exercise detached dialogs and shared wrapper props.
const views = [
  ['main', 'MainNotice', {notice:c}],
  ['telemetry-ui', 'TelemetryPreview', {output:{state:{effective:'on'},items:[{stream:'counts',state:'queued',at:'2026-11-06T00:00:00Z',bytes:1,body:c}]}}],
  ['home', 'Home', {api, data, circles: [circle], agents: [], lending: {}, members: [], mutate: noop}],
  ['home', 'HomeDraftCopy', {text: c}],
  ['compose', 'ComposeBody', {vm: {send: {}}, draft: {prompt: c, sourceKind: 'none'}, circles: [circle]}],
  ['project-picker', 'ProjectRow', {project: {name: c, path: '/synthetic/' + c}, onChoose: noop, onBrowse: noop}],
  ['source-choice', 'OtherSource', {draft: {sourceKind: 'git', gitUrl: 'https://example.invalid/' + c}}],
  ['saved-request', 'SavedRequestPreview', {text: c, circle: c}],
  ['request-rows', 'RequestRows', {rows: [{card: {id: c}, view: {localName: c, prompt: c}}]}],
  ['request', 'Decision', {card: {}, name: c, deadline: {state: 'expired', line: c}, outcome: null, view: {}, own: true, blocked: true}],
  ['jobs', 'RenameJob', {initial: c, save: noop}],
  ['job-view', 'AskedCard', {prompt: c}],
  ['job-view', 'AskedCard', {prompt: c, bare: true}],
  ['job-view', 'HowItRan', {lines: [{text: c}], bare: true}],
  ['job-parent', 'ParentJobLink', {parent: {job_digest: 'sha256:' + 'a'.repeat(64), result_digest: 'sha256:' + 'b'.repeat(64), title: c}, circle: c}],
  ['job-thread', 'JobThreadPanel', {hasContinuation: true, data: {handoff: {objective: c}}, circleId: c}],
  ['job-thread', 'JobThreadPanel', {hasContinuation: true, data: {handoff: {objective: c}}, circleId: c, bare: true}],
  ['transcript-feed', 'AgentActivity', {feed: {entries: [{kind: 'message', id: c, role: 'user', text: c}]}}],
  ['transcript-feed', 'AgentActivity', {bare: true, feed: {entries: [{kind: 'message', id: c, role: 'user', text: c}]}}],
  ['agent-question', 'AgentQuestion', {question: c, onAnswer: noop}],
  ['check-line', 'CheckLine', {vm: {cmd: c, note: c, changedTests: [c]}}],
  ['result-reader', 'ResultReader', {data: {message: {markdown: c + ' [link](https://example.invalid/' + c + ')'}, files: [{path: c, text: c}]}}],
  ['result-workspace', 'ResultWorkspace', {data: {files: [], diffstat: {}, details: c}, outputWarning: c}],
  ['result-actions', 'ResultActionsBody', {repo: '/synthetic/' + c, phase: 'idle'}],
  ['apply-sheet', 'ApplyBody', {phase: 'form', repo: '/synthetic/' + c, branch: c, context: {}, digest: c}],
  ['image-preview', 'ImagePreview', {file: {path: c, preview: {url: '/api/synthetic/' + c}}, inline: true}],
  ['circles', 'CircleProfileSettings', {circle: {...circle, purpose: c}, mutate: noop}],
  ['circle-activity', 'Activity', {data: {activity: [{type: 'unknown', data: {title: c}}]}}],
  ['invitations', 'InvitationList', {items: [{id: c, label: c, createdAt: '2026-11-01T00:00:00Z'}]}],
  ['people', 'PeopleList', {people: [{personId: 'mask-person', name: c, computers: [{key_id: 'mask-key'}]}], members: [{person_id: 'mask-person', key_id: 'mask-key', device_name: c}], circleId: c}],
  ['local-name', 'LocalNameControl', {circleId: 'mask-circle', keyId: 'mask-key', remoteName: c, current: c, circleLabel: c}],
  ['profile', 'ComputerProfile', {data, mutate: noop}],
  ['info', 'SettingsMap', {computer: c}],
  ['shell', 'Shell', {route: {page: 'home'}, circles: [circle], title: c, subtitle: c, devices: data.devices}],
  ['palette', 'Palette', {open: true, api, circles: [circle], data, devices: data.devices}],
  ['lend', 'RequesterLimitsControl', {circleId: 'mask-circle', keyId: 'mask-key', value: {}}],
  ['lending-policy-view', 'Line', {label: c, hint: c}],
  ['limits', 'SaveFailed', {error: {code: 'network'}, onShow: noop, onCheck: noop}],
  ['host', 'StoppedHostNote', {name: c}],
  ['member-host', 'MemberHostNotices', {items: [{circle, banners: [{id: 'host-unknown', headline: c, text: c}]}]}],
  ['member-address', 'MemberAddressBody', {view: {state: 'ready', address: c}, note: c}],
  ['member-address', 'MemberOriginsBody', {items: [{keyId: 'mask-key', name: c, state: 'proposed', address: c, signedAddress: null}], notes: {'mask-key': c}}],
  ['start-circle', 'StartAnotherCircle', {computerReference: c, mutate: noop}],
  ['phone', 'Phone', {now: Date.UTC(2026, 10, 6), initial: {enabled: true, reach: {state: 'http'}, hostname: c, certFile: '/synthetic/' + c, pairing: {id: 'mask-pair', state: 'waiting', code: 'M4SK-7CNY', expiresAt: '2026-11-06T00:05:00Z', url: 'https://example.invalid/' + MASK_CANARIES.link, qr: {size: 9, d: 'M4 4h1v1h-1z'}}}}],
  ['signin', 'SignIn', {api, target: c, agentName: c}],
  ['command-line-tool', 'CommandLineTool', {api}],
  ['blockers', 'StepRow', {item: {label: c, detail: c}, children: c}],
  ['setup', 'SetupDetails', {readiness: {details: c}, copyDetails: c}],
  ['shared', 'Note', {children: c}],
  ['ds/card', 'Row', {title: c, meta: c, href: '#/' + c}],
  ['ds/facts', 'Facts', {items: [{text: c, by: c}]}],
  ['ds/job', 'Command', {text: c}],
  ['ds/form', 'Field', {label: c, hint: c, value: c}],
  ['ds/disclosure', 'Disclosure', {summary: c, rows: [[c, c]], children: maskCanaryContent()}],
  ['ds/nav', 'ThisComputer', {name: c, line: c, word: c, href: '#/' + c}],
  ['ds/swing', 'SwingItemCard', {actor: c, title: c}],
  ['ds/button', 'Button', {children: maskCanaryContent(), class: 'ph-no-capture', 'data-telemetry-private': 'fixture-button'}],
  ['ds/sheet', 'Sheet', {open: true, label: c, children: maskCanaryContent()}],
  ['job-timeline', 'JobTimelineView', {bare: true, view: {state: 'ready', rows: [{key: 'mask', label: c, detail: c}], notes: [c]}}],
  ['job-timeline', 'JobTimelineView', {view: {state: 'ready', rows: [{key: 'mask', label: c, detail: c}], notes: [c]}}],
  ['onboarding', 'FirstTasks', {tasks: [{label: c, prompt: c}]}],
  ['shell-states', 'ConnectionBanner', {vm: {text: c}}],
  ['updates', 'Updates', {api, initial: {currentVersion: '1.0.0', notes: [c], notesUrl: 'https://example.invalid/' + MASK_CANARIES.link}}],
  ['support-export', 'SupportExport', {api}],
];
export async function maskViewFixtures() {
  return Promise.all(views.map(async ([file, name, props]) => {
    const module = await import('./' + file + '.jsx');
    if (typeof module[name] !== 'function') throw new Error('Missing mask fixture component: ' + file + ':' + name);
    const region = {main:'main-notice',shell: 'shell-heading', 'ds/form': 'ds-form-field', 'ds/nav': 'ds-nav-computer', 'ds/button': 'fixture-button'}[file] || file.replace('/', '-');
    return {file, name, props, region, Component: module[name]};
  }));
}

// Existing structural assertions can compare the same HTML while accepting only
// the two added privacy markers. All other classes, attributes and text survive.
export function withoutMaskMarkers(html) {
  return html.replace(/ data-telemetry-private="[a-z][a-z0-9-]*"/g, '')
    .replace(/ class="([^"]*)"/g, (attribute, classes) => {
      if (!classes.split(' ').includes('ph-no-capture')) return attribute;
      const kept = classes.split(' ').filter(value => value !== 'ph-no-capture');
      return kept.every(value => !value) ? '' : ' class="' + kept.join(' ') + '"';
    });
}
