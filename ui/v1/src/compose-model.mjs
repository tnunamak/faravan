import {validRunRequest, defaultRunRequest} from './compose-draft.mjs';
import {membershipProjectionFor} from './membership-projection-view.mjs';
import {circlePhrase} from './safety-copy.mjs';
import {hostOffline} from '../../../lib/v1/circle-host.mjs';

// A composer can send only to a networked circle whose membership is ready.
export const sendableCircles = circles => (circles ?? []).filter(c => c.origin && membershipProjectionFor(c).phase === 'approved');
// The default skips a circle whose host is known not to answer while another can take the job (job-recipient.mjs);
// a circle the person picked on this page stays picked, and a lone offline circle stays chosen with its offline banner.
export function composeCircle(circles, last, current, {explicit = false} = {}) {
  const sendable = sendableCircles(circles);
  if (explicit && sendable.some(c => c.id === last)) return last;
  const answering = sendable.filter(c => !hostOffline(c)), available = answering.length ? answering : sendable;
  return available.find(c => c.id === last)?.id || available.find(c => c.id === current)?.id || available.find(c => c.selected)?.id || available[0]?.id || '';
}
// Local adapter installation is not evidence of what another computer lends.
// `here` is true when this computer is one of the lenders that offer the agent now. It is a snapshot, not routing:
// any computer that offers the agent when the job is picked up can take it.
export function circleAgents(state) {
  const byId = new Map();
  for (const lender of state?.lenders ?? []) for (const agent of lender.agents ?? []) {
    const adapter = agent.adapter ?? agent.id;
    const id = ['claude','claude-code','claude-code-subscription','claude-code-api-key'].includes(adapter) ? 'claude-code' : adapter;
    if (!['claude-code','codex'].includes(id) || agent.readiness !== 'ready') continue;
    const effort = agent.run?.effort ?? agent.effort ?? null;
    const existing = byId.get(id), here = lender.self === true || Boolean(existing?.here);
    byId.set(id, {id, effort: existing && existing.effort !== effort ? null : effort, here});
  }
  return [...byId.values()];
}
// A lender takes jobs now only in these states; paused, outside its hours, resting, blocked or updating it does not.
// A lender row with no state comes from an older app and is counted as taking jobs.
const TAKING_JOBS = ['ready', 'starting'];
export const takingJobs = lender => !lender.state || TAKING_JOBS.includes(lender.state);
// Why the Agent list is empty, and what to do. Null while the list has agents or the lenders are unknown
// (a failed or pending read has its own banner).
// A job sent with Agent on "Let the lender choose" waits in the circle. A job with a chosen agent that no lender has
// ready is refused before it is sent (agent_unavailable), so only the first is promised to wait.
export function noAgentReason(state, circleName) {
  if (!Array.isArray(state?.lenders) || circleAgents(state).length) return null;
  const circle = circlePhrase(circleName);
  if (!state.lenders.length) {
    return {why: `No computer in ${circle} is lending right now, this one included, so no agent can take this job.`,
      next: 'Turn on lending here to run it on this computer, or add your other computer or invite someone.',
      actions: [{label: 'Lend from this computer', href: '#/lend'}, {label: 'Invite someone', href: '#/circles'}]};
  }
  const why = state.lenders.some(takingJobs)
    ? `No computer lending in ${circle} has an agent ready right now, so no agent can take this job.`
    : `Every computer that lends in ${circle} is paused, outside its hours or not taking jobs right now, so no agent can take this job.`;
  return {why,
    next: 'With Agent on “Let the lender choose”, you can still send, and the job waits for a computer to take it. To run it on this computer, open Lend and choose an agent, or sign it in.',
    actions: [{label: 'Open Lend', href: '#/lend'}]};
}

// Model and Effort come only from the pairs the circle's lenders offer now (state.offers). Blank means "Let the lender choose".
// A chosen model waits for its effort, so Send is off until one is chosen.
export const offeredModels = (offers, agent) => [...new Set((offers ?? []).filter(o => o.harness === agent).map(o => o.model))];
export const offeredEfforts = (offers, agent, model = '') => [...new Set((offers ?? []).filter(o => o.harness === agent && (!model || o.model === model)).map(o => o.effort))];
// What a blank Model and Effort will run: the first offer, in the lenders' order, which the lender saved as its first choice.
// The screen only repeats that offer; it computes no rank or price. Empty when nothing is offered for the agent.
export function lendersChoice(offers, agent) {
  const first = (offers ?? []).find(o => o.harness === agent);
  return first ? `Lender’s choice: ${first.model} · ${first.effort} effort` : '';
}
export function lendersAccountChoice(accountOffers) {
  const first = accountModels(accountOffers)[0];
  if (!first) return '';
  // A blank effort runs at the model's default, which is medium when offered and otherwise none.
  return `Lender’s choice: ${first.modelId}${first.effortIds.includes('medium') ? ' · medium effort' : ''}`;
}
export function choiceOffered(offers, {agent = '', model = '', effort = ''} = {}) {
  return (!model && !effort) || (offers ?? []).some(o => o.harness === agent && (!model || o.model === model) && (!effort || o.effort === effort));
}
// Changing the agent or the model keeps the other choices only while the circle still offers them.
export function keepOffered(offers, {agent = '', model = '', effort = ''} = {}) {
  const nextModel = model && offeredModels(offers, agent).includes(model) ? model : '';
  const nextEffort = effort && offeredEfforts(offers, agent, nextModel).includes(effort) ? effort : '';
  return {model: nextModel, effort: nextEffort};
}

export const createdJobVM = (response, draft, circle) => ({
  ...response, job_digest:response.jobDigest, circle, prompt:draft.prompt.trim(), title:draft.prompt.trim(),
  submittedByMe:true, status:'Waiting', state:'queued',
});


// Select values encode the pair, never just a model ID shared by providers.
export const accountModelKey = m => JSON.stringify([m.providerId,m.modelId]);
export const accountModels = offers => [...new Map((offers ?? []).filter(o =>
  typeof o?.providerId === 'string' && typeof o?.modelId === 'string' && Array.isArray(o.effortIds))
  .map(o => [accountModelKey(o),o])).values()];
export function accountEfforts(offers, request) {
  return [...new Set((offers ?? []).filter(o => request?.models === 'any' ||
    request?.models?.some(m => accountModelKey(m) === accountModelKey(o)))
    .flatMap(o => o.effortIds ?? []))];
}
export function signedRequestBlocker(state, draft, {recovering=false} = {}) {
  const signed = draft.requestMode === 'signed' || (!draft.requestMode && state?.runRequestSupported === true);
  if (!signed) return draft.requestMode === 'legacy' || state?.runRequestSupported === false ? '' : 'Confirming host request support. Nothing has been sent.';
  if (state?.readStatus !== 'ready' || state?.runRequestSupported !== true) return 'The host cannot confirm support for this saved request. It will not be sent as a legacy request.';
  const request = draft.runRequest ?? defaultRunRequest();
  if (!validRunRequest(request)) return 'The saved request is malformed. Reopen the saved draft before sending.';
  if (recovering) return '';
  const offers = accountModels(state.accountOffers);
  const matches = (m,o) => accountModelKey(m) === accountModelKey(o) &&
    (request.effortId === null || o.effortIds.includes(request.effortId));
  const available = request.models === 'any'
    ? request.effortId === null || offers.some(o => o.effortIds.includes(request.effortId))
    : request.models.every(m => offers.some(o => matches(m,o)));
  return available ? '' : 'The selected provider, model or effort is unavailable. Choose another option before sending.';
}
