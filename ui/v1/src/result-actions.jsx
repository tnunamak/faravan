import { useRef, useState, useEffect } from 'preact/hooks';
import { Button, Command, Icon, Spinner } from './ds/index.mjs';
import { editorLinksVM, workingTreePreviewVM, workingTreeRequestVM, resultActionRefusalVM, undoCommandVM, removeBranchVM, confirmedWorkingTreeReceipt, createResultWriteGuard } from './result-actions.mjs';

const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

/** Open in editor: deep links for a folder on this computer. Nothing shows for a folder Faravan can't link safely. */
export function EditorLinks({ repo, label = 'Open in' }) {
  const links = editorLinksVM(repo);
  if (!links.length) return null;
  return <p class="result-editor t-sm ph-no-capture" data-telemetry-private="result-actions"><span class="t-2">{label}</span>{links.map(l => <a key={l.label} class="btn btn-quiet btn-sm" href={l.href}><Icon name="ext" size="sm" />{l.label}</a>)}</p>;
}

// What the actions panel shows, as a pure view of its state (no effects), so tests can render each state.
export function ResultActionsBody({ repo, phase, preview, selection, refusal, applied, done, removal = {}, onRepo, onCheck, onToggle, onApply, onRemoveAsk, onRemoveConfirm, onRemoveCancel, submittedRepo = repo, onReconciled, onRemovalReconciled }) {
  const vm = preview && (phase === 'preview' || phase === 'changed' || phase === 'applying') ? workingTreePreviewVM(preview) : null;
  const remove = removeBranchVM(applied) || (removal.phase === 'unconfirmed' ? {branch:removal.branch || ''} : null);
  const locked = phase === 'applying' || phase === 'unconfirmed' || removal.phase === 'removing' || removal.phase === 'unconfirmed';
  const chosen = vm ? vm.files.filter(f => f.selectable && selection.includes(f.path)).length : 0;
  return (
    <div class="stack-4 result-actions ph-no-capture" data-telemetry-private="result-actions">
      <EditorLinks repo={done?.repo || applied?.repo || repo} />
      <section class="stack-3" aria-labelledby="result-apply-tree">
        <h3 class="t-title3" id="result-apply-tree">Apply to working tree</h3>
        <p class="t-sm t-2">Previews the affected files, then writes your confirmed selection into the checked-out folder as uncommitted changes, merging three ways with your commits. Your folder must have no uncommitted changes.</p>
        <p class="t-sm t-2">Add as a branch writes a separate branch instead and leaves the checked-out files alone. Both actions remain available.</p>
        {phase !== 'applied' && <form class="result-apply-form" onSubmit={e => { e.preventDefault(); if (!locked) onCheck?.(); }}>
          <label class="field grow"><span class="t-sm"><b>Repository folder</b></span>
            <input class="input" aria-label="Repository folder for apply" value={repo} disabled={locked} placeholder="/home/you/code/project" autocomplete="off" spellcheck={false} onInput={e => !locked && onRepo?.(e.currentTarget.value)} />
          </label>
          <Button type="submit" pending={phase === 'checking'} disabled={locked || !repo.trim()} disabledReason={locked ? 'Waiting for the current change to finish.' : 'Enter the repository folder first'}>Check the folder</Button>
        </form>}
        {phase === 'applying' && <p class="t-sm" role="status">Applying to {submittedRepo} — wait for the result before changing folders.</p>}
        {phase === 'unconfirmed' && <div role="alert"><p>The outcome is not confirmed. Check the repository before trying again.</p><p>Submitted folder: {submittedRepo}</p><Button onClick={onReconciled}>I checked the repository</Button></div>}
        {phase === 'checking' && <p class="t-sm t-2" role="status"><Spinner /> Checking the folder…</p>}
        {phase === 'refused' && refusal && <div class="banner bad" role="alert"><Icon name="alert" /><p class="grow">{resultActionRefusalVM(refusal)}</p></div>}
        {phase === 'changed' && <p class="t-sm" role="status"><b>The repository changed since you looked.</b> Here is what it looks like now. Nothing was written.</p>}
        {vm && <>
          <p class="t-sm">{vm.summary}</p>
          <p class="t-sm t-2">This lists affected files, not the final merged contents. Review the result diff; files merged with your commits may differ.</p>
          {vm.blocked && <div class="banner bad" role="alert"><Icon name="alert" /><p class="grow">{vm.blocked}</p></div>}
          <ul class="result-apply-files" aria-label="Files to apply">{vm.files.map(f => <li key={f.path} class={'is-' + f.state}>
            <label>
              {vm.perFile && <input type="checkbox" checked={f.selectable && selection.includes(f.path)} disabled={locked || !f.selectable || !!vm.blocked} onChange={() => { if (!locked) onToggle?.(f.path); }} />}
              <code>{f.oldPath ? f.oldPath + ' → ' : ''}{f.path}</code><span class="t-xs">{f.status}</span>{f.binary && <span class="t-xs">Binary</span>}
              <span class="diff-count"><span class="plus">{f.plus}</span> <span class="minus">{f.minus}</span></span>
              <span class={'result-apply-state t-xs' + (f.selectable ? '' : ' is-blocked')}>{f.word}</span>
            </label>
          </li>)}</ul>
          {!vm.blocked && <div class="hstack-2 wrap"><Button kind="secondary" pending={phase === 'applying'} disabled={locked || !chosen} disabledReason={locked ? 'Waiting for the current change to finish.' : 'Choose what to apply first'} onClick={() => { if (!locked) onApply?.(); }}><Icon name="file" size="sm" />Apply {plural(vm.perFile ? chosen : vm.files.length, 'file')}</Button></div>}
        </>}
        {phase === 'applied' && done && <div class="stack-3" role="status">
          <p class="t-sm"><Icon name="check-circle" size="sm" /> Applied {plural(done.applied.length, 'file')} to {done.repo}. Nothing was staged or committed.</p>
          {undoCommandVM(done.repo, done.undo) && <details class="job-details"><summary>Discard applied changes from the terminal</summary><p>This discards all current uncommitted changes in the listed files, including edits made after applying. Back up your work first. It cannot recover deleted file contents.</p><Command text={undoCommandVM(done.repo, done.undo)} /></details>}
        </div>}
      </section>
      {remove && <section class="stack-3" aria-labelledby="result-remove-branch">
        <h3 class="t-title3" id="result-remove-branch">Remove this branch</h3>
        {removal.phase === 'removed' ? <p class="t-sm" role="status">{removal.gone ? (removal.branch || remove.branch) + ' was already removed.' : 'Removed ' + (removal.branch || remove.branch) + '.'}</p> : <>
          <p class="t-sm t-2">Undo Add as a branch while nobody has added commits to <code>{remove.branch}</code>.</p>
          {removal.phase === 'unconfirmed' && <div role="alert"><p>The outcome is not confirmed. Check the repository before trying again.</p><p>Submitted folder: {removal.repo}</p><Button onClick={onRemovalReconciled}>I checked the repository</Button></div>}
          {removal.refusal && <div class="banner bad" role="alert"><Icon name="alert" /><p class="grow">{resultActionRefusalVM(removal.refusal)}</p></div>}
          {removal.phase === 'confirm' || removal.phase === 'removing'
            ? <div class="stack-2"><p class="t-sm">{remove.confirm}</p><div class="hstack-2 wrap"><Button kind="danger" pending={removal.phase === 'removing'} disabled={locked} disabledReason="Waiting for the current change to finish." onClick={() => { if (!locked) onRemoveConfirm?.(); }}><Icon name="trash" size="sm" />Remove {remove.branch}</Button><Button kind="quiet" disabled={locked} disabledReason="Waiting for the current change to finish." onClick={() => { if (!locked) onRemoveCancel?.(); }}>Keep it</Button></div></div>
            : <div><Button kind="quiet" pending={removal.phase === 'checking'} disabled={locked} disabledReason="Waiting for the current change to finish." onClick={() => { if (!locked) onRemoveAsk?.(); }}><Icon name="undo" size="sm" />Remove this branch…</Button></div>}
        </>}
      </section>}
    </div>
  );
}

