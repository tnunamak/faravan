import {checkLineVM} from './check-line.mjs';
import {circlePhrase} from '../../../lib/v1/lending-summary.mjs';
// Faravan safety copy v4: the ONE source of truth for every trust sentence on every surface
// (request card and page, gift sheet, invite, composer, receipt, setup, site, README).
// Pure functions of facts the system really has. U1c ports this file to ui/v1/src/view-models.mjs.
// S0.1b fails the build if a screen or fixture hard-codes a safety sentence, or puts "only",
// "nothing else" or "reached nothing" next to a host list.
//
// TOTAL (R3-08): every function accepts missing, null, empty or unsupported values and renders a
// cautious sentence for each one. It never prints "undefined", never throws, and an unknown fact
// never turns into a green assurance. `mockups/safety-copy.test.mjs` runs every function over
// every null combination and fails on either.
//
// Inputs, each from a real field:
//   job.network     {mode, registries[]}, mode 'provider' | 'provider+git' | 'provider+registries' | 'internet'
//                   (S5.4 `network` object). Legacy: the string 'provider-only' or the old `egress` enum.
//   job.maxMinutes  the job's whole time budget, checks included (P9)
//   adapter         {name, provider, providerHosts[], credentialInGuest, credentialProxyVerified (S5.2)}
//   boundaryVerified  S5.3 record for this OS + sbx + Faravan version
//   quota           {remaining (0..1), checkedAt}  (S6.2; never a per-job share)
//   lender          {name, deviceName}
export const SAFETY_VERSION = 4;

export const REQUEST_APPROVAL_DISCLOSURE = 'This job runs on your computer under your AI-provider account and uses your subscription. You, your AI provider, and logs on this computer may receive or retain its code, instructions and results. The circle’s host and members can read shared job contents. The sandbox limits the job’s access to your computer; it does not keep those contents confidential from these recipients.';

// The composer's check field: where and on what the requested check command runs.
export const CHECK_COMMAND_HELP = 'Runs on the returned source in a fresh sandbox; include dependency installation if needed. Leave it blank to skip the check.';

export const FIRST_SEND_COPY = Object.freeze({
  visible: 'The circle’s host and members can read what you send. The lender’s computer and its AI provider can access your request, code and data, and logs may keep copies of what the job sends and produces. A sandbox is meant to limit what a job can reach on the lender’s computer; it does not hide your code or job results from the lender, their provider or logs. Send only material you are allowed to share.',
  title: 'Before your first job goes to a friend',
  body: 'Your job will run on your friend’s computer, inside a sandbox meant to limit what it can reach on that computer. It does not hide your code or the job’s results from your friend, their AI provider, or logs on that computer. The job uses your friend’s subscription, under their name with their AI provider.',
  learnMore: 'A sandbox is a separate space on the lender’s computer where a job runs. It is meant to limit which files and programs the job can reach. The lender’s computer runs the job, so the lender, the AI provider tied to their account, and logs on that computer may receive or store the code the job sends and the results it produces. The job runs under the lender’s name with that provider and uses the lender’s subscription quota. Lending changes how quota is shared, not who can access job contents.',
});

export const JOIN_COPY = Object.freeze({
  noSideEffect: 'Joining does not send a job or turn on lending.',
  heading: 'What this means',
  points: Object.freeze([
    'Your friend’s jobs run on your computer, under your name with your AI provider, using your subscription.',
    'A sandbox is meant to limit what each job can reach on your computer.',
    'You, your AI provider, and logs on your computer can see what a job sends and produces.',
    'You pick how much to lend: automatic, a fixed share, or ask before each job.',
  ]),
});

export const INVITATION_COPY = Object.freeze({
  onePerson: 'Send the full link to one person for one computer.',
  audience: 'Invite only people who may access your circle’s shared requests, code and results. Jobs run on members’ computers and can be sent to AI providers and recorded in logs. Sending the invitation link only to selected people does not limit what recipients can see.',
});

