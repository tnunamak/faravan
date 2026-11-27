import { useEffect, useRef, useState } from 'preact/hooks';
import { Button, Command, Icon, Sheet, Spinner } from './ds/index.mjs';
import { applyPreviewVM, applyRefusalVM, applyCommandVM, showBranchCommandVM, defaultApplyBranchVM } from './view-models.mjs';

import { applyWriteRecord } from './result-actions.mjs';

const LAST = 'faravan-apply-repo';
const remembered = () => { try { return localStorage.getItem(LAST) || ''; } catch { return ''; } };
const remember = (path) => { try { localStorage.setItem(LAST, path); } catch { /* the folder is just not remembered */ } };

// What the sheet shows, as a pure view of its state: the preview (what a dry run says it would write), a changed
// repository (the new state, nothing written), a refusal (its own words and next step) or a plain form.
export function ApplyBody({ phase, repo, branch, summary, refusal, context, lender, digest, sourceBranch, onRepo, onBranch, onChoose, onRetry, onRename, onPatch, onDetails, onFollowup, onRecover, adding = false, copyState = '', detailsText = '' }) {
  const preview = summary ? applyPreviewVM(summary, { lender, digest, sourceBranch }) : null;
  const refused = refusal ? applyRefusalVM(refusal, {...context,branch:refusal.branch || context.branch}) : null;
  return (
    <div class="stack-3 apply-body ph-no-capture" data-telemetry-private="apply-sheet">
      <h2 class="t-title2">Add as a branch</h2>
      <p class="t-sm t-2">Creates a separate branch and leaves your checked-out files alone. Apply to working tree is the other action: it previews the affected files and writes your confirmed selection into the checked-out folder as uncommitted changes. Both actions remain available.</p>
      <label class="field"><span class="t-sm"><b>Repository folder</b> <span class="t-2">on the computer running Faravan</span></span>
        <input class="input" aria-label="Repository folder" value={repo} placeholder="/home/you/code/project" autocomplete="off" spellcheck={false}
          disabled={adding} onInput={(e) => onRepo(e.currentTarget.value)} />
      </label>
      {phase === 'checking' && <p class="t-sm t-2" role="status"><Spinner /> Checking the repository…</p>}
      {refused && (
        <div class="banner bad" role="alert">
          <Icon name="alert" />
          <div class="grow">
            <p>{refused.text}</p>
            <div class="hstack-2 wrap apply-remedies">
              {refused.actions.includes('choose') && <Button size="sm" onClick={onChoose}>Change the folder</Button>}
              {refused.actions.includes('retry') && <Button size="sm" onClick={onRetry}>Check the project again</Button>}
              {refused.actions.includes('recover') && <Button size="sm" onClick={onRecover}>Recover preview locks</Button>}
              {refused.actions.includes('rename') && <Button size="sm" onClick={onRename}>Use another name</Button>}
              {refused.actions.includes('patch') && <Button size="sm" onClick={onPatch}>Download the patch</Button>}
              {refused.actions.includes('followup') && <Button size="sm" onClick={onFollowup}>Send a follow-up job</Button>}
              {refused.actions.includes('details') && <Button size="sm" disabled={copyState === 'copying'} disabledReason="Copying the details…" onClick={onDetails}>Copy details</Button>}
            </div>
            {copyState === 'copying' && <p role="status">Copying details…</p>}
            {copyState === 'copied' && <p role="status">Details copied.</p>}
            {copyState === 'failed' && <div role="alert"><p>Couldn’t copy details. Try Copy details again, or select and copy them below.</p><textarea class="input" aria-label="Details to copy manually" readOnly value={detailsText} /></div>}
            {refused.state === 'job.apply-branch-exists' && <details class="job-details"><summary>Show the inspect-branch command</summary><Command text={showBranchCommandVM(repo, refusal.branch || context.branch || branch)} /></details>}
          </div>
        </div>
      )}
      {phase === 'changed' && <p class="t-sm" role="status"><b>The repository changed since you looked.</b> Here is what it looks like now. Nothing was written.</p>}
      {preview && (
        <>
          <p>{preview.adds.map((part) => (part.strong ? <b>{part.text}</b> : part.text))}</p>
          <p class="t-sm">{preview.starts}</p>
          <p class="t-sm">{preview.count}</p>
          <ul class="apply-files">{preview.files.map((f) => <li key={f.path}><code>{f.path}</code> <span class="plus">{f.plus}</span> <span class="minus">{f.minus}</span></li>)}</ul>
          <p class="t-sm">{preview.commit}</p>

        </>
      )}
      <label class="field"><span class="t-sm"><b>Branch name</b></span><input class="input mono" aria-label="Branch name" value={branch} disabled={adding} onInput={e => onBranch(e.currentTarget.value)} /></label>
      <details class="job-details apply-terminal"><summary>Show the add-branch command</summary><Command text={applyCommandVM({digest, branch})} /></details>
    </div>
  );
}

