// Run the same byte validator and filename rules inside the guest. The agent
// receives only the pinned tree, never the clone's history or excluded files.
import {readFileSync} from 'node:fs';
import {shellQuote} from './harnesses/job-framing.mjs';

import {guestRuntimeCommand} from './guest-runtime.mjs';

export function gitSourceSnapshotScript(runtime) {
  const modules=Object.fromEntries(['archive.mjs','tar-writer.mjs','source-filter.mjs','v1/secret-files.mjs']
    .map(path=>[path,readFileSync(new URL(path,import.meta.url),'utf8')]));
  modules['main.mjs']=`
import {execFileSync} from 'node:child_process';
import {mkdir,rm,rename} from 'node:fs/promises';
import {filterSourceArchive} from './source-filter.mjs';
import {extractArchive,readArchiveEntries} from './archive.mjs';
const source=execFileSync('git',['-C','repo','-c','core.fsmonitor=false','archive','--format=tar','HEAD'],{maxBuffer:64*1024*1024});
const {buffer}=filterSourceArchive(source);
readArchiveEntries(buffer,{preserveExecutable:true,maxEntries:1000,maxTotalBytes:20*1024*1024,maxFileBytes:20*1024*1024});
const clean=await mkdir('.wf-clean-source',{recursive:false}).then(()=>'.wf-clean-source');
try {
  await extractArchive(buffer,clean,{preserveExecutable:true});
  await rm('repo',{recursive:true});
  await rename(clean,'repo');
} finally {await rm(clean,{recursive:true,force:true});}
console.log('FARAVAN_GIT_SOURCE_OK');
`;
  const bootstrap=`const fs=require('node:fs'),path=require('node:path');
const modules=${JSON.stringify(modules)};
const root=fs.mkdtempSync('.wf-source-filter-');
(async()=>{try{for(const [name,text] of Object.entries(modules)){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}await import(path.resolve(root,'main.mjs'));}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(()=>{console.error('Pinned source did not pass source checks.');process.exitCode=1;});`;
  return guestRuntimeCommand(runtime, shellQuote(runtime.node)+' -e '+shellQuote(bootstrap));
}