export const DATA_SHARING_COPY = 'Jobs share your source and instructions with the circle’s host and receiving members. The receiving computer’s AI provider can also access them, and logs or other copies may persist. Leaving a circle does not delete those copies. Review what you send.';

export const LENDING_ON_COPY = 'Turning on lending lets a friend’s jobs run on your computer, using your subscription account under your name with your AI provider. A sandbox is meant to keep each job from reaching the rest of your computer, but it does not hide what a job sends or produces from you, your AI provider, or logs on your computer. You choose how much to lend: automatic, a fixed share, or ask before each job.';

export const STRATEGY_HELP_COPY = Object.freeze([
  'Automatic: Lends only what the app estimates you probably will not use before your quota resets.',
  'Fixed share: By default, it lends up to 20% of your weekly quota and keeps 30% for your use.',
  'Ask before each job: You approve each job before it runs.',
  'Some people use all their quota on purpose, pacing themselves through the week. For them, fixed share may fit better than automatic.',
]);

export const SANDBOX_LEARN_MORE = FIRST_SEND_COPY.learnMore;

const scText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const scList = (v) => (Array.isArray(v) ? v.map(scText).filter(Boolean) : []);
const scAgent = (a) => scText(a?.name) ?? 'your agent';
const scProvider = (a) => scText(a?.provider) ?? 'the agent’s model service';
const scDevice = (l) => scText(l?.deviceName) ?? 'computer';
const scMinutes = (m) => (Number.isFinite(m) && m > 0 ? Math.round(m) : null);
const scDuration = (milliseconds, minutes) => {
  const ms = Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds
    : Number.isFinite(minutes) && minutes >= 0 ? minutes * 60000 : null;
  if (ms === null) return null;
  const wholeMinutes = ms > 0 && ms % 60000 === 0;
  const amount = ms / (wholeMinutes ? 60000 : 1000);
  const unit = wholeMinutes ? 'minute' : 'second';
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
};
// Safe only when both facts are explicitly known; anything else is the cautious case.
const credentialSafe = (a) => a?.credentialInGuest === false && a?.credentialProxyVerified === true;
export const NATIVE_SIGNIN_OWNER_ONLY = 'Native sign-in is only for your own jobs and is never lent.';

// One canonical network shape (R3-12). The legacy spellings map in; anything else is unknown.
export const NETWORK_MODES = ['provider', 'provider+git', 'provider+registries', 'internet'];
export function normalizeNetwork(job) {
  const n = job?.network ?? job?.egress;
  if (n && typeof n === 'object') return {mode: NETWORK_MODES.includes(n.mode) ? n.mode : null, registries: scList(n.registries)};
  if (n === 'provider-only' || n === 'provider') return {mode: 'provider', registries: []};
  if (NETWORK_MODES.includes(n)) return {mode: n, registries: scList(job?.registries)};
  return {mode: null, registries: []};
}

function networkFact(job, adapter) {
  const p = scProvider(adapter), {mode, registries} = normalizeNetwork(job);
  const writeTone = credentialSafe(adapter) ? 'info' : 'warn'; // a write channel is a warning while the sign-in may be reachable
  switch (mode) {
    case 'provider': return {tone: 'info', icon: 'globe', text: `The job’s network rules allow ${p}. Docker’s sandbox image and start-up services can also be contacted.`};
    case 'provider+git': return {tone: writeTone, icon: 'globe', text: `It can reach ${p} and GitHub, to fetch the code. GitHub can also be used to send data out.`};
    case 'provider+registries': return {tone: writeTone, icon: 'globe', text: registries.length
      ? `It can reach ${p} and ${registries.join(', ')} to install packages. A package registry can also be used to send data out.`
      : `It can reach ${p} and package registries that weren’t named. A package registry can also be used to send data out.`};
    case 'internet': return {tone: 'warn', icon: 'globe', text: 'It can reach public websites, which can be used to send data out.'};
    default: return {tone: 'warn', icon: 'globe', text: 'We can’t tell which websites this job can reach. Ask the sender before you say yes.'};
  }
}