// The Add as a branch sheet. It previews with a dry run, and "Add the branch" repeats the same inputs with what it
// showed; if the repository moved, it shows the new state and writes nothing (the person looks again, then adds).
export function ApplySheet({ open, onClose, api, jobId, circle, lender, sourceFolder = '', sourceBranch = '', onApplied, onPatch, onFollowup }) {
  const [repo, setRepo] = useState(() => sourceFolder || remembered()), [branch, setBranch] = useState(() => defaultApplyBranchVM(jobId)), [phase, setPhase] = useState('form');
  const [summary, setSummary] = useState(null), [refusal, setRefusal] = useState(null), [busy, setBusy] = useState(false);
  const [copyState, setCopyState] = useState('');
  const write = applyWriteRecord(api, circle, jobId);
  const [writeState, setWriteState] = useState(write.state);
  const blocked = () => ['pending', 'uncertain', 'reconciling', 'applied'].includes(write.state?.phase);
  const adding = useRef(blocked());
  const base = 'jobs/' + encodeURIComponent(jobId) + '/apply';
  const mounted = useRef(true), generation = useRef(0), currentRepo = useRef(repo);
  const previewMatches = summary?.requestedRepo === repo.trim();
  function changeRepo(value) {
    if (blocked()) return;
    write.clear();
    setCopyState('');
    generation.current++; currentRepo.current = value;
    setRepo(value); setSummary(null); setBusy(false); setPhase('form'); setRefusal(null);
  }
  function changeBranch(value) {
    if (blocked()) return;
    write.clear();
    setCopyState('');
    generation.current++;
    setBranch(value); setSummary(null); setBusy(false); setPhase('form'); setRefusal(null);
  }
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = write.subscribe(state => {
      if (!mounted.current) return;
      setWriteState(state);
      adding.current = ['pending', 'uncertain', 'reconciling', 'applied'].includes(state?.phase);
      if (!state) return;
      generation.current++;
      const {target, receipt, error} = state;
      currentRepo.current = target.requestedRepo;
      setRepo(target.requestedRepo); setBranch(target.branch);
      setBusy(state.phase === 'pending' || state.phase === 'reconciling');
      setSummary(null); setRefusal(null); setPhase(state.phase);
      if (state.phase === 'applied') {
        write.deliver(out => { remember(out.repo); return onApplied?.(out); });
      } else if (state.phase === 'changed') {
        setSummary({...receipt, requestedRepo:target.requestedRepo});
      } else if (state.phase === 'refused') {
        setRefusal({...error.refused, branch:target.branch});
      }
    });
    return () => { unsubscribe(); mounted.current = false; generation.current++; };
  }, [write]);
  useEffect(() => { if (!open && sourceFolder && !write.state) changeRepo(sourceFolder); }, [sourceFolder]);
  async function call(body) {
    try { return await api.post(base, { circle, ...body }); }
    catch (error) {
      if (!error.applyRefusal) throw error;
      const refused = { ...error.applyRefusal, code:error.applyRefusal.code || error.code, errorId:error.problem?.diagnosticId || error.error_id || error.errorId };
      throw Object.assign(error, { refused });
    }
  }
  async function preview(next = {}) {
    if (blocked()) return;
    write.clear();
    setCopyState('');
    const requestedRepo = (next.repo ?? currentRepo.current).trim();
    if (!requestedRepo) return;
    const requestedBranch = (next.branch ?? branch).trim() || defaultApplyBranchVM(jobId);
    const request = ++generation.current;
    const active = () => mounted.current && generation.current === request && currentRepo.current.trim() === requestedRepo;
    setSummary(null);
    setBusy(true); setRefusal(null); setPhase('checking');
    try {
      const out = await call({ repo: requestedRepo, dry_run: true, branch:requestedBranch });
      if (!active()) return;
      if (out.status === 'applied') { remember(out.repo); onApplied?.(out); return; }
      setSummary({...out, requestedRepo}); setBranch(out.branch); setPhase('preview');
    } catch (error) {
      if (!active()) return;
      setSummary(null); setRefusal({...error.refused,state:error.refused?.state || 'job.apply-failed',code:error.refused?.code || error.code,branch:requestedBranch}); setPhase('refused');
    } finally { if (active()) setBusy(false); }
  }
  async function add() {
    if (blocked() || busy || !summary || summary.requestedRepo !== currentRepo.current.trim()) return;
    write.clear();
    await write.submit({repo:summary.repo, requestedRepo:summary.requestedRepo, branch:branch.trim(),
      preview_token:summary.preview_token, job_digest:summary.job_digest, base:summary.base, patch_hash:summary.patch_hash}, call);
  }
  async function recover() {
    if (blocked() || busy || !currentRepo.current.trim()) return;
    const requestedRepo = currentRepo.current.trim();
    const request = ++generation.current;
    const active = () => mounted.current && generation.current === request && currentRepo.current.trim() === requestedRepo;
    setBusy(true);
    try {
      await call({repo:requestedRepo, dry_run:false, recover_locks:true});
      if (active()) await preview();
    } catch (error) {
      if (active()) { setRefusal({...error.refused, state:error.refused?.state || 'job.apply-failed', code:error.refused?.code || error.code}); setPhase('refused'); }
    } finally { if (active()) setBusy(false); }
  }
  // Opening with a remembered folder previews at once.
  useEffect(() => {
    if (write.state || writeState) return;
    if (open) { if (currentRepo.current.trim()) preview(); }
    else { generation.current++; setBusy(false); setSummary(null); setPhase('form'); setRefusal(null); }
  }, [open]);
  // Answers false while a write has no known outcome: the sheet stays open (see Sheet's veto).
  const close = () => {if (blocked()) return false;write.clear();generation.current++;setSummary(null);setBusy(false);setPhase('form');setRefusal(null);onClose?.();};
  const detailsText = JSON.stringify({ state: refusal?.state, code: refusal?.code, errorId:refusal?.errorId, job: jobId, circle, repo });
  async function copyDetails() {
    setCopyState('copying');
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await globalThis.navigator.clipboard.writeText(detailsText);
      setCopyState('copied');
    } catch { setCopyState('failed'); }
  }
  const context = { repo, base: summary?.base, branch };
  return (
    <Sheet class="ph-no-capture" open={open || !!writeState || phase === 'refused' || phase === 'changed'} onClose={close} label="Add as a branch" data-telemetry-private="apply-sheet">
      <ApplyBody adding={adding.current} copyState={copyState} detailsText={detailsText} phase={phase} repo={repo} branch={branch} summary={previewMatches ? summary : null} refusal={refusal} context={context} lender={lender} digest={jobId} sourceBranch={sourceBranch}
        onRepo={changeRepo} onBranch={changeBranch}
        onChoose={() => document.querySelector('.apply-body input')?.focus()} onRetry={() => preview()} onRename={() => document.querySelector('.apply-body input[aria-label="Branch name"]')?.focus()}
        onPatch={onPatch} onRecover={recover} onFollowup={() => {close();onFollowup?.();}} onDetails={copyDetails} />
      {!previewMatches && repo.trim() && <p class="t-sm t-2 apply-hint" role="status">Check this folder before adding the branch.</p>}
      {writeState?.phase === 'pending' && <p class="t-sm" role="status">Adding the branch… This write has already been sent and cannot be cancelled. Wait for its result before closing.</p>}
      {['uncertain', 'reconciling'].includes(writeState?.phase) && <div role="alert">
        <p>Could not confirm whether {writeState.target.branch} was added in {writeState.target.repo}. Do not add it again until the original write is checked.</p>
        <p>This sheet stays open until the write is checked.</p>
        <Button pending={busy} onClick={() => write.reconcile(call)}>Check the submitted branch</Button>
        <details class="job-details"><summary>Show the inspect-branch command</summary><Command text={showBranchCommandVM(writeState.target.repo, writeState.target.branch)} /></details>
      </div>}
      {writeState?.phase === 'applied' && <div role="status">
        <p>Added {writeState.target.branch} in {writeState.target.repo}. The saved result is retained until it can be shown.</p>
        <Button onClick={() => write.deliver(out => { remember(out.repo); return onApplied?.(out); })}>Show the added branch</Button>
      </div>}
      <div class="pair">
        <Button kind="secondary" disabled={adding.current} disabledReason="Adding the branch. Wait for it to finish." onClick={close}>Cancel</Button>
        {previewMatches && summary && phase !== 'refused' ? <Button key="add-branch" kind="primary" pending={busy} disabled={adding.current} disabledReason="Adding the branch. Wait for it to finish." onClick={add}><Icon name="branch" size="sm" />Add the branch</Button>
          : <Button key="check-repository" kind="primary" pending={busy} disabled={adding.current || !repo.trim()} disabledReason={adding.current ? 'Adding the branch. Wait for it to finish.' : 'Enter the repository folder first'} onClick={() => preview()}>Check the repository</Button>}
      </div>
      {!repo.trim() && <p class="t-sm t-2 apply-hint">Enter the repository folder to check it.</p>}
    </Sheet>
  );
}
