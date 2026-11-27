import {createTranscriptRedactor,redactTranscriptText} from './v1/transcript-redaction.mjs';
import {sandboxCommandDiagnosticOf,sanitizeSandboxCommandDiagnostic} from './sandbox-command-diagnostic.mjs';
const WITHHELD='[private details withheld]';

export function sandboxCommandDiagnostic(result,{subcommand='ls --json',runtime_path='',duration_ms=0,daemon_status_passed=null,stage}={}) {
 const existing=sandboxCommandDiagnosticOf(result);if(existing)return existing;
 const timedOut=result?.timedOut===true||result?.errorCode==='ETIMEDOUT'||result?.code==='ETIMEDOUT'||result?.name==='TimeoutError'||result?.code==='wall_timeout';
 const exit=Number.isInteger(result?.code)&&!timedOut&&!result?.killed&&!result?.signal&&
  (result?.errorCode==null||typeof result.errorCode==='number')?result.code:null;
 if(!stage) {
  if(timedOut)stage='timeout';
  else if(result?.sbxLaunchRefused||result?.code==='SBX_DAEMON_UNVERIFIED'||result?.errorCode==='SBX_DAEMON_UNVERIFIED')stage='fence';
  else if(exit!==null&&exit!==0)stage='exit';
  else if(result?.truncated||result?.killed||result?.signal||result?.errorCode)stage='complete';
  else if(result?.stderr?.trim())stage='stderr nonempty';
  else stage=['create','run'].includes(subcommand)?'complete':'parse';
 }
 let redact;try{const scanner=createTranscriptRedactor({maxTextLength:65536});redact=value=>redactTranscriptText(value,scanner);}catch{redact=()=>WITHHELD;}
 return sanitizeSandboxCommandDiagnostic({subcommand,runtime_path,duration_ms,daemon_status_passed,stage,exit_code:exit,
  signal:result?.signal,timedOut,killed:result?.killed,truncated:result?.truncated,
  stderr_first_line:result?.stderr??result?.message??''},redact);
}
