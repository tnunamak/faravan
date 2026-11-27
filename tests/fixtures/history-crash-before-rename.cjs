const fs = require('node:fs');
const realRename = fs.renameSync;
fs.renameSync = (from,to) => {
  if (to.endsWith('lending-history-claude.json')) {
    process.send('ready');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  }
  return realRename(from,to);
};
(async () => {
  const {createLocalLendingHistoryAdapter}=await import('../../lib/v1/lending-history-import.mjs');
  const start=Date.parse('2026-10-01T00:00:00Z'),end=start+7*24*60*60*1000;
  const adapter=createLocalLendingHistoryAdapter({homeDir:process.env.HOME,now:()=>end+1000});
  adapter.writeImportedScores([{resource:'claude:seven_day',account_week_id:end,week_start:start,score:2,censored:false,source:'import',coverage_ratio:1}],[],[]);
})().catch(error=>{process.send({error:error.message});process.exitCode=1;});
