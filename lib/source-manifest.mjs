// A receipt for the exact filtered snapshot. Never include file contents or local absolute paths.
import {gzipSync} from 'node:zlib';
import {readArchiveEntries} from './archive.mjs';
import {digestBytes} from './protocol/index.mjs';
const MAX_LIST=1000,MAX_LIST_BYTES=48*1024;
const OMISSION_REASONS=new Set(['credentials','not_source','ignored','export_ignore','too_large','outside_project']);
function bounded(items) {
 let bytes=0;
 return items.filter((item,index)=>{bytes+=Buffer.byteLength(JSON.stringify(item));return index<MAX_LIST && bytes<=MAX_LIST_BYTES;});
}
export function buildSourceManifest(tar,{omitted=[],includeOmittedPaths=false}={}) {
 const entries=readArchiveEntries(tar,{allowGit:true}).filter(entry=>entry.type==='0');
 const all=entries.map(entry=>({path:entry.name,bytes:entry.data.length}));
 const unique=[...new Map(omitted.map(file=>[file.path,file])).values()];
 const counts=new Map();
 for(const file of unique) {
  const reason=OMISSION_REASONS.has(file.reason)?file.reason:'other',directory=file.kind==='directory';
  const key=reason+':'+directory;
  const group=counts.get(key)??{reason,count:0,...(directory?{kind:'directory'}:{})};
  group.count++;counts.set(key,group);
 }
 // Only local previews opt into names. Signed manifests use fixed reason codes.
 const files=bounded(all),notSent=includeOmittedPaths?bounded(unique):[...counts.values()],packed=gzipSync(tar);
 return {schema:'faravan.source-manifest.v1',archive_digest:digestBytes(packed),file_count:all.length,total_bytes:all.reduce((n,file)=>n+file.bytes,0),packed_bytes:packed.length,
  files,files_truncated:files.length<all.length,not_sent:notSent,not_sent_count:unique.length,not_sent_truncated:includeOmittedPaths&&notSent.length<unique.length,check:'filename-rules-only'};
}
