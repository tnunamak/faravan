import fs from 'node:fs';
import path from 'node:path';
import {hostname} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readWindowsProcess} from './windows-process.mjs';

const refuse=()=>{throw new Error('cannot verify the previous coordinator process; stop that host before starting the new circle');};
// A live coordinator whose owner record matches but whose program is another install's copy of this entry.
// It is named, never adopted or stopped: callers branch on this code, not on the message.
export const PREVIOUS_COORDINATOR_OTHER_INSTALL='previous_coordinator_other_install';
const otherInstall=()=>Object.assign(new Error('The recorded hosting process appears to use a different program path. Faravan could not verify it as this copy, so it was left running. Check the Faravan installation that started hosting and stop hosting there before trying again.'),{code:PREVIOUS_COORDINATOR_OTHER_INSTALL});
const entry=fileURLToPath(new URL('../../bin/faravan-coordinator',import.meta.url));
// How a named program file relates to this install's entry, directly or through a link. A name that cannot be resolved is
// 'unverified': it is never taken as proof of another install.
function programRelation(named,wanted=entry){
  let actual,expected;
  try {actual=fs.realpathSync(named);expected=fs.realpathSync(wanted);}
  catch {return 'unverified';}
  return actual===expected?'same':'different';
}
// Splits a Windows command line the way the C runtime does: a backslash run before a quote, and a quote pair inside quotes.
// An unterminated quote has no defined argument list, so it decodes to null.
function decodeWindowsArgv(line){
  const args=[];let current='',quoted=false,started=false;
  for(let i=0;i<line.length;){
    const ch=line[i];
    if(ch==='\\'){
      let run=0;while(line[i+run]==='\\')run++;
      started=true;
      if(line[i+run]!=='"'){current+='\\'.repeat(run);i+=run;continue;}
      current+='\\'.repeat(run>>1);
      if(run%2===1) current+='"'; else quoted=!quoted;
      i+=run+1;continue;
    }
    if(ch==='"'){
      started=true;
      if(quoted&&line[i+1]==='"'){current+='"';i+=2;continue;}
      quoted=!quoted;i++;continue;
    }
    if((ch===' '||ch==='\t')&&!quoted){
      if(started) args.push(current);
      current='';started=false;i++;continue;
    }
    current+=ch;started=true;i++;
  }
  if(quoted) return null;
  if(started) args.push(current);
  return args;
}
const fields=['version','platform','host','pid','boot','namespace','start','config'];
const same=(a,b)=>fields.every(key=>a?.[key]===b?.[key]);
const valid=owner=>owner?.version===1&&['linux','darwin','win32'].includes(owner.platform)&&owner.host===hostname()&&
  Number.isSafeInteger(owner.pid)&&owner.pid>0&&typeof owner.boot==='string'&&owner.boot.length>0&&
  (owner.namespace===null||typeof owner.namespace==='string')&&typeof owner.start==='string'&&/^\d+$/.test(owner.start)&&typeof owner.config==='string';
