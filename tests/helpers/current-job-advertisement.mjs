// Synthetic account metadata for protocol/store transport tests; no credentials or provider calls.
import {resolveSelection} from '../../lib/v1/run-request.mjs';
import {RUN_REQUEST_CAPABILITY} from '../../lib/v1/versions.mjs';
export function currentAdvertisement(advertisement,accounts=null) {
  return {...advertisement,capabilities:[...new Set([...advertisement.capabilities,RUN_REQUEST_CAPABILITY])],
    accounts:accounts??[{accountId:'protocol-test-account',providerId:'codex',models:advertisement.models.map(id=>({id,enabled:true,efforts:[],defaultEffort:null}))}]};
}
export function accountHeartbeat(advertisement) {
  return {seq:Date.now(),intent:{state:'ready'},execution:{state:'idle'},blockers:[],agents:[],capabilities:[RUN_REQUEST_CAPABILITY],accounts:advertisement.accounts};
}
export function selectionForJob(job,advertisement) {
  const selected=resolveSelection({runRequest:job.runRequest,accounts:advertisement.accounts});
  if(!selected.ok)throw new Error('Synthetic account cannot run fixture job: '+selected.code);
  return selected.value;
}
export function currentReceipt(receipt,selection) {
  return {...structuredClone(receipt),selection,capabilities_applied:[...new Set([...receipt.capabilities_applied,RUN_REQUEST_CAPABILITY])]};
}
