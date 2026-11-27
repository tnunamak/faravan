// Private command observations travel with their result/hold without becoming
// part of public recovery responses. The log writer reprojects them on disk.
const observations=new WeakMap();
export const sandboxCommandDiagnosticOf=value=>value&&typeof value==='object'?observations.get(value):undefined;
export function bindSandboxCommandDiagnostic(value,diagnostic) {
 if(value&&typeof value==='object'&&diagnostic)observations.set(value,diagnostic);
 return value;
}
const STAGES=new Set(['parse','complete','stderr nonempty','exit','timeout','fence']);
const COMMANDS=new Set(['ls --json','daemon status','create','run']);
const WITHHELD='[private details withheld]';
const credentialPath=/(?:credential-sources|credential-writers|provider-sources|(?:^|[\\/])\.(?:claude|codex|config|sbx)|(?:^|[\\/])(?:auth|credential-evidence)\.json|(?:^|[\\/])tokens?(?:[.\/_-]|$))/i;
// Redaction precedes slicing; a long value or an unavailable scanner withholds
// text. Neither argv supplied by sbx nor environment fields enter this schema.
export function sanitizeSandboxCommandDiagnostic(value,redact) {
 if(!value||!COMMANDS.has(value.subcommand)||!STAGES.has(value.stage))return undefined;
 const text=input=>{
  if(typeof input!=='string'||input.length>65536||credentialPath.test(input)||/(?:^|\s)[A-Z][A-Z0-9_]*=/.test(input))return WITHHELD;
  try{return redact(input).split(/[\r\n]/,1)[0].slice(0,160);}catch{return WITHHELD;}
 };
 const diagnostic={subcommand:value.subcommand,runtime_path:text(value.runtime_path),
  exit_code:Number.isInteger(value.exit_code)&&value.exit_code>=0&&value.exit_code<=255?value.exit_code:null,
  signal:typeof value.signal==='string'&&/^SIG[A-Z0-9]{1,12}$/.test(value.signal)?value.signal:null,
  timedOut:value.timedOut===true,killed:value.killed===true,truncated:value.truncated===true,
  duration_ms:Number.isFinite(value.duration_ms)&&value.duration_ms>=0?Math.min(Math.round(value.duration_ms),86400000):0,
  daemon_status_passed:typeof value.daemon_status_passed==='boolean'?value.daemon_status_passed:null,
  stage:value.stage,stderr_first_line:text(value.stderr_first_line),
  ...(Number.isInteger(value.attempts)&&value.attempts>=1&&value.attempts<=3?{attempts:value.attempts}:{})};
 while(new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength>640) {
  const key=diagnostic.stderr_first_line.length>diagnostic.runtime_path.length?'stderr_first_line':'runtime_path';
  diagnostic[key]=diagnostic[key].slice(0,-8);
 }
 return diagnostic;
}