// Known refusals retain their safety reason; uncertain outcomes keep a typed problem.
// lib/v1/result-actions.mjs raises these apply refusals before git restore touches the working tree.
// write_failed comes after a restore attempt, and unknown codes are unproven, so both stay unconfirmed.
const APPLY_PREWRITE_REFUSALS = new Set(['repo_missing','not_a_repository','repo_busy','patch_conflict','unsafe_patch','index_flags',
  'attributes','invalid_job','patch_invalid','unknown_file','nothing_selected','too_many_files','dirty','path_exists','unsafe_path']);
const refusalOf = error => error?.applyRefusal ? {code:error.applyRefusal.code} : {problem:error?.problem??error};

/**
 * The job page's other result actions: Open in editor, Apply to working tree (check, choose files, apply) and Remove
 * this branch. Add as a branch stays the primary action elsewhere. `onChanged` runs after anything was written.
 */
export function ResultActions({ api, jobId, circle, applied = null, sourceFolder = '', onChanged }) {
  const [repo, setRepo] = useState(() => sourceFolder || applied?.repo || ''), [phase, setPhase] = useState('idle');
  const [preview, setPreview] = useState(null), [selection, setSelection] = useState([]), [refusal, setRefusal] = useState(null), [done, setDone] = useState(null);
  const [removal, setRemoval] = useState({}), [submittedRepo, setSubmittedRepo] = useState('');
  const write = useRef(createResultWriteGuard());
  const removalGeneration = useRef(0);
  const generation = useRef(0), mounted = useRef(true);
  const base = 'jobs/' + encodeURIComponent(jobId) + '/';
  useEffect(() => () => { mounted.current = false; generation.current++; }, []);
  useEffect(() => { if (!write.current.state) { removalGeneration.current++; setRemoval({}); } }, [applied?.repo, applied?.branch, applied?.commit]);
  const live = ticket => mounted.current && ticket === generation.current;
  function changeRepo(value) { if (write.current.state) return; generation.current++; setRepo(value); setPreview(null); setPhase('idle'); setRefusal(null); }
  function showPreview(result, nextPhase) { setPreview(result); setSelection(workingTreePreviewVM(result).defaultSelection); setPhase(nextPhase); }
  async function run(body, onResult) {
    const ticket = ++generation.current;
    try { const result = await api.post(base + 'working-tree', body); if (live(ticket)) onResult(result); }
    catch (error) {
      if (!live(ticket)) return;
      setRefusal(refusalOf(error)); setPhase('refused');
    }
  }
  const check = () => {
    if (write.current.state) return;
    setPhase('checking'); setRefusal(null);
    return run(workingTreeRequestVM({circle, repo, preview:null}), r => showPreview(r, 'preview'));
  };
  const apply = async () => {
    if (!preview || workingTreePreviewVM(preview).blocked || !selection.length ||
        !write.current.begin('applying')) return;
    // The server answers with the repository's top folder, so bind the write and its receipt to the checked folder.
    const target = typeof preview.repo === 'string' && preview.repo ? preview.repo : repo.trim(), chosen = [...selection], ticket = ++generation.current;
    setSubmittedRepo(target); setPhase('applying'); setRefusal(null);
    try {
      const r = await api.post(base + 'working-tree', workingTreeRequestVM({circle, repo:target, preview, selection:chosen}));
      if (!live(ticket)) return;
      if (r?.status === 'changed' && r.repo === target && Array.isArray(r.files)) {
        write.current.settle(true); return showPreview(r, 'changed');
      }
      const receipt = confirmedWorkingTreeReceipt(r, target, chosen);
      setDone(receipt || {repo:target, response:r});
      write.current.settle(!!receipt); setPhase(receipt ? 'applied' : 'unconfirmed');
      if (receipt) { try { await onChanged?.(); } catch { /* A refresh failure does not invalidate the write receipt. */ } }
    } catch (error) {
      if (!live(ticket)) return;
      if (APPLY_PREWRITE_REFUSALS.has(error?.applyRefusal?.code)) { write.current.settle(true); setRefusal(refusalOf(error)); return setPhase('refused'); }
      write.current.settle(false); setDone({repo:target, error}); setPhase('unconfirmed');
    }
  };
  const toggle = path => { if (!write.current.state) setSelection(s => s.includes(path) ? s.filter(p => p !== path) : [...s, path]); };
  const reconciled = () => {
    if (!write.current.acknowledge()) return;
    // Explicit manual reconciliation still requires a new dry run before another write.
    generation.current++; setPreview(null); setSelection([]); setPhase('idle');
  };
  async function removeStep(dryRun) {
    if (write.current.state || (!dryRun && !write.current.begin('removing'))) return;
    const target = applied?.repo, branch = applied?.branch, ticket = ++removalGeneration.current;
    setRemoval({phase:dryRun ? 'checking' : 'removing', repo:target});
    try {
      const r = await api.post(base + 'remove-branch', {circle, dry_run:dryRun});
      if (!mounted.current || ticket !== removalGeneration.current) return;
      if (dryRun) return setRemoval({phase:'confirm', repo:target});
      // lib/v1/result-actions.mjs removeBranchForApp answers 'removed', or 'gone' when the branch was already deleted.
      if ((r?.status === 'removed' || r?.status === 'gone') && r.branch === branch) {
        write.current.settle(true); setRemoval({phase:'removed', branch:r.branch, gone:r.status === 'gone'});
        try { await onChanged?.(); } catch { /* A refresh failure does not undo the removal. */ }
        return;
      }
      write.current.settle(false);
      setRemoval({phase:'unconfirmed', repo:target, branch, response:r});
    } catch (error) {
      if (!mounted.current || ticket !== removalGeneration.current) return;
      if (dryRun) return setRemoval({refusal:refusalOf(error)});
      if (error?.applyRefusal) { write.current.settle(true); return setRemoval({refusal:refusalOf(error)}); }
      write.current.settle(false);
      setRemoval({phase:'unconfirmed', repo:target, branch, error});
    }
  }
  return <ResultActionsBody repo={repo} phase={phase} preview={preview} selection={selection} refusal={refusal} applied={applied} done={done} removal={removal} submittedRepo={submittedRepo} onReconciled={reconciled}
    onRemovalReconciled={() => { if (write.current.acknowledge()) { setRemoval({}); setPreview(null); setSelection([]); setPhase('idle'); } }}
    onRepo={changeRepo} onCheck={check} onToggle={toggle} onApply={apply}
    onRemoveAsk={() => removeStep(true)} onRemoveConfirm={() => removeStep(false)} onRemoveCancel={() => { if (!write.current.state) { removalGeneration.current++; setRemoval({}); } }} />;
}
