import {open, mkdir, mkdtemp, readFile, readdir, rename, rm, lstat} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {constants,openSync,fstatSync,readFileSync,closeSync,lstatSync} from 'node:fs';
import {parseDocument,isMap} from 'yaml';

const unresolved = () => Object.assign(new Error('A previous sign-in may still be changing credentials.'), {code:'credential_writer_unresolved'});
export const generationId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
// Releases before the stable kit stored each generation globally under this name. Only old stores hold them.
export const generationService = id => `faravan-github-${id}`;
// The one service name the GitHub kit requests. Its value is only ever scoped to one sandbox.
export const GITHUB_SERVICE = 'faravan-github';
const digest = value => createHash('sha256').update(value).digest('hex');
function checkPrivateDirectory(info) {
  if(!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid!==process.getuid()))throw unresolved();
}
async function privateDirectory(directory) {
  checkPrivateDirectory(await lstat(directory).catch(()=>{throw unresolved();}));
}
async function generationDirectory(home,id) {
  await privateDirectory(home);
  await privateDirectory(join(home,'credential-generations'));
  const directory=join(home,'credential-generations',id);
  await privateDirectory(directory);
  return directory;
}
async function syncDirectory(directory) {
  const fd=await open(directory,'r');
  try { await fd.sync(); } finally { await fd.close(); }
}
async function save(file, value) {
  const fd=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { await fd.writeFile(value); await fd.sync(); } finally { await fd.close(); }
}
export const savePrivateFile = save;
// The checks run on the descriptor that is read, so a path swapped after the open changes nothing. A symlink is never opened.
async function readPrivate(file) {
  let fd;
  try { fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW); }
  catch(error) { if(error.code==='ELOOP')throw unresolved(); throw error; }
  try {
    checkPrivateFile(await fd.stat());
    return await fd.readFile();
  } finally { await fd.close(); }
}

function checkPrivateFile(info) {
  if(!info.isFile() || info.size>1024*1024 || (info.mode & 0o777)!==0o600 || (process.getuid && info.uid!==process.getuid()))throw unresolved();
}
function readPrivateSync(file) {
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {checkPrivateFile(fstatSync(fd));return readFileSync(fd);}finally{closeSync(fd);}
}
function parseClaudePointer(accountId,bytes,marker) {
  const record=JSON.parse(bytes.toString());
  if(!record || record.version!==1 || record.accountId!==accountId || !generationId(record.id) || !claudeKinds.includes(record.kind) || !/^[a-f0-9]{64}$/.test(record.digest))throw uncertain();
  if(marker!==undefined && JSON.stringify(record)!==marker.toString())throw uncertain();
  return record;
}
function checkClaudeValue(record,bytes) {
  if(digest(bytes)!==record.digest)throw unresolved();
  return bytes.toString('utf8');
}
// The synchronous launch boundary uses the same descriptor, provenance and value checks as admission.
export function readClaudeAccountSync(home,accountId) {
  checkPrivateDirectory(lstatSync(home));
  const pointer=readPrivateSync(join(home,'claude-account-'+accountId+'.json'));
  const record=parseClaudePointer(accountId,pointer);
  const root=join(home,'credential-generations'),directory=join(root,record.id);
  checkPrivateDirectory(lstatSync(root));checkPrivateDirectory(lstatSync(directory));
  parseClaudePointer(accountId,pointer,readPrivateSync(join(directory,'claude-account.json')));
  checkClaudeValue(record,readPrivateSync(join(directory,'value')));
  return record;
}

export async function createGitHubSource(home, source) {
  if(!generationId(source?.id))throw unresolved();
  await privateDirectory(home);
  const directory=join(home,'.gh-task-access-'+source.id);
  await mkdir(directory,{mode:0o700});
  const receipts=join(home,'credential-sources');
  await mkdir(receipts,{recursive:true,mode:0o700});
  await privateDirectory(receipts);
  await save(join(receipts,source.id+'.json'),JSON.stringify({version:1,id:source.id,provider:'github'}));
  await syncDirectory(directory);
  await syncDirectory(receipts);
  await syncDirectory(home);
}

