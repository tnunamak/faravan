// Continuations are bounded data. No session, identity, tool records or permissions travel here.
import {CONTEXT_HEADER,DELTA_HEADER} from './request-line.mjs';
import {sign,verify} from 'node:crypto';
import {canonicalize,exportPublicKey,importPublicKey,fingerprint} from '../protocol/index.mjs';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {scanText,classifyValue,sha256} from './credential-probe-guest.mjs';

// Outbound-only additions to the guest probe's token formats (that file is blob-pinned).
// Known prefixes match even when glued to preceding word characters, so a cut cannot leave a token's head behind.
const OUTBOUND_TOKEN_FORMATS=[
  /(?:\bsk-ant-[A-Za-z0-9_-]{16,}|sk-ant-(?:api|oat|admin)[0-9]{2}-[A-Za-z0-9_-]{16,})/,
  /sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{16,}/,
  /github_pat_[A-Za-z0-9_]{16,}/,
  /dckr_pat_[A-Za-z0-9_-]{16,}/,
  /authorization["']?[ \t]*[:=][ \t]*["']?bearer[ \t]+[^\s"']+/i,
];
// The pinned probe matches sk-ant- inside a word (risk-ant-...). Ignore its finding when every such match is glued to a preceding letter or digit;
// real Anthropic key shapes glued to text are still caught by OUTBOUND_TOKEN_FORMATS.
function gluedAnthropicHashes(line) {
  const glued=new Set(),bare=new Set();
  for(const match of line.matchAll(/sk-ant-[A-Za-z0-9_-]{16,}/g))(/[A-Za-z0-9]/.test(line[match.index-1]??'')?glued:bare).add(sha256(match[0]));
  for(const hash of bare)glued.delete(hash);
  return glued;
}
export function scanCredentialText(text,{knownValues=[]}={}) {
  text=String(text);
  // Do not run the versioned probe's unbounded assignment-name regex on
  // provider text. Tokenize names once, then parse values at that exact offset.
  const findings=[];
  const separator=/["']?\s*[:=]\s*/y,assignedValue=/"([^"\n]*)"|'([^'\n]*)'|([^\s,;#}\]"']+)/y;
  const secretName=/(token|secret|passw(?:or)?d|passwd|api[_-]?key|apikey|credential|bearer|authorization|auth|cookie|private[_-]?key)/i;
  for(const line of text.split('\n')) {
    if(line.length>65536||[...line.matchAll(/[A-Za-z0-9_.-]+/g)].some(match=>match[0].length>4096))
      return {ok:false,findings:[{code:'credential_scan_limit'}]};
    if(OUTBOUND_TOKEN_FORMATS.some(pattern=>pattern.test(line)))return {ok:false,findings:[{code:'credential_pattern'}]};
    const real=scanText(line,{config:false}).filter(item=>item.kind==='real'),glued=real.length?gluedAnthropicHashes(line):null;
    if(real.some(item=>!glued.has(item.full)))return {ok:false,findings:[{code:'credential_pattern'}]};
  }
  const names=/[A-Za-z0-9_.-]+/g;let name;
  while((name=names.exec(text))) {
    if(!secretName.test(name[0]))continue;
    separator.lastIndex=name.index+name[0].length;
    if(!separator.exec(text))continue;
    assignedValue.lastIndex=separator.lastIndex;
    const value=assignedValue.exec(text);
    if(!value)continue;
    // A value is one token, even if it contains more assignment-like text.
    // Do not classify every suffix of token=token=... independently.
    names.lastIndex=assignedValue.lastIndex;
    if(classifyValue(value[1]??value[2]??value[3])==='real')return {ok:false,findings:[{code:'credential_pattern'}]};
  }
  for(const match of text.matchAll(/\bmachine\s+\S+[\s\S]{0,200}?\bpassword\s+(\S+)/g))
    if(classifyValue(match[1])==='real')return {ok:false,findings:[{code:'credential_pattern'}]};
  if(knownValues.some(value=>typeof value==='string'&&value.length>0&&text.includes(value)))findings.push({code:'known_lender_value'});
  return {ok:findings.length===0,findings};
}
// Only in-memory values enter the scanner; neither values nor hashes go into the result.
export async function lenderCredentialValues({env=process.env,home=homedir(),read=readFile}={}) {
  const values=new Set();
  for(const [key,value] of Object.entries(env))if(/(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIALS?|COOKIE)(?:$|_)/i.test(key)&&typeof value==='string'&&value.length>=8)values.add(value);
  const files=[join(env.CLAUDE_CONFIG_DIR||join(home,'.claude'),'.credentials.json'),join(env.CODEX_HOME||join(home,'.codex'),'auth.json')];
  for(const file of files) {
    let content;try {content=await read(file,'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
    const walk=value=>{if(typeof value==='string'&&value.length>=8)values.add(value);else if(value&&typeof value==='object')Object.values(value).forEach(walk);};
    walk(JSON.parse(content));
  }
  return [...values];
}
function finalMessage(transcript) {
  let result='';
  for(const line of String(transcript??'').split('\n')) {
    let event;try{event=JSON.parse(line);}catch{continue;}
    if(event.type==='transcript.withheld')result='[private details withheld]';
    if(event.type==='result'&&typeof event.result==='string')result=event.result;
    if(event.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string')result=event.item.text;
    if(event.type==='assistant'&&Array.isArray(event.message?.content)) {
      const text=event.message.content.filter(part=>part.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n');
      if(text)result=text;
    }
  }
  return result;
}
function instructions(prompt) {
  const text=String(prompt),split=text.indexOf(DELTA_HEADER);
  if(text.startsWith(CONTEXT_HEADER)&&split>=0) {
    try {const context=JSON.parse(text.slice(CONTEXT_HEADER.length,split));return {objective:typeof context.objective==='string'?context.objective:'',latest:text.slice(split+DELTA_HEADER.length)};}catch{}
  }
  return {objective:text,latest:text};
}
const clip=value=>String(value??'').slice(0,1800);
export function buildHandoff({prompt='',transcript='',checks=[],knownValues=[],scan=scanCredentialText,scanUnavailable=false,scanUnavailableReason='known_value_scan_unavailable'}={}) {
  const claims=finalMessage(transcript),request=instructions(prompt);
  const observed=Array.isArray(checks)?checks.map(check=>({cmd:String(check.cmd??''),exit:check.exit??null,timed_out:check.timed_out===true,observed_by:'sandbox'})):[];
  // Scan the full selected content BEFORE bounding it. Do not export raw tool output.
  const selected=[request.objective,request.latest,claims,...observed.map(check=>check.cmd)].join('\n');
  const safe=!scanUnavailable&&!claims.includes('[private details withheld]')&&Buffer.byteLength(selected)<=65536&&scan(selected,{knownValues}).ok;
  return {schema:'faravan.continuation.v1',mode:'summary',trust:'untrusted',
    objective:safe?clip(request.objective):'',latest_instruction:safe?clip(request.latest):'',
    changes:safe?clip(claims):'',observed_checks:safe?observed.slice(0,4).map(check=>({...check,cmd:check.cmd.slice(0,500)})):[],
    agent_claims:safe?clip(claims):'',open_issues:[],next_steps:[],
    scan:{status:safe?'passed':'withheld',policy:'credential-rules-v1',...(scanUnavailable?{reason:scanUnavailableReason}:{})}};
}
const signedBytes=(handoff,binding)=>Buffer.from('faravan.continuation.v1\0'+canonicalize({handoff,binding}));
export function signHandoff(handoff,binding,privateKey) {
  return {type:'faravan.continuation',handoff,binding,public_key:exportPublicKey(privateKey),signature:sign(null,signedBytes(handoff,binding),privateKey).toString('base64url')};
}
export function readHandoff(transcript,expected) {
  let handoff=null;
  for(const line of String(transcript??'').split('\n')) {
    let record;try{record=JSON.parse(line);}catch{continue;}
    const value=record.type==='faravan.continuation'?record.handoff:null;
    if(!expected||!record.public_key||!record.signature||!record.binding)continue;
    try {
      if(fingerprint(record.public_key)!==expected.executor||
         ['circle','job_digest','attempt_id'].some(key=>record.binding[key]!==expected[key])||
         !verify(null,signedBytes(value,record.binding),importPublicKey(record.public_key),Buffer.from(record.signature,'base64url')))continue;
    }catch{continue;}
    if(value?.schema==='faravan.continuation.v1'&&value.mode==='summary'&&value.trust==='untrusted'&&
       ['passed','withheld'].includes(value.scan?.status)&&Buffer.byteLength(JSON.stringify(value))<=65536)handoff=value;
  }
  return handoff;
}
export function continuationPrompt(handoff,delta) {
  // A different lender may receive this job. Only borrower instructions and
  // sandbox observations cross that boundary; scanned agent prose can still
  // contain identity claims or private instructions that scanners do not know.
  const context={schema:'faravan.continuation.v1',mode:'summary',trust:'untrusted',
    objective:handoff.objective,latest_instruction:handoff.latest_instruction,
    observed_checks:(handoff.observed_checks??[]).map(({cmd,exit,timed_out})=>({cmd,exit,timed_out,observed_by:'sandbox'})),
    scan:{status:handoff.scan?.status==='passed'?'passed':'withheld',policy:'credential-rules-v1'}};
  return CONTEXT_HEADER+JSON.stringify(context)+DELTA_HEADER+delta;
}
