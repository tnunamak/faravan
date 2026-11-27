import {durableJsonAsync} from '../durable-write.mjs';
// What the submitting device already knows about its own jobs (prompt, title, source summary,
// agent, model). Local to this home, keyed by job digest, never sent to the circle.
import {readFile, rename, mkdir} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import { acquireProcessLock, withProfileWriter } from './lock.mjs';
import { CONTEXT_HEADER, requestLine } from './request-line.mjs';
const MAX_VERDICTS = 10000;

const MAX_PROMPT = 65536, MAX_TITLE = 160, MAX_ENTRIES = 2000;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const writes = new Map();

/** First non-empty line of the person's own request (a follow-up's new request, not its context envelope), trimmed to a readable length. */
export function defaultTitle(prompt) {
  const line = requestLine(prompt);
  const chars = [...line];
  return chars.length > 80 ? chars.slice(0, 79).join('') + '…' : line;
}
export function cleanTitle(value) {
  // Titles saved before follow-up titles were fixed can hold the envelope's warning line; that is never a title.
  if (String(value ?? '').trim().startsWith(CONTEXT_HEADER.trim())) return '';
  const text = [...String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim()].slice(0, MAX_TITLE).join('').trim();
  return text;
}

export function createJobMetaStore(directory) {
  const file = resolve(directory, 'job-meta.json');
  const lockFile = join(directory, 'job-meta.lock');
  async function load() {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  const inflight=new Set();
  function mutate(change) {
    // Take the profile gate before joining the file queue: its current owner
    // may need a nested metadata write to finish before releasing that gate.
    const run=withProfileWriter(dirname(directory),()=>{
      const queued=(writes.get(file)??Promise.resolve()).catch(()=>{}).then(()=>mutateNow(change));
      writes.set(file,queued);
      const finished=()=>{if(writes.get(file)===queued)writes.delete(file);};
      queued.then(finished,finished);return queued;
    },{timeoutMs:3000});
    inflight.add(run);
    const finished=()=>inflight.delete(run);
    run.then(finished,finished);return run;
  }
  async function mutateNow(change) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // The holder fsyncs the file and its parent, which can outlast the default 250 ms on a busy disk.
    const release = await acquireProcessLock(lockFile, { timeoutMs: 3000 });
    try {
      const all = await load(), result = change(all);
      const keys = Object.keys(all);
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => String(all[a].submittedAt).localeCompare(String(all[b].submittedAt)));
        for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[key];
      }
      await durableJsonAsync(file,all);
      return result;
    } finally { release(); }
  }
  return {
    async snapshotForDisplay() {
      const all=await load();
      return {get:async digest=>DIGEST.test(digest??'')?structuredClone(all[digest]??null):null};
    },
    // Resolves once every in-flight write has finished; app close waits for it.
    settled:async()=>{while(inflight.size)await Promise.allSettled([...inflight]);},
    async thread(digest,circle) {
      const all=await load(),rootOf=id=>{const seen=new Set();while(all[id]?.circle===circle&&all[id]?.parentJob&&!seen.has(id)){seen.add(id);id=all[id].parentJob;}return id;};
      const root=rootOf(digest);
      // submittedAt has one-second resolution, so a follow-up can tie with its parent. Ties go to the job recorded later (a follow-up is recorded after its parent), not to the digest.
      return Object.entries(all).filter(([id,entry])=>entry.circle===circle&&rootOf(id)===root).map(([job_digest,entry],recorded)=>({recorded,job_digest,title:entry.title,parentJob:entry.parentJob??null,submittedAt:entry.submittedAt,runs:entry.runs??[]})).sort((a,b)=>String(b.submittedAt).localeCompare(String(a.submittedAt))||b.recorded-a.recorded).map(({recorded,...row})=>row);
    },
    async observe(digest,view) {
      if(!DIGEST.test(digest)||!view.current_attempt)return;
      const entry=await this.get(digest),prior=entry?.runs?.find(run=>run.attempt_id===view.current_attempt.attempt_id);
      const next={...view.current_attempt,...(view.result_digest?{result_digest:view.result_digest}:{})};
      if(!entry||JSON.stringify(prior)===JSON.stringify(next))return;
      return mutate(all=>{
        if(!all[digest])return;
        const runs=all[digest].runs??=[],index=runs.findIndex(run=>run.attempt_id===next.attempt_id);
        if(index<0)runs.push(next);
        else {
          if(['completed','failed','released','expired','cancelled'].includes(runs[index].state)&&!['completed','failed','released','expired','cancelled'].includes(next.state))return;
          runs[index]={...runs[index],...next};
        }
      });
    },
    async get(digest) { return DIGEST.test(digest ?? '') ? (await load())[digest] ?? null : null; },
    /** Record once per job: a resubmission of the same intent keeps the title the user edited. */
    async record(digest, entry) {
      if (!DIGEST.test(digest)) return null;
      return mutate(all => {
        if (!all[digest]) all[digest] = {
          title: cleanTitle(entry.title) || defaultTitle(entry.prompt) || 'Untitled job',
          prompt: String(entry.prompt ?? '').slice(0, MAX_PROMPT),
          source: String(entry.source ?? '').slice(0, 512),
          ...(typeof entry.sourcePath==='string' ? {sourcePath:entry.sourcePath.slice(0,4096)} : {}),
          ...(typeof entry.sourceBranch==='string' ? {sourceBranch:entry.sourceBranch.slice(0,256)} : {}),
          ...(DIGEST.test(entry.parentJob??'')&&DIGEST.test(entry.parentResult??'')?{parentJob:entry.parentJob,parentResult:entry.parentResult}:{}),
          ...(entry.sentByAgent===true?{sentByAgent:true}:{}),
          agent: entry.agent ?? null, model: entry.model ?? null,
          circle: entry.circle ?? null, submittedAt: entry.submittedAt,
        };
        return all[digest];
      });
    },
    /** Add as a branch (U22): what was written, kept so the job page says "Added as a branch". Own jobs only. */
    async setApplied(digest, applied) {
      if (!DIGEST.test(digest)) return null;
      const entry = { branch: String(applied.branch ?? '').slice(0, 256), repo: String(applied.repo ?? '').slice(0, 1024), commit: String(applied.commit ?? '').slice(0, 64), at: applied.at };
      return mutate(all => { if (!all[digest]) return null; all[digest].applied = entry; return entry; });
    },
    /** Remove this branch: forgets the Add as a branch record, only while it still names `commit` (compare-and-clear). */
    async clearApplied(digest, commit) {
      if (!DIGEST.test(digest ?? '')) return false;
      return mutate(all => { if (!all[digest]?.applied || all[digest].applied.commit !== commit) return false; delete all[digest].applied; return true; });
    },
    async setTitle(digest, title) {
      const clean = cleanTitle(title);
      if (!clean || !DIGEST.test(digest)) return null;
      return mutate(all => { if (!all[digest]) return null; all[digest].title = clean; return all[digest]; });
    },
  };
}