export async function isolatedSourceWriter(home, isolation) {
  if(!generationId(isolation?.id))return false;
  try {
    await privateDirectory(home);
    if(isolation.kind==='github-source') {
      await privateDirectory(join(home,'credential-sources'));
      const source=JSON.parse(await readPrivate(join(home,'credential-sources',isolation.id+'.json')));
      return source.version===1 && source.id===isolation.id && source.provider==='github';
    }
    if(isolation.kind==='github-literal') {
      const directory=await generationDirectory(home,isolation.id);
      const assignment=JSON.parse(await readPrivate(join(directory,'assignment.json')));
      return assignment.version===1 && assignment.id===isolation.id && assignment.service===generationService(isolation.id) &&
        assignment.digest===digest(await readPrivate(join(directory,'value')));
    }
    if(isolation.kind==='provider-source') {
      await privateDirectory(join(home,'credential-sources'));
      const source=JSON.parse(await readPrivate(join(home,'credential-sources',isolation.id+'.json')));
      return source.version===1 && source.id===isolation.id && ['codex','claude'].includes(source.provider);
    }
    if(isolation.kind==='docker-proxy-source') {
      await privateDirectory(join(home,'credential-sources'));
      const source=JSON.parse(await readPrivate(join(home,'credential-sources',isolation.id+'.json')));
      return source.version===1 && source.id===isolation.id && source.provider==='docker-proxy' &&
        ['codex','claude'].includes(source.agent) && source.service===(source.agent==='codex'?'openai':'anthropic');
    }
  } catch {}
  return false;
}

export async function createProviderSource(home, provider) {
  if(!['codex','claude'].includes(provider))throw unresolved();
  await privateDirectory(home);
  const id=randomUUID(), root=join(home,'provider-sources'), directory=join(root,id);
  await mkdir(root,{recursive:true,mode:0o700});
  await privateDirectory(root);
  await mkdir(directory,{mode:0o700});
  const receipts=join(home,'credential-sources');
  await mkdir(receipts,{recursive:true,mode:0o700});
  await privateDirectory(receipts);
  await save(join(receipts,id+'.json'),JSON.stringify({version:1,id,provider}));
  await syncDirectory(root);await syncDirectory(receipts);await syncDirectory(home);
  return {id,provider,directory};
}

export async function createDockerProxySource(home, provider, service) {
  if (!['codex', 'claude'].includes(provider) || service !== (provider === 'codex' ? 'openai' : 'anthropic')) throw unresolved();
  await privateDirectory(home);
  const id = randomUUID(), receipts = join(home, 'credential-sources');
  await mkdir(receipts, {recursive:true, mode:0o700});
  await privateDirectory(receipts);
  await save(join(receipts, id + '.json'), JSON.stringify({version:1, id, provider:'docker-proxy', agent:provider, service}));
  await syncDirectory(receipts); await syncDirectory(home);
  return {id, provider, service};
}

function providerFile(provider) {
  if(provider==='codex')return 'auth.json';
  if(provider==='claude')return '.credentials.json';
  throw unresolved();
}

export async function readProviderSource(home,source) {
  if(!generationId(source?.id))throw unresolved();
  await privateDirectory(home);await privateDirectory(join(home,'provider-sources'));await privateDirectory(join(home,'provider-sources',source.id));
  const bytes=await readPrivate(join(home,'provider-sources',source.id,providerFile(source.provider))).catch(()=>{throw unresolved();});
  let value;
  try { value=JSON.parse(bytes); } catch {throw unresolved();}
  if(!value || typeof value!=='object' || Array.isArray(value))throw unresolved();
  if(source.provider==='codex') {
    if(value.OPENAI_API_KEY || typeof value.tokens?.access_token!=='string' || !value.tokens.access_token ||
      typeof value.tokens.id_token!=='string' || !value.tokens.id_token || typeof value.tokens.refresh_token!=='string' || !value.tokens.refresh_token)throw unresolved();
  } else if(typeof value.claudeAiOauth?.accessToken!=='string' || !value.claudeAiOauth.accessToken ||
      typeof value.claudeAiOauth.refreshToken!=='string' || !value.claudeAiOauth.refreshToken || !Number.isFinite(value.claudeAiOauth.expiresAt))throw unresolved();
  return Buffer.from(JSON.stringify(value));
}

