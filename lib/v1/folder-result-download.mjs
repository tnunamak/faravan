// Rebuild a verified patch against the sent archive, never the user's current folder.
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractArchive} from '../archive.mjs';
import {rejectMetadataRoot} from '../source-package.mjs';
import {parseUnifiedDiff, patchHazards} from '../git-candidate.mjs';
import {git} from './apply.mjs';
import {zipDirectory} from './result-download.mjs';
const fail=()=>{throw Object.assign(new Error('The changed files could not be rebuilt safely from the sent folder.'),{code:'result_unavailable',status:409});};
export async function prepareFolderResultDownload({source,patch,jobId='result'}) {
 if(!(source instanceof Uint8Array)||!(patch instanceof Uint8Array)||patch.byteLength>16*1024*1024)fail();
 const parsed=parseUnifiedDiff(patch);
 if(patchHazards(parsed).length||parsed.files.some(file=>file.newMode==='120000'||file.oldMode==='120000'))fail();
 const paths=parsed.files.filter(file=>file.status!=='deleted').map(file=>file.path);
 const scratch=await mkdtemp(join(tmpdir(),'faravan-changed-files-'));
 try {
  await extractArchive(source,scratch,{maxEntries:2000,maxTotalBytes:64*1024*1024,maxFileBytes:64*1024*1024,preserveExecutable:true});
  await rejectMetadataRoot(scratch);
  if((await git(['init','-q','--template='],{cwd:scratch})).code!==0)fail();
  if(patch.length&&(await git(['apply','--binary','--whitespace=nowarn','-'],{cwd:scratch,input:patch})).code!==0)fail();
  const bytes=await zipDirectory(scratch,{paths});
  const stem=String(jobId).replace(/^sha256:/,'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,64);
  return {bytes,contentType:'application/zip',filename:'faravan-'+stem+'-changed-files.zip'};
 } finally {await rm(scratch,{recursive:true,force:true});}
}
