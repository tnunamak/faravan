// Presentation only: never use these lossy lines to build a signed result or receipt.
const MAX_LINE_BYTES=16*1024-1; // Leave room for the newline.
const MAX_TRANSCRIPT_BYTES=256*1024;
const MARKER=' [transcript line truncated]';

// Placeholder bytes count the UTF-8 base64 payload removed, not decoded media bytes.
function omitMedia(_key,value) {
  if(!value||typeof value!=='object')return value;
  if(['image','document'].includes(value.type)&&value.source?.type==='base64'&&typeof value.source.data==='string')
    return {type:value.type,omitted:true,media_type:value.source.media_type??null,bytes:Buffer.byteLength(value.source.data)};
  // Codex/Responses image and file content can carry a base64 data URL.
  if(['input_image','image_url','input_file'].includes(value.type)) {
    const url=value.image_url?.url??value.image_url??value.file_data;
    if(typeof url==='string') {
      const match=/^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
      if(match)return {type:value.type,omitted:true,media_type:match[1],bytes:Buffer.byteLength(match[2])};
    }
  }
  return value;
}

function displayLine(line) {
  let text=line,changed=false;
  try {
    const event=JSON.parse(line);
    const sanitized=JSON.stringify(event,(key,value)=>{
      const result=omitMedia(key,value);
      if(result!==value)changed=true;
      return result;
    });
    if(changed)text=sanitized;
  }catch{} // Providers can also emit plain text.
  const bytes=Buffer.byteLength(text);
  if(bytes<=MAX_LINE_BYTES)return {text,truncated:false};
  // Cutting serialized JSON directly would leave an invalid record. Wrap its head
  // as a text message, so the feed can still show it. Measure after JSON escaping.
  const record=head=>JSON.stringify({type:'assistant',message:{content:[{type:'text',text:head+MARKER}]},truncated:true,bytes});
  let low=0,high=Math.min(text.length,MAX_LINE_BYTES);
  while(low<high) {
    const middle=Math.ceil((low+high)/2);
    if(Buffer.byteLength(record(text.slice(0,middle)))<=MAX_LINE_BYTES)low=middle;
    else high=middle-1;
  }
  // Do not cut a UTF-16 surrogate pair.
  if(low>0&&/[\uD800-\uDBFF]/.test(text[low-1]))low--;
  return {text:record(text.slice(0,low)),truncated:true};
}

/** Frame each stream separately; retain a byte-bounded tail of complete display lines. */
export function createTranscriptBuffer() {
  const pending=new Map(),lines=[];
  let bytes=0,truncated=false;
  const appendLine=(line,newline)=>{
    const display=displayLine(line),text=display.text+newline;
    truncated ||= display.truncated;
    lines.push(text);bytes+=Buffer.byteLength(text);
    while(bytes>MAX_TRANSCRIPT_BYTES) {
      bytes-=Buffer.byteLength(lines.shift());truncated=true;
    }
    return text;
  };
  return {
    append(chunk,stream='stdout') {
      const text=(pending.get(stream)??'')+String(chunk??'');
      let start=0,index,out='';
      while((index=text.indexOf('\n',start))>=0) {
        out+=appendLine(text.slice(start,index),'\n');start=index+1;
      }
      pending.set(stream,text.slice(start));
      return out;
    },
    snapshot() {
      // A provider need not end its last line with a newline. Render pending data
      // without consuming it: later chunks can still complete the same JSON record.
      const tail=[...lines];
      let size=bytes,trimmed=truncated;
      for(const text of pending.values())if(text) {
        const display=displayLine(text);
        if(tail.length&&!tail.at(-1).endsWith('\n')){tail.push('\n');size++;}
        tail.push(display.text);size+=Buffer.byteLength(display.text);trimmed ||= display.truncated;
      }
      while(size>MAX_TRANSCRIPT_BYTES){size-=Buffer.byteLength(tail.shift());trimmed=true;}
      return {text:tail.join(''),truncated:trimmed};
    },
  };
}