// Lender side, before "Run it". Warnings first: on a phone these are the rows read before the button.
export function safetyFacts({job, adapter, boundaryVerified, quota, lender} = {}) {
  const a = scAgent(adapter), m = scMinutes(job?.maxMinutes);
  const facts = [];
  facts.push(credentialSafe(adapter)
    ? {tone: 'info', icon: 'key', text: `A sign-in proxy is meant to keep credentials outside the sandbox. These checks do not compare your own tokens. The job can still use your allowance.`}
    : {tone: 'warn', icon: 'key', text: `${NATIVE_SIGNIN_OWNER_ONLY} Job code can read credentials supplied inside a sandbox. Other adapters’ credential isolation has not been verified here.`});
  facts.push(networkFact(job, adapter));
  // No per-job share of the allowance (T22): quota snapshots can't attribute usage to one job.
  const r = quota?.remaining;
  // T22: a remaining figure always says when it was checked. Without one, say nothing: Faravan reads the
  // weekly allowance itself (clawmeter), so "doesn't report" was false.
  const at = scText(quota?.checkedAt);
  const left = Number.isFinite(r) && r >= 0 && r <= 1 ? ` You have ${Math.round(r * 100)}% of your ${a} week left${at ? ` (checked ${at})` : ' (time of check unknown)'}.`
    : '';
  facts.push(m
    ? {tone: 'info', icon: 'clock', text: `Uses up to ${m} minutes of ${a}, including Faravan’s checks.${left}`}
    : {tone: 'warn', icon: 'clock', text: `This job didn’t say how long it may run, so your own per-job limit for ${a} applies.${left}`});
  facts.push({tone: 'ok', icon: 'box', text: `Runs in a new sandbox on your ${scDevice(lender)}, starting with the submitted project files and required runtime resources. The sandbox is meant to limit the job’s access to your computer; it does not hide submitted code from you, the AI provider or logs.`});
  facts.push({tone: 'ok', icon: 'shield', text: 'Before starting, the app runs its configured host and private-network access checks. Passing those checks does not cover every access path.'});
  const rank = {warn: 0, info: 1, ok: 2};
  facts.sort((x, y) => rank[x.tone] - rank[y.tone]);
  if (boundaryVerified !== true) facts.push({tone: 'info', icon: 'alert', text: 'Independent verification of these isolation controls is not available here. Treat isolation as a disclosed risk, not a promise. These controls do not hide source from the lender, provider or logs.'});
  return {facts};
}

// The inviter, when turning on a gift (P14). The gift removes the "yes", so every term the inviter
// delegates is shown here (R3-17): who, which agent, which websites, how long, until when.
export function giftFacts({adapter, maxMinutes, network, recipient, expiresAt} = {}) {
  const a = scAgent(adapter), m = scMinutes(maxMinutes);
  const who = scText(recipient) ?? 'the person who joins with this invitation';
  const facts = [];
  facts.push(credentialSafe(adapter)
    ? {tone: 'info', icon: 'gift', text: `The first job from ${who} runs without asking you.`}
    : {tone: 'warn', icon: 'key', text: `The first job from ${who} runs without asking you. ${NATIVE_SIGNIN_OWNER_ONLY} Job code can read credentials supplied inside a sandbox.`});
  facts.push(networkFact({network}, adapter));
  facts.push(m
    ? {tone: 'info', icon: 'clock', text: `Up to ${m} minutes of ${a}, once, including Faravan’s checks.`}
    : {tone: 'warn', icon: 'clock', text: `Once, within your per-job limit for ${a}.`});
  facts.push({tone: 'info', icon: 'cal', text: scText(expiresAt)
    ? `It ends ${expiresAt}, or when you turn it off. A job that needs more than this asks you first.`
    : 'It ends with the invitation, or when you turn it off. A job that needs more than this asks you first.'});
  return facts;
}

