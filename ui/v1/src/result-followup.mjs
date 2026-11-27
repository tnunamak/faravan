import {problemResult} from './problem-catalog.mjs';
// Keep one draft preparation path for normal follow-ups, line notes and question answers.
export function saveFollowupRequest({prepare,save,storage,circle,continuation,request=''}) {
  const delta=typeof request==='string'?request.trim():'';
  if(!delta)return problemResult('followup_empty');
  if(delta.length>16000)return problemResult('followup_too_long');
  const prepared=prepare(storage,circle,continuation);
  if(!prepared.ok)return prepared;
  const draft={...prepared.draft,prompt:delta};
  save(storage,circle,draft);
  return {...prepared,draft};
}
