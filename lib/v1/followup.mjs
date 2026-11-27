// Rebuild the parent's exact result snapshot in a disposable directory. Never apply it to the user's checkout.
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {extractArchive,archiveFileCount} from '../archive.mjs';
import {rejectMetadataRoot} from '../source-package.mjs';
import {parseUnifiedDiff,patchHazards} from '../git-candidate.mjs';
import {buildHandoff,readHandoff,continuationPrompt} from './continuation.mjs';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code,status:409});};
export function checkFollowup(value) {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['parentJob','parentResult'].includes(key))||
    !/^sha256:[0-9a-f]{64}$/.test(value.parentJob??'')||!/^sha256:[0-9a-f]{64}$/.test(value.parentResult??''))fail('invalid_request','Choose a delivered result to continue.');
 return value;
}
function git(cwd,args,input) {
 const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
 for(const key of Object.keys(env))if(/^GIT_/.test(key))delete env[key];
 Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'true'});
 return new Promise((resolve,reject)=>{
  const child=spawn('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=','-c','core.askPass=','-c','http.followRedirects=false','-c','protocol.allow=never','-c','protocol.https.allow=always',...args],{cwd,env,stdio:['pipe','pipe','pipe']});
  const timer=setTimeout(()=>child.kill('SIGKILL'),60000);child.once('close',()=>clearTimeout(timer));
  const chunks=[];let bytes=0;child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>64*1024*1024)child.kill('SIGKILL');else chunks.push(chunk);});child.stderr.resume();child.on('error',reject);child.on('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(Object.assign(new Error('The previous result could not be rebuilt safely.'),{code:'followup_base_unavailable',status:409})));
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
async function snapshot(directory,runGit) {
 const names=await runGit(directory,['ls-files','-z']);
 const bytes=await new Promise((resolve,reject)=>{
  const env={...process.env};delete env.TAR_OPTIONS;
  const child=spawn('tar',['-cf','-','--no-xattrs','--null','--no-recursion','-C',directory,'-T','-'],{env,stdio:['pipe','pipe','pipe']});
  const chunks=[];let total=0;const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
  child.stdout.on('data',chunk=>{total+=chunk.length;if(total>64*1024*1024)child.kill('SIGKILL');else chunks.push(chunk);});child.stderr.resume();child.once('error',reject);
  child.once('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(chunks)):reject(Object.assign(new Error('The previous result snapshot could not be packaged.'),{code:'followup_base_unavailable',status:409}));});
  child.stdin.on('error',()=>{});child.stdin.end(names);
 });
 try{archiveFileCount(bytes);}catch{fail('followup_base_unavailable','This result contains files that snapshot jobs cannot send, such as symbolic links. Start a new Git URL job instead.');}
 return bytes;
}
export async function continuationFor({client,meta,circle,digest,thread=[]}) {
 const local=await meta.get(digest);if(!local||local.circle!==circle)fail('not_your_job','Only jobs sent from this computer can be continued.');
 const view=await client.getJob(digest);if(view.state!=='result-accepted'||!view.result_digest)fail('result_not_delivered','Wait for the result before continuing.');
 const transcript=await client.fetchTranscript(digest,{attempt:view.current_attempt});
 const handoff=readHandoff(Buffer.from(transcript).toString('utf8'),{circle,job_digest:digest,attempt_id:view.current_attempt?.attempt_id,executor:view.current_attempt?.holder})??buildHandoff({scanUnavailable:true});
 return {handoff,sourceKind:view.job?.payload?.source?.kind==='none'?'none':'folder',parentJob:digest,parentResult:view.result_digest,base:{path:local.applied?.repo||local.sourcePath||'',branch:local.applied?.branch||local.sourceBranch||'',commit:local.applied?.commit||null},thread};
}
export async function prepareFollowup({client,meta,circle,followup,delta,directory,runGit=git}) {
 checkFollowup(followup);
 if(typeof delta!=='string'||!delta.trim())fail('invalid_request','Describe what should change next.');
 const context=await continuationFor({client,meta,circle,digest:followup.parentJob});
 if(context.parentResult!==followup.parentResult)fail('followup_result_changed','The previous result changed. Open it again before continuing.');
 const view=await client.getJob(followup.parentJob);
 if(view.result_digest!==followup.parentResult)fail('followup_result_changed','The previous result changed.');
 if(view.job?.payload?.source?.kind==='none')return {noSource:true,sourceLabel:'No project + follow-up',
  prompt:continuationPrompt(context.handoff,delta),title:delta,followup:{...followup}};
 const result=await client.fetchResult(followup.parentJob,{includeMetadata:true,attempt:view.current_attempt});
 const isPatch=result.candidate.media_type==='text/x-diff';
 if(!isPatch&&result.candidate.media_type!=='application/gzip')fail('followup_base_unavailable','This result has no supported code snapshot to continue.');
 if(isPatch&&patchHazards(parseUnifiedDiff(result.bytes)).length)fail('followup_base_unavailable','Review unsafe paths before continuing this result.');
 await mkdir(directory,{recursive:true,mode:0o700});const temp=await mkdtemp(join(directory,'followup-'));
 try {
  const source=view.job.payload.source;
  if(!isPatch) {
    await extractArchive(result.bytes,temp,{preserveExecutable:true,maxTotalBytes:64*1024*1024,maxFileBytes:64*1024*1024});
    await rejectMetadataRoot(temp);
    await runGit(temp,['init','-q']);
  } else if(source.kind==='archive') {
    await extractArchive(await client.fetchArtifact(source.artifact),temp,{preserveExecutable:true,maxTotalBytes:64*1024*1024,maxFileBytes:64*1024*1024});
    await rejectMetadataRoot(temp);
    await runGit(temp,['init','-q']);
  } else if(source.kind==='git') {
    const url=new URL(source.url);
    if(url.protocol!=='https:'||url.username||url.password||!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(source.commit))fail('followup_base_unavailable','The previous source is not a pinned HTTPS repository.');
    await runGit(temp,['init','-q']);
    await runGit(temp,['fetch','--no-tags','--depth=1',source.url,source.commit]);
    await runGit(temp,['checkout','--detach',source.commit]);
  } else fail('followup_base_unavailable','This result has no code snapshot to continue.');
  if(isPatch&&result.bytes.length)await runGit(temp,['apply','--binary','--whitespace=nowarn','-'],result.bytes);
  await rejectMetadataRoot(temp);
  // The validated snapshot is the source manifest, including tracked ignored files.
  await runGit(temp,['add','--all','--force']);
  return {sourceTar:await snapshot(temp,runGit),sourceLabel:'Previous result + follow-up',
   prompt:continuationPrompt(context.handoff,delta),title:delta,followup:{...followup},
   sourcePath:context.base.path,sourceBranch:context.base.branch};
 }finally{await rm(temp,{recursive:true,force:true});}
}
