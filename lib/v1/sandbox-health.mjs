import {randomUUID} from 'node:crypto';

// Service observations provide a notice. Every real job checks isolation itself.
export function createSandboxHealth({newId=randomUUID}={}) {
  let generation=0,wasUp=null,notice=null;
  return {
    get generation(){return generation;},
    get notice(){return notice;},
    observe(checks,{lendingOn=false}={}) {
      const daemon=checks.find(check=>check?.name==='sbx_daemon');
      if(!daemon||daemon.unknown===true)return;
      const up=daemon.ok===true;
      if(!up&&wasUp!==false){
        generation++;
        if(lendingOn)notice={id:newId(),reason:'Docker Sandboxes stopped. Faravan is checking it again.'};
      }
      wasUp=up;
    },
    restarted({lendingOn=false}={}) {this.observe([{name:'sbx_daemon',ok:false}],{lendingOn});},
  };
}
