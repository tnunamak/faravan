import {jobDiffVM} from './view-models.mjs';
// Counts use a number formatter; dates go through dates.mjs.
const count = value => new Intl.NumberFormat('en-US').format(value);
export const REVIEW_LINE_LIMIT = 4000;
// Legacy preview servers omit file hashes. Keep their local keys bounded without claiming cryptographic identity.
function legacyReviewFingerprint(file) {
  const value=JSON.stringify([file.path,file.rows,file.binary,file.status]);let hash=2166136261;
  for(let n=0;n<value.length;n++)hash=Math.imul(hash^value.charCodeAt(n),16777619);
  return 'legacy:'+value.length+':'+(hash>>>0).toString(16);
}
export function reviewFiles(data) {
  return jobDiffVM(data).files.map(file => ({...file,
    directory:file.path.includes('/') ? file.path.slice(0,file.path.lastIndexOf('/')) : 'Project root',
    generated:/(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|dist\/|build\/)|\.min\.(?:js|css)$/.test(file.path),
    hash:data.files?.find(row=>row.path===file.path)?.hash ?? legacyReviewFingerprint(file),
  }));
}
export function reviewKey(circle,result,file) { return JSON.stringify([circle,result,file.path,file.hash]); }
export function reviewCoverage(data) {
  const lines=String(data.diff??'').split('\n');if(lines.at(-1)==='')lines.pop();
  const shown=Math.min(lines.length,REVIEW_LINE_LIMIT),total=data.total_lines??lines.length;
  const bytes=Number.isSafeInteger(data.shown_bytes) ? `${count(data.shown_bytes)} of ${count((data.bytes??data.shown_bytes))} bytes` : null;
  const coverage=data.truncated&&!Number.isSafeInteger(data.total_lines)?`${count(shown)} diff lines from a truncated preview; total not recorded`:`${count(shown)} of ${count(total)} diff lines`;
  return `Showing ${coverage}${bytes?' · '+bytes:''}${data.more_files?` · ${data.more_files} files omitted`:''}.`;
}
export function reviewNotePrompt(notes) {
  return 'Please make these changes:\n\n'+notes.map(note=>`- ${note.path} (${note.side} line ${note.line}): ${note.text.trim().slice(0,2000)}`).join('\n');
}
// Local review preferences may be unavailable in private browsing. Reading code must still work.
export function readReview(storage,key) {try {const data=JSON.parse(storage?.getItem('faravan.review.'+key)??'{}');return {viewed:data.viewed===true,notes:Array.isArray(data.notes)?data.notes.filter(n=>n&&typeof n.text==='string'&&n.text.length<=2000&&Number.isInteger(n.line)&&n.line>0&&['old','new'].includes(n.side)).slice(0,50):[]};}catch{return {viewed:false,notes:[]};}}
export function writeReview(storage,key,value) {try{if(!storage)return false;storage.setItem('faravan.review.'+key,JSON.stringify(value));return true;}catch{return false;}}

export function splitRows(rows) {
  const pairs=[];
  for(let index=0;index<rows.length;) {
    const row=rows[index];
    if(['del','add'].includes(row.kind)) {
      const removed=[],added=[];
      while(rows[index]?.kind==='del')removed.push(rows[index++]);
      while(rows[index]?.kind==='add')added.push(rows[index++]);
      for(let n=0;n<Math.max(removed.length,added.length);n++)pairs.push({old:removed[n]??null,new:added[n]??null});
    }else {pairs.push({old:row,new:row});index++;}
  }
  return pairs;
}

export function syntaxParts(text,path) {
  if(!/\.(?:[cm]?[jt]sx?|py|go|rs|java|c|h|cpp|cs)$/.test(path))return [{text}];
  const parts=[];let at=0;
  const tokens=/\/\/.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|import|from|export|class|new|async|await|throw|try|catch|def|for|while|in|None|True|False|null|true|false|public|private|static|void|package|func|fn|use|struct|impl)\b|\b\d+(?:\.\d+)?\b/g;
  for(const match of text.matchAll(tokens)) {
    if(match.index>at)parts.push({text:text.slice(at,match.index)});
    const value=match[0],kind=value.startsWith('//')?'comment':/^["'`]/.test(value)?'string':/^\d/.test(value)?'number':'keyword';
    parts.push({text:value,kind});at=match.index+value.length;
  }
  if(at<text.length)parts.push({text:text.slice(at)});return parts;
}
