import {TELEMETRY_COPY} from '../../../lib/v1/telemetry/copy.mjs';
const LEVELS = ['on', 'off'];
export function selectedLevel(view, asked = null) {
  if (LEVELS.includes(asked)) return asked;
  if (LEVELS.includes(view?.level)) return view.level;
  return view?.reason?.kind === 'default' && view.effective === 'on' ? 'on' : null;
}
export function envLine(view) {
  return view?.reason?.kind === 'env' && typeof view.reason.env === 'string' ? TELEMETRY_COPY.settings.offBecause(view.reason.env) : null;
}
export function privacyCardModel(view, {asked = null} = {}) {
  const copy = TELEMETRY_COPY.settings, selected = selectedLevel(view, asked), env = envLine(view);
  return {
    title:copy.title,intro:copy.intro,readers:copy.readers,links:copy.links,retention:copy.retention,turnOff:copy.turnOff,
    unavailable:view?.uploadable === false ? copy.unavailable : null,envLine:env,disabled:env!==null,selected,
    recordings:{label:copy.recordings.label,detail:copy.recordings.detail,checked:view?.recordings===true && selected==='on',disabled:selected!=='on'},
    choices:copy.choices.map(choice=>({...choice,checked:choice.level===selected})),
  };
}
export function firstRunShown(view) { return view?.notice?.pending === true && view?.uploadable !== false; }
export function firstRunModel(view) {
  const copy=TELEMETRY_COPY.firstRun,unavailable=view?.uploadable === false;
  return {show:firstRunShown(view),recordsNotice:!unavailable,body:copy.body,link:copy.link,linkHref:copy.linkHref,close:copy.close,preview:copy.preview,
    unavailable:unavailable?copy.unavailable:null,where:copy.unavailableWhere};
}
export function stateSentence(view) {
  const env=envLine(view);if(env)return env;
  const choice=TELEMETRY_COPY.settings.choices.find(item=>item.level===(view?.effective==='on'?'on':'off'));
  return choice.label+'. '+choice.detail;
}
export const chooseBody = level => ({level});
export const recordingsBody = on => ({recordings:on === true});
