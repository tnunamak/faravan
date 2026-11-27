import {membershipProjectionOf} from '../../../lib/v1/membership-projection.mjs';
import {safeName} from './safe-name.mjs';
import {circlePhrase} from './safety-copy.mjs';

export const membershipProjectionFor = membershipProjectionOf;

/** Shared membership facts and the only formatter for join/membership copy. */
// `checking` means this computer is asking the host right now: a pending answer is not known yet (I16), so the
// banner says so instead of "Waiting for … to approve".
export function formatMembership(circle, {surface = 'status', name: givenName, owner: givenOwner, checking = false} = {}) {
  const projection = membershipProjectionFor(circle);
  const phase = projection.phase;
  const name = circlePhrase(safeName(givenName ?? circle?.name, ''));
  const owner = safeName(givenOwner ?? circle?.joinInfo?.ownerName, '');
  const invitation = projection.invitationPolicy;
  const joinUnknown = circle?.joinIntent?.outcome === 'unknown';
  const retryMessage = 'Couldn’t reach the host. Faravan will retry this join.';
  const pendingStatus = invitation === 'each' ? 'Waiting for approval' :
    invitation === 'automatic' ? 'Waiting for host' : 'Membership pending';
  const pendingMessage = invitation === 'each'
    ? 'Request sent. Waiting for ' + (owner || 'the owner') + ' to approve this computer.'
    : invitation === 'automatic'
      ? 'Request sent. ' + (owner ? owner + '’s' : 'The host’s') + ' computer adds this one when it is online.'
      : 'This computer is waiting for its membership to be confirmed.';

  if (surface === 'onboarding') return {
    phase, joined: phase === 'approved', waiting: phase === 'pending' || phase === 'unknown' && joinUnknown,
    turn: phase === 'unknown' && joinUnknown ? retryMessage : phase !== 'pending' ? '' : invitation === 'each'
      ? 'Waiting for ' + (owner || 'the circle’s owner') + ' to let this computer in'
      : invitation === 'automatic'
        ? 'Waiting for ' + (owner ? owner + '’s computer' : 'the host’s computer') + ' to come online'
        : 'This computer is waiting for its membership to be confirmed',
  };

  if (surface === 'outcome') {
    if (phase === 'approved') return {phase, joined: true, closeForm: true, message: 'You joined ' + name};
    if (phase === 'pending') return {phase, joined: false, closeForm: false, message: pendingMessage};
    if (phase === 'expired') return {phase, joined: false, closeForm: false,
      message: 'This invitation has expired. Ask ' + (owner || 'the person who invited you') + ' for a new one.'};
    if (phase === 'rejected') return {phase, joined: false, closeForm: false,
      message: 'This computer was not added to ' + name + '. Ask ' + (owner || 'the person who invited you') + ' for a new invitation.'};
    return {phase, joined: false, closeForm: false, waiting:joinUnknown,
      message:joinUnknown?retryMessage:'Membership is not confirmed yet. Refresh this circle to check its status.'};
  }

  if (surface === 'banner') {
    if (phase === 'approved') return {phase, joined: true, waiting: false, message: 'You joined ' + name};
    if (phase === 'pending') return {phase, joined: false, waiting: true, message: checking
      ? 'Checking whether ' + (owner || 'the owner of ' + name) + ' approved this computer…' : pendingMessage};
    if (phase === 'expired') return {phase, joined: false, waiting: false,
      message: 'This invitation has expired. Ask ' + (owner || 'the person who invited you') + ' for a new one.'};
    if (phase === 'rejected') return {phase, joined: false, waiting: false,
      message: 'This computer was not added to the circle. Ask ' + (owner || 'the person who invited you') + ' for a new invitation.'};
    return {phase, joined: false, waiting: joinUnknown,
      message:joinUnknown?retryMessage:'This computer’s membership is not confirmed. Refresh to check its status.'};
  }

  if (surface === 'join-status') {
    if (phase === 'approved') return {waiting:false, message:'This computer is a member.', code:null};
    if (phase === 'expired') return {waiting:false, expired:true,
      message:'This invitation has expired. Ask '+(owner||'the person who invited you')+' for a new one.', code:null};
    if (phase === 'rejected') return {waiting:false, terminal:true,
      message:'This computer was not added to the circle. Ask '+(owner||'the person who invited you')+' for a new invitation.', code:null};
    if (phase === 'pending' && invitation === 'each') return {waiting:true,
      message:'Waiting for '+(owner||'the owner of '+name)+' to approve this computer', code:circle?.joinInfo?.code||null};
    if (phase === 'pending' && invitation === 'automatic') return {waiting:true,
      message:"The owner's computer approves new computers when it is online. This one is not in the circle yet.", code:null};
    if (phase === 'pending') return {waiting:true,
      message:'This computer is waiting for its membership to be confirmed.', code:null};
    return {waiting:joinUnknown, message:joinUnknown?retryMessage:'This computer’s membership is not confirmed. Refresh to check its status.', code:null};
  }

  return {
    phase,
    joined: phase === 'approved',
    status: phase === 'pending' ? pendingStatus : phase === 'expired' ? 'Invitation expired' :
      phase === 'rejected' ? 'Not joined' : phase === 'unknown' ? 'Membership unknown' : '',
    waiting: phase === 'pending' || phase === 'unknown' && joinUnknown,
  };
}
