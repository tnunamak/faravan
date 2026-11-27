const {parentPort, workerData} = require('node:worker_threads');
const {createReadStream, opendirSync, statSync, lstatSync, openSync, closeSync, fstatSync, constants} = require('node:fs');
const {join, dirname} = require('node:path');

if (!workerData) {
  module.exports = {};
} else {
(async () => {
const {parseClaudeRecord, parseCodexRecordsForWorker} = await import(workerData.importerUrl);
const {homeDir, cached = {}, logRoots = null} = workerData;
const MAX_LINE_BYTES = 1 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ROWS_PER_FILE = 25_000;
const MAX_ROWS_PER_IMPORT = 200_000;
const stats = {skippedFiles:0,skippedBytes:0,skippedLines:0,skippedRows:0,skippedFilePaths:[],droppedItems:[]};
const accept = {claude:name=>name.endsWith('.jsonl'), codex:name=>/^rollout-.+\.jsonl$/.test(name)};
// The caller may name the log folders (one per signed-in account); otherwise the two default folders.
const roots = (Array.isArray(logRoots) ? logRoots : [
  {provider:'claude', path:join(homeDir,'.claude','projects')},
  {provider:'codex', path:join(homeDir,'.codex','sessions')},
]).filter(root => Object.hasOwn(accept, root?.provider) && typeof root.path === 'string')
  .map(root => ({provider:root.provider, account:root.provider, path:root.path, accept:accept[root.provider]}));
const MAX_DISCOVERY_ENTRIES = 4096;
const MAX_DISCOVERY_FILES = 1024;
let discoveryEntries = 0, discoveryFiles = 0, discoveryTruncated = false;
// Each folder has its own discovery budget, so one large folder cannot hide another account's logs.
function files(root) {
  discoveryEntries = 0; discoveryFiles = 0;
  let truncated = false;
  try {
    if (lstatSync(dirname(root.path)).isSymbolicLink() || lstatSync(root.path).isSymbolicLink()) {
      stats.incomplete=true;recordDroppedItem(root);reportStats();return [];
    }
  } catch(error) {if(error.code==='ENOENT')return [];throw error;}
  const found = [], pending = [root.path];
  let markedUnsupported = false;
  while (pending.length && !truncated) {
    const path = pending.pop();
    let dir;
    try {dir=opendirSync(path);} catch(error) {if(error.code==='ENOENT')continue;throw error;}
    try {
      let entry;
      while ((entry=dir.readSync()) !== null) {
        if (++discoveryEntries > MAX_DISCOVERY_ENTRIES) {discoveryTruncated=truncated=true;break;}
        const child=join(path,entry.name);
        if(entry.isDirectory()) pending.push(child);
        else if(entry.isFile()&&root.accept(entry.name)) {
          if (discoveryFiles >= MAX_DISCOVERY_FILES) {discoveryTruncated=truncated=true;break;}
          const stat=statSync(child);
          found.push({...root,path:child,mtimeMs:stat.mtimeMs,size:stat.size,dev:stat.dev,ino:stat.ino});
          discoveryFiles++;
        } else if (!markedUnsupported && (entry.isSymbolicLink() || root.accept(entry.name))) {
          markedUnsupported=true;stats.incomplete=true;recordDroppedItem(root);reportStats();
        }
      }
    } finally {dir.closeSync();}
  }
  return found;
}
function validRow(row) {return typeof row.message_id==='string' && row.message_id.length>0 && row.message_id.length<=512 &&
  typeof row.model==='string' && row.model.length>0 && row.model.length<=128;}
function verifyFile(file) {
  const current=lstatSync(file.path);
  if(!current.isFile() || current.dev!==file.dev || current.ino!==file.ino || current.size!==file.size ||
    current.mtimeMs!==file.mtimeMs || current.ctimeMs!==file.ctimeMs) throw new Error('History file changed');
}
function sameClaude(a,b) {return a.model===b.model&&['fresh_input','cache_read','cache_write_5m','cache_write_1h'].every(key=>a.tokens[key]===b.tokens[key]);}
function reportStats() {parentPort.postMessage({type:'stats',stats:{...stats}});}
function recordDroppedItem(file) {
  stats.incomplete=true;
  stats.droppedItems.push({provider:file.provider,account:file.account,mtimeMs:file.mtimeMs});
}
function skipFile(file, bytes) {
  stats.skippedFiles++;stats.skippedBytes+=bytes;stats.skippedFilePaths??=[];stats.skippedFilePaths.push(file.path);
  recordDroppedItem(file);
  stats.incomplete=true;reportStats();
}
async function* boundedLines(fd, expectedSize) {
  let parts=[], size=0, oversized=false, bytes=0;
  for await (const chunk of createReadStream(null,{fd,autoClose:false,start:0,end:expectedSize})) {
    bytes+=chunk.length;
    if (bytes>expectedSize) throw new Error('History file changed while reading');
    let start=0;
    for (let i=0;i<chunk.length;i++) {
      if (chunk[i]!==10) continue;
      const part=chunk.subarray(start,i);
      if (!oversized && size+part.length<=MAX_LINE_BYTES) {parts.push(part);size+=part.length;}
      else oversized=true;
      yield oversized ? null : Buffer.concat(parts,size).toString('utf8');
      parts=[];size=0;oversized=false;start=i+1;
    }
    const part=chunk.subarray(start);
    if (!oversized && size+part.length<=MAX_LINE_BYTES) {parts.push(part);size+=part.length;}
    else {oversized=true;parts=[];size=0;}
  }
  if (oversized) yield null;
  else if (size) yield Buffer.concat(parts,size).toString('utf8');
}
async function parseFile(file, account, rowLimit) {
  const fd=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
  const opened=fstatSync(fd);
  if(!opened.isFile() || opened.dev!==file.dev || opened.ino!==file.ino || opened.size!==file.size || opened.mtimeMs!==file.mtimeMs || opened.ctimeMs!==file.ctimeMs) throw new Error('History file changed before reading');
  const parsedRows=new Map(),conflicted=new Set(),codexState={};
  let malformedLines=0,model=null,lineIndex=0,skippedRows=0,skippedLines=0,sentRows=0;
  for await(const line of boundedLines(fd,file.size)) {
    if(line===null){malformedLines++;skippedLines++;stats.skippedLines++;continue;}
    if(!line.trim())continue;
    if(parsedRows.size>=rowLimit){skippedRows++;stats.skippedRows++;continue;}
    let record;
    try {record=JSON.parse(line);} catch {malformedLines++;continue;}
    if(record?.type==='system'&&record.subtype==='init'&&typeof record.model==='string')model=record.model;
    if(account==='claude') {
      const candidate=record?.type==='assistant'&&record.message&&typeof record.message==='object'&&
        typeof record.message.model!=='string'&&model
        ? {...record,message:{...record.message,model}}:record;
      const result=parseClaudeRecord(candidate,{account});
      malformedLines+=result.malformedLines;
      for(const row of result.usage){
        if(!validRow(row)){malformedLines++;continue;}
        const id=row.message_id;if(conflicted.has(id))continue;const prior=parsedRows.get(id);
        if(prior&&!sameClaude(prior,row)){parsedRows.delete(id);conflicted.add(id);malformedLines++;}
        else if(!prior)parsedRows.set(id,row);
        else {const at=prior.at===null?row.at:row.at===null?prior.at:Math.min(prior.at,row.at);const selected=row.tokens.output>=prior.tokens.output?row:prior;
          parsedRows.set(id,{...selected,at});}
      }
    } else {
      const parsed=parseCodexRecordsForWorker([record],{account,state:codexState});
      malformedLines+=parsed.malformedLines;
      for(const row of parsed.usage) {
        if(!validRow(row)){malformedLines++;continue;}
        parsedRows.set(`${lineIndex}:${row.message_id}`,row);
      }
    }
    lineIndex++;
    if (parsedRows.size-sentRows>=1000) {
      const usage=[...parsedRows.values()].slice(sentRows,sentRows+1000);
      sentRows+=usage.length;
      parentPort.postMessage({type:'fileChunk',provisional:true,file:file.path,log:{provider:file.provider,account:file.account,
        source:file.path,mtimeMs:file.mtimeMs,parsed:{usage,malformedLines,skippedLines,skippedRows}}});
      if (!await waitForContinue()) return {cancelled:true};
    }
  }
  const end=fstatSync(fd);
  if(end.size!==opened.size || end.mtimeMs!==opened.mtimeMs || end.ctimeMs!==opened.ctimeMs) throw new Error('History file changed while reading');
  return {usage:[...parsedRows.values()].sort((a,b)=>(a.at??Infinity)-(b.at??Infinity)),malformedLines,skippedLines,skippedRows};
  } finally {closeSync(fd);}
}
let proceedResolve,cachedResolve,startResolve;
parentPort.on('message',message=>{
  if(message?.type==='started'&&startResolve){const resolve=startResolve;startResolve=null;resolve();}
  if(message?.type==='continue'&&proceedResolve){const resolve=proceedResolve;proceedResolve=null;resolve(message.value);}
  if(message?.type==='cached'&&cachedResolve){const resolve=cachedResolve;cachedResolve=null;resolve(message);}
});
const waitForStart=()=>new Promise(resolve=>{startResolve=resolve;});
const waitForContinue=()=>new Promise(resolve=>{proceedResolve=resolve;});
const waitForCached=()=>new Promise(resolve=>{cachedResolve=resolve;});
try {
  const list=roots.flatMap(files).sort((a,b)=>b.mtimeMs-a.mtimeMs||a.path.localeCompare(b.path));
  if (discoveryTruncated) {
    stats.incomplete=true;
    for (const root of roots) stats.droppedItems.push({provider:root.provider,account:root.account});
    reportStats();
  }
  let totalBytes=0,totalRows=0;
  const seenFiles=new Set();
  for(const file of list) {
    const stat=statSync(file.path);
    Object.assign(file,{mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,size:stat.size,dev:stat.dev,ino:stat.ino});
    const identity=`${file.dev}:${file.ino}`;
    if(seenFiles.has(identity))continue;
    seenFiles.add(identity);
    parentPort.postMessage({type:'progress',file:file.path,metadata:{provider:file.provider,account:file.account,mtimeMs:file.mtimeMs}});
    await waitForStart();
    verifyFile(file);
    if(file.size>MAX_FILE_BYTES || totalBytes+file.size>MAX_TOTAL_BYTES || totalRows>=MAX_ROWS_PER_IMPORT) {
      skipFile(file,file.size);parentPort.postMessage({type:'progress',file:null});continue;
    }
    totalBytes+=stat.size;
    const fingerprint=`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const prior=cached[file.path];
    const rowLimit=Math.min(MAX_ROWS_PER_FILE,MAX_ROWS_PER_IMPORT-totalRows);
    let parsed;
    if(prior?.fingerprint===fingerprint) {
      parentPort.postMessage({type:'cached',file:file.path,fingerprint,rowLimit,provider:file.provider,account:file.account,mtimeMs:file.mtimeMs});
      parsed=await waitForCached();
      if(parsed?.stop)break;
      verifyFile(file);
      if(parsed?.found) {
        totalRows+=parsed.rowCount;
        stats.skippedLines+=parsed.skippedLines??0;
        stats.skippedRows+=parsed.skippedRows??0;
        if((parsed.skippedLines??0)>0||(parsed.skippedRows??0)>0||(parsed.malformedLines??0)>0){recordDroppedItem(file);reportStats();}
        parentPort.postMessage({type:'progress',file:null});
        if(!parsed.proceed)break;
        continue;
      }
      parsed=null;
    }
    if(!parsed)parsed=await parseFile(file,file.account,rowLimit);
    if(parsed.cancelled)break;
    if(parsed.skippedRows>0||parsed.skippedLines>0||parsed.malformedLines>0)recordDroppedItem(file);
    totalRows+=parsed.usage.length;
    let keepGoing=true;
    const rows=parsed.usage;
    for(let offset=0;offset<rows.length || offset===0;offset+=1000) {
      const last=offset+1000>=rows.length;
      parentPort.postMessage({type:last?'file':'fileChunk',replace:offset===0,file:file.path,fingerprint,log:{provider:file.provider,account:file.account,
        source:file.path,mtimeMs:file.mtimeMs,parsed:{...parsed,usage:rows.slice(offset,offset+1000)}}});
      if(!await waitForContinue()){keepGoing=false;break;}
    }
    reportStats();parentPort.postMessage({type:'progress',file:null});
    if(!keepGoing)break;
  }
  stats.incomplete=stats.incomplete===true||stats.skippedFiles>0||stats.skippedLines>0||stats.skippedRows>0;
  parentPort.postMessage({type:'done',stats});
} catch(error) {parentPort.postMessage({type:'error',message:error.message,stack:error.stack,stats});}
})().catch(error => parentPort?.postMessage({type:'error',message:error.message,stack:error.stack}));
}
