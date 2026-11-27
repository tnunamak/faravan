// Read repository status without executing project-defined Git commands.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, copyFile, readdir, rm, lstat, realpath, open, utimes } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
const exec=promisify(execFile);
const invalid=message=>Object.assign(new Error(message),{code:'invalid_request'});
function environment(extra={},dataConfig=false) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^GIT_/i.test(key)));
  return {...env,...(dataConfig?{}:{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null'}),
    GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',...extra};
}
async function git(cwd,args,extra={},capture={},dataConfig=false) {
  return (await exec('git',['--no-lazy-fetch','--no-replace-objects','-C',cwd,
    '-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','safe.bareRepository=explicit',
    '-c','protocol.allow=never',...args],{
    encoding:'utf8',maxBuffer:64*1024*1024,timeout:5000,killSignal:'SIGKILL',env:environment(extra,dataConfig),...capture,
  })).stdout;
}
// Compatibility for other callers; enumeration is not the status safety boundary.
export async function gitFilterOverrides(top) {
  // Status can invoke project-defined clean filters and submodule fsmonitor commands.
  // Include every configuration scope before blanking the drivers; a read must not execute them.
  const keys=(await git(top,['config','--includes','--name-only','--null','--list'])).split('\0');
  return [...new Set(keys)].flatMap(key=>{
    const match=/^filter\.[A-Za-z0-9_.-]+\.(clean|smudge|process|required)$/i.test(key);
    if(/^filter\./i.test(key)&&!match) throw Object.assign(new Error('This repository uses a Git filter name that cannot be safely disabled.'),{code:'invalid_request'});
    return match?['-c',key+'='+(/\.required$/i.test(key)?'false':'')]:[];
  });
}
async function setting(top,key,type,signal) {
  try{
    const value=await git(top,['config','--includes',...(type?['--type='+type]:[]),'--get',key],{}, {signal},true);
    if(type!=='path')return value.trim();
    const path=value.replace(/\n$/,'');
    if(!path||/[\0\r\n]/.test(path))throw invalid('Unsupported Git data path.');
    return path;
  }
  catch(error){if(error.code===1)return null;throw error;}
}
function oid(value) {
  if(!/^[0-9a-f]{40}$/.test(value))throw invalid('Expected a complete SHA-1 object ID.');
  return value;
}

// Text reads retain their 64 MiB limit. Binary output has a separate explicit
// ceiling; execFile accumulates actual output, not a preallocated GiB.
export const MAX_GIT_ARCHIVE_BYTES=1024*1024*1024;
const MAX_DATA_FILE_BYTES=1024*1024;
function binaryOptions({maxBytes=MAX_GIT_ARCHIVE_BYTES}={}) {
 if(!Number.isSafeInteger(maxBytes)||maxBytes<=0||maxBytes>MAX_GIT_ARCHIVE_BYTES)
  throw invalid('Unsupported binary read budget.');
 return {encoding:'buffer',maxBuffer:maxBytes};
}
function sourcePath(path) {
 if(typeof path!=='string'||!path||isAbsolute(path)||/[\\\x00-\x1f\x7f]/.test(path)||
    path.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git'))
  throw invalid('Unsupported committed source path.');
 return path;
}
function committedListing(bytes) {
 let text;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
 catch{throw invalid('Unsupported non-UTF8 committed path.');}
 if(text&&!text.endsWith('\0'))throw invalid('Incomplete committed tree listing.');
 for(const entry of text.split('\0').filter(Boolean)) {
  const match=/^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})\t(.+)$/.exec(entry);
  if(!match||(match[1]==='160000')!==(match[2]==='commit'))throw invalid('Invalid committed tree header.');
  sourcePath(match[4]);
 }
 return text;
}
async function dataFile(path,{optional=false}={}) {
 let handle;
 try {
  handle=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
  const before=await handle.stat();
  if(!before.isFile()||before.size>MAX_DATA_FILE_BYTES)throw invalid('Unsupported Git data file.');
  const bytes=Buffer.alloc(before.size+1);
  const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
  if(bytesRead!==before.size)throw invalid('Git data file changed during capture.');
  return bytes.subarray(0,bytesRead);
 } catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
 finally{await handle?.close();}
}
async function discover(top) {
 const selected=await realpath(top);
 if(!(await lstat(selected)).isDirectory())throw invalid('Source must be a directory.');
 let directory=selected;
 while(true) {
  const entries=await readdir(directory,{withFileTypes:true});
  const named=name=>entries.find(entry=>entry.name.toLowerCase()===name);
  if((named('head')?.isFile()&&(named('objects')?.isDirectory()||named('config')?.isFile()||named('commondir')?.isFile()))||
     (named('config')?.isFile()&&named('objects')?.isDirectory()))
   throw invalid('Git metadata cannot be packaged as source.');
  try {
   const marker=await lstat(join(directory,'.git'));
   if(!marker.isDirectory()&&!marker.isFile())throw invalid('Unsupported Git metadata marker.');
   return {selected,root:directory};
  } catch(error){if(error.code!=='ENOENT')throw error;}
  const parent=dirname(directory);
  if(parent===directory)return {selected,root:null};
  directory=parent;
 }
}
async function plainSession(callback) {
 let live=true;
 const unavailable=()=>Promise.reject(invalid(live?'No committed source in this session.':'The isolated read session is closed.'));
 const metadata=Object.freeze({kind:'nonrepository',commit:null,subdirectory:null,tracked:false});
 try{return await callback(Object.freeze({
  packaging:()=>live?Promise.resolve(metadata):unavailable(),
  archive:unavailable,committedTree:unavailable,blobBuffer:unavailable,
  status:unavailable,blob:unavailable,tree:unavailable,
 }));}finally{live=false;}
}

/** Own all bounded reads and disposal; readers cannot outlive the callback. */
export async function withIsolatedGitRead(top,callback,{signal,wholeRepository=false}={}) {
  signal?.throwIfAborted();
  if(typeof wholeRepository!=='boolean')throw invalid('Invalid repository read scope.');
  const scopedGit=(cwd,args,extra={},capture={})=>git(cwd,args,extra,{...capture,signal});
  // Discovery reads names/config/ref metadata only, never status or source
  // contents through original configuration. Absence is a filesystem proof.
  const discovered=await discover(top);
  if(discovered.root===null)return plainSession(callback);
  top=wholeRepository?discovered.root:discovered.selected;
  const worktree=await realpath((await scopedGit(top,['rev-parse','--show-toplevel'])).trim());
  if(worktree!==discovered.root)throw invalid('Configured worktree differs from source root.');
  const subdirectory=relative(worktree,top).split(sep).join('/');
  if(subdirectory)sourcePath(subdirectory);
  const gitdir=(await scopedGit(top,['rev-parse','--absolute-git-dir'])).trim();
  const common=resolve(top,(await scopedGit(top,['rev-parse','--git-common-dir'])).trim());
  const format=(await scopedGit(top,['rev-parse','--show-object-format'])).trim();
  if(format!=='sha1')throw invalid('Unsupported Git object format: '+format);
  if(await setting(top,'core.sparseCheckout','bool',signal)==='true'||await setting(top,'index.sparse','bool',signal)==='true')
    throw invalid('Sparse checkout/index is not supported by isolated reads.');
  const config=['[core]',' repositoryFormatVersion = 0',' bare = false',
    ' fsmonitor = false',' hooksPath = /dev/null',' untrackedCache = false'];
  for(const key of ['fileMode','ignoreCase','symlinks','precomposeUnicode']) {
    const value=await setting(top,'core.'+key,'bool',signal);
    if(value!==null)config.push(' '+key+' = '+value);
  }
  for(const [key,values] of [['autocrlf',['true','false','input']],['eol',['lf','crlf','native']]]) {
    const value=await setting(top,'core.'+key,undefined,signal);
    if(value!==null){if(!values.includes(value))throw invalid('Unsupported core.'+key);config.push(' '+key+' = '+value);}
  }
  // Copy only effective nonexecutable data settings. Explicit data files are
  // snapshotted once with a small bound, never retained as original paths.
  const dataSettings=[];
  for(const [key,name] of [['attributesFile','global-attributes'],['excludesFile','global-exclude']]) {
    const path=await setting(top,'core.'+key,'path',signal);
    dataSettings.push({key,name,bytes:path===null?null:await dataFile(resolve(top,path))});
  }
  let head;
  try{head=oid((await scopedGit(top,['rev-parse','--verify','--quiet','HEAD'])).trim());}
  catch(error){
    if(error.code!==1)throw error;
    const branch=(await scopedGit(top,['symbolic-ref','--quiet','HEAD'])).trim();
    if(!branch.startsWith('refs/heads/'))throw invalid('Unsupported unresolved HEAD.');
    try{await scopedGit(top,['show-ref','--verify','--quiet',branch]);throw invalid('Unresolved existing HEAD.');}
    catch(missing){if(missing.code!==1)throw missing;}
    head='ref: refs/heads/isolated-unborn';
  }
  const commit=head.startsWith('ref: ')?null:head;
  const branch=await scopedGit(top,['symbolic-ref','--quiet','--short','HEAD'])
    .then(value=>value.trim()||null,error=>{if(error.code===1)return null;throw error;});
  const admin=await mkdtemp(join(tmpdir(),'fv-git-read-'));
  const active=new Set();
  let live=true,failed=false;
  try {
    for(const dir of ['refs','objects','info'])await mkdir(join(admin,dir));
    for(const name of ['exclude','attributes']){
      const bytes=await dataFile(join(common,'info',name),{optional:true});
      if(bytes!==null)await writeFile(join(admin,'info',name),bytes);
    }
    for(const {key,name,bytes} of dataSettings) {
      const path=join(admin,name);
      await writeFile(path,bytes??Buffer.alloc(0));
      config.push(' '+key+' = '+JSON.stringify(path));
    }
    await writeFile(join(admin,'config'),config.join('\n')+'\n',{mode:0o600});
    await writeFile(join(admin,'HEAD'),head+'\n',{mode:0o600});
    try{
      await copyFile(join(gitdir,'index'),join(admin,'index'));
      // A newly copied index must not make same-timestamp worktree changes
      // look older than the index. Force Git's racy-stat content check.
      await utimes(join(admin,'index'),1,1);
    }
    catch(error){if(error.code!=='ENOENT')throw error;}
    for(const name of await readdir(gitdir))
      if(/^sharedindex\.[0-9a-f]{40}$/.test(name))await copyFile(join(gitdir,name),join(admin,name));
    const run=(args,capture)=>{
      if(!live)return Promise.reject(invalid('The isolated read session is closed.'));
      signal?.throwIfAborted();
      const pending=scopedGit(top,['--git-dir='+admin,'--work-tree='+worktree,...args],{
        GIT_OBJECT_DIRECTORY:join(common,'objects'),GIT_INDEX_FILE:join(admin,'index'),
      },capture);
      active.add(pending);
      pending.then(()=>active.delete(pending),()=>active.delete(pending));
      return pending;
    };
    // Packaging is an additive capability: legacy status/blob/tree readers
    // do not acquire new packaging path restrictions or extra source reads.
    let packagingPromise;
    const packaging=async()=>{
      if(!live)throw invalid('The isolated read session is closed.');
      packagingPromise??=(async()=>{
        if(commit&&(await run(['cat-file','-t',commit])).trim()!=='commit')
          throw invalid('HEAD is not a commit.');
        const listing=commit?committedListing(await run(['ls-tree','-r','-z',commit],{encoding:'buffer'})):null;
        const trackedBytes=await run(['ls-files','--cached','-z','--','.'],{encoding:'buffer'});
        let trackedNames;
        try{trackedNames=new TextDecoder('utf-8',{fatal:true}).decode(trackedBytes);}
        catch{throw invalid('Unsupported non-UTF8 index path.');}
        if(trackedNames&&!trackedNames.endsWith('\0'))throw invalid('Incomplete index listing.');
        for(const path of trackedNames.split('\0').filter(Boolean))sourcePath(path);
        const tracked=trackedNames.length>0;
        const metadata=Object.freeze({kind:commit?(tracked?'committed':'no-tracked-content'):'unborn',
          commit,subdirectory,tracked,worktree,branch});
        return {metadata,listing};
      })();
      return packagingPromise;
    };
    const committed=async()=>{
      const result=await packaging();
      // The index may be empty while the pinned commit still contains source.
      // Packaging callers retain their own no-tracked-content fallback policy.
      if(!result.metadata.commit)throw invalid('No committed source in this session.');
      return result;
    };
    return await callback(Object.freeze({
      packaging:async()=>(await packaging()).metadata,
      archive:async({paths,...options}={})=>{
        await committed();
        if(paths!==undefined&&(!Array.isArray(paths)||paths.length===0))throw invalid('Invalid archive paths.');
        const selected=paths?.map(sourcePath);
        return run(['--literal-pathspecs','archive','--format=tar',commit,...(selected?['--',...selected]:[])],binaryOptions(options));
      },
      committedTree:async()=>(await committed()).listing,
      worktreeFiles:async()=>({
        listed:await run(['ls-files','-z','--cached','--others','--exclude-standard']),
        tracked:await run(['ls-files','-z','--cached']),
      }),
      blobBuffer:async(object,options)=>run(['cat-file','blob',oid(object)],binaryOptions(options)),
      status:({scope=[]}={})=>{
        if(!Array.isArray(scope)||scope.some(path=>typeof path!=='string'||path.includes('\0')))
          return Promise.reject(invalid('Invalid status path scope.'));
        return run(['status','--ignore-submodules=all','--porcelain=v1','-z','--untracked-files=all',...(scope.length?['--',...scope]:[])]);
      },
      blob:object=>run(['cat-file','blob',oid(object)]),
      tree:object=>run(['ls-tree','-z',oid(object)]),
    }));
  } catch(error) { failed=true;throw error; }
  finally {
    live=false;
    await Promise.allSettled([...active]);
    try{await rm(admin,{recursive:true,force:true});}
    catch(error){if(!failed)throw error;}
  }
}
export async function changedFiles(top,{scope=[]}={}) {
  return withIsolatedGitRead(top,async read=>{
    const fields=(await read.status({scope})).split('\0').filter(Boolean);
    const files=[];
    for(let i=0;i<fields.length;i++){
      const code=fields[i].slice(0,2).trim()||'?';
      files.push({code:code==='??'?'?':code[0],path:fields[i].slice(3)});
      if(/[RC]/.test(fields[i].slice(0,2)))i++;
    }
    return files;
  });
}
