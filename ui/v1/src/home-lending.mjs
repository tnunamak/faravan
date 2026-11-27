import {formatLendingProjection, lendingProjectionOf} from './lending-projection-view.mjs';

// Home summarizes prerequisites; restart recovery is actionable here and in Needs your attention.
export function homeLendingCardVM(vm) {
  const projection = lendingProjectionOf(vm);
  const projectedReason = vm.reason ?? formatLendingProjection(projection, {dailyFacts:vm.dailyFacts,circleName:vm.circleName}).reason;
  const items=vm.blockers?.items ?? [];
  const fixes=vm.blockers?.needsYou ?? [];
  const fix=fixes.find(item=>item.key==='lending'&&item.action==='Resume now') ?? fixes[0];
  if(projection.admissionReason==='platform_unsupported'||projection.intent==='paused')return {reason:projectedReason,action:null,showSwitch:Boolean(vm.switch)};
  if(fix?.key==='lending'&&fix.action==='Resume now')return {
    reason:projectedReason,action:fix,showSwitch:false,
  };
  if(fix){
    return {reason:projectedReason,action:null,showSwitch:false};
  }
  const waiting=items.find(item=>item.key!=='lending'&&!['ok','off'].includes(item.status));
  if(waiting)return {reason:projectedReason,action:null,showSwitch:false};
  if(projection.intent==='off')return {reason:projectedReason,action:{key:'lending',action:'Turn lending on'},showSwitch:false};
  return {reason:projectedReason,action:null,showSwitch:Boolean(vm.switch)};
}

/** Intent is not execution: Off does not certify that an active job has stopped. */
export function homeLendingSummary(vm) {
  const projection=lendingProjectionOf(vm);
  const headline=vm.headline.replace(/^Lending is /,'Lending ');
  const active=['starting','running','finishing','stopping'].includes(projection.execution);
  if(!active)return headline;
  const execution=projection.execution==='stopping'?'Job stopping':headline;
  const intent=projection.intent==='off'?'Lending off':projection.intent==='on'?'Lending on':null;
  return intent ? intent+' · '+execution : execution;
}