export async function currentProviderGeneration(home,provider) {
  providerFile(provider);
  let value;
  try {value=JSON.parse(await readPrivate(join(home,provider+'-generation.json')));}
  catch(error){if(error.code==='ENOENT')return null;throw unresolved();}
  if(!value || value.version!==1 || !generationId(value.id) || !generationId(value.source?.id) || value.source.provider!==provider)throw unresolved();
  const directory=await generationDirectory(home,value.id);
  const bytes=await readPrivate(join(directory,providerFile(provider))).catch(()=>{throw unresolved();});
  if(digest(bytes)!==value.digest)throw unresolved();
  return {...value,directory,file:providerFile(provider)};
}

/** The parsed value of the current provider generation, for Faravan's own host reads. It is returned in memory only and
 *  never logged. The generation id and digest bind a read to one credential. Null when no sign-in is published. */
export async function readCurrentProviderValue(home,provider) {
  const current=await currentProviderGeneration(home,provider);
  if(!current)return null;
  let value;
  try {value=JSON.parse(await readPrivate(join(current.directory,current.file)));}catch{throw unresolved();}
  if(!value || typeof value!=='object' || Array.isArray(value))throw unresolved();
  return {id:current.id,digest:current.digest,source:current.source,value};
}

// Provider files are documented native authentication stores. Read a complete
// JSON record, copy it, and never let the provider use the published directory.
export async function publishProviderGeneration(home,source,{signal}={}) {
  signal?.throwIfAborted();
  const bytes=await readProviderSource(home,source), hash=digest(bytes);
  const current=await currentProviderGeneration(home,source.provider);
  if(current?.source.id===source.id && current.digest===hash)return current;
  const id=randomUUID(),root=join(home,'credential-generations'),directory=join(root,id);
  await mkdir(root,{recursive:true,mode:0o700});await privateDirectory(root);await mkdir(directory,{mode:0o700});
  const file=providerFile(source.provider);
  await save(join(directory,file),bytes);
  if(source.provider==='codex')await save(join(directory,'config.toml'),'cli_auth_credentials_store = "file"\n');
  await syncDirectory(directory);await syncDirectory(root);
  const record={version:1,id,source:{id:source.id,provider:source.provider},digest:hash};
  const pending=join(home,id+'.publication');
  await save(pending,JSON.stringify(record));
  signal?.throwIfAborted();
  await rename(pending,join(home,source.provider+'-generation.json'));await syncDirectory(home);
  return {...record,directory,file};
}

/** A job-private Codex consumer file made from one published generation: its access and identity tokens, with an empty refresh
 *  token and a current `last_refresh`. Codex renews a copied auth.json itself, and the provider rotates the refresh token on
 *  renewal, so a full copy is a second holder of the sign-in. This copy can only spend its access token; Faravan's own
 *  refresher stays the one holder. The caller copies `file` into the guest and then calls `remove`. */
