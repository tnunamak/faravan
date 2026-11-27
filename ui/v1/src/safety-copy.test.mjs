// Totality test for src/safety-copy.mjs (R3-08). Every function runs over every combination of
// missing, null, empty and unsupported inputs. It fails if any output throws, prints a JavaScript
// placeholder (undefined, null, NaN, [object Object]), or lets an unknown fact become an assurance.
// Usage: node ui/v1/src/safety-copy.test.mjs. This copy runs against the shipped UI module beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from './safety-copy.mjs';
import {LENDING_PARAMETERS} from '../../../lib/v1/lending-policy.mjs';

const bad = /undefined|\bnull\b|NaN|\[object/;
let n = 0, failed = 0, fails = [];
const texts = (out) => (Array.isArray(out) ? out : out?.facts ?? [out]).map((f) => (typeof f === 'string' ? f : `${f.text} ${f.by ?? ''}`));
const check = (label, fn, assert) => {
  n++;
  const before = fails.length;
  let out;
  try { out = fn(); } catch (e) { fails.push(`${label}: threw ${e.message}`); failed++; return; }
  for (const t of texts(out)) if (bad.test(t)) fails.push(`${label}: "${t}"`);
  if (assert) { const msg = assert(out); if (msg) fails.push(`${label}: ${msg}`); }
  if (fails.length > before) failed++;
};

const missing = [undefined, null, '', [], {}, 'surprise', 0, -1, NaN];
const adapters = [undefined, null, {}, {name: 'Claude Code'}, {name: 'Claude Code', provider: 'Anthropic', providerHosts: ['**.anthropic.com'], credentialInGuest: false, credentialProxyVerified: true},
  {name: 'Codex', credentialInGuest: true, credentialProxyVerified: true}, {name: null, provider: null, providerHosts: null}];
const networks = [undefined, null, 'provider-only', 'provider', 'provider+git', 'provider+registries', 'internet', 'surprise', {}, {mode: 'provider+registries'},
  {mode: 'provider+registries', registries: null}, {mode: 'provider+registries', registries: ['npm', null, '']}, {mode: 'nope'}];
const lenders = [undefined, null, {}, {name: 'Ana', deviceName: 'MacBook'}, {name: '', deviceName: null}];

for (const adapter of adapters) for (const network of networks) for (const maxMinutes of [20, ...missing]) for (const lender of lenders) {
  for (const quota of [undefined, null, {}, {remaining: 0.51}, {remaining: 7}, {remaining: NaN}]) {
    check(`safetyFacts ${JSON.stringify({adapter, network, maxMinutes, lender, quota})}`,
      () => S.safetyFacts({job: {network, maxMinutes, registries: null}, adapter, boundaryVerified: undefined, quota, lender}),
      (out) => {
        const all = out.facts.map((f) => f.text).join(' ');
        const safe = adapter?.credentialInGuest === false && adapter?.credentialProxyVerified === true;
        if (!safe && !out.facts.some((f) => f.tone === 'warn' && f.icon === 'key')) return 'credential not proven safe, but no credential warning';
        const mode = S.normalizeNetwork({network}).mode;
        if (!mode && !out.facts.some((f) => f.tone === 'warn' && f.icon === 'globe')) return 'unknown network rendered without a warning';
        if (!/Independent verification of these isolation controls is not available here\./.test(all)) return 'boundary not verified, but no footnote';
        return null;
      });
  }
}
for (const adapter of adapters) for (const maxMinutes of [20, ...missing]) for (const network of networks)
  for (const recipient of [undefined, '', 'Mia']) for (const expiresAt of [undefined, null, 'tomorrow, 2:15 PM'])
    check('giftFacts', () => S.giftFacts({adapter, maxMinutes, network, recipient, expiresAt}),
      (out) => (out.length < 4 ? 'gift terms incomplete (who, websites, time, end)' : null));
for (const route of [undefined, null, [], [''], ['Ana'], ['Ana', 'Mo'], ['Ana', null, 'Mo']]) for (const hosted of [undefined, true, false]) for (const attachments of [undefined, 0, 1, 3])
  check('borrowerDisclosure', () => S.borrowerDisclosure({route, hosted, attachments}));
for (const circle of [undefined, null, '', 'Weekend projects']) for (const lenders of [undefined, null, [], [''], ['Ana’s MacBook'], ['Ana’s MacBook', 'Mo’s Mac'], ['A', 'B', 'C']]) for (const host of [undefined, '', 'Ana’s MacBook'])
  check('circleDisclosure', () => S.circleDisclosure({circle, lenders, host}));
for (const networked of [undefined, false, true])
  check('My devices is not described as shared even with stale network information', () => S.circleDisclosure({circle:'My devices',networked}),
    out => /not shared with other circle members/.test(out) && !/people who join later/.test(out) ? null : 'local circle was described as shared');
for (const run of [undefined, null, {}, {agent: 'Claude Code', version: '2.3.1', model: 'claude-opus-5-5', effort: 'medium', backend: 'Docker Sandboxes', backendVersion: '0.49', minutes: 14}, {agent: null, minutes: 'x'}, {minutes: 1}, {effort: 5, model: {}}]) for (const lender of [undefined, null, {}, {name: 'Ana', deviceName: 'MacBook'}])
  check('runFacts', () => S.runFacts({run, lender}));
for (const jobCredit of [true, false, undefined, null]) for (const minutes of [0, 1, 9, ...missing]) for (const agent of [undefined, '', 'Ana’s Codex'])
  check('usageLine', () => S.usageLine({jobCredit, minutes, agent}));
const evidences = [undefined, null, {}, {'*': 'unknown'}, 'garbage', {'github.com:443': 'allowed', 'pastebin.com:443': 'denied', 'x.example:443': 'unknown', 'y.example:443': 'weird', 'chatgpt.com:443': 'allowed', 'archive.ubuntu.com:80': 'allowed'},
  Object.fromEntries(Array.from({length: 32}, (_, i) => [`h${i}.example:443`, 'allowed']))];
const checksList = [undefined, null, [], [{}], [{cmd: 'npm test', exit: 0, observedBy: 'sandbox'}], [{observedBy: 'sandbox', timedOut: true}], [{observedBy: 'sandbox', skipped: 'no time was left'}], [{cmd: null, exit: null, observedBy: 'sandbox', agentChangedTests: null}], [{observedBy: 'agent'}]];
for (const egressEvidence of evidences) for (const allowedByRules of [undefined, null, [], ['GitHub']]) for (const checks of checksList)
  for (const minutes of [9, undefined, null, 0]) for (const lender of lenders) for (const adapter of adapters) for (const viewer of ['borrower', 'lender'])
    for (const preflight of [true, false, undefined]) for (const cleanupVerified of [true, undefined])
      check('receiptLines', () => S.receiptLines({receipt: {minutes, egressEvidence, allowedByRules, checks, preflight, cleanupVerified}, lender, adapter, viewer}),
        (out) => {
          const all = out.map((l) => l.text).join(' ');
          if (/\bonly\b|nothing else|reached nothing/i.test(all)) return 'banned assurance word in a receipt';
          if (viewer === 'borrower' && /removed afterwards/.test(all)) return 'borrower receipt claims cleanup';
          return null;
        });
for (const a of [undefined, true, false]) for (const b of [undefined, true, false]) check('overviewFacts', () => S.overviewFacts({anyCredentialUnverified: a, boundaryVerified: b}));
check('receiptLines with no arguments', () => S.receiptLines());
check('safetyFacts with no arguments', () => S.safetyFacts());
for (const network of ['provider-only', {mode: 'provider'}]) check('provider rules include sandbox start-up services',
  () => S.safetyFacts({job:{network}, adapter:{provider:'Anthropic'}}), (out) => {
    const row = out.facts.find(f => f.icon === 'globe');
    if (row.tone !== 'info' || !row.text.includes('network rules allow Anthropic') || !row.text.includes('start-up services can also be contacted')) return 'requested rules must not claim exclusive observed access';
    if (/\bonly\b|no other|nothing else/i.test(row.text)) return 'exclusive network assurance';
    return null;
  });
for (const [duration_ms, expected] of [[0,'0 seconds'], [500,'0.5 seconds'], [1000,'1 second'], [59000,'59 seconds'], [60000,'1 minute'], [90000,'90 seconds'], [540000,'9 minutes']]) {
  check('runFacts preserves measured duration ' + duration_ms, () => S.runFacts({run:{agent:'Codex',duration_ms,minutes:99}}),
    out => out[1].text === `Used ${expected} of the lender’s Codex time, measured by Faravan.` ? null : 'duration rounded or ignored');
  check('receiptLines preserves measured duration ' + duration_ms, () => S.receiptLines({receipt:{duration_ms}}),
    out => out[0].text.startsWith(`Ran ${expected.replace(/minutes?$/, 'min')} in a new sandbox`) ? null : 'receipt duration rounded or ignored');
}
check('runFacts marks the model id as one identifier', () => S.runFacts({run:{agent:'Codex',model:'gpt-6-sol',effort:'medium'}}),
  out => out[0].text.includes('(`gpt-6-sol`, medium effort)') ? null : 'model id is not marked as code: ' + out[0].text);
for (const duration_ms of [undefined, null, -1, NaN, '1000']) check('runFacts rejects unknown measured duration',
  () => S.runFacts({run:{duration_ms}}), out => out[1].text === 'The agent time used isn’t known.' ? null : 'unknown duration became measured usage');

const exactCopy = (label, actual, expected) => check(label, () => actual,
  out => out === expected ? null : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(out)}`);
exactCopy('first-send disclosure copy', S.FIRST_SEND_COPY.visible,
  'The circle’s host and members can read what you send. The lender’s computer and its AI provider can access your request, code and data, and logs may keep copies of what the job sends and produces. A sandbox is meant to limit what a job can reach on the lender’s computer; it does not hide your code or job results from the lender, their provider or logs. Send only material you are allowed to share.');
exactCopy('first-send notice title', S.FIRST_SEND_COPY.title, 'Before your first job goes to a friend');
exactCopy('first-send notice body', S.FIRST_SEND_COPY.body,
  'Your job will run on your friend’s computer, inside a sandbox meant to limit what it can reach on that computer. It does not hide your code or the job’s results from your friend, their AI provider, or logs on that computer. The job uses your friend’s subscription, under their name with their AI provider.');
exactCopy('first-send Learn more copy', S.FIRST_SEND_COPY.learnMore,
  'A sandbox is a separate space on the lender’s computer where a job runs. It is meant to limit which files and programs the job can reach. The lender’s computer runs the job, so the lender, the AI provider tied to their account, and logs on that computer may receive or store the code the job sends and the results it produces. The job runs under the lender’s name with that provider and uses the lender’s subscription quota. Lending changes how quota is shared, not who can access job contents.');
exactCopy('join side-effect disclosure', S.JOIN_COPY.noSideEffect, 'Joining does not send a job or turn on lending.');
exactCopy('join disclosure heading', S.JOIN_COPY.heading, 'What this means');
exactCopy('join disclosure points', S.JOIN_COPY.points.join('\n'), [
  'Your friend’s jobs run on your computer, under your name with your AI provider, using your subscription.',
  'A sandbox is meant to limit what each job can reach on your computer.',
  'You, your AI provider, and logs on your computer can see what a job sends and produces.',
  'You pick how much to lend: automatic, a fixed share, or ask before each job.',
].join('\n'));
exactCopy('single-person invitation guidance', S.INVITATION_COPY.onePerson, 'Send the full link to one person for one computer.');
exactCopy('invitation audience disclosure', S.INVITATION_COPY.audience,
  'Invite only people who may access your circle’s shared requests, code and results. Jobs run on members’ computers and can be sent to AI providers and recorded in logs. Sending the invitation link only to selected people does not limit what recipients can see.');
exactCopy('settings data-sharing disclosure', S.DATA_SHARING_COPY,
  'Jobs share your source and instructions with the circle’s host and receiving members. The receiving computer’s AI provider can also access them, and logs or other copies may persist. Leaving a circle does not delete those copies. Review what you send.');
exactCopy('first-time lender disclosure', S.LENDING_ON_COPY,
  'Turning on lending lets a friend’s jobs run on your computer, using your subscription account under your name with your AI provider. A sandbox is meant to keep each job from reaching the rest of your computer, but it does not hide what a job sends or produces from you, your AI provider, or logs on your computer. You choose how much to lend: automatic, a fixed share, or ask before each job.');
exactCopy('strategy help lines', S.STRATEGY_HELP_COPY.join('\n'), [
  'Automatic: Lends only what the app estimates you probably will not use before your quota resets.',
  'Fixed share: By default, it lends up to 20% of your weekly quota and keeps 30% for your use.',
  'Ask before each job: You approve each job before it runs.',
  'Some people use all their quota on purpose, pacing themselves through the week. For them, fixed share may fit better than automatic.',
].join('\n'));
check('fixed-share help matches engine defaults', () => S.STRATEGY_HELP_COPY[1],
  out => out.includes('up to ' + LENDING_PARAMETERS.fixedSharePct.default + '%') &&
    out.includes('keeps ' + LENDING_PARAMETERS.keepPct.default + '%') ? null : 'default share or owner reserve is missing');
exactCopy('shared circle disclosure', S.circleDisclosure({circle:'Weekend projects', host:'Ana’s MacBook', lenders:['Mo’s MacBook']}),
  'Anyone lending in the circle “Weekend projects”, including members who join later, may take this job. Current lenders include Mo’s MacBook. The lender can inspect the code and data their computer receives. Their AI provider can also receive it, and logs or other copies may persist. The host, Ana’s MacBook, states job/result retention is 30 days. That does not remove copies held by lenders, providers or logs.');
exactCopy('local circle disclosure', S.circleDisclosure({circle:'My devices', networked:false}),
  'This circle is not shared with other circle members. A job run here can still send code and data to its AI provider and leave logs. Choose a member-hosted circle to share a job.');
exactCopy('borrower provider and log disclosure', S.borrowerDisclosure({route:['Ana'], hosted:false, attachments:1}),
  'Ana can read your request, your screenshot and the list of files. Whoever runs it gets the code and keeps a copy, and the circle’s server can read all of it. The runner’s AI provider can receive code and data, and logs or other copies may persist. Sandboxing does not keep your source confidential from these recipients. We ask you before anyone else sees it.');
exactCopy('lender sandbox and configured-check copy', S.safetyFacts({job:{maxMinutes:20}, adapter:{credentialInGuest:false,credentialProxyVerified:true}, boundaryVerified:true, lender:{deviceName:'MacBook'}}).facts
  .filter(fact => fact.icon === 'box' || fact.icon === 'shield').map(fact => fact.text).join('\n'), [
  'Runs in a new sandbox on your MacBook, starting with the submitted project files and required runtime resources. The sandbox is meant to limit the job’s access to your computer; it does not hide submitted code from you, the AI provider or logs.',
  'Before starting, the app runs its configured host and private-network access checks. Passing those checks does not cover every access path.',
].join('\n'));
exactCopy('unverified isolation footnote', S.overviewFacts().footnote,
  'Independent verification of these isolation controls is not available here. Treat isolation as a disclosed risk, not a promise. These controls do not hide source from the lender, provider or logs.');
exactCopy('overview sandbox and configured-check copy', S.overviewFacts().facts.find(fact => fact.icon === 'box').text,
  'Each job starts in a new sandbox with the submitted project files and required runtime resources. The sandbox is meant to limit access to the lender’s computer; it does not hide borrower source from the lender, provider or logs. The app runs configured host and private-network access checks before start.');
exactCopy('borrower preflight receipt copy', S.receiptLines({receipt:{egressEvidence:{'*':'unknown'},preflight:true},viewer:'borrower'})
  .find(line => line.text.startsWith('The lender reported')).text,
  'The lender reported that the configured host and private-network checks passed before start. This does not independently check isolation or source confidentiality.');
exactCopy('lender preflight receipt copy', S.receiptLines({receipt:{egressEvidence:{'*':'unknown'},preflight:true},viewer:'lender'})
  .find(line => line.text.startsWith('The configured host')).text,
  'The configured host and private-network checks passed before start; other access paths were not independently checked.');
const disclosedCopy = [S.FIRST_SEND_COPY.visible, S.FIRST_SEND_COPY.title, S.FIRST_SEND_COPY.body, S.FIRST_SEND_COPY.learnMore,
  S.JOIN_COPY.noSideEffect, S.JOIN_COPY.heading, ...S.JOIN_COPY.points, ...Object.values(S.INVITATION_COPY), S.DATA_SHARING_COPY, S.LENDING_ON_COPY, ...S.STRATEGY_HELP_COPY].join(' ');
check('new disclosures avoid absolute safety or confidentiality claims', () => disclosedCopy,
  out => /\b(?:safe|secure|guarantee|private)\b/i.test(out) ? 'contains a prohibited claim word' : null);

console.log(`${n - failed}/${n} cases pass`);
if (fails.length) { console.log(fails.slice(0, 20).join('\n')); process.exit(1); }

test('proxy copy does not claim that un-compared owner tokens are absent',()=>{
  const key=S.safetyFacts({adapter:{id:'claude-code-subscription',credentialInGuest:false,credentialProxyVerified:true}}).facts.find(f=>f.icon==='key');
  assert.match(key.text,/not compare.*(?:your|owner).*tokens/i);
  assert.match(S.overviewFacts({anyCredentialUnverified:false}).facts.find(f=>f.icon==='key').text,/not compare.*(?:your|owner).*tokens/i);
  assert.doesNotMatch(key.text,/sign-in stays outside/);
});
