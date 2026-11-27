import './no-browser.mjs';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {lendingMeterJobId} from '../../lib/docker-backend.mjs';
import {barrier} from './crash-process.mjs';
import {fileSbx,receiptBackend,receiptJob} from './sandbox-receipt-fixture.mjs';

const [root,scenario]=process.argv.slice(2);
// The test home helper clears an inherited sbx home, so this child names its own, as the parent test does.
process.env.FARAVAN_SBX_HOME=join(root,'sbx-home');process.env.FARAVAN_SCRATCH_ROOT=join(root,'scratch');
const job=receiptJob();
if(scenario==='two-dispatches') {
  const sbx=fileSbx(join(root,'sbx')),backend=receiptBackend(root,sbx),names=[];
  for(let n=0;n<2;n++) {
    try {names.push((await backend.prepare(job)).sandbox_id);}
    catch(error){names.push('error:'+(error.code??error.message));}
  }
  writeFileSync(join(root,'prepared.json'),JSON.stringify(names));
  await barrier('prepared','prepared');
} else if(scenario==='check-git-created'||scenario==='check-git-reserved') {
  // The git helper a check run starts: its own job identity and dispatch row.
  const sbx=fileSbx(join(root,'sbx')),check=receiptJob({job_id:job.job_id+'-check-git',image:'wf-gh-cli'});
  if(scenario==='check-git-reserved') {
    // The first await after the synchronous reservation: die before any create.
    const backend=receiptBackend(root,sbx,{hostDisk:{free:async()=>{await barrier('reserved','reserved');return {free:2**40};}}});
    await backend.prepare(check);
  } else {
    const handle=await receiptBackend(root,sbx).prepare(check);
    writeFileSync(join(root,'check-git.json'),JSON.stringify({name:handle.sandbox_id}));
    await barrier('created','created');
  }
} else if(scenario==='redispatch-live') {
  // The first dispatch of the job returns; the second materializes and the
  // process dies before its create command returns.
  let second=false;
  const sbx=fileSbx(join(root,'sbx'),{create:async(name,args,options,{materialize})=>{
    if(!second)return {code:0};
    materialize();
    writeFileSync(join(root,'second.json'),JSON.stringify({name}));
    await barrier('dispatched','dispatched');
    await new Promise(()=>{});
  }});
  const backend=receiptBackend(root,sbx);
  const first=await backend.prepare(job);
  writeFileSync(join(root,'first.json'),JSON.stringify({name:first.sandbox_id}));
  second=true;
  await backend.prepare(job).catch(error=>writeFileSync(join(root,'second.json'),JSON.stringify({error:error.code??error.message})));
  await new Promise(()=>{});
} else if(scenario==='five-targets') {
  // The main create succeeds. Each other target's create materializes and then its CLI fails with
  // a daemon timeout, except the last one, which the process dies in. Creates of one store run one at a
  // time (the store gate is held across a create), so the targets reach their create one after another.
  // No target receipt exists for any of them.
  let waiting=0;
  const hang=new Set([job.job_id+'-git',job.job_id+'-check',job.job_id+'-check-git',lendingMeterJobId('attempt-receipt')]);
  const jobOf=new Map();
  const sbx=fileSbx(join(root,'sbx'),{create:async(name,args,options,{materialize})=>{
    if(!hang.has(jobOf.get(name)))return {code:0};
    materialize();
    if(++waiting<hang.size)return {code:1,stderr:'daemon timeout'};
    await barrier('dispatched','dispatched');
    await new Promise(()=>{});
  }});
  const backend=receiptBackend(root,sbx);
  const runJob=backend._runJobCommand.bind(backend);
  backend._runJobCommand=(handle,...rest)=>{jobOf.set(handle.sandbox_id,handle.job_id);return runJob(handle,...rest);};
  const main=await backend.prepare(job);
  writeFileSync(join(root,'main.json'),JSON.stringify({name:main.sandbox_id}));
  for(const jobId of hang)backend.prepare(receiptJob({job_id:jobId})).catch(()=>{});
  await new Promise(()=>{});
}