export async function codexConsumerCopy(home,generation,{now=Date.now}={}) {
  if(!generationId(generation?.id)||generation.source?.provider!=='codex')throw unresolved();
  const directory=await generationDirectory(home,generation.id);
  const bytes=await readPrivate(join(directory,'auth.json')).catch(()=>{throw unresolved();});
  if(digest(bytes)!==generation.digest)throw unresolved();
  let value;
  try {value=JSON.parse(bytes);}catch{throw unresolved();}
  if(typeof value?.tokens?.access_token!=='string'||!value.tokens.access_token)throw unresolved();
  const copy={...value,tokens:{...value.tokens,refresh_token:''},last_refresh:new Date(now()).toISOString()};
  const root=join(home,'credential-consumers');
  await mkdir(root,{recursive:true,mode:0o700});await privateDirectory(root);
  // A copy left by a preparation that stopped before its cleanup holds an access token: remove those older than ten minutes.
  for(const name of await readdir(root)) {
    const info=await lstat(join(root,name)).catch(()=>null);
    if(info&&now()-info.mtimeMs>600_000)await rm(join(root,name),{recursive:true,force:true});
  }
  const consumer=await mkdtemp(join(root,'codex-'));
  try {await save(join(consumer,'auth.json'),JSON.stringify(copy));}
  catch(error){await rm(consumer,{recursive:true,force:true});throw error;}
  return {file:join(consumer,'auth.json'),remove:()=>rm(consumer,{recursive:true,force:true})};
}

export async function refreshProviderGeneration(home,provider) {
  if(!['codex','claude'].includes(provider))return null;
  const current=await currentProviderGeneration(home,provider);
  return current ? publishProviderGeneration(home,current.source) : null;
}

export async function currentGitHubGeneration(home) {
  let value;
  try { value=JSON.parse(await readPrivate(join(home,'github-generation.json'))); }
  catch (error) { if(error.code==='ENOENT')return null; throw unresolved(); }
  if (!value || value.version!==1 || !generationId(value.id) || !generationId(value.source?.id) ||
      typeof value.source.ghBin!=='string' || !value.source.ghBin || typeof value.source.pathEnv!=='string' ||
      !/^[a-f0-9]{64}$/.test(value.digest)) throw unresolved();
  const directory=await generationDirectory(home,value.id);
  const token=await readPrivate(join(directory,'value')).catch(()=>{throw unresolved();});
  if (digest(token)!==value.digest) throw unresolved();
  return {...value,directory,service:GITHUB_SERVICE};
}

/** The generation's literal value. Callers deliver it to sbx on stdin only. */
export async function readGitHubGenerationValue(home,generation) {
  if(!generationId(generation?.id))throw unresolved();
  const directory=await generationDirectory(home,generation.id);
  const token=await readPrivate(join(directory,'value')).catch(()=>{throw unresolved();});
  if(digest(token)!==generation.digest)throw unresolved();
  return token.toString('utf8');
}

// sbx assembles and keeps one template image (1.5-2.1 GB) for each agent and kit it sees. The kit therefore
// holds no credential and no generation data: one content-addressed directory, written once, never changed.
// A running `sbx run` may read it at any time, so it is renamed into place complete.
async function stableGitHubKit(home) {
  const original=await readFile(new URL('../kits/wf-gh-cli/spec.yaml',import.meta.url),'utf8');
  const kit=original.replaceAll(': github\n',`: ${GITHUB_SERVICE}\n`).replaceAll('    github:\n',`    ${GITHUB_SERVICE}:\n`);
  const directory=join(home,'github-kit-'+digest(kit).slice(0,16));
  await privateDirectory(home);
  // The caller holds the credential lock, so any temporary kit here is from a write that never reached its rename.
  for(const name of await readdir(home))if(name.startsWith('.github-kit-'))await rm(join(home,name),{recursive:true,force:true});
  if(!await lstat(directory).then(()=>true,()=>false)) {
    const pending=await mkdtemp(join(home,'.github-kit-'));
    try { await save(join(pending,'spec.yaml'),kit); await syncDirectory(pending); await rename(pending,directory); }
    finally { await rm(pending,{recursive:true,force:true}); }
    await syncDirectory(home);
  }
  try {
    await privateDirectory(directory);
    const names=await readdir(directory);
    if(names.length===1 && names[0]==='spec.yaml' && (await readPrivate(join(directory,'spec.yaml'))).toString('utf8')===kit)return directory;
  } catch {}
  throw unresolved();
}

