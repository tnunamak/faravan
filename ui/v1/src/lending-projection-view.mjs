import {lendingReasonCode} from '../../../lib/v1/lending-reasons.mjs';
import {createLendingProjection, projectLendingState} from '../../../lib/v1/state-projection.mjs';
import {formatLendingProjection as formatShared} from '../../../lib/v1/lending-summary.mjs';
import {formatDate} from './dates.mjs';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The single UI boundary for lending domain state. V2 is authoritative; old API
 * responses are adapted here until all stored fixtures and clients have moved. */
export function lendingProjectionOf(status = {}) {
  if (!isRecord(status)) return projectLendingState(null);
  if (Object.hasOwn(status, 'lendingProjection')) return createLendingProjection(status.lendingProjection);

  const lending = isRecord(status.lending) ? status.lending : status;
  const legacyStatus = lending.status ?? status.status;
  const rawReason=status.intent?.reason??status.reason??lending.reason;
  const legacyReason=rawReason?lendingReasonCode(rawReason):null;
  const stateFromStatus = ({
    idle: 'ready', paused: ['daily_limit','no_spare','owner_active'].includes(legacyReason) ? 'resting' : 'paused',
    daily_limit: 'resting', no_spare: 'resting', owner_active: 'resting',
    outside: 'outside', resting: 'resting', blocked: 'blocked', starting: 'starting', update: 'update', off: 'off',
    contributing: 'ready', running: 'ready', 'sending-result': 'ready', pausing: 'ready', stopping: 'ready',
  })[legacyStatus];
  const stateFromReason = ({paused:'paused',daily_limit:'resting',no_spare:'resting',owner_active:'resting'})[legacyReason] ??
    (legacyReason ? 'blocked' : undefined);
  const legacyPaused = lending.paused === true && Boolean(lending.circle);
  const legacyState = status.intent?.state ?? status.state ?? lending.state ?? stateFromStatus ?? stateFromReason ??
    (legacyPaused ? 'paused' : lending.enabled === false ? 'off' : undefined);
  const intent = status.intent && typeof status.intent.on === 'boolean'
    ? {...status.intent}
    : {on: legacyPaused ? true : status.intent === 'off' || legacyState === 'off' || lending.enabled === false ? false :
      legacyState == null && lending.enabled !== true ? null : true,
      state: legacyPaused ? 'paused' : legacyState, reason: legacyReason};
  if (intent.on === false && intent.state !== 'off') intent.state = 'off';
  const current = status.currentJob ?? lending.current;
  const execution = isRecord(status.execution) ? status.execution
    : current == null && legacyState != null ? {state: 'idle'} : {state: 'unknown'};
  const today = status.today ?? {};
  const jobsCapped = Number.isFinite(today.jobs) && Number.isFinite(today.jobLimit) && today.jobs >= today.jobLimit;
  const minutesCapped = Number.isFinite(today.minutes) && Number.isFinite(today.minuteLimit) && today.minutes >= today.minuteLimit;
  const cap = legacyReason === 'daily_limit' || jobsCapped || minutesCapped;
  const legacyAdmissionKnown = ['idle','ready'].includes(legacyStatus) || legacyState === 'ready';
  const dailyLimitReached = cap ? true : Number.isFinite(today.jobs) && Number.isFinite(today.jobLimit) ||
    Number.isFinite(today.minutes) && Number.isFinite(today.minuteLimit) || legacyAdmissionKnown && legacyReason == null ? false : null;
  return projectLendingState({effective: {intent, execution, version: null}, dailyLimitReached});
}

/** One vocabulary for Home, shell, and Lending: the shared formatter (lib/v1/lending-summary.mjs), with this page's clock. */
export const formatLendingProjection = (projection, options = {}) =>
  formatShared(projection, {formatClock: ms => formatDate(ms, 'clock'), ...options});

/**
 * What joining a circle does to lending, from the projection only (dot UI review P2). The saved choice is not
 * permission to start: a paused, off or unconfirmed projection never reads as "already on", whatever older fields say.
 */
export function joinLendingNote(status = {}, {surface = 'join'} = {}) {
  const p = lendingProjectionOf(status);
  if (p.intent === 'on') return surface === 'fresh'
    ? 'Lending is set to on. Once you join, this computer uses your saved limits.'
    : 'Lending is set to on. Once you join, this computer uses your saved limits.';
  if (p.intent === 'paused') return 'Lending is paused. Joining does not resume it.';
  if (p.intent === 'off') return surface === 'fresh'
    ? 'Lending is optional. You can set this computer up to help others later, from Lending.'
    : 'Joining does not turn lending on.';
  return 'Joining does not change your lending setting.';
}