// Borrower observations are separate from submission metadata and all signed objects.
// The JSON tuple binds the exact circle id and job digest without ambiguous delimiters.
export function createBorrowerOutcomeStore(directory) {
  const file = join(directory, 'borrower-outcomes.json');
  const lockFile = join(directory, 'borrower-outcomes.lock');
  const keyFor = (circle, digest) => typeof circle === 'string' && circle.length > 0 &&
    circle.length <= 512 && DIGEST.test(digest ?? '') ? JSON.stringify([circle, digest]) : null;
  const invalid = () => { throw Object.assign(new Error('invalid_request'), { code: 'invalid_request', status: 400 }); };
  function clean(value) {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['verdict', 'note', 'checks'].includes(key)) ||
      !['used', 'needs-more-work', 'unused'].includes(value.verdict)) invalid();
    for (const [key, limit] of [['note', 1000], ['checks', 4000]]) {
      if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > limit)) invalid();
    }
    return { verdict: value.verdict, note: value.note ?? '', checks: value.checks ?? '' };
  }
  // A damaged verdict file must not hide verified jobs: it reads as empty, and the next save
  // moves the bad bytes aside instead of overwriting them.
  async function load() {
    let text;
    try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { all: {} }; return { all: {}, corrupt: true }; }
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { all: {}, corrupt: true };
      return { all: value };
    } catch { return { all: {}, corrupt: true }; }
  }
  return {
    async get(circle, digest) {
      const key = keyFor(circle, digest);
      return key ? (await load()).all[key] ?? null : null;
    },
    async set(circle, digest, value) {
      const key = keyFor(circle, digest), outcome = clean(value);
      if (!key) invalid();
      return withProfileWriter(dirname(directory), async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const release = await acquireProcessLock(lockFile, { timeoutMs: 3000 });
        try {
          const { all, corrupt } = await load();
          if (corrupt) await rename(file, file + '.corrupt-' + Date.now()).catch(() => {});
          if (outcome === null) delete all[key];
          else {
            if (!(key in all) && Object.keys(all).length >= MAX_VERDICTS) throw Object.assign(new Error('verdict_store_full'), { code: 'verdict_store_full', status: 409 });
            all[key] = outcome;
          }
          await durableJsonAsync(file,all);
          return outcome;
        } finally { release(); }
      },{timeoutMs:3000});
    },
  };
}
