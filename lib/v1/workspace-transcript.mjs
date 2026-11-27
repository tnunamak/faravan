import {createTranscriptRedactor,redactTranscriptText,createTranscriptLabels,WITHHELD_TRANSCRIPT_RECORD} from './transcript-redaction.mjs';
const MAX_LINE=1024*1024,WITHHELD='[private details withheld]';
// Buffer complete provider records so a split email or credential never leaves in an earlier chunk.
export function workspaceTranscript(root,options={}) {
  if(typeof root!=='string'||!root)throw new TypeError('A private workspace prefix is required');
  const pending=new Map(),redact=createTranscriptRedactor({...options,maxTextLength:MAX_LINE});
  const omittedRecord=WITHHELD_TRANSCRIPT_RECORD;
  const omitted=JSON.stringify(omittedRecord);
  const scalar=value=>redactedText(String(value??''));
  const tools=new Set(['Bash','Read','Write','Edit','MultiEdit','NotebookEdit','Grep','Glob','LS','WebFetch','WebSearch','TodoWrite','Task','Agent']);
  const {command,path}=createTranscriptLabels(scalar,{roots:[root,'/workspace']});
  const fact=value=>{
    if(!['number','boolean'].includes(typeof value))return undefined;
    return scalar(value)===String(value)?value:undefined;
  };
  const usage=value=>Object.fromEntries(['input_tokens','output_tokens','cached_input_tokens','cache_read_input_tokens','cache_creation_input_tokens']
    .filter(key=>typeof value?.[key]==='number'&&fact(value[key])!==undefined).map(key=>[key,value[key]]));
  function block(value) {
    if(!value||typeof value!=='object')return null;
    const media=omitMedia(value);if(media)return media;
    if(value.type==='text')return {type:'text',text:scalar(value.text)};
    if(value.type==='tool_use'&&tools.has(value.name))return {type:'tool_use',name:scalar(value.name),input:value.name==='Bash'?{command:command(value.input?.command)}:{file_path:path(value.input?.file_path),path:path(value.input?.path),notebook_path:path(value.input?.notebook_path)}};
    if(value.type==='tool_result')return {type:'tool_result',content:Array.isArray(value.content)?value.content.slice(0,32).map(omitMedia).filter(Boolean):''};
    return null;
  }
  // Signed transcripts expose only these provider fields. Raw tool output,
  // arbitrary metadata and provider correlation IDs never cross the boundary.
  function project(event) {
    if(!event||typeof event!=='object'||Array.isArray(event))return omittedRecord;
    if(['assistant','user'].includes(event.type)) {
      const message=typeof event.message==='string'?scalar(event.message):{content:(Array.isArray(event.message?.content)?event.message.content:[]).slice(0,32).map(block).filter(Boolean)};
      return {type:event.type,message};
    }
    if(event.type==='result')return {type:'result',result:scalar(event.result),...(fact(event.is_error)===undefined?{}:{is_error:event.is_error})};
    if(['turn.started','turn.completed','turn.failed'].includes(event.type))return {type:event.type,...(event.usage?{usage:usage(event.usage)}:{})};
    if(['item.started','item.updated','item.completed'].includes(event.type)) {
      const item=event.item;
      if(item?.type==='agent_message')return {type:event.type,item:{type:item.type,text:scalar(item.text)}};
      if(item?.type==='command_execution')return {type:event.type,item:{type:item.type,command:command(item.command),...(fact(item.exit_code)===undefined?{}:{exit_code:item.exit_code})}};
      if(item?.type==='file_change')return {type:event.type,item:{type:item.type,changes:(Array.isArray(item.changes)?item.changes:[]).slice(0,32).map(change=>({path:path(change?.path)}))}};
      if(item?.type==='error')return {type:event.type,item:{type:item.type,message:scalar(item.message)}};
    }
    if(event.type==='error')return {type:'error',message:scalar(event.message)};
    return null;
  }
  const mediaBytes=value=>{const bytes=Buffer.byteLength(value);return fact(bytes)===undefined?{}:{bytes};};
  function omitMedia(value) {
    if(!value||typeof value!=='object')return null;
    if(['image','document'].includes(value.type)&&value.source?.type==='base64'&&typeof value.source.data==='string')
      return {type:value.type,omitted:true,media_type:scalar(value.source.media_type??''),...mediaBytes(value.source.data)};
    if(['input_image','image_url','input_file'].includes(value.type)) {
      const url=value.image_url?.url??value.image_url??value.file_data;
      const match=typeof url==='string'&&/^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
      if(match)return {type:value.type,omitted:true,media_type:scalar(match[1]),...mediaBytes(match[2])};
    }
    return null;
  }
  function redactedText(value) {
    return redactTranscriptText(value.split(root).join('/workspace'),redact);
  }
  const line=value=>{
    if(!value)return '';
    if(options.scanUnavailable||value.length>MAX_LINE)return omitted;
    let event;try{event=JSON.parse(value);}catch{const safe=redactedText(value);return safe.includes(WITHHELD)?omitted:safe;}
    try{const projected=project(event);if(!projected)return '';const json=JSON.stringify(projected);return json.includes(WITHHELD)?omitted:json;}catch{return omitted;}
  };
  return {
    text:value=>String(value??'').split('\n').map(line).filter((row,i,all)=>row||i===all.length-1).join('\n'),
    append(stream,chunk){
      let {value='',dropping=false}=pending.get(stream)??{},output='';
      for(const part of String(chunk??'').split(/(?<=\n)/)){
        const end=part.endsWith('\n'),piece=end?part.slice(0,-1):part;
        if(!dropping&&value.length+piece.length<=MAX_LINE)value+=piece;
        else {value='';dropping=true;}
        if(end){const row=dropping?omitted:line(value);if(row)output+=row+'\n';value='';dropping=false;}
      }
      pending.set(stream,{value,dropping});return output;
    },
    end(stream){const state=pending.get(stream);pending.delete(stream);return state?(state.dropping?omitted:line(state.value)):'';}
  };
}
