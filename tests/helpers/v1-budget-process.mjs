import { createLenderCounterStorage } from '../../lib/v1/lender.mjs';
const storage=createLenderCounterStorage(process.argv[2]);
let release;
try {
  release=await storage.acquire();
  const value=await storage.get()??{day:'2026-10-09',jobs:0,milliseconds:0,pending:null};
  if(value.jobs<1) {
    await storage.set({...value,jobs:value.jobs+1,milliseconds:value.milliseconds+60000});
    await new Promise(resolve=>setTimeout(resolve,150));
    process.stdout.write('reserved');
  } else process.stdout.write('limited');
} catch(e) {
  if(e.code!=='lender_already_running')throw e;
  process.stdout.write('busy');
} finally {await release?.();}
