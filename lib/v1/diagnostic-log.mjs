import {sanitizeProbePhase} from './probe-diagnostics.mjs';
import {sanitizeSandboxCommandDiagnostic} from '../sandbox-command-diagnostic.mjs';
import {fileURLToPath} from 'node:url';
const libRoot=fileURLToPath(new URL('../',import.meta.url));
const sourcePattern=/^lib\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.[cm]?js:[1-9]\d*$/;

export function diagnosticSource(error) {
  for(const frame of String(error?.stack??'').split('\n').slice(1)) {
    const location=frame.match(/^\s+at (?:.*?\s+\()?((?:file:\/\/\/|\/).*):(\d+):\d+\)?$/);
    if(!location)continue;
    let file;
    try {file=location[1].startsWith('file:')?fileURLToPath(location[1]):location[1];}catch{continue;}
    if(!file.startsWith(libRoot))continue;
    const source='lib/'+file.slice(libRoot.length)+':'+location[2];
    if(sourcePattern.test(source))return source;
  }
  return null;
}
const WITHHELD='[private details withheld]';
const TEXT_LIMIT=2000;
const METADATA=['at','code','phase','job','ref','attemptId','attempt_id','target','stage','condition','provider','window'];

/** Private lending diagnostics. The injected redactor factory must scan before bounding text. */
export function createDiagnosticLog({file,fs,redactor}) {
  let pending=Promise.resolve();
  function record(entry) {
    const next=pending.then(async()=>{
      let redact;
      try {redact=redactor({maxTextLength:TEXT_LIMIT});}catch{}
      const text=value=>{
        try {
          if(typeof value!=='string'||typeof redact!=='function')return WITHHELD;
          const safe=redact(value);
          return typeof safe==='string'?safe.slice(0,TEXT_LIMIT).replace(/[\uD800-\uDBFF]$/,''):WITHHELD;
        }catch{return WITHHELD;}
      };
      // Project before serialization, including retained rows. Never copy raw historical JSONL.
      const project=value=>{
        const safe={};
        if(!value||typeof value!=='object'||Array.isArray(value))return safe;
        const field=(target,key,input)=>{
          if(typeof input==='string'&&input.length<=256&&text(input)===input)target[key]=input;
        };
        for(const key of METADATA)field(safe,key,value[key]);
        if(typeof value.source==='string'&&sourcePattern.test(value.source))field(safe,'source',value.source);
        if(value.code==='probe_phase') {
          const phase=sanitizeProbePhase(value);
          if(phase) {Object.assign(safe,phase);field(safe,'probe_id',value.probe_id);
            if(['native_identity','proxy_identity','allowance','meter'].includes(value.purpose))safe.purpose=value.purpose;
            if(Number.isSafeInteger(value.generation)&&value.generation>=0)safe.generation=value.generation;}
        }
        for(const key of ['elapsed_ms','absent_ms','exit_code'])
          if(Number.isFinite(value[key])&&value[key]>=0)safe[key]=value[key];
        if(Object.hasOwn(value,'message'))safe.message=text(value.message);
        if(value.details&&typeof value.details==='object'&&!Array.isArray(value.details)) {
          const details={};
          for(const key of ['stage','attemptId'])field(details,key,value.details[key]);
          const command=sanitizeSandboxCommandDiagnostic(value.details.sandbox_command,text);
          if(command)details.sandbox_command=command;
          if(Object.keys(details).length)safe.details=details;
        }
        if(safe.details?.sandbox_command) {
          // Keep the existing row, including its message, within one KiB.
          // Drop optional metadata first; UTF-8 bytes, not characters, count.
          for(const key of Object.keys(safe))if(!['at','code','phase','condition','message','details'].includes(key))delete safe[key];
          for(const key of ['at','code','phase','condition'])if(safe[key])safe[key]=safe[key].replace(/[^\x20-\x7e]/g,'?').slice(0,64);
          delete safe.details.attemptId;
          if(safe.details.stage)safe.details.stage=safe.details.stage.replace(/[^\x20-\x7e]/g,'?').slice(0,64);
          while(Buffer.byteLength(JSON.stringify(safe)+'\n')>=1024) {
            if(safe.message){safe.message=safe.message.slice(0,-8);continue;}
            if(safe.details.sandbox_command.stderr_first_line){safe.details.sandbox_command.stderr_first_line=safe.details.sandbox_command.stderr_first_line.slice(0,-8);continue;}
            safe.details.sandbox_command.runtime_path=safe.details.sandbox_command.runtime_path.slice(0,-8);
          }
        }
        return safe;
      };
      let kept=[];
      try {kept=(await fs.readFile(file,'utf8')).split('\n').filter(Boolean).slice(-49)
        .flatMap(line=>{try{return [project(JSON.parse(line))];}catch{return [];}});}catch{}
      const temp=file+'.'+process.pid+'.tmp';
      await fs.writeFile(temp,[...kept,project(entry)].map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});
      await fs.rename(temp,file);
    });
    // A failed write does not poison later diagnostics or shutdown, matching the app's old queue.
    pending=next.catch(()=>{});
    return next;
  }
  record.flush=()=>pending;
  return record;
}
