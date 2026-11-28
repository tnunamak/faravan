// Persist the signed selector without repairing malformed state into a different request.
export const defaultRunRequest = () => ({schemaVersion:1, models:'any', effortId:null});
export function validRunRequest(value) {
  const text = x => typeof x === 'string' && x.trim().length > 0;
  const keys = (x, names) => x && typeof x === 'object' && !Array.isArray(x) &&
    Object.keys(x).length === names.length && names.every(k => Object.hasOwn(x,k));
  if (!keys(value,['schemaVersion','models','effortId']) || value.schemaVersion !== 1 ||
      !(value.effortId === null || text(value.effortId))) return false;
  if (value.models === 'any') return true;
  if (!Array.isArray(value.models) || !value.models.length) return false;
  const seen = new Set();
  return value.models.every(m => {
    if (!keys(m,['providerId','modelId']) || !text(m.providerId) || !text(m.modelId)) return false;
    const key = JSON.stringify([m.providerId,m.modelId]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function validRequestState(draft) {
  if (!Object.hasOwn(draft,'requestMode') && !Object.hasOwn(draft,'runRequest')) return true;
  return draft.requestMode === 'signed' ? validRunRequest(draft.runRequest)
    : draft.requestMode === 'legacy' && !Object.hasOwn(draft,'runRequest');
}
const requestState = saved => ({
  // Pre-upgrade in-flight drafts were already sent through the legacy path.
  ...(!Object.hasOwn(saved,'requestMode') && !Object.hasOwn(saved,'runRequest') && (saved.sending || saved.agentRefusal) ? {requestMode:'legacy'} : {}),
  ...(Object.hasOwn(saved,'requestMode') ? {requestMode:saved.requestMode} : {}),
  ...(Object.hasOwn(saved,'runRequest') ? {runRequest:saved.runRequest} : {}),
});
// The composer's draft lives on this computer (EXPERIENCE M7, R3-05): the text, the folder and the choices are kept
// until the job is sent, and one draft carries one idempotency key. A definite refusal starts a new send identity;
// an uncertain outcome and an explicit Send anyway response keep the original identity.
const PREFIX = 'faravan-compose-draft:';
export const COMPOSE_DRAFT_PREFIX = PREFIX;
const FOLDER = 'faravan-compose-folder';
const SOURCE = 'faravan-compose-source';
export const newDraftId = () => (globalThis.crypto?.randomUUID?.() ?? 'd-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
const fresh = (folder = '') => ({id: newDraftId(), prompt: '', path: folder, sourceKind:'folder', workingDirectory:'', gitUrl:'', gitCommit:'', gitBranch:'', files:[], zip:null, includeUncommitted: false, agent: '', model: '', effort: '', verifyCmd: '', verifyEdited: false, sending: false, uncertainSince: null, retryNotBefore: null, sendAnyway: false, agentRefusal: null});
const read = (storage, key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
const write = (storage, key, value) => { try { if (!storage) return false; storage.setItem(key, value); return storage.getItem(key) === value; } catch { return false; } };
const followupOf = value => typeof value?.parentJob === 'string' && typeof value?.parentResult === 'string'
  ? {parentJob:value.parentJob.slice(0,160), parentResult:value.parentResult.slice(0,160)} : null;
const baseOf = value => value && typeof value === 'object'
  ? {path:String(value.path ?? '').slice(0,4096), branch:String(value.branch ?? '').slice(0,512), commit:String(value.commit ?? '').slice(0,160), ...(value.title?{title:String(value.title).slice(0,200)}:{})} : null;
export function loadDraft(storage, circle) {
  const folder = read(storage, FOLDER) || '';
  try {
    const saved = JSON.parse(read(storage, PREFIX + circle) ?? 'null');
    if (saved && typeof saved === 'object' && typeof saved.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(saved.id))
      return {...fresh(folder), ...requestState(saved), id: saved.id, sourceExpectedDigest:typeof saved.sourceExpectedDigest==='string'?saved.sourceExpectedDigest:null, attachmentId:typeof saved.attachmentId==='string'?saved.attachmentId:null, workingDirectory:String(saved.workingDirectory??''), sourceKind:['none','folder','git','files'].includes(saved.sourceKind)?saved.sourceKind:'folder', gitUrl:String(saved.gitUrl??''), gitCommit:String(saved.gitCommit??''), gitBranch:String(saved.gitBranch??''), files:Array.isArray(saved.files)?saved.files:[], zip:saved.zip??null, prompt: String(saved.prompt ?? ''), path: String(saved.path ?? folder), includeUncommitted: saved.includeUncommitted === true, agent: String(saved.agent ?? ''), model: String(saved.model ?? ''), effort: String(saved.effort ?? ''), verifyCmd: String(saved.verifyCmd ?? ''), verifyEdited: saved.verifyEdited === true, sending: saved.sending === true, retryNotBefore: saved.sending === true && Number.isSafeInteger(saved.retryNotBefore) && saved.retryNotBefore > 0 ? saved.retryNotBefore : null, uncertainSince: Number.isFinite(saved.uncertainSince) ? saved.uncertainSince : null, sendAnyway: saved.sendAnyway === true, ...(saved.sourceUnknown === true ? {sourceUnknown:true} : {}), agentRefusal: typeof saved.agentRefusal?.label === 'string' && typeof saved.agentRefusal?.message === 'string' ? {label:saved.agentRefusal.label.slice(0,80),message:saved.agentRefusal.message.slice(0,300)} : null,
        ...(followupOf(saved.followup) && baseOf(saved.base) ? {followup:followupOf(saved.followup),base:baseOf(saved.base)} : {})};
  } catch { /* an unreadable draft starts over */ }
  const defaults=fresh(folder);
  try {const last=JSON.parse(read(storage,SOURCE)||'null');if(['none','folder','git','files'].includes(last?.sourceKind))return {...defaults,sourceKind:last.sourceKind,gitUrl:String(last.gitUrl??''),gitBranch:String(last.gitBranch??'')};}catch{}
  return defaults;
}
// Mounts must distinguish a verified absence from an unreadable recovery record.
export function restoreDraft(storage, circle) {
  try {
    if (!storage) return {state:'unreadable'};
    const raw = storage.getItem(PREFIX + circle);
    if (raw !== null) {
      let saved;
      try { saved = JSON.parse(raw); } catch { return {state:'malformed'}; }
      if (!saved || !validRequestState(saved) || typeof saved.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(saved.id)) return {state:'malformed'};
    }
    // Parse the exact snapshot, not a second permissive read of the recovery key.
    return {state:raw === null ? 'absent' : 'saved', draft:loadDraft({
      getItem:key => key === PREFIX + circle ? raw : storage.getItem(key),
    }, circle)};
  } catch { return {state:'unreadable'}; }
}
// Local best-effort move, not an atomic cross-tab transaction.
export function moveDraft(storage, from, to, draft) {
  let sourceRaw, next;
  try {
    sourceRaw = storage.getItem(PREFIX + from);
    if (sourceRaw === null || JSON.parse(sourceRaw)?.id !== draft.id) return {state:'changed'};
    if (storage.getItem(PREFIX + to) !== null) return {state:'occupied'};
  } catch { return {state:'unreadable'}; }
  next = {...draft, id:newDraftId(), sending:false, uncertainSince:null, retryNotBefore:null, sendAnyway:false};
  if (saveDraft(storage, to, next) && clearDraftIfCurrent(storage, from, draft.id))
    return {state:'moved'};
  // A remove may have committed before its verification failed. Restore only into
  // a verified empty source slot; never overwrite another tab's newer identity.
  // null means verification failed; false means a read proved this source was not kept.
  let sourceKept = null;
  try {
    if (storage.getItem(PREFIX + from) === null) storage.setItem(PREFIX + from, sourceRaw);
    sourceKept = storage.getItem(PREFIX + from) === sourceRaw;
  } catch {}
  // Do not discard the sole surviving recovery copy if source restoration failed.
  const rolledBack = sourceKept === true && clearDraftIfCurrent(storage, to, next.id);
  return {state:'unconfirmed', sourceKept, rolledBack};
}
// When the request text last changed. Drafts saved before this field existed have no time; never invent one.
const editedAtOf = (storage, circle, prompt) => {
  let prior = null;
  try { prior = JSON.parse(read(storage, PREFIX + circle) ?? 'null'); } catch {}
  if (prior && typeof prior === 'object' && String(prior.prompt ?? '') === String(prompt ?? ''))
    return Number.isFinite(prior.editedAt) ? prior.editedAt : undefined;
  return Date.now();
};
export function saveDraft(storage, circle, draft, onSaved) {
  // Keep attachment bytes out of localStorage's small quota. IndexedDB restores them before the page mounts.
  const {files,zip,editedAt:_,...metadata}=draft;
  const editedAt = editedAtOf(storage, circle, draft.prompt);
  const encoded = JSON.stringify({...metadata,...(editedAt===undefined?{}:{editedAt}),files:[],zip:null});
  const saved = write(storage, PREFIX + circle, encoded);
  if (draft.path) write(storage, FOLDER, draft.path);
  write(storage,SOURCE,JSON.stringify({sourceKind:draft.sourceKind || 'folder',gitUrl:draft.gitUrl,gitBranch:draft.gitBranch}));
  if (saved) onSaved?.(encoded);
  return saved;
}
export function clearDraft(storage, circle) { try { storage?.removeItem(PREFIX + circle); } catch { /* nothing to clear */ } }
// An old successful response must not clear a newer or unreadable recovery record.
// This synchronous check is not an atomic cross-tab compare-and-delete.
export function clearDraftIfCurrent(storage, circle, id) {
  try {
    if (!storage || typeof id !== 'string') return false;
    const key = PREFIX + circle, raw = storage.getItem(key);
    if (raw === null || JSON.parse(raw)?.id !== id) return false;
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch { return false; }
}
/** The body of the one request this draft makes. The same draft always yields the same body. */
export const draftBody = (draft, circle) => {
  if (!validRequestState(draft)) throw new Error('The saved request is malformed. Reopen the saved draft before sending.');
  return {
  circle, prompt: draft.prompt.trim(), draft_id: draft.id,
  ...(!draft.followup ? ((draft.sourceKind || 'folder')==='none' ? {noSource:true} : draft.sourceKind==='git' ? {git:{url:draft.gitUrl.trim(),commit:draft.gitCommit}} : draft.sourceKind==='files' ? (draft.zip ? {zip:draft.zip} : {files:draft.files}) : {repo: {path: draft.path.trim(), ...(draft.sourceExpectedDigest?{expected_digest:draft.sourceExpectedDigest}:{}), ...(draft.includeUncommitted ? {includeUncommitted: true} : {})}}) : {}),
  ...(followupOf(draft.followup) ? {followup:followupOf(draft.followup)} : {}),
  ...(draft.sourceKind === 'none' ? {result:{kind:'message'}} : {}),
  ...(!draft.followup && draft.workingDirectory?.trim() && draft.sourceKind!=='none' ? {working_directory:draft.workingDirectory.trim()} : {}),
  ...(draft.agent ? {harness: draft.agent} : {}),
  // A model and effort are one request to the agent the lenders offered them for. A model is never sent alone: Send waits for its effort. Blank fields are the lender's choice.
  ...(draft.requestMode === 'signed' ? {runRequest:structuredClone(draft.runRequest)} : {}),

  ...(draft.requestMode !== 'signed' && draft.agent && draft.model ? {model: draft.model} : {}),
  ...(draft.requestMode !== 'signed' && draft.agent && draft.effort ? {effort: draft.effort} : {}),
  ...(draft.sourceKind !== 'none' && draft.verifyCmd?.trim() ? {verify: {cmd: draft.verifyCmd.trim()}} : {}),
  ...(draft.sendAnyway ? {send_anyway:true} : {}),
};
};
/** Did the request reach the person's own app and get a definite answer? Anything else leaves it uncertain (T21: never guess, never resend blindly). */
/** How long a send refused by a busy host waits before it is asked again: the host's Retry-After, 1–30 s. */
export const busyWait = (error, now = Date.now()) => {
  const until = error?.problem?.retryPolicy?.until;
  return Math.min(30000, Math.max(1000, Number.isFinite(until) ? until - now : 2000));
};
export const sendUncertain = error => error?.outcome !== 'not_applied';

/**
 * A new send keeps every source choice the finished job still records and never reuses its send identity.
 * Git keeps its URL and pinned commit (the branch is not recorded on a job). A files or ZIP job keeps no bytes:
 * the job record holds only a digest, so the person chooses the files again. A folder keeps its path and its
 * include-uncommitted choice, which the job records in its source label. A record that names no source gets no
 * source at all (sourceUnknown), so nothing is chosen for the person.
 */
export function newDraftFromJob(job, {prompt='',path=''}={}) {
  const signed=job.job?.payload??{}, source=signed.source??{}, label=String(job.local?.source??'');
  const recorded=job.sourceKind??job.local?.sourceKind??source.kind;
  const folder=(typeof path==='string'?path.trim():'')||(typeof job.local?.sourcePath==='string'?job.local.sourcePath.trim():'');
  const base={...fresh(''),prompt,agent:job.local?.agent||''};
  if(recorded==='none')return {...base,sourceKind:'none'};
  const workingDirectory=typeof signed.working_directory==='string'?signed.working_directory:'';
  if(recorded==='git')return {...base,sourceKind:'git',workingDirectory,
    gitUrl:typeof source.url==='string'?source.url:'',gitCommit:typeof source.commit==='string'?source.commit:''};
  if(recorded==='archive'&&!folder&&/^Uploaded files/.test(label))return {...base,sourceKind:'files',workingDirectory};
  // A folder kind alone does not identify a project. Do not let the composer guess one.
  if(!folder)return {...base,sourceKind:'folder',workingDirectory,sourceUnknown:true};
  return {...base,path:folder,sourceKind:'folder',workingDirectory,includeUncommitted:Boolean(folder)&&/\(folder, with uncommitted changes\)$/.test(label)};
}

/** The first line of a request, short enough to name it in one sentence. */
export function draftExcerpt(text, max = 80) {
  const line = String(text ?? '').trim().split(/\r?\n/)[0].trim();
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}
// Home text the person chose to keep while opening an earlier draft. Home puts it back in its box.
export const HOME_TEXT_KEY = 'faravan-home-text';
export function readHomeText(storage) { const value = read(storage, HOME_TEXT_KEY); return typeof value === 'string' ? value : ''; }
export function keepHomeText(storage, text) {
  try {
    if (!String(text ?? '').trim()) { storage?.removeItem(HOME_TEXT_KEY); return true; }
    return write(storage, HOME_TEXT_KEY, text);
  } catch { return false; }
}

// Home handoff is fail-closed; unlike background draft saving it must prove persistence before navigation.
// Every question names the earlier request by its excerpt (and its age, when the draft stores one).
export function handoffHomeDraft(storage, circle, prompt, {replace=false, keep=false}={}) {
  try {
    if (!storage?.getItem || !storage?.setItem) return {state:'failed'};
    const raw=storage.getItem(PREFIX+circle);
    const saved=raw===null ? null : JSON.parse(raw);
    if (saved && (typeof saved.id!=='string' || !/^[A-Za-z0-9-]{8,64}$/.test(saved.id))) return {state:'failed'};
    const savedText=String(saved?.prompt??'').trim();
    const earlier={raw, text:String(saved?.prompt??''), excerpt:draftExcerpt(savedText), editedAt:Number.isFinite(saved?.editedAt)?saved.editedAt:null};
    if (!keep && (saved?.sending || saved?.uncertainSince != null)) return {state:'pending',...earlier};
    if (!keep && saved?.agentRefusal) return {state:'refused',...earlier};
    // Same text, or nothing saved to lose: just open it.
    const same=savedText===prompt.trim();
    if (!keep && prompt.trim() && savedText && !same && !replace) return {state:'replace',...earlier};
    // Opening the earlier draft keeps Home's new text on this computer; Home puts it back in its box.
    if (keep && prompt.trim() && !keepHomeText(storage,prompt)) return {state:'preserve'};
    // Establish the route binding before touching the draft; any error leaves Home text visible.
    storage.setItem('faravan-compose-circle',circle);
    if (storage.getItem('faravan-compose-circle')!==circle) return {state:'failed'};
    if (!keep && prompt.trim() && !same) {
      // Validate default reads too: loadDraft intentionally swallows errors for background use.
      storage.getItem(FOLDER); storage.getItem(SOURCE);
      const draft=saved ? {...saved,prompt} : {...loadDraft(storage,circle),prompt};
      const {files,zip,...metadata}=draft;
      const encoded=JSON.stringify({...metadata,editedAt:Date.now(),files:[],zip:null});
      storage.setItem(PREFIX+circle,encoded);
      if(storage.getItem(PREFIX+circle)!==encoded)return {state:'failed'};
    }
    return {state:'open'};
  } catch { return {state:'failed'}; }
}

// Explicit discard/undo checks the exact saved snapshot. These synchronous checks
// are best-effort across tabs, not an atomic storage transaction.
export function discardSavedDraft(storage, circle, raw) {
  try {
    const saved = JSON.parse(raw);
    if (!saved || saved.sending || saved.uncertainSince != null || saved.agentRefusal ||
        storage.getItem(PREFIX + circle) !== raw) return false;
    storage.removeItem(PREFIX + circle);
    return storage.getItem(PREFIX + circle) === null;
  } catch { return false; }
}
export function undoDiscardedDraft(storage, circle, raw, expectedRaw = null) {
  try {
    const current = storage.getItem(PREFIX + circle);
    if (current !== expectedRaw) return false;
    storage.setItem(PREFIX + circle, raw);
    return storage.getItem(PREFIX + circle) === raw;
  } catch { return false; }
}