export const sameCoordinatorOwner=same;
const options={encoding:'utf8',timeout:2500,stdio:['ignore','pipe','ignore']};
const quoteWindows=(value,always=false)=>!always&&!/[\s"]/.test(value)?value:
  `"${value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')}"`;

function observe(pid,config,{platform=process.platform,readFile=fs.readFileSync,readlink=fs.readlinkSync,execFile=execFileSync}={}) {
  const owner={version:1,platform,host:hostname(),pid,config:path.resolve(config),namespace:null};
  let role=false,foreign=false,dead=false;
  if(platform==='linux') {
    const stat=readFile('/proc/'+pid+'/stat','utf8'),parts=stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);
    owner.boot=readFile('/proc/sys/kernel/random/boot_id','utf8').trim();
    owner.namespace=readlink('/proc/'+pid+'/ns/pid');owner.start=parts[19];dead=parts[0]==='Z';
    const args=readFile('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);
    role=args.length===4&&path.isAbsolute(args[1])&&path.resolve(args[1])===entry&&args[2]==='--host-config'&&
      path.isAbsolute(args[3])&&path.resolve(args[3])===owner.config&&
      fs.realpathSync(readlink('/proc/'+pid+'/exe'))===fs.realpathSync(process.execPath);
    // Another install's copy of this entry serving this same config: named to the operator, never adopted or stopped.
    foreign=args.length===4&&path.isAbsolute(args[1])&&path.basename(args[1])==='faravan-coordinator'&&programRelation(args[1])==='different'&&
      args[2]==='--host-config'&&path.isAbsolute(args[3])&&path.resolve(args[3])===owner.config;
  }else if(platform==='darwin') {
    const module=fileURLToPath(import.meta.url),marker='/Contents/Resources/faravan/',at=module.lastIndexOf(marker);
    const helper=at<0?fileURLToPath(new URL('../../bin/faravan-process-identity',import.meta.url)):
      path.join(module.slice(0,at),'Contents/MacOS/faravan-process-identity');
    const birth=JSON.parse(execFile(helper,[String(pid)],options));
    owner.boot=birth.boot;owner.start=birth.start;dead=birth.state==='Z';
    if(!['live','Z'].includes(birth.state)||!owner.boot?.startsWith('darwin:'))return refuse();
    const command=execFile('/bin/ps',['-ww','-p',String(pid),'-o','command='],options).trim();
    role=command===`${process.execPath} ${entry} --host-config ${owner.config}`;
    const tail=` --host-config ${owner.config}`,head=command.endsWith(tail)?command.slice(0,-tail.length):'';
    // Exactly "<absolute program> <absolute script>" before the config. Any other argument is not this shape.
    const shape=/^(\/[^ ]+) (\/.+)$/.exec(head);
    foreign=!role&&shape!==null&&path.posix.basename(shape[2])==='faravan-coordinator'&&programRelation(shape[2])==='different';
  }else if(platform==='win32') {
    const value=readWindowsProcess(pid,{execFile,fullPrecision:true});
    if(!value)return refuse();
    owner.boot=value.Boot;owner.start=value.CreationDate;
    if(typeof value.CommandLine!=='string')return refuse();
    const equal=(actual,wanted)=>typeof actual==='string'&&path.win32.isAbsolute(actual)&&path.win32.normalize(actual).toLowerCase()===path.win32.normalize(wanted).toLowerCase();
    const args=[process.execPath,entry,'--host-config',owner.config];
    const command=always=>args.map((arg,i)=>quoteWindows(arg,always&&i!==2)).join(' ');
    role=equal(value.ExecutablePath,process.execPath)&&[command(false),command(true)].includes(value.CommandLine);
    // Exactly four decoded arguments: an absolute program, an absolute script, the flag and this owner's config.
    const argv=decodeWindowsArgv(value.CommandLine);
    foreign=!role&&argv?.length===4&&path.win32.isAbsolute(argv[0])&&path.win32.isAbsolute(argv[1])&&
      path.win32.basename(argv[1])==='faravan-coordinator'&&argv[2]==='--host-config'&&argv[3]===owner.config&&
      programRelation(argv[1])==='different';
  }else return refuse();
  if(!valid(owner))return refuse();
  return {owner,role,foreign,dead};
}

export function captureCoordinatorOwner(pid,config,io={}) {
  try {
    if(!Number.isSafeInteger(pid)||pid<=0)return refuse();
    const first=observe(pid,config,io),second=observe(pid,config,io);
    if(!first.role||!second.role||first.dead||second.dead||!same(first.owner,second.owner))return refuse();
    return first.owner;
  }catch{return refuse();}
}

// Absence and a confirmed different incarnation retire only the recorded owner.
// An unreadable identity or foreign observation domain is never absence.
export function coordinatorOwnerAlive(status,config,io={}) {
  if(!status||status.status==='stopped')return false;
  if(status.protocol_version!==1||!Number.isSafeInteger(status.pid)||status.pid<=0)return refuse();
  const recorded=status.owner;
  if(!valid(recorded)||recorded.pid!==status.pid||recorded.config!==path.resolve(config)||recorded.platform!==(io.platform??process.platform))return refuse();
  // Validate the local boot before probing a PID. A prior boot cannot own a
  // current process; within this boot a foreign PID namespace stays unknown.
  try {
    const local=observe(process.pid,config,io).owner;
    if(recorded.boot!==local.boot)return false;
    if(recorded.namespace!==local.namespace)return refuse();
  }catch{return refuse();}
  const probe=io.probe??process.kill;
  try{probe(status.pid,0);}catch(error){if(error.code==='ESRCH')return false;return refuse();}
  try {
    const first=observe(status.pid,config,io),second=observe(status.pid,config,io);
    if(!same(first.owner,second.owner))return refuse();
    const current=second.owner;
    if(current.platform!==recorded.platform||current.host!==recorded.host||current.namespace!==recorded.namespace)return refuse();
    if(!same(current,recorded)||second.dead)return false;
    if(!first.role||!second.role){
      // Same owner and config, alive, but another install's entry: the reason is named and the refusal is unchanged.
      if(first.foreign&&second.foreign)throw otherInstall();
      return refuse();
    }
    return true;
  }catch(error){
    if(error?.code===PREVIOUS_COORDINATOR_OTHER_INSTALL)throw error;
    try{probe(status.pid,0);}catch(probeError){if(probeError.code==='ESRCH')return false;}
    return refuse();
  }
}
