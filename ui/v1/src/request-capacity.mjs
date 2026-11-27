import {todayCounts} from './helpers.mjs';
import {formatDate} from './dates.mjs';
import {projectRequestAdmission,validateRequestAdmission} from '../../../lib/v1/request-admission.mjs';
import {createLendingProjection} from '../../../lib/v1/state-projection.mjs';
import {formatLendingProjection, lendingProjectionOf} from './lending-projection-view.mjs';

const unknown = () => ({schemaVersion:2,kind:'request-admission',admission:'unknown',reasonCode:'invalid_projection',evidence:{jobCap:null,minuteCap:null}});
const projectionText = (projection, usage) => {
  if (projection.admission === 'unknown') return 'We can’t confirm whether this computer can run this request. Refresh this request before you run it.';
  if (projection.admission !== 'blocked') return '';
  const {jobCap,minuteCap}=projection.evidence;
  const reasons=[];
  if(jobCap && jobCap.used>=jobCap.limit) reasons.push(`You've run ${jobCap.used} of ${jobCap.limit} jobs today.`);
  if(minuteCap && minuteCap.used>=minuteCap.limit) reasons.push("You've reached today's minute limit.");
  else if(projection.reasonCode==='request_does_not_fit') reasons.push("This request doesn't fit today's minute limit.");
  if(!reasons.length && usage?.jobs>=usage?.jobLimit) reasons.push(`You've run ${usage.jobs} of ${usage.jobLimit} jobs today.`);
  if(!reasons.length) reasons.push("You've reached today's lending limit.");
  return reasons.join(' ')+' Other lenders can take this one.';
};

// Only the lender's explicit projection says "Done for today" for this rule. Counters never do: a card's admission beats
// counter-derived status (request.test.mjs), and only an explicit projection is shown as the same page's headline.
const explicitlyDoneForToday = home => Object.hasOwn(home ?? {}, 'lendingProjection') &&
  formatLendingProjection(lendingProjectionOf(home)).headline === 'Done for today';

// Compatibility boundary for old API fixtures only. Explicit card admission is
// always authoritative and can never fall through to conflicting counters, except
// for the lender's own "Done for today" (below).
export function requestCapacity(home = {}, lending = {}, now = Date.now(), card = {}) {
  let projection, usage=null, lendingBlockedReason=null;
  if (Object.hasOwn(card ?? {}, 'requestAdmission')) {
    projection=validateRequestAdmission(card.requestAdmission);
  } else if (Object.hasOwn(home ?? {}, 'lendingProjection')) {
    const lendingProjection=home.lendingProjection;
    if (!lendingProjection || lendingProjection.schemaVersion !== 2 || lendingProjection.kind !== 'lending' ||
        !['allowed','blocked','unknown'].includes(lendingProjection.admission)) projection=unknown();
    else {
      const validated=createLendingProjection(lendingProjection);
      if(validated.admission==='unknown') projection=unknown();
      else if (validated.admission === 'blocked') {
        if(validated.admissionReason==='daily_limit') projection={schemaVersion:2,kind:'request-admission',admission:'blocked',
          reasonCode:'minute_cap_reached',evidence:{jobCap:null,minuteCap:null}};
        else lendingBlockedReason=validated.admissionReason;
      } else projection={schemaVersion:2,kind:'request-admission',admission:'allowed',reasonCode:null,evidence:{jobCap:null,minuteCap:null}};
    }
  } else {
    // Legacy adapter: retain local-day normalization and the server's exact
    // millisecond + signed wall_seconds comparison while old fixtures migrate.
    const today=home?.today, use=todayCounts(lending,new Date(now));
    usage=today ?? (use && {jobs:use.jobs,jobLimit:use.max,minutes:use.minutes,minuteLimit:use.maxMinutes});
    const zone=lending?.limits?.timeZone;
    const day=formatDate(now,'dayKey',zone?{zone}:{});
    const counters=lending?.counters;
    const milliseconds=counters?.day===day?(counters.milliseconds??0):0;
    const wallSeconds=card?.job?.requirements?.limits?.wall_seconds ?? (card?.job===undefined?0:undefined);
    // Keep the historical no-usage behavior, while malformed supplied data
    // fails closed through the same pure projector used by the server.
    projection=projectRequestAdmission({usage,accountedMilliseconds:milliseconds,
      dailyMinutes:Number.isSafeInteger(lending?.limits?.dailyMinutes)?lending.limits.dailyMinutes:null,wallSeconds,now});
    if(home?.intent?.reason==='daily_limit'||lending?.reason==='daily_limit') {
      projection={schemaVersion:2,kind:'request-admission',admission:'blocked',reasonCode:'minute_cap_reached',evidence:projection.evidence};
    }
  }
  // The card's admission and the lender's status are read at different moments, so an admitting card is overruled while the
  // same page says the lender is done for today. Run it is then never enabled beside "Done for today" (I08).
  if (!lendingBlockedReason && projection.admission==='allowed' && explicitlyDoneForToday(home)) projection={schemaVersion:2,kind:'request-admission',admission:'blocked',reasonCode:'minute_cap_reached',evidence:projection.evidence};
  const admission=lendingBlockedReason?'blocked':projection.admission;
  const reasonCode=lendingBlockedReason??projection.reasonCode;
  const capped=admission==='blocked' && ['job_cap','minute_cap_reached','request_does_not_fit'].includes(reasonCode);
  const canRun=admission==='allowed';
  const text=admission==='unknown' ? projectionText(projection,usage) : capped ? projectionText(projection,usage) :
    admission==='blocked' ? ({off:'Lending is off. Review Lending settings.',paused:'Lending is paused. Review Lending settings.',sandbox_not_ready:'Sandbox protection is not ready. Open Setup to review the required checks.'}[reasonCode] || 'This computer can’t run requests right now. Review Lending settings for its status.') : '';
  return {capped,canRun,admission,reasonCode,text};
}
