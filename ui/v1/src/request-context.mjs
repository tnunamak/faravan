// Display-only projection of the signed continuation prompt. Never write the projection back to the job.
import {CONTEXT_HEADER as HEADER, DELTA_HEADER as DELTA} from '../../../lib/v1/request-line.mjs';
export function requestContextVM(prompt = '') {
  if (!prompt.startsWith(HEADER)) return {instruction:prompt};
  const split = prompt.indexOf(DELTA, HEADER.length);
  // A recognized envelope must never leak its wire representation into the reading surface.
  const result = {instruction:split < 0 ? 'The follow-up instruction couldn’t be read. Ask the sender to send it again.' : prompt.slice(split + DELTA.length), followup:true, title:'an earlier job', unavailable:true};
  if (split < 0) return result;
  let context;
  try { context = JSON.parse(prompt.slice(HEADER.length, split)); } catch { return result; }
  if (context?.schema !== 'faravan.continuation.v1' || context.mode !== 'summary' || context.trust !== 'untrusted') return result;
  const objective = typeof context.objective === 'string' ? context.objective : '';
  const title = objective.trim().split('\n')[0].replace(/^#+\s*/, '');
  return {...result, unavailable:false, title:title.length > 100 ? title.slice(0, 100).replace(/\s+\S*$/, '') + '…' : title || result.title,
    objective, latest:typeof context.latest_instruction === 'string' ? context.latest_instruction : '',
    checks:(Array.isArray(context.observed_checks) ? context.observed_checks : []).filter(check => typeof check?.cmd === 'string').map(check => ({
      cmd:check.cmd, result:check.timed_out === true ? 'Timed out' : check.exit === 0 ? 'Passed' : Number.isInteger(check.exit) ? 'Failed (exit ' + check.exit + ')' : 'Outcome not recorded',
    })), withheld:context.scan?.status === 'withheld'};
}
// Recognized continuation envelopes must be readable before approval, not just nonempty on the wire.
export function requestContextReady(context) {
  return Boolean(context?.instruction?.trim()) && (!context.followup || (!context.unavailable && !context.withheld));
}
export function requestProjectVM(card, source, followup) {
  if (card.source?.kind === 'none') return {label:'Project', value:'No project · prompt only'};
  if (followup) return {label:'Source', value:card.source?.kind || card.sourceManifest || card.job?.source_manifest || card.job?.source || card.projectName
    ? 'Source files for this follow-up'
    : 'Source details unavailable. Ask the sender to confirm the files before approving.'};
  const manifest=card.sourceManifest || card.job?.source_manifest;
  const projectName=manifest?.project_name || card.job?.source?.project_name || card.projectName;
  if(projectName)return {label:'Project',value:String(projectName)};
  const value = source.replace(/^Uploaded files( · )?/, '');
  return {label:card.source?.kind === 'git' ? 'Project' : 'Source', value:card.source?.kind === 'git' ? value : 'Files sent with the job' + (value ? ' · ' + value : '')};
}
