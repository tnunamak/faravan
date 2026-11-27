// Bounded, name-filtered ingest. Never follow filesystem links or execute archive content.
import {readdir,lstat,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createTar} from '../tar-writer.mjs';
import {filterSourceArchive} from '../source-filter.mjs';
import {sourceFileOmission,SECRET_FILE_RULES} from './secret-files.mjs';
const exec=promisify(execFile);
const refuse=message=>{throw Object.assign(new Error(message),{code:'invalid_source',status:400});};
export const SOURCE_LIMITS={maxBytes:20*1024*1024,maxFiles:1000};
export function isSourceBase64(value) {
 if(typeof value!=='string'||value.length%4!==0||/[^A-Za-z0-9+/=]/.test(value))return false;
 const padding=value.indexOf('=');
 return padding<0 || (padding>=value.length-2 && /^={1,2}$/.test(value.slice(padding)));
}
function safeName(name){
 if(typeof name!=='string'||!name||name.length>1024||/[\\\x00-\x1f]/.test(name)||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'))refuse('Source contains an unsafe path.');
 return name;
}
export async function folderFiles(root,{maxBytes=SOURCE_LIMITS.maxBytes,maxFiles=SOURCE_LIMITS.maxFiles}={}){
 root=await realpath(root);
 const rootParts=root.toLowerCase().split(/[\\/]/);
 if(rootParts.includes('.git'))refuse('Git metadata cannot be sent as source. Select the working folder instead.');
 // Relative entry names no longer contain a credential ancestor when the
 // chosen root is inside it. Refuse that selection before enumerating files.
 if(rootParts.some(part=>SECRET_FILE_RULES.directories.includes(part)))refuse('Credential folders cannot be sent as project source. Choose the project folder instead.');
 const rootNames=new Set((await readdir(root)).map(name=>name.toLowerCase()));
 if((rootNames.has('head')&&['objects','refs','config','commondir'].some(name=>rootNames.has(name)))||(rootNames.has('objects')&&rootNames.has('config')))refuse('Git metadata cannot be sent as source. Select the working folder instead.');
 const files=[],omitted=[];let bytes=0,count=0;
 async function walk(relative=''){
  for(const entry of await readdir(join(root,relative),{withFileTypes:true})){
   const path=relative?relative+'/'+entry.name:entry.name;safeName(path);
   if(++count>maxFiles)refuse('Source contains too many entries.');
   const omission=sourceFileOmission(path);if(omission){omitted.push({...omission,...(entry.isDirectory()?{kind:'directory'}:{})});continue;}
   const target=join(root,path),info=await lstat(target);
   if(info.isSymbolicLink())refuse('Source contains symbolic links.');
   if(info.isDirectory()){await walk(path);continue;}
   if(!info.isFile())refuse('Source contains a special file.');
   bytes+=info.size;if(bytes>maxBytes)refuse('Source is too large.');
   // O_NOFOLLOW closes the final-component link race; parent folders are local owner-selected input.
   if(await realpath(dirname(target))!==dirname(target))refuse('Source paths through symbolic links cannot be sent.');
   const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    const data=Buffer.alloc(info.size+1);let length=0;
    while(length<data.length){const read=await handle.read(data,length,data.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}
    if(length!==info.size)refuse('Source changed while reading.');
    files.push({path,base64:data.subarray(0,length).toString('base64'),mode:info.mode&0o777});
   }finally{await handle.close();}
  }
 }
 await walk();return {files,omitted,bytes};
}
export function sourceFilesArchive(files){return filterSourceArchive(createTar(files.map(file=>({name:file.path,data:Buffer.from(file.base64,'base64'),mode:0o644|((file.mode??0)&0o111),type:'0'})))).buffer;}
function crc32(data){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export function zipFiles(buffer,{maxBytes=SOURCE_LIMITS.maxBytes,maxFiles=SOURCE_LIMITS.maxFiles}={}){
 if(!Buffer.isBuffer(buffer)||buffer.length>maxBytes)refuse('ZIP is too large.');
 let end=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0)refuse('Invalid ZIP archive.');
 if(buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6)||buffer.readUInt16LE(end+8)!==buffer.readUInt16LE(end+10)||end+22+buffer.readUInt16LE(end+20)!==buffer.length)refuse('Unsupported ZIP archive.');
 const count=buffer.readUInt16LE(end+10),centralSize=buffer.readUInt32LE(end+12),centralStart=buffer.readUInt32LE(end+16);
 if(count>maxFiles||count===65535)refuse('ZIP contains too many entries.');
 if(centralStart+centralSize!==end)refuse('Invalid ZIP directory.');
 const files=[],omitted=[],names=new Set();let cursor=centralStart,total=0;
 for(let i=0;i<count;i++){
  if(cursor+46>end||buffer.readUInt32LE(cursor)!==0x02014b50)refuse('Invalid ZIP entry.');
  const flags=buffer.readUInt16LE(cursor+8),method=buffer.readUInt16LE(cursor+10),compressed=buffer.readUInt32LE(cursor+20),size=buffer.readUInt32LE(cursor+24),nameLength=buffer.readUInt16LE(cursor+28),extra=buffer.readUInt16LE(cursor+30),comment=buffer.readUInt16LE(cursor+32),mode=buffer.readUInt32LE(cursor+38)>>>16,offset=buffer.readUInt32LE(cursor+42);
  if(flags&1||flags&64)refuse('Encrypted ZIP archives cannot be sent.');
  if(![0,8].includes(method)||size===0xffffffff||compressed===0xffffffff||buffer.readUInt16LE(cursor+34))refuse('Unsupported ZIP entry.');
  const next=cursor+46+nameLength+extra+comment;if(next>end)refuse('Invalid ZIP entry.');
  const rawName=buffer.subarray(cursor+46,cursor+46+nameLength).toString('utf8'),directory=rawName.endsWith('/'),path=safeName(directory?rawName.slice(0,-1):rawName);
  if(names.has(path))refuse('ZIP contains duplicate paths.');names.add(path);
  if((mode&0xf000)&&![0x8000,0x4000].includes(mode&0xf000))refuse('ZIP contains symbolic links or special files.');
  total+=size;if(total>maxBytes)refuse('Expanded ZIP is too large.');
  if(offset+30>centralStart||buffer.readUInt32LE(offset)!==0x04034b50)refuse('Invalid ZIP data.');
  const localFlags=buffer.readUInt16LE(offset+6),localMethod=buffer.readUInt16LE(offset+8),localName=buffer.readUInt16LE(offset+26),localExtra=buffer.readUInt16LE(offset+28),start=offset+30+localName+localExtra;
  if(localFlags!==flags||localMethod!==method||start+compressed>centralStart||buffer.subarray(offset+30,offset+30+localName).toString('utf8')!==rawName)refuse('Invalid ZIP data.');
  const omission=sourceFileOmission(path);
  if(omission)omitted.push({...omission,...(directory?{kind:'directory'}:{})});
  else if(!directory){
   let data;try{data=method===0?buffer.subarray(start,start+compressed):inflateRawSync(buffer.subarray(start,start+compressed),{maxOutputLength:Math.max(1,Math.min(size,maxBytes))});}catch{refuse('Invalid ZIP compressed data.');}
   if(data.length!==size)refuse('Invalid ZIP expanded size.');if(crc32(data)!==buffer.readUInt32LE(cursor+16))refuse('Invalid ZIP checksum.');files.push({path,base64:data.toString('base64'),mode:mode&0o777});
  }
  cursor=next;
 }
 if(cursor!==end)refuse('Invalid ZIP directory.');return {files,omitted,bytes:total};
}
export async function resolveRepository(url,ref,{run}={}){
 let parsed;try{parsed=new URL(url);}catch{refuse('Use a credential-free HTTPS repository URL.');}
 if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash||parsed.search)refuse('Use a credential-free HTTPS repository URL.');
 if(ref!==undefined&&(typeof ref!=='string'||ref.length>200||!ref||/[\x00-\x20~^:?*\[\\]/.test(ref)||ref.startsWith('-')||ref.includes('..')))refuse('Choose a valid repository branch.');
 const args=['-c','credential.helper=','-c','core.askPass=','-c','http.followRedirects=false','ls-remote','--symref',url,'HEAD','refs/heads/*'];
 let output;
 try{output=run?await run(args):(await exec('git',args,{timeout:15000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'/bin/false',LC_ALL:'C'}})).stdout;}
 catch{refuse('Could not read repository branches. Check the public HTTPS URL and try again.');}
 const branches=[];let defaultBranch=null,head=null;
 for(const line of output.split('\n')){const match=line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/(.+)$/);if(match)branches.push({name:match[2],commit:match[1]});const sym=line.match(/^ref: refs\/heads\/(.+)\tHEAD$/);if(sym)defaultBranch=sym[1];if(/^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/.test(line))head=line.split('\t')[0];}
 const branch=ref??defaultBranch,selected=branches.find(b=>b.name===branch),commit=selected?.commit??(!ref?head:null);if(!commit)refuse('Repository branch was not found.');
 return {url,branch:branch??null,commit,branches};
}
