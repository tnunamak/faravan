import {execFile} from 'node:child_process';
import {access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs, promisify} from 'node:util';
import {readManifest, candidateURL, latestURL, manifestCommit} from './bar-feed.mjs';
import {main as realJobs} from './bar-real-jobs.mjs';

const execute=promisify(execFile);
const cwd=fileURLToPath(new URL('../',import.meta.url));
export const runCommand=(command,args,options={})=>execute(command,args,{cwd,timeout:300_000,maxBuffer:4*1024*1024,...options});
export async function repositoryName(run=runCommand) {
  const {stdout}=await run('git',['remote','get-url','origin']);
  const match=stdout.trim().match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if(!match)throw Error('Hosted checks require a GitHub origin remote');
  return match[1];
}
const repository=await repositoryName();
async function requireFiles(files,root=cwd) {
  for(const file of files) {
    try {await access(resolve(root,file));} catch {throw Error('not built: '+file);}
  }
}
export function testCheck(files,{cwd:root=cwd,run=runCommand,timeout=300_000}={}) {
  return async()=>{
    await requireFiles(files,root);
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const {stdout}=await run(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',...files],{cwd:root,env,timeout});
    const passed=Number(stdout.match(/^# pass (\d+)$/m)?.[1]??0);
    const failed=Number(stdout.match(/^# fail (\d+)$/m)?.[1]??0);
    const skipped=Number(stdout.match(/^# skipped (\d+)$/m)?.[1]??0);
    const cancelled=Number(stdout.match(/^# cancelled (\d+)$/m)?.[1]??0);
    return {pass:passed>0&&!failed&&!skipped&&!cancelled,reason:`tests: ${passed} passed, ${failed} failed, ${skipped} skipped, ${cancelled} cancelled`};
  };
}
export function ownerOfflineCheck({run=runCommand,real=()=>realJobs(['--member-home'])}={}) {
  return async()=>{
    let tests;
    try {tests=await testCheck(['tests/owner-offline-two-members.test.mjs'],{run,timeout:900_000})();}
    catch(error) {tests={pass:false,reason:`tests: ${error.stdout?.match(/^# fail (\d+)$/m)?.[1]??'unknown'} failed; ${error.message}`};}
    let jobs;
    try {jobs=await real();}
    catch(error) {jobs={pass:false,reason:error.message};}
    return {pass:tests.pass&&jobs.pass,reason:`${tests.reason}; ${jobs.reason.startsWith('real:')?jobs.reason:'real: '+jobs.reason}`};
  };
}
export async function trunkHead({run=runCommand,branch=process.env.FARAVAN_BAR_BRANCH||'ff/t1-integ-1127'}={}) {
  const ref='refs/heads/'+branch;
  const {stdout}=await run('git',['ls-remote','origin',ref]);
  const [sha,observedRef]=stdout.trim().split(/\s+/);
  if(!/^[a-f0-9]{40}$/.test(sha)||observedRef!==ref)throw Error('Could not read configured branch head');
  return sha;
}
async function hostedCheck(workflow,{install=false}={}) {
  await requireFiles(['.github/workflows/'+workflow,...(install?['docs/install.md']:[])]);
  const sha=await trunkHead();
  const {stdout}=await runCommand('gh',['run','list','--repo',repository,'--workflow',workflow,'--commit',sha,'--json','conclusion,databaseId','--limit','1']);
  const newest=JSON.parse(stdout)[0];
  if(!newest||newest.conclusion!=='success')return {pass:false,reason:`${workflow}: newest run for ${sha} ${newest?.conclusion||'has not succeeded'}`};
  const {stdout:detail}=await runCommand('gh',['run','view',String(newest.databaseId),'--repo',repository,'--json','jobs']);
  const jobs=JSON.parse(detail).jobs;
  const platforms=[/macos|darwin|\bmac\b/i,/linux|ubuntu/i];
  const pass=platforms.every(pattern=>jobs.some(job=>pattern.test(job.name)&&job.conclusion==='success'))&&jobs.every(job=>job.conclusion==='success');
  return {pass,reason:`${workflow} run ${newest.databaseId}: ${pass?'macOS and Linux succeeded':'macOS and Linux success not confirmed'}`};
}
export async function candidateCheck({read=readManifest,head=trunkHead,headFile=fetch}={}) {
  const manifest=await read(candidateURL);
  if(typeof manifest.privateHead!=='string'||!/^[a-f0-9]{40}$/i.test(manifest.privateHead))
    return {pass:false,reason:'candidate lacks signed privateHead'};
  const sha=await head();
  if(manifest.privateHead.toLowerCase()!==sha)
    return {pass:false,reason:'candidate privateHead differs from configured branch head '+sha};
  const files=[{url:manifest.tarball,size:manifest.size},...(manifest.assets??[])];
  if(!manifest.deb||!files.some(file=>file.platform==='darwin'))return {pass:false,reason:'candidate lacks Linux .deb or macOS app'};
  files.push({url:new URL(manifest.deb.file,manifest.tarball).href,size:manifest.deb.size});
  for(const file of files) {
    const response=await headFile(new URL(file.url,candidateURL),{method:'HEAD',cache:'no-store',signal:AbortSignal.timeout(30000)});
    if(!response.ok||response.headers.get('content-length')!==String(file.size))throw Error('File unavailable or size differs: '+file.url);
  }
  return {pass:true,reason:`signed candidate ${sha}; ${files.length} file sizes match`};
}
export function createRows() {
  return [
    {id:'R1',userCan:'get the build',check:candidateCheck},
    {id:'R2',userCan:'install without a terminal',check:()=>hostedCheck('bar-install.yml',{install:true})},
    {id:'R3',userCan:'join and borrow from another network',check:()=>hostedCheck('bar-join-borrow.yml')},
    {id:'R4',userCan:'lend the first job offered',check:testCheck(['tests/availability.test.mjs','tests/admission-tombstone.test.mjs'],{timeout:900_000})},
    {id:'R5',userCan:'use two accounts of one provider, one sign-in each',check:testCheck(['tests/account-claim-time-admission.test.mjs','tests/run-request.test.mjs','tests/second-account-one-signin.test.mjs'])},
    {id:'R6',userCan:'know the one next step when held',check:testCheck(['tests/reason-codes-closed.test.mjs','tests/abandoned-request-log.test.mjs'])},
    {id:'R7',userCan:"work with the owner's machine off",check:ownerOfflineCheck()},
    {id:'R8',userCan:'rely on it',check:async()=>{
      await requireFiles(['scripts/bar-real-jobs.mjs']);
      const {stdout}=await runCommand(process.execPath,['scripts/bar-real-jobs.mjs']).catch(error=>{
        if(error.code===1&&error.stdout)return {stdout:error.stdout};
        throw error;
      });
      return JSON.parse(stdout);
    }},
    {id:'R9',userCan:'(owner) see it',check:async()=>{
      const candidate=manifestCommit(await readManifest(candidateURL));
      const latest=manifestCommit(await readManifest(latestURL));
      return {pass:candidate===latest,reason:candidate===latest?'latest names candidate commit '+candidate:'latest and candidate commits differ'};
    }},
  ];
}
const oneLine=value=>String(value).replace(/\s+/g,' ').trim();
export async function runBar(rows) {
  const results=[];
  for(const {id,userCan,check} of rows) {
    try {
      const result=await check();
      results.push({id,userCan,pass:result.pass===true,reason:oneLine(result.reason)});
    } catch(error) {
      const summary=error.stdout?.match(/^# fail (\d+)$/m);
      results.push({id,userCan,pass:false,reason:summary?`test command failed: ${summary[1]} failed`:oneLine(error.message)});
    }
  }
  return results;
}
export async function main(args,{rows=createRows(),stdout=process.stdout}={}) {
  const {values}=parseArgs({args,options:{json:{type:'boolean'},row:{type:'string'}}});
  if(values.row&&!rows.some(row=>row.id===values.row))throw Error('Unknown row: '+values.row);
  const results=await runBar(values.row?rows.filter(row=>row.id===values.row):rows);
  stdout.write(values.json?JSON.stringify(results,null,2)+'\n':results.map(row=>`${row.id} | ${row.userCan} | ${row.pass?'PASS':'FAIL'} | ${row.reason}`).join('\n')+'\n');
  return results.every(row=>row.pass)?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {process.exitCode=await main(process.argv.slice(2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
