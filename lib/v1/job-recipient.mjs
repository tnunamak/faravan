// A send binds a default choice before consent. Recheck that choice before transmitting anything.
import {opError} from './ops/errors.mjs';
import {projectMembership} from './membership-projection.mjs';
import {hostOffline} from './circle-host.mjs';
export const sendsJob = id => id === 'jobs.submit' || id === 'jobs.send_and_wait';
const error = (code, message, status = 400) => opError(code,status,message);
const choices = circles => circles.map(c => JSON.stringify(c.name ?? c.id)).join(', ') || '(none)';
const offlineWords = c => JSON.stringify(c.name ?? c.id) + ' isn’t answering' + (c.host?.lastReachedAt ? ' (last seen ' + c.host.lastReachedAt + ').' : '.');
const eligibleCircle = c => Boolean(c.origin) && projectMembership(c).phase === 'approved';
const eligibleCircles = circles => circles.filter(eligibleCircle);
// A circle whose host is known not to answer is never the default; a person can still name it.
function defaultCircle(circles) {
  const networked = eligibleCircles(circles);
  if (!networked.length) throw error('circle_required', 'You have no confirmed circle with a server yet. Join a circle and check approval before sending. Valid circles: ' + choices(circles) + '.');
  const answering = networked.filter(c => !hostOffline(c));
  if (!answering.length) throw error('circle_required', networked.map(offlineWords).join(' ') + ' Choose a circle by name, or send when its host is back.');
  const selected = answering.filter(c => c.selected === true);
  const matches = selected.length ? selected : answering;
  if (matches.length !== 1) throw error('circle_required', 'Choose a circle for this job. Valid circles: ' + choices(networked) + '.');
  return matches[0];
}
export function resolveJobRecipient(input, circles) {
  if (!Array.isArray(circles)) throw error('circle_required', 'The circle list is unavailable. Refresh Faravan and choose a circle.');
  if (input.expected_circle_id !== undefined && (input.circle !== input.expected_circle_id || !circles.some(c => c.id === input.expected_circle_id)))
    throw error('circle_changed', 'The recipient circle changed after consent. Review the send again. Valid circles: ' + choices(circles) + '.', 409);
  if (input.expected_default_circle !== undefined) {
    let current;
    try { current = defaultCircle(circles); } catch { /* no longer an unambiguous default */ }
    if (current?.id !== input.expected_default_circle || input.circle !== input.expected_default_circle)
      throw error('circle_changed', 'The default circle changed after consent. Review the send again. Valid circles: ' + choices(eligibleCircles(circles)) + '.', 409);
  }
  const matches = input.circle ? circles.filter(c => c.id === input.circle || c.name === input.circle) : [defaultCircle(circles)];
  if (matches.length !== 1) throw error('circle_required', 'Choose one existing circle by ID or unique name. Valid circles: ' + choices(circles) + '.');
  const circle = matches[0];
  if (projectMembership(circle).phase !== 'approved')
    throw error('circle_required', 'Membership in this circle is not confirmed. Check approval before sending. Valid circles: ' + choices(eligibleCircles(circles)) + '.');
  return {circle, input:{...input,circle:circle.id,expected_circle_id:circle.id,...(!input.circle ? {expected_default_circle:circle.id} : {})}};
}
// The default recipient: the circle this computer lends in when it can take jobs, else the last circle used.
export async function jobCircles(device, {lendingCircle = null} = {}) {
  const circles = await device.listCircles();
  let selected;
  try { selected = (await device.selectCircle()).id; } catch { /* resolve only a sole networked circle */ }
  const lending = circles.find(c => c.id === lendingCircle && eligibleCircle(c));
  if (lending) selected = lending.id;
  return circles.map(c => ({...c,selected:c.id === selected}));
}
