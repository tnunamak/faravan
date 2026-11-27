import {createHostedCoordinators,prepareWithHostedCoordinator} from './hosted-coordinators.mjs';
// Managed-supervisor-only recovery preparation. The app retains admission and
// the install lock until its owned helper has acknowledged or been cancelled.
import {lstat,readFile,mkdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {acquireProcessLock} from './lock.mjs';
import {macUpdateJournalPath} from './macos-update-boot.mjs';
import {isNewerMacUpdate} from './macos-update-version.mjs';
import {prepareMacUpdateHelper} from './macos-update-helper-bridge.mjs';

const phases=new Set(['prepared','exchanging','retaining','starting','rollback-exchanging','rollback-retaining','restarting-old']);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const source='Contents/Resources/faravan/';
export const recoveryFiles=Object.freeze([
  {source:source+'runtime/bin/node',destination:'runtime/bin/node',executable:true},
  ...['macos-update-helper.mjs','macos-update-transaction.mjs','macos-update-boot.mjs','macos-update-version.mjs','lock.mjs','windows-process.mjs'].map(name=>({source:source+'lib/v1/'+name,destination:'lib/v1/'+name})),
  {source:source+'lib/durable-write.mjs',destination:'lib/durable-write.mjs'},
  {source:'Contents/MacOS/faravan-process-identity',destination:'faravan-process-identity',executable:true},
  {source:'Contents/MacOS/faravan-update-exchange',destination:'faravan-update-exchange',executable:true},
]);

export async function prepareManagedRecovery({home,identity,coordinatorHome,hosts,snapshot,exclusive,signal,prepare=prepareMacUpdateHelper,acquire=acquireProcessLock}={}) {
  if(!identity?.appPath || typeof snapshot!=='function' || typeof exclusive!=='function')throw Error('Managed recovery is unavailable');
  const path=macUpdateJournalPath(identity.appPath),uid=process.getuid?.();
  const st=await lstat(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o077)!==0||(uid!==undefined&&st.uid!==uid))throw Error('Untrusted update journal');
  const journalText=await readFile(path,'utf8'),journal=JSON.parse(journalText);
  if(journal.schema!==1||!uuid(journal.id)||journal.appPath!==identity.appPath||journal.home!==home||journal.channel!==identity.channel||
     journal.bundleId!==identity.bundleId||!phases.has(journal.phase)||![journal.version,journal.previousVersion].includes(identity.version)||
     !isNewerMacUpdate(journal.version,journal.previousVersion,identity.channel))throw Error('Update journal identity mismatch');
  const releaseInstall=await acquire(identity.appPath+'.update.lock',{timeoutMs:0});
  let handed=false, releaseIdle;
  const release=async()=>{if(releaseIdle){const fn=releaseIdle;releaseIdle=null;await fn();}releaseInstall();};
  try {
    signal?.throwIfAborted();
    const again=await lstat(path);
    if(!again.isFile()||again.isSymbolicLink()||again.nlink!==1||(again.mode&0o077)!==0||(uid!==undefined&&again.uid!==uid)||await readFile(path,'utf8')!==journalText)throw Error('Update journal changed');
    releaseIdle=await exclusive();if(releaseIdle===null)return null;
    if(typeof releaseIdle!=='function')throw Error('Admission exclusion unavailable');
    const oldOwners=await snapshot();signal?.throwIfAborted();
    const root=join(home,'v1','update-helpers');await mkdir(root,{recursive:true,mode:0o700});
    const rs=await lstat(root);if(!rs.isDirectory()||rs.isSymbolicLink()||(rs.mode&0o077)!==0||(uid!==undefined&&rs.uid!==uid)||await realpath(root)!==root)throw Error('Untrusted helper directory');
    const spec={mode:'recover',appPath:identity.appPath,home,journalPath:path,version:journal.version,previousVersion:journal.previousVersion,
      channel:identity.channel,bundleId:identity.bundleId,oldOwners};
    hosts??=coordinatorHome?createHostedCoordinators({home,coordinatorHome,installDir:join(identity.appPath,'Contents/Resources/faravan')}):null;
    const ticket=await prepareWithHostedCoordinator(hosts,()=>prepare({appPath:identity.appPath,sourceRoot:identity.appPath,capsuleRoot:root,files:recoveryFiles,
      runtime:'runtime/bin/node',entrypoint:'lib/v1/macos-update-helper.mjs',spec,signal,exclusive:async()=>release}));
    if(!ticket?.ready||typeof ticket.cancel!=='function'){await ticket?.cancel?.();throw Error('Recovery helper is not ready');}
    handed=true;return ticket;
  } finally {if(!handed)await release();}
}
