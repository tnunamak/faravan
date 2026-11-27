import {newDraftFromJob} from './compose-draft.mjs';
// A new request reuses source choices, while a continuation uses the previous result as its base.
export function resendResultDraft({current,job,prompt,sourceFolder=''}) {
  if(current?.sending)throw new Error('An earlier send is still waiting for an answer. Open New job to check it.');
  return newDraftFromJob(job,{prompt:typeof prompt==='string'?prompt:'',path:sourceFolder});
}
export const RESELECT_FILES_LINE = 'Choose the files again before sending this job.';
export const SOURCE_UNKNOWN_LINE = 'Choose what to send again. Faravan could not tell what this job used.';