// Borrower side: names every reader, and freezes the audience (R3-11). route: ['Ana', 'Mo'].
// Nobody outside the named route sees the request unless the borrower agrees to ask more people.
export function borrowerDisclosure({route, hosted, attachments = 0} = {}) {
  const r = scList(route);
  const lenders = r.length === 0 ? 'The friends we ask'
    : r.length === 1 ? r[0]
    : `${r[0]} (and ${r.slice(1).join(', then ')} if ${r[0]} passes)`;
  const what = attachments > 0 ? `your request, your ${attachments === 1 ? 'screenshot' : attachments + ' screenshots'} and the list of files` : 'your request and the list of files';
  const service = hosted === false ? 'the circle’s server' : 'the circle’s service';
  const more = r.length ? ' We ask you before anyone else sees it.' : '';
  return `${lenders} can read ${what}. Whoever runs it gets the code and keeps a copy, and ${service} can read all of it. The runner’s AI provider can receive code and data, and logs or other copies may persist. Sandboxing does not keep your source confidential from these recipients.${more}`;
}

// MVP composer (EXPERIENCE §M7): the audience is the circle's current lenders. The frozen route is Later (P13).
// lenders: ['Ana’s MacBook', 'Mo’s Mac'] (computer names, from the circle's current lenders).
// A circle named in a sentence. Circle names are often a person's name ("Tessa"), so a bare name reads as a person.
export {circlePhrase};
export function circleDisclosure({circle, lenders, host, networked} = {}) {
  if (networked === false || circle === 'My devices') return 'This circle is not shared with other circle members. A job run here can still send code and data to its AI provider and leave logs. Choose a member-hosted circle to share a job.';
  const c = circlePhrase(scText(circle)), hostName = scText(host);
  const named = scList(lenders).filter(name => name !== 'another member’s computer');
  const names = named.length <= 1 ? named.join('') : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  const now = names ? ` Current lenders include ${names}.` : '';
  const retention = hostName && !['the host’s computer', 'the circle’s host'].includes(hostName)
    ? `The host, ${hostName}, states job/result retention is 30 days.` : 'The host states job/result retention is 30 days.';
  return `Anyone lending in ${c}, including members who join later, may take this job.${now} The lender can inspect the code and data their computer receives. Their AI provider can also receive it, and logs or other copies may persist. ${retention} That does not remove copies held by lenders, providers or logs.`;
}

// Usage after a job, with the two counters reported apart.
export function usageLine({jobCredit, minutes, agent} = {}) {
  const a = scText(agent) ?? 'the agent';
  const credit = jobCredit === true ? 'It used 1 of today’s jobs.' : jobCredit === false ? 'It didn’t use one of today’s jobs.' : 'We don’t know yet whether it used one of today’s jobs.';
  if (minutes === 0) return `${credit} No agent time was used.`;
  const m = scMinutes(minutes);
  return m ? `${credit} ${m} ${m === 1 ? 'minute' : 'minutes'} of ${a} were used.` : `${credit} The agent time used isn’t known yet.`;
}

// After the job, from the job record. `egressEvidence` is exactly receipt.egress_evidence (S5.5, on main):
// host:port -> 'allowed' | 'denied' | 'unknown', at most 32 entries, a denial wins over an allowance,
// and {"*": "unknown"} when the sbx network log could not be read. The log covers the sandbox's whole life
// (start-up and agent), so hosts are grouped by WHAT THEY ARE, never by when they were reached.
const BOOT_HOSTS = ['download.docker.com', 'archive.ubuntu.com', 'security.ubuntu.com', 'ports.ubuntu.com', 'deb.debian.org', 'security.debian.org'];
const SOURCE_HOSTS = ['github.com', 'codeload.github.com'];
const glob = (pat, host) => new RegExp('^' + pat.replace(/\./g, '\\.').replace(/^\*\*\\\./, '(.+\\.)?') + '$').test(host);
export function groupEgress(evidence, providerPatterns) {
  const entries = Object.entries(evidence && typeof evidence === 'object' ? evidence : {});
  if (!entries.length || (entries.length === 1 && entries[0][0] === '*')) return {unknown: true};
  const pats = scList(providerPatterns);
  const g = {provider: [], source: [], boot: [], docker: [], other: [], blocked: [], unknownHosts: [], truncated: entries.length >= 32, providerKnown: pats.length > 0};
  for (const [hp, v] of entries) {
    const host = hp.replace(/:\d+$/, '');
    if (v === 'denied') { g.blocked.push(hp); continue; }
    if (v !== 'allowed') { g.unknownHosts.push(hp); continue; } // 'unknown' and any unexpected value
    if (host.endsWith('.docker.internal')) g.docker.push(hp);
    else if (BOOT_HOSTS.includes(host)) g.boot.push(hp);
    else if (SOURCE_HOSTS.includes(host)) g.source.push(hp);
    else if (pats.some((p) => glob(p, host))) g.provider.push(hp);
    else g.other.push(hp);
  }
  return g;
}