// sbx withholds credentials from an unattended custom kit unless this exact
// service/domain binding exists. This file is approval metadata, never a token.
export async function approveServiceBinding(home,service,domains) {
  const config=join(home,'.config'), directory=join(config,'sbx');
  await mkdir(directory,{recursive:true,mode:0o700});
  for(const path of [config,directory]) {
    const info=await lstat(path);
    if(!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) ||
      (process.getuid && info.uid!==process.getuid()))throw unresolved();
  }
  const file=join(directory,'credentials.yaml');
  let text='bindings: {}\n';
  try {text=(await readPrivate(file)).toString('utf8');}catch(error){if(error.code!=='ENOENT')throw unresolved();}
  const document=parseDocument(text,{prettyErrors:false,logLevel:'silent',stringKeys:true});
  if(document.errors.length || document.warnings.length || !isMap(document.contents))throw unresolved();
  try {document.toJS({maxAliasCount:0});}catch{throw unresolved();}
  if(!document.has('bindings'))document.set('bindings',{});
  if(!isMap(document.get('bindings')))throw unresolved();
  const binding={apiKey:{domains}};
  if(document.hasIn(['bindings',service])) {
    if(JSON.stringify(document.toJS({maxAliasCount:0}).bindings[service])!==JSON.stringify(binding))throw unresolved();
    return;
  }
  document.setIn(['bindings',service],binding);
  const pending=join(directory,randomUUID()+'.publication');
  await save(pending,String(document));
  await rename(pending,file);await syncDirectory(directory);await syncDirectory(config);await syncDirectory(home);
}

// Caller holds credential-changes.lock. A generation is an immutable literal
// copy. Publication writes nothing to sbx: each job's preparation copies the
// value into a secret scoped to that job's sandbox. No provider process receives this path.
export async function publishGitHubGeneration(home, source, token, {signal}={}) {
  signal?.throwIfAborted();
  if (!generationId(source?.id) || typeof token!=='string' || !token.trim() || token.length>1024*1024) throw unresolved();
  const hash=digest(token), previous=await currentGitHubGeneration(home);
  const kitDirectory=await stableGitHubKit(home);
  await approveServiceBinding(home,GITHUB_SERVICE,['api.github.com','github.com']);
  if (previous?.source.id===source.id && previous.digest===hash) return {...previous,kitDirectory};
  const id=randomUUID(), root=join(home,'credential-generations'), directory=join(root,id);
  await mkdir(root,{recursive:true,mode:0o700});
  await privateDirectory(root);
  await mkdir(directory,{mode:0o700});
  await save(join(directory,'value'),token);
  await syncDirectory(directory);
  await syncDirectory(root);
  const record={version:1,id,source,digest:hash};
  const pending=join(home,id+'.publication');
  await save(pending,JSON.stringify(record));
  signal?.throwIfAborted();
  await rename(pending,join(home,'github-generation.json'));
  await syncDirectory(home);
  return {...record,directory,kitDirectory,service:GITHUB_SERVICE};
}

