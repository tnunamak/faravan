import {createHash} from 'node:crypto';
// Coverage and review invalidation refer to the complete verified artifact, before preview clipping.
export function resultReviewMetadata(bytes,view) {
  if(view.format && view.format!=='diff')return {};
  const raw=Buffer.from(bytes),starts=[];
  if(raw.subarray(0,11).toString()==='diff --git ')starts.push(0);
  let cursor=0;
  while((cursor=raw.indexOf('\ndiff --git ',cursor))!==-1){starts.push(cursor+1);cursor+=12;}
  const lines=raw.toString('utf8').split('\n');if(lines.at(-1)==='')lines.pop();
  return {shown_bytes:Buffer.byteLength(view.diff??''),total_lines:lines.length,
    files:(view.files??[]).map((file,index)=>({...file,hash:'sha256:'+createHash('sha256').update(raw.subarray(starts[index]??raw.length,starts[index+1]??raw.length)).digest('hex')}))};
}
