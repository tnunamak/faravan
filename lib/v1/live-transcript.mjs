// A lossy, bounded presentation channel. Signed result bytes never pass through it.
import {createTranscriptRedactor,redactTranscriptText,createTranscriptLabels,WITHHELD_TRANSCRIPT_RECORD} from './transcript-redaction.mjs';

const MAX_LINE = 65536, MAX_SNAPSHOT = 65536, INTERVAL = 5000, MAX_UPDATES = 2048;
const TOOLS = new Set(['Bash','Read','Write','Edit','MultiEdit','NotebookEdit','Grep','Glob','LS','WebFetch','WebSearch','TodoWrite','Task','Agent']);
const INPUT_KEYS = ['command','file_path','path','notebook_path'];

/** Project only fields the feed renders; provider account, session and auth records never travel. */
export function createRelayTranscript(redaction={}) {
  const redact=createTranscriptRedactor(redaction);
  const text=value=>redactTranscriptText(String(value??''),redact);
  // Scan both the provider fact and any bounded value that will actually leave.
  const fact=(key,value,project=value=>value)=>{
    if(value===undefined||text(String(value))!==String(value))return {};
    const projected=project(value);
    return text(String(projected))===String(projected)?{[key]:projected}:{};
  };
  const pending=new Map(),lines=[],ids=new Map();
  let bytes=0,truncated=false,nextId=0;
  const id = value => {
    if(typeof value!=='string'||!value||value.length>512)return '';
    if(!ids.has(value)) {
      // Tool correlation is bounded independently of the transcript tail.
      if(ids.size>=2048)ids.delete(ids.keys().next().value);
      ids.set(value,'activity-'+(++nextId));
    }
    return ids.get(value);
  };
  const {path,command}=createTranscriptLabels(text);
  function project(event) {
    if(!event||typeof event!=='object')return null;
    if(event.type==='transcript.withheld'||redaction.scanUnavailable)return WITHHELD_TRANSCRIPT_RECORD;
    const timestamp=typeof event.timestamp==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(event.timestamp)?fact('timestamp',event.timestamp):{};
    if(['assistant','user'].includes(event.type)&&Array.isArray(event.message?.content)) {
      const content=[];
      for(const block of event.message.content.slice(0,32)) {
        if(block?.type==='text'&&typeof block.text==='string')content.push({type:'text',text:text(block.text)});
        if(block?.type==='tool_use'&&TOOLS.has(block.name)) {
          const input={};
          for(const key of INPUT_KEYS)if(typeof block.input?.[key]==='string')input[key]=key==='command'?command(block.input[key]):['file_path','path','notebook_path'].includes(key)?path(block.input[key]):text(block.input[key]);
          content.push({type:'tool_use',id:id(block.id),name:block.name,input});
        }
        if(block?.type==='tool_result')content.push({type:'tool_result',tool_use_id:id(block.tool_use_id),content:'',...fact('is_error',block.is_error===true)});
      }
      return content.length?{type:event.type,...timestamp,message:{content}}:null;
    }
    if(event.type==='tool_progress'&&Number.isFinite(event.elapsed_time_seconds)&&event.elapsed_time_seconds>=0)
      return {type:event.type,parent_tool_use_id:id(event.parent_tool_use_id),...fact('elapsed_time_seconds',event.elapsed_time_seconds,value=>Math.min(value,86400)),...timestamp};
    if(event.type==='result')return {type:'result',result:text(event.result),...fact('is_error',event.is_error===true),...timestamp};
    const item=event.item;
    if(['item.started','item.updated','item.completed'].includes(event.type)&&item) {
      const common={type:event.type,...timestamp,item:{id:id(item.id),type:item.type}};
      if(item.type==='agent_message')Object.assign(common.item,{text:text(item.text)});
      else if(item.type==='command_execution')Object.assign(common.item,{command:command(item.command),aggregated_output:'',
        ...fact('exit_code',Number.isSafeInteger(item.exit_code)?item.exit_code:null),status:['failed','completed','in_progress'].includes(item.status)?item.status:'in_progress'});
      else if(item.type==='file_change')common.item.changes=(Array.isArray(item.changes)?item.changes:[]).slice(0,32).map(change=>({path:path(change?.path)}));
      else if(item.type==='error')common.item.message=text(item.message);
      else return null;
      return common;
    }
    if(event.type==='error')return {type:'error',message:text(event.message),...timestamp};
    // Plain stderr, init, credentials, usage, image data and unknown provider records stay local.
    return null;
  }
  function add(value) {
    let row=JSON.stringify(value)+'\n';
    if(row.includes('[private details withheld]'))row=JSON.stringify(WITHHELD_TRANSCRIPT_RECORD)+'\n';
    if(Buffer.byteLength(row)>16384){row=JSON.stringify(WITHHELD_TRANSCRIPT_RECORD)+'\n';truncated=true;}
    lines.push(row);bytes+=Buffer.byteLength(row);
    while(bytes>MAX_SNAPSHOT){bytes-=Buffer.byteLength(lines.shift());truncated=true;}
  }
  return {
    append(chunk,stream='stdout') {
      let {value='',dropping=false}=pending.get(stream)??{};
      // Scan chunks incrementally so a huge newline-free line never becomes retained state.
      const incoming=String(chunk??'');let from=0,index;
      while((index=incoming.indexOf('\n',from))>=0) {
        const piece=incoming.slice(from,index);from=index+1;
        if(!dropping&&value.length+piece.length<=MAX_LINE) {
          try{const event=project(JSON.parse(value+piece));if(event)add(event);}catch{}
        }else truncated=true;
        value='';dropping=false;
      }
      const rest=incoming.slice(from);
      if(!dropping&&value.length+rest.length<=MAX_LINE)value+=rest;
      else {value='';dropping=true;truncated=true;}
      pending.set(stream,{value,dropping});
    },
    snapshot:()=>({text:lines.join(''),truncated}),
  };
}

/** Coalesce to one in-flight request and one timer; a broken relay cannot stop an agent. */
export function createTranscriptPublisher({send,now=Date.now,schedule=setTimeout,unschedule=clearTimeout,...redaction}={}) {
  const transcript=createRelayTranscript(redaction);
  let seq=0,last=-Infinity,timer=null,closed=false,dirty=false,inFlight=false,chain=Promise.resolve(),previous='';
  function queue() {
    if(closed||inFlight||!dirty||seq>=MAX_UPDATES||timer!==null)return;
    if(now()-last>=INTERVAL)flush();
    else {timer=schedule(flush,INTERVAL-(now()-last));timer?.unref?.();}
  }
  function flush() {
    timer=null;
    if(closed||inFlight||!dirty||seq>=MAX_UPDATES)return;
    const snapshot=transcript.snapshot();
    dirty=false;
    const key=JSON.stringify(snapshot);
    if(key===previous)return;
    last=now();
    const entry={seq:++seq,...snapshot};
    inFlight=true;
    chain=Promise.resolve().then(()=>send(entry)).then(()=>{previous=key;},()=>{dirty=true;}).finally(()=>{inFlight=false;queue();});
  }
  return {
    append(chunk,stream) {
      if(closed||seq>=MAX_UPDATES)return;
      transcript.append(chunk,stream);dirty=true;
      queue();
    },
    // Do not wait for the interval or send after an attempt ends. Result delivery has its own signed channel.
    async close(){closed=true;if(timer!==null)unschedule(timer);timer=null;await chain;},
    settled:()=>chain,
  };
}
