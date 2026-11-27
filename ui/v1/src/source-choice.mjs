export const SOURCE_CHOICES = [{id:'none',label:'No project'},{id:'folder',label:'Folder'},{id:'git',label:'Git URL'},{id:'files',label:'Files or ZIP'}];
export const sourceKind = draft => draft.sourceKind || 'folder';
export function sourceReady(draft, repo) {
 switch(sourceKind(draft)) {
  case 'none':return true;
  case 'git':return repo.status==='ok' && /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(draft.gitCommit || '');
  case 'files':return repo.status==='ok' && Boolean(draft.files?.length || draft.zip);
  default:return repo.status==='ok';
 }
}
export function validateUploadSelection(files) {
 if(files.length>1000)throw Object.assign(new Error('Choose up to 1,000 files.'),{code:'upload_file_limit'});
 if(files.reduce((n,f)=>n+f.size,0)>20*1024*1024)throw Object.assign(new Error('Choose files totalling no more than 20 MB.'),{code:'upload_size_limit'});
 if(files.some(f=>/\.zip$/i.test(f.name)) && files.length!==1)throw Object.assign(new Error('Choose one ZIP on its own, or individual files.'),{code:'upload_zip_selection'});
}
export function sourceSummary(draft) {
 switch(sourceKind(draft)) {
  case 'none':return 'No project files. Only your request is sent.';
  case 'git':return draft.gitCommit ? 'Pinned to commit '+draft.gitCommit : 'Choose a branch to pin its current commit.';
  case 'files':return draft.zip ? draft.zip.name : (draft.files?.length || 0)+(draft.files?.length===1?' file selected':' files selected');
  default:return '';
 }
}
export const byteWords = n => n>=1024*1024 ? (n/(1024*1024)).toFixed(1)+' MB' : n>=1024 ? (n/1024).toFixed(1)+' KB' : n+' bytes';
export const omissionReason = reason => ({credentials:'looked like credentials',not_source:'not source',ignored:'ignored by project rules',export_ignore:'excluded by archive rules',too_large:'too large',outside_project:'link outside the project'})[reason] || reason;
export async function readUploadSelection(selection) {
 const files=Array.from(selection);validateUploadSelection(files);
 const output=[];
 // Sequential reads bound the temporary browser memory; total size is checked first.
 for(const file of files) {
  const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Object.assign(new Error('Could not read the selected file.'),{code:'upload_read_failed'}));reader.readAsDataURL(file);});
  output.push({path:file.webkitRelativePath || file.name,base64});
 }
 return files.length===1 && /\.zip$/i.test(files[0].name) ? {zip:{name:files[0].name,base64:output[0].base64},files:[]} : {files:output,zip:null};
}

export const workingDirectoryProblem = value => value && (value.length>1024 || /[\\\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').some(part=>!part||part==='.'||part==='..')) ? 'Use a relative folder inside the project, for example packages/app.' : '';