export function receiptLines({receipt, lender, adapter, viewer = 'borrower'} = {}) {
  const rc = receipt ?? {};
  // The lender reads about their own computer ("this MacBook"); the borrower reads "Ana's MacBook".
  const own = viewer === 'lender', name = scText(lender?.name), dev = scDevice(lender);
  const by = own ? 'this computer' : name ? `${name}’s computer` : 'the lender’s computer';
  const where = own ? `this ${dev}` : name ? `${name}’s ${dev}` : `the lender’s ${dev}`;
  const duration = scText(rc.durationText) || scDuration(rc.duration_ms, rc.minutes);
  const lines = [{tone: 'ok', icon: 'box', text: duration ? `Ran ${duration.replace(/minutes?$/, 'min')} in a new sandbox on ${where}.` : `Ran in a new sandbox on ${where}. The run time wasn’t recorded.`, by: own ? 'recorded on this computer' : 'reported by ' + by}];
  if (own) lines.push(rc.cleanupVerified === true
    ? {tone: 'ok', icon: 'trash', text: 'The sandbox was removed afterwards.', by: 'checked on this computer'}
    : {tone: 'warn', icon: 'trash', text: 'Removal of the sandbox wasn’t confirmed. Faravan retries and tells you if it stays.', by: 'checked on this computer'});
  const g = groupEgress(rc.egressEvidence, adapter?.providerHosts);
  if (g.unknown) {
    const rules = scList(rc.allowedByRules);
    lines.push({tone: 'info', icon: 'globe', text: `The network log couldn’t be read for this job, so we don’t know which sites it reached. ${rules.length ? `The rules allowed: ${rules.join(', ')}.` : 'The job’s rules weren’t recorded either.'}`, by: 'from the job’s rules'});
  } else {
    const L = (arr) => arr.map((h) => '`' + h + '`').join(', ');
    const log = 'Docker Sandboxes network log';
    if (g.blocked.length) lines.push({tone: 'warn', icon: 'shield', text: `Blocked: ${L(g.blocked)}.`, by: log});
    if (g.provider.length) lines.push({tone: 'ok', icon: 'cpu', text: `${scProvider(adapter)} (the agent’s model service): ${L(g.provider)}.`, by: log});
    if (g.source.length) lines.push({tone: 'info', icon: 'github', text: `GitHub: ${L(g.source)}.`, by: log});
    if (g.other.length) lines.push({tone: 'warn', icon: 'globe', text: g.providerKnown ? `Other sites: ${L(g.other)}.` : `Other sites (we couldn’t tell which belong to the agent’s model service): ${L(g.other)}.`, by: log});
    if (g.boot.length || g.docker.length) lines.push({tone: 'info', icon: 'refresh', text: `Sandbox start-up: ${L([...g.boot, ...g.docker])}. Docker’s sandbox image and services use these when the sandbox starts; the agent may also have used them.`, by: log});
    if (g.unknownHosts.length) lines.push({tone: 'info', icon: 'alert', text: `Not sure whether allowed: ${L(g.unknownHosts)}.`, by: log});
    if (g.truncated) lines.push({tone: 'info', icon: 'list', text: 'The log keeps at most 32 sites, so the list may be incomplete.', by: log});
  }
  if (rc.preflight === true) lines.push({tone: 'ok', icon: 'shield', text: own
    ? 'The configured host and private-network checks passed before start; other access paths were not independently checked.'
    : 'The lender reported that the configured host and private-network checks passed before start. This does not independently check isolation or source confidentiality.',
  by: own ? 'checked on this computer' : 'checked by ' + by});
  else if (rc.preflight === false) lines.push({tone: 'warn', icon: 'shield', text: 'The check before start didn’t pass, so the agent didn’t run.', by: own ? 'checked on this computer' : 'checked by ' + by});
  for (const c of Array.isArray(rc.checks) ? rc.checks : []) lines.push(checkLineVM(c));
  return lines;
}

