// The deadline supervisor refuses to start without a trusted startup record bound to its row (lib/sandbox-deadline-supervisor.mjs
// `startupBinding`), and in production the row IS that record's deadline. These fixtures build the guard row and the saved record
// separately, so each reading is bound to the row's target (name, home, deadline) while every other field stays the record's own.
const BINDING=['sandbox_id','sbx_home','deadline_at','deadline_clock'];
const bind=(target,record)=>record!==null&&typeof record==='object'&&!Array.isArray(record)?
  {...record,...Object.fromEntries(BINDING.map(key=>[key,target[key]]))}:record;
// A startup reading that cannot be taken (the record is already gone) leaves only the row's own binding.
const startup=(readRecord,target)=>{try{return readRecord?readRecord():{...target};}catch{return {...target};}};
export const superviseBound=(supervise,target,options={})=>{
  const read=options.readRecord;
  const readRecord=read?()=>bind(target,read()):undefined;
  return supervise(target,{...options,...(readRecord?{readRecord}:{}),originalRecord:startup(readRecord,target)});
};
