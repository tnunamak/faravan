// Pool unit tests replace only the lender loop. Facts are refreshed asynchronously; admits stays read-only
// and synchronous, as the production worker's admission memo does.
export function poolFactCache(policy){
 let reason='lender_starting';
 return {get reason(){return reason;},async refresh(job=null){
  const facts=await policy.observeLending(job);
  reason=facts.enabledNow===false?'lending_off':facts.waits[0]?.reason??null;
  return facts;
 }};
}