// MVP receipt (EXPERIENCE §M11): two lines from receipt fields the app has. Missing facts say so; none becomes an assurance.
// run = {agent, version, model, effort, backend, backendVersion, duration_ms, minutes}; lender = {name, deviceName}
export function runFacts({run, lender, viewer} = {}) {
  const r = run ?? {}, name = scText(lender?.name), where = name ? `${name}’s ${scDevice(lender)}` : `the lender’s ${scDevice(lender)}`;
  const agent = scText(r.agent) ?? 'the agent', version = scText(r.version);
  // A model id is one identifier: it is marked as code so it never wraps at its hyphens.
  const model = scText(r.model)?.replaceAll('`', '');
  const detail = [model ? '`' + model + '`' : null, scText(r.effort) ? `${r.effort.trim()} effort` : null].filter(Boolean).join(', ');
  const backend = scText(r.backend) ? ` in ${r.backend.trim()}${scText(r.backendVersion) ? ' ' + r.backendVersion.trim() : ''}` : '';
  const duration = scText(r.durationText) || scDuration(r.duration_ms, r.minutes);
  return [
    {tone: 'ok', icon: 'box', text: `${viewer==='own'?'Ran on this computer':viewer==='lender'?'Ran here':'Ran on '+where} with ${agent}${version ? ' ' + version : ''}${detail ? ` (${detail})` : ''}${backend}.`, by: 'from the job record'},
    duration ? {tone: 'info', icon: 'clock', text: `Used ${duration} of ${['lender','own'].includes(viewer)?'your':'the lender’s'} ${agent} time, measured by Faravan.`, by: ''}
      : {tone: 'info', icon: 'clock', text: 'The agent time used isn’t known.', by: ''},
  ];
}

// General statements where no single job exists yet (setup aside, invite page, site FAQ).
export function overviewFacts({anyCredentialUnverified = true, boundaryVerified = false} = {}) {
  const facts = [
    {tone: 'info', icon: 'bell', text: 'A friend asks. You get a notification on this computer, and you say yes or not now.'},
    {tone: 'info', icon: 'box', text: 'Each job starts in a new sandbox with the submitted project files and required runtime resources. The sandbox is meant to limit access to the lender’s computer; it does not hide borrower source from the lender, provider or logs. The app runs configured host and private-network access checks before start.'},
    anyCredentialUnverified !== false
      ? {tone: 'warn', icon: 'key', text: `${NATIVE_SIGNIN_OWNER_ONLY} Job code can read credentials supplied inside a sandbox. Other adapters’ credential isolation has not been verified here.`}
      : {tone: 'info', icon: 'key', text: 'The sign-in proxy is meant to keep credentials outside the sandbox. The checks do not compare your own tokens. Jobs can still use your allowance.'},
    {tone: 'info', icon: 'clock', text: 'Jobs use your agent’s allowance, inside limits you set.'},
  ];
  return {facts, footnote: boundaryVerified === true ? null : 'Independent verification of these isolation controls is not available here. Treat isolation as a disclosed risk, not a promise. These controls do not hide source from the lender, provider or logs.'};
}

// Unknown receipt facts use the same wording on every job surface (§M11).
export const RECEIPT_COPY = {
  missingRun: 'The agent, time used and cleanup were not recorded for this job.',
  missingCleanup: 'Cleanup was not recorded for this job.',
};
