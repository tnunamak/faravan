// Shared outbound text policy for live activity and uploaded transcripts.
import {scanCredentialText} from './continuation.mjs';
import {classifyEnv,shannon} from './credential-probe-guest.mjs';
import {homedir} from 'node:os';
const WITHHELD='[private details withheld]';
// Match the trust probe's secret-name categories, but protect every known value regardless of its heuristic verdict.
// Keep this stricter outbound rule outside the versioned guest probe; changing that file invalidates safety evidence.
const PRIVATE_ENV_NAME = /(?:^|[_-])(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|apikey|credentials?|bearer|authorization|auth|cookie|private[_-]?key|session[_-]?key)(?:$|[_-])/i;
const environmentPrivateValues = () => Object.entries(process.env)
  .filter(([key,value]) => {
    if(typeof value!=='string'||value.length<8||/^(?:true|false|[0-9.]+)$/i.test(value)||shannon(value)<2)return false;
    if(/(?:^|[_-])(?:enabled|disabled)$/i.test(key)&&/^(?:true|false|0|1)$/i.test(value))return false;
    return PRIVATE_ENV_NAME.test(key)||value.length>4096||classifyEnv(key,value)?.kind==='real';
  })
  .map(([,value]) => value);

export function createTranscriptRedactor({privateValues=environmentPrivateValues(),home=homedir(),scanUnavailable=false,maxTextLength=6000}={}) {
  privateValues=[...new Set([...environmentPrivateValues(),...privateValues])];
  const privateHome=typeof home==='string'&&home.length>1?new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:/[^\\s"\'<>]*)?','g'):null;
  return value => {
    if(typeof value!=='string'||!value)return '';
    if(scanUnavailable||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))return WITHHELD;
    if(!scanCredentialText(value,{knownValues:privateValues}).ok)return WITHHELD;
    let safe=value.toWellFormed();
    if(privateHome)safe=safe.replace(privateHome,WITHHELD);
    safe=safe.replace(/(^[ \t]*|[{,][ \t]*)(["']?(?:account|session|organization|user|device)(?:[_-]?(?:id|name|email))?["']?[ \t]*[:=][ \t]*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\n,;}]+))/gim,
      (match,prefix,key,double,single,bare,offset,input)=>{
        const quoted=/^["']/.test(key),specific=/(?:id|name|email)["']?[ \t]*[:=]/i.test(key);
        if(!quoted&&!specific) {
          // Bare '=' labels are source assignments. Unquoted object members
          // and parameter lists are code, while a plain 'user: alice' is a log.
          if(key.includes('=')||/[{,]/.test(prefix))return match;
          if(bare!==undefined&&/^[A-Za-z_]\w*(?:\[[^\]]+\])?[; ]*$/.test(bare)&&input[offset+match.length]===';')return match;
        }
        const quote=double!==undefined?'"':single!==undefined?"'":'';
        return prefix+key+quote+WITHHELD+quote;
      });
    safe=safe.replace(/(\b(?:signed|logged)\s+in\s+as[ \t]+)[^\s,;]+/gi,'$1'+WITHHELD);
    safe=safe.replace(/(https?:\/\/)[^/@\s]+@/gi,'$1'+WITHHELD+'@');
    if(safe.includes('@'))safe=safe.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi,(match,offset,input)=>
        match.startsWith('git@')&&input[offset+match.length]===':'||
        match.startsWith('//git@')&&input[offset+match.length]==='/'&&/\b(?:ssh|git\+ssh):$/i.test(input.slice(Math.max(0,offset-8),offset))?match:WITHHELD);
    return safe.slice(0,maxTextLength).replace(/[\uD800-\uDBFF]$/,'');
  };
}

// Use the same bounded decoder for signed records and the live presentation channel.
export function redactTranscriptText(value,redact) {
  if(value.length>65536)return WITHHELD;
  let decoded=value,invalid=false;
  for(let pass=0;pass<4;pass++) {
    const next=decoded.replace(/\\u([a-f0-9]{4})|((?:%[a-f0-9]{2})+)|&#(x[a-f0-9]{1,6}|[0-9]{1,7});|&(amp|commat|period|sol|bsol|colon);/gi,
      (match,unicode,percent,entity,named)=>{
        if(named)return {amp:'&',commat:'@',period:'.',sol:'/',bsol:'\\',colon:':'}[named.toLowerCase()];
        if(percent){try{return decodeURIComponent(percent);}catch{invalid=true;return '';}}
        const code=unicode?parseInt(unicode,16):entity[0].toLowerCase()==='x'?parseInt(entity.slice(1),16):Number(entity);
        return code<=0x10ffff?String.fromCodePoint(code):match;
      });
    if(invalid)return WITHHELD;
    if(next===decoded){const safe=redact(decoded);return decoded===value?safe:safe===decoded?redact(value):WITHHELD;}
    decoded=next;
  }
  return WITHHELD;
}

export const WITHHELD_TRANSCRIPT_RECORD=Object.freeze({type:'transcript.withheld',omitted:true,reason:'private details withheld'});

/** Labels contain no edit bodies, shell arguments, raw output or paths outside the job roots. */
export function createTranscriptLabels(text,{roots=['/workspace']}={}) {
  return {
    path(value) {
      if(typeof value!=='string'||value.length>4096)return '';
      let path=value;
      for(const root of roots)if(path.startsWith(root+'/')){path=path.slice(root.length+1);break;}
      // Check both spellings, before text decoding, with identical containment rules.
      // Invisible, unassigned, private-use and surrogate code points could split a private value.
      const valid=candidate=>candidate&&!/^(?:[\\/~\s]|[A-Za-z][A-Za-z0-9+.-]*:)/u.test(candidate)&&
        !candidate.endsWith(' ')&&!/[\\\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}\p{Cs}]/u.test(candidate.replaceAll(' ',''))&&
        !candidate.split('/').includes('..')&&!/%|&#|\\u|&(?:amp|commat|period|sol|bsol|colon);/i.test(candidate);
      const normalized=path.normalize('NFKC');
      const syntax=candidate=>(candidate.match(/[\/\\.:~%& ]/g)??[]).join('');
      if(!valid(path)||!valid(normalized)||syntax(path)!==syntax(normalized))return '';
      // A private value must not pass in either spelling.
      const safe=text(path);
      return safe.includes(WITHHELD)||text(normalized).includes(WITHHELD)?'':safe;
    },
    command(value) {
      if(typeof value!=='string'||!value||value.length>65536)return '';
      const safe=text(value);
      if(safe.includes(WITHHELD))return '';
      const check=/^(?:(?:npm|pnpm|yarn) (?:test|run [\w:-]+)|(?:go|cargo) test|node --test|pytest)(?=$|\s)/.exec(safe);
      if(check)return check[0].slice(0,238)+(safe.length>Math.min(check[0].length,238)?' …':'');
      // Only fixed executable names become public. Never echo arbitrary arguments or heredoc bodies.
      const executable=/^(?:python3?|node|npm|pnpm|yarn|go|cargo|pytest|git|cat|sed|grep|rg|ls|find|make|bash|sh)(?=$|\s)/.exec(safe);
      return executable?executable[0]+(safe.length>executable[0].length?' …':''):'';
    },
  };
}
