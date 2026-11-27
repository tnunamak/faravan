import {deadlineSupervisorPayload,deadlineBinding,deadlineProcessStartSync,SANDBOX_GUARD_BUILD_ID} from '../../lib/sandbox-deadline.mjs';
export function serviceProof(args,row,binary) {
 const payload=deadlineSupervisorPayload(row,binary),argv=['/usr/bin/env','-i','HOME='+row.sbx_home,process.execPath,new URL('../../lib/sandbox-deadline-supervisor.mjs',import.meta.url).pathname,JSON.stringify(payload)];
 return {code:0,stdout:JSON.stringify({data:args.includes('GetUnit')?['/org/freedesktop/systemd1/unit/deadline_2eservice']:args.at(-1)==='ExecStart'?[[argv[0],argv,false,0,0,0,0,0,0,0]]:['HOME='+row.sbx_home]})};
}
export function serviceState(row,binary){return {build_id:SANDBOX_GUARD_BUILD_ID,binding:deadlineBinding(deadlineSupervisorPayload(row,binary)),state:'armed',pid:process.pid,start:deadlineProcessStartSync(process.pid)};}