// Additional Claude accounts are immutable literals, independent of native sign-in files.
// Shape only: a setup token is Bearer-only, an API key goes as x-api-key. The message never repeats the value.
export function claudeTokenKind(token) {
  if (typeof token === 'string' && token.length <= 16384) {
    if (/^sk-ant-oat01-[A-Za-z0-9_-]{32,}$/.test(token)) return 'subscription-token';
    if (/^sk-ant-api03-[A-Za-z0-9_-]{32,}$/.test(token)) return 'api-key';
  }
  throw Object.assign(new Error('Claude token format is invalid.'),{code:'claude_token_invalid'});
}
// A new generation is built under this name, which only this code creates, and renamed to its final name when complete.
const claudePendingName=/^claude-pending-([0-9a-f-]{36})$/;
export async function publishClaudeAccount(home, accountId, {kind, token}) {
  if (!generationId(accountId) || claudeTokenKind(token) !== kind)
    throw Object.assign(new Error('Claude token format is invalid.'),{code:'claude_token_invalid'});
  await privateDirectory(home);
  const id=randomUUID(),root=join(home,'credential-generations'),directory=join(root,id),building=join(root,'claude-pending-'+id);
  await mkdir(root,{recursive:true,mode:0o700});await privateDirectory(root);
  const record={version:1,id,accountId,kind,digest:digest(token)};
  const pending=join(home,id+'.publication'),pointer=join(home,'claude-account-'+accountId+'.json');
  let pointed=false;
  await mkdir(building,{mode:0o700});
  try {
    // The marker is durable before any secret byte is written, and the directory entry is too. A crash at any later
    // point leaves a directory that only this code names, which the orphan sweep finds and deletes.
    await syncDirectory(root);
    await save(join(building,'claude-account.json'),JSON.stringify(record));
    await syncDirectory(building);
    await save(join(building,'value'),token);
    await syncDirectory(building);
    await rename(building,directory);await syncDirectory(root);
    await save(pending,JSON.stringify(record));
    await rename(pending,pointer);pointed=true;await syncDirectory(home);
  } catch(error) {
    // A failed publication leaves no value behind: no pointer may name it, and its directory goes.
    if(pointed)await rm(pointer,{force:true}).catch(()=>{});
    await rm(pending,{force:true}).catch(()=>{});
    await rm(building,{recursive:true,force:true}).catch(()=>{});
    await rm(directory,{recursive:true,force:true}).catch(()=>{});
    throw error;
  }
  return record;
}
const claudePointerName=/^claude-account-([0-9a-f-]{36})\.json$/;
const claudeKinds=['subscription-token','api-key'];
const uncertain=()=>Object.assign(new Error('An added Claude account pointer could not be read, so no saved value was deleted.'),{code:'claude_pointer_uncertain'});
// A pointer is trusted only when it is well formed, names its own account, and the generation's private marker is the
// same bytes. Anything else is damaged provenance.
async function validClaudePointer(home,accountId,bytes) {
  const record=parseClaudePointer(accountId,bytes);
  const directory=await generationDirectory(home,record.id);
  parseClaudePointer(accountId,bytes,await readPrivate(join(directory,'claude-account.json')));
  return record;
}
// Every account pointer in the home: the generation it names, or damage. Damage means any generation may still be in use.
async function claudePointers(home) {
  const pointers=[];let damaged=false;
  for(const name of await readdir(home)) {
    const match=claudePointerName.exec(name);
    if(!match)continue;
    try{pointers.push({accountId:match[1],record:await validClaudePointer(home,match[1],await readPrivate(join(home,name)))});}
    catch{damaged=true;}
  }
  return {pointers,damaged};
}
// Records a durable deletion obligation before unlinking the pointer. Retries finish that obligation even when
// the pointer is gone. The pointer and private marker must agree and no other pointer may share the generation.
// Returns true once the account's value is verified gone. Anything unknown about the filesystem is a failure, never absence.
export async function removeClaudeAccount(home, accountId) {
  if(!generationId(accountId))throw unresolved();
  await privateDirectory(home);
  const pointer=join(home,'claude-account-'+accountId+'.json'),obligation=join(home,'claude-removal-'+accountId+'.json');
  let record;
  try {record=parseClaudePointer(accountId,await readPrivate(obligation));}
  catch(error){if(error.code!=='ENOENT')throw uncertain();}
  const present=await lstat(pointer).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw uncertain();});
  if(present) {
    const current=await validClaudePointer(home,accountId,await readPrivate(pointer));
    if(record && JSON.stringify(record)!==JSON.stringify(current))throw uncertain();
    record=current;
  }
  if(!record)return true;
  const {pointers,damaged}=await claudePointers(home);
  if(damaged||pointers.some(other=>other.accountId!==accountId&&other.record.id===record.id))throw uncertain();
  // The durable obligation contains provenance only, never the account value.
  if(present) {
    try {await save(obligation,JSON.stringify(record));}catch(error){if(error.code!=='EEXIST')throw error;}
    await syncDirectory(home);
    await rm(pointer,{force:true});
  }
  await syncDirectory(home);
  if(!await removeOwnedGeneration(home,record.id))throw uncertain();
  await lstat(join(home,'credential-generations',record.id)).then(()=>{throw uncertain();},error=>{if(error.code!=='ENOENT')throw uncertain();});
  await syncDirectory(join(home,'credential-generations'));
  await rm(obligation,{force:true});await syncDirectory(home);
  return true;
}
// True when the directory is gone; false when it is not ours to delete; throws when its state cannot be known.
async function removeOwnedGeneration(home,id,name=id) {
  const directory=join(home,'credential-generations',name);
  const info=await lstat(directory).catch(error=>{if(error.code==='ENOENT')return 'absent';throw uncertain();});
  if(info==='absent')return true;
  // Only a real directory this user owns, never a symlink's target.
  if(!info.isDirectory()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid()))return false;
  await rm(directory,{recursive:true,force:true});return true;
}
// A directory is ours to delete only when its private marker is a Claude account marker for that same directory.
async function hasClaudeMarker(home,id) {
  try{
    const record=JSON.parse((await readPrivate(join(home,'credential-generations',id,'claude-account.json'))).toString());
    return record?.version===1&&record.id===id&&generationId(record.accountId)&&claudeKinds.includes(record.kind);
  }catch{return false;}
}
/** Deletes Claude account generations that no account pointer names, and their unfinished publications. Returns the ids removed.
 *  A pointer that cannot be read or checked might name any generation, so then nothing is deleted and the sweep reports it. */
