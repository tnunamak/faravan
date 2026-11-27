// Input must be candidate bytes verified against the signed result by fetchResult.
import {readArchiveFiles} from '../archive.mjs';
import {rasterPreview} from '../raster-preview.mjs';
const PREVIEW_BYTES = 256 * 1024;
const policy = {gzip:true,maxEntries:2000,maxTotalBytes:64*1024*1024,maxFileBytes:64*1024*1024,requiredRoot:['faravan-output','faravan-output']};
const isOutput = path => path.startsWith('faravan-output/') || path.startsWith('faravan-output/');
const filesOf = bytes => {
  if (bytes.length > 16*1024*1024) throw Object.assign(new Error('Result is too large'),{code:'result_too_large'});
  return readArchiveFiles(bytes,policy).filter(file => isOutput(file.path));
};
function textPreview(bytes, limit) {
  if(limit<=0)return null;
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,limit),{stream:true});}catch{return null;}
  return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) ? null : text;
}
export function readOutputFile(bytes, path) {
  if (typeof path!=='string' || !isOutput(path)) return null;
  const file=filesOf(bytes).find(file=>file.path===path);
  return file ? {...file,...(rasterPreview(path,file.bytes)??{})} : null;
}
/** Last completed assistant message from the verified provider transcript, never tool output. */
export function finalMessage(transcript='') {
  let message='';
  for(const line of String(transcript).split('\n')) {
    let event;try{event=JSON.parse(line);}catch{continue;}
    if(event===null || typeof event!=='object' || Array.isArray(event))continue;
    if(event.type==='item.completed'&&event.item?.type==='agent_message'&&(!event.item.phase||event.item.phase==='final_answer')&&typeof event.item.text==='string')message=event.item.text;
    if(event.type==='assistant'&&Array.isArray(event.message?.content)) {
      const text=event.message.content.filter(item=>item!==null&&typeof item==='object'&&!Array.isArray(item)&&item.type==='text'&&typeof item.text==='string').map(item=>item.text).join('\n');
      if(text)message=text;
    }
    if(event.type==='result'&&event.is_error!==true&&(!event.subtype||event.subtype==='success')&&typeof event.result==='string')message=event.result;
  }
  return message.trim();
}
export function resultOutputView({bytes,output,transcript='',digest,circle}) {
  let files=[],downloadOnly=false;
  try{files=filesOf(bytes).sort((a,b)=>a.path.localeCompare(b.path));}
  catch(error){if(error.code!=='too_large'&&error.code!=='result_too_large')throw error;downloadOnly=true;}
  const kind=output?.kind==='message'?'message':'files';
  const text=finalMessage(transcript),base='/api/jobs/'+encodeURIComponent(digest);
  let budget=512*1024;
  return {format:kind,message:{markdown:text.slice(0,PREVIEW_BYTES),truncated:text.length>PREVIEW_BYTES,
    url:base+'/message?'+new URLSearchParams(circle?{circle}:{})},
    download_only:downloadOnly,
    warning:[!text?'The agent did not include a final message. These are the files it returned.':'',downloadOnly?'Files exceed the preview limits. Download all files to review them.':''].filter(Boolean).join(' '),
    files:files.slice(0,200).map(file=>{
      const query=new URLSearchParams({...(circle?{circle}:{}),path:file.path});
      const oversize=file.bytes.length>16*1024*1024;
      const raster=oversize?null:rasterPreview(file.path,file.bytes);
      const media_type=raster?.media_type;
      const downloadOnly=oversize||(/\.(?:png|jpe?g|gif|webp)$/i.test(file.path)&&!raster);
      const limit=Math.min(32*1024,budget),text=media_type||downloadOnly?null:textPreview(file.bytes,limit);
      if(text!==null)budget-=Math.min(file.bytes.length,limit);
      return {path:file.path,bytes:file.bytes.length,url:base+'/file?'+query,...(downloadOnly?{download_only:true}:{}),
        ...(media_type&&file.bytes.length<=10*1024*1024?{preview:{...raster,url:base+'/image?'+query}}:{}),
        ...(text!==null?{text,truncated:file.bytes.length>limit}:{})};
    }),more_files:Math.max(0,files.length-200)};
}
