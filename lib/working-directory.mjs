// One invariant shared by submission, signed protocol validation and guest execution.
import {shellQuote} from './harnesses/job-framing.mjs';
export function validateWorkingDirectory(value) {
 if(typeof value!=='string'||!value||value.length>1024||/[\\\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||/^[A-Za-z]:/.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))
  throw Object.assign(new Error('Choose a relative working directory inside the project.'),{code:'invalid_working_directory',status:400});
 return value;
}
export function workingDirectoryCheck(root,value) {
 validateWorkingDirectory(value);
 const prefixes=[root];for(const part of value.split('/'))prefixes.push(prefixes.at(-1)+'/'+part);
 return prefixes.map(path=>'test -d '+shellQuote(path)+' && test ! -L '+shellQuote(path)).join(' && ')+" && printf 'FARAVAN_WORKDIR_OK\\n'";
}