export async function removeOrphanClaudeGenerations(home) {
  const root=join(home,'credential-generations');
  try{await privateDirectory(home);await privateDirectory(root);}catch{return [];}
  const {pointers,damaged}=await claudePointers(home);
  if(damaged)throw uncertain();
  const referenced=new Set(pointers.map(pointer=>pointer.record.id));
  const removed=[];
  for(const id of await readdir(root)){
    const building=claudePendingName.exec(id);
    // An unfinished build has a name only this code creates, so it is deleted whatever it holds.
    if(building){
      if(await removeOwnedGeneration(home,building[1],id).catch(()=>false)){removed.push(building[1]);await rm(join(home,building[1]+'.publication'),{force:true}).catch(()=>{});}
      continue;
    }
    if(!generationId(id)||referenced.has(id))continue;
    // The entry must be a real directory before anything inside it is read.
    const info=await lstat(join(root,id)).catch(()=>null);
    if(!info?.isDirectory()||info.isSymbolicLink()||!await hasClaudeMarker(home,id))continue;
    if(await removeOwnedGeneration(home,id).catch(()=>false)){removed.push(id);await rm(join(home,id+'.publication'),{force:true}).catch(()=>{});}
  }
  return removed;
}
export async function readClaudeAccount(home, accountId) {
  try {
    if(!generationId(accountId))throw unresolved();
    await privateDirectory(home);
    const record=await validClaudePointer(home,accountId,await readPrivate(join(home,'claude-account-'+accountId+'.json')));
    return record;
  } catch {throw Object.assign(new Error('The selected Claude account is missing or unreadable.'),{code:'claude_account_unavailable'});}
}
export async function readClaudeAccountValue(home, record) {
  try {
    const directory=await generationDirectory(home,record.id), bytes=await readPrivate(join(directory,'value'));
    return checkClaudeValue(record,bytes);
  } catch {throw Object.assign(new Error('The selected Claude account secret is missing or unreadable.'),{code:'claude_account_unavailable'});}
}
