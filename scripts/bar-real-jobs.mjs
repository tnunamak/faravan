import {execFile} from 'node:child_process';
import {access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs, promisify} from 'node:util';
import {candidateURL, readManifest} from './bar-feed.mjs';

const execute=promisify(execFile);
const instant=value=>typeof value==='string'?Date.parse(value):NaN;
// Completed public job views omit submission time. Claim time is the available
// lower bound; unclaimed jobs stay in the sample with unknown timing.
const jobTime=job=>instant(job.submittedAt??job.waitingTiming?.submittedAt??job.current_attempt?.claimed_at);
function uniqueJobs(records) {
  const unique=new Map();
  for(const job of records) {
    if(typeof job.job_digest!=='string'||!job.job_digest)throw Error('Job has no ID');
    if(job.savedAt||job.savedReason)throw Error('App returned a saved job instead of a live read');
    const previous=unique.get(job.job_digest);
    if(previous&&JSON.stringify([previous.state,previous.current_attempt])!==JSON.stringify([job.state,job.current_attempt]))throw Error('Apps disagree about job '+job.job_digest);
    unique.set(job.job_digest,job);
  }
  return [...unique.values()];
}
export function countJobs(records,since) {
  const cutoff=instant(since);
  if(!Number.isFinite(cutoff))throw Error('Invalid --since timestamp');
  const jobs=uniqueJobs(records).filter(job=>!Number.isFinite(jobTime(job))||jobTime(job)>=cutoff)
    .sort((a,b)=>(Number.isFinite(jobTime(b))?jobTime(b):Infinity)-(Number.isFinite(jobTime(a))?jobTime(a):Infinity)||a.job_digest.localeCompare(b.job_digest)).slice(0,20);
  let finished=0,unnamedFailures=0,startedWithin90=0,missingClaim=0,missingStart=0;
  for(const job of jobs) {
    const attempt=job.current_attempt;
    if(['result-accepted','finished'].includes(job.state))finished++;
    let reason=attempt?.reason;
    if(typeof reason==='string'&&reason.startsWith('{')){try{reason=JSON.parse(reason).code;}catch{reason=null;}}
    if(job.state==='failed'&&!(typeof reason==='string'&&/^[a-z][a-z0-9_]*$/.test(reason)))unnamedFailures++;
    const claimed=instant(attempt?.claimed_at),started=instant(attempt?.execution_observed_at);
    if(!Number.isFinite(claimed))missingClaim++;
    if(!Number.isFinite(started))missingStart++;
    if(Number.isFinite(claimed)&&Number.isFinite(started)&&started>=claimed&&started-claimed<=90000)startedWithin90++;
  }
  const pass=jobs.length===20&&finished>=18&&unnamedFailures===0&&startedWithin90>=18;
  return {pass,sample:jobs.length,finished,unnamedFailures,startedWithin90,missingClaim,missingStart,
    reason:`${jobs.length}/20 jobs; ${finished} finished; ${unnamedFailures} failed without named cause; ${startedWithin90} started within 90 s; missing claim/start: ${missingClaim}/${missingStart}`};
}
export function countMemberHomeJobs(records,since) {
  const cutoff=instant(since);
  if(!Number.isFinite(cutoff))throw Error('Invalid --since timestamp');
  const finished=uniqueJobs(records).filter(job=>typeof job.jobHome?.origin==='string'&&job.jobHome.origin.length>0&&
    typeof job.jobHome.ownerOrigin==='string'&&job.jobHome.ownerOrigin.length>0&&job.jobHome.origin!==job.jobHome.ownerOrigin&&
    ['result-accepted','finished'].includes(job.state)&&jobTime(job)>=cutoff).length;
  return {pass:finished>0,finished,reason:`real: ${finished} finished jobs sent to a member's address since ${since}`};
}
export async function readRealJobs({apps,since,run=execute,memberHome=false}) {
  if(!Number.isFinite(instant(since)))throw Error('Invalid --since timestamp');
  const records=[];
  for(const app of [...new Set(apps)]) {
    const list=JSON.parse((await run(app,['jobs','list','--json'],{timeout:120000,maxBuffer:8*1024*1024})).stdout);
    if(!Array.isArray(list))throw Error('App job list is not an array');
    for(const listed of uniqueJobs(list)) {
      const args=['jobs','get','--digest',listed.job_digest,...(listed.circle?.id?['--circle',listed.circle.id]:[]),'--json'];
      const job=JSON.parse((await run(app,args,{timeout:120000,maxBuffer:8*1024*1024})).stdout);
      if(job.job_digest!==listed.job_digest)throw Error('App returned another job');
      records.push(job);
    }
  }
  return memberHome?countMemberHomeJobs(records,since):countJobs(records,since);
}
async function installedApp() {
  const candidates=[join(homedir(),'.local/bin/faravan'),join(homedir(),'.local/share/faravan/usr/bin/faravan'),join(homedir(),'.local/share/faravan-preview-20261026/usr/bin/faravan'),'/Applications/Faravan.app/Contents/MacOS/faravan'];
  for(const app of candidates){try{await access(app);return app;}catch{}}
  throw Error('Installed Faravan command not found');
}
export async function main(args) {
  try {
    const {values}=parseArgs({args,options:{since:{type:'string'},'member-home':{type:'boolean'}}});
    const since=values.since??(await readManifest(candidateURL)).released;
    return await readRealJobs({since,memberHome:values['member-home'],apps:[await installedApp(),...(process.env.FARAVAN_BAR_APPS??'').split(':').filter(Boolean)]});
  } catch(error){return {pass:false,reason:error.message};}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=await main(process.argv.slice(2));
  console.log(JSON.stringify(result));
  process.exitCode=result.pass?0:1;
}
