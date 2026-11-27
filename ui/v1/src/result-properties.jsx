import {agentProduct} from './helpers.mjs';
import {runDurationVM} from './view-models.mjs';
import {formatDate} from './dates.mjs';
export function ResultProperties({receipt,lender='',device='',ownRun=false,retention,zone}) {
 const duration=runDurationVM(receipt?.duration_ms);
 const rows=[['Agent',receipt?.harness?agentProduct(receipt.harness).name:null],
  ['Ran on',device || (ownRun?'Your computer':lender?lender+'’s computer':null)],
  ['Time used',duration?.long||null],
  ['Kept until',formatDate(retention?.retained_until,'dateClock',{zone})||null]];
 return <dl class="result-properties">{rows.filter(([,value])=>value).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
