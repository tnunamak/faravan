import {writeFileSync} from 'node:fs';
import {createLender,createLenderCounterStorage} from '../../lib/v1/lender.mjs';
import {lenderFixture} from './v1-lender-fixture.mjs';

const [phase,file,receipt]=process.argv.slice(2);
const f=await lenderFixture({after(){}},{hold:true});
const storage=createLenderCounterStorage(file),set=storage.set.bind(storage);
storage.set=async value=>{
  if(phase==='crash-ack'&&value.observationPending?.length===0)process.kill(process.pid,'SIGKILL');
  await set(value);
  if(phase==='crash'&&value.observationPending?.length===1)process.kill(process.pid,'SIGKILL');
  if(phase==='recover'&&value.observationPending?.length===0){writeFileSync(receipt+'.cleared','yes');process.exit(0);}
};
if(phase==='recover'||phase==='crash-ack')f.client.observeExecutionStart=async(attempt,options)=>{
  writeFileSync(receipt,JSON.stringify({attempt,observedAt:options.observedAt,idempotencyKey:options.idempotencyKey}));
  return {execution_observed_at:options.observedAt};
};
f.policy.storage=storage;
const lender=createLender({client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,approve:async()=>true});
lender.start(new AbortController().signal).catch(()=>process.exit(2));
