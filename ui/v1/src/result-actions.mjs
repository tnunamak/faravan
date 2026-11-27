import {problemView,browserProblemContext} from './problem-catalog.mjs';
// The result actions besides Add as a branch, as pure views: Open in editor links, the Apply to working tree preview,
// request and outcome, each refusal in plain words, and Remove this branch. result-actions.jsx renders them.

const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
const unsafeText = value => typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value);

/** Editor deep links for a folder (and optionally a file in it). Absolute paths only, no `..`, every segment encoded. */
export function editorLinksVM(repo, file = '') {
  if (unsafeText(repo)) return [];
  const drive = /^([A-Za-z]):[\\/]/.exec(repo);
  if (!drive && !repo.startsWith('/')) return [];
  const parts = (drive ? repo.slice(3) : repo.slice(1)).split(/[\\/]/).filter(Boolean);
  const inner = file ? file.split('/') : [];
  if (file && (unsafeText(file) || file.startsWith('/') || inner.some(p => !p))) return [];
  if ([...parts, ...inner].some(p => p === '.' || p === '..')) return [];
  const path = (drive ? drive[1] + ':/' : '') + [...parts, ...inner].map(encodeURIComponent).join('/') + (file ? '' : '/');
  return [{label:'VS Code', href:'vscode://file/' + path}, {label:'Cursor', href:'cursor://file/' + path}];
}

const STATE_WORDS = {
  applies: 'Applies cleanly', merges: 'Merges with your commits', conflict: 'Conflicts with your version',
  yours: 'You changed this file', exists: 'A file is already there', unsafe: 'Inside a linked folder',
};
const SELECTABLE = new Set(['applies', 'merges']);

/** What a dry run said: per-file rows, the default selection, and why nothing can be applied (`blocked`), if so. */
export function workingTreePreviewVM(preview) {
  const tree = preview.working_tree;
  const verified = tree && typeof tree.clean === 'boolean' && Array.isArray(tree.changed) &&
    tree.changed.every(p => typeof p === 'string') && (tree.more === undefined || (Number.isSafeInteger(tree.more) && tree.more >= 0)) &&
    !(tree.clean && (tree.changed.length || tree.more));
  const files = (preview.files ?? []).map(f => ({path:f.path, oldPath:f.old_path ?? null, status:f.status, plus:'+' + (f.insertions ?? 0), minus:'−' + (f.deletions ?? 0),
    binary:!!f.binary, state:f.state, word:STATE_WORDS[f.state] ?? 'Cannot be applied', selectable:!!verified && tree.clean && SELECTABLE.has(f.state)}));
  const ready = files.filter(f => f.selectable);
  const where = preview.repo + (preview.current_branch ? ' on ' + preview.current_branch : ' (detached HEAD)');
  const perFile = preview.per_file !== false;
  let blocked = null;
  if (!verified) blocked = 'Could not verify that this folder has no uncommitted changes. Check the folder again.';
  else if (!tree.clean) {
    const total = tree.changed.length + (tree.more ?? 0);
    const named = tree.changed.join(', ') + (tree.more ? ' and ' + tree.more + ' more' : '');
    blocked = (total === 1 ? named + ' has' : plural(total, 'file') + ' in this folder have') + ' uncommitted changes' + (total === 1 ? '' : ' (' + named + ')') +
      '. Commit or stash them first, then check the folder again. Nothing was written.';
  } else if (!ready.length) blocked = 'None of these files can be applied here. Download the patch to inspect it without applying.';
  else if (!perFile && ready.length !== files.length) blocked = 'This result is too large to apply file by file, and some files cannot be applied. Download the patch to inspect it without applying.';
  const summary = !verified || !tree.clean ? 'This result changes ' + plural(files.length, 'file') + ' in ' + where + '.' : perFile ? ready.length + ' of ' + plural(files.length, 'file') + ' can be applied to ' + where + '.'
    : 'All ' + plural(files.length, 'file') + ' are applied together to ' + where + '.';
  return {files, perFile, blocked, summary, defaultSelection:ready.map(f => f.path)};
}

/** The POST body: a dry run without a preview; otherwise the chosen files (null = all of them) and what the preview showed. */
export function workingTreeRequestVM({circle, repo, preview, selection}) {
  const folder = String(repo ?? '').trim();
  if (!preview) return {circle, repo:folder, dry_run:true};
  const all = preview.files.length === selection.length && preview.files.every(f => selection.includes(f.path));
  return {circle, repo:folder, dry_run:false, files:all ? null : [...selection], expect:{head:preview.head, current_branch:preview.current_branch ?? null}};
}

/** Result refusal copy is selected by a typed problem, never a server message. */
export function resultActionRefusalVM(refusal = {}) {
  return problemView(refusal.problem ?? {code:'result_'+refusal.code},browserProblemContext()).detail;
}

const quote = value => /^[A-Za-z0-9_\/.,:@%+=-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
/** The shell command that undoes a working-tree apply: restore the changed tracked files, remove the added ones. */
export function undoCommandVM(repo, undo = {}) {
  const restore = undo.restore ?? [], remove = undo.remove ?? [], root = String(repo).replace(/\/+$/, '');
  const steps = [];
  if (restore.length) steps.push('git --literal-pathspecs -C ' + quote(root) + ' restore -- ' + restore.map(quote).join(' '));
  if (remove.length) steps.push('rm -- ' + remove.map(p => quote(root + '/' + p)).join(' '));
  return steps.join(' && ');
}

/** Remove this branch, for the app's own Add as a branch record only. */
export function removeBranchVM(applied) {
  if (!applied?.branch || !applied.repo) return null;
  return {branch:applied.branch, repo:applied.repo,
    confirm:'Remove ' + applied.branch + ' from ' + applied.repo + '? Only this branch is removed, and only while it has no commits besides this result.'};
}

/** Only receipt fields already consumed by this UI are available in this scope. */
export function confirmedWorkingTreeReceipt(result, repo, selection) {
  if (!result || result.status === 'changed' || result.status === 'dry_run' || result.repo !== repo ||
      !Array.isArray(result.applied) || !result.applied.length ||
      result.applied.some(path => unsafeText(path) || !selection.includes(path)) ||
      new Set(result.applied).size !== result.applied.length ||
      result.applied.length !== selection.length) return null;
  const undo = result.undo;
  if (undo != null && (typeof undo !== 'object' || ['restore', 'remove'].some(key =>
      undo[key] !== undefined && (!Array.isArray(undo[key]) || undo[key].some(path => unsafeText(path)))))) return null;
  return {repo:result.repo, applied:result.applied, undo:undo ?? undefined};
}

/** A ref-backed lock closes the same-tick gap before a render disables controls. */
export function createResultWriteGuard() {
  let state = null;
  return {
    get state() { return state; },
    begin(next) { if (state) return false; state = next; return true; },
    settle(confirmed) { state = confirmed ? null : 'unconfirmed'; },
    acknowledge() { if (state !== 'unconfirmed') return false; state = null; return true; },
  };
}


// Retained for the lifetime of the API object, not the sheet. A full page reload or
// replacement API/session is outside this in-memory receipt boundary.
const applyWrites = new WeakMap();
export function applyWriteRecord(api, circle, jobId) {
  let records = applyWrites.get(api);
  if (!records) applyWrites.set(api, records = new Map());
  const key = JSON.stringify([circle, jobId]);
  if (records.has(key)) return records.get(key);
  let state = null;
  const listeners = new Set(), notifications = [];
  let publishing = false, delivering = false;
  const notify = (listener, snapshot) => {
    // Observer failures must not discard the receipt or starve other observers.
    try { listener(snapshot); } catch { /* a later subscription can recover */ }
  };
  const publish = () => {
    notifications.push(state);
    if (publishing) return;
    publishing = true;
    try {
      while (notifications.length) {
        const snapshot = notifications.shift();
        for (const listener of [...listeners]) if (listeners.has(listener)) notify(listener, snapshot);
      }
    } finally { publishing = false; }
  };
  const matchesTarget = out => out?.repo === state.target.repo && out?.branch === state.target.branch;
  // The server verifies the saved intent against the exact published commit.
  // Bind that receipt to the verified result shown in this write's preview too.
  const matches = out => matchesTarget(out) && /^sha256:[0-9a-f]{64}$/.test(out.job_digest ?? '') &&
    out.job_digest === state.target.job_digest && /^[0-9a-f]{64}$/.test(out.patch_hash ?? '') &&
    out.patch_hash === state.target.patch_hash && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(out.base ?? '') &&
    out.base === state.target.base && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(out.commit ?? '');
  const record = {
    get state() { return state; },
    subscribe(listener) { listeners.add(listener); notify(listener, state); return () => listeners.delete(listener); },
    clear() {
      if (!state || ['pending', 'uncertain', 'reconciling', 'applied'].includes(state.phase)) return false;
      state = null; publish(); return true;
    },
    async deliver(consume) {
      if (state?.phase !== 'applied' || delivering) return false;
      const receiptState = state;
      delivering = true;
      try {
        await consume(receiptState.receipt);
        if (state === receiptState) { state = null; publish(); }
        return true;
      } catch { return false; } // Keep the receipt and lock until delivery succeeds.
      finally { delivering = false; }
    },
    async submit(target, send) {
      if (state) return false;
      state = {phase:'pending', target:Object.freeze({...target}), receipt:null};
      publish();
      try {
        const out = await send({repo:target.repo, branch:target.branch, dry_run:false, expect:{preview_token:target.preview_token}});
        state = {...state, receipt:out, phase:matches(out) && out.status === 'applied' ? 'applied'
          : matchesTarget(out) && out.status === 'changed' && out.preview_token ? 'changed' : 'uncertain'};
      } catch (error) {
        state = {...state, error, phase:error.outcome === 'not_applied' && error.refused ? 'refused' : 'uncertain'};
      }
      publish();
      return true;
    },
    async reconcile(send) {
      if (state?.phase !== 'uncertain') return false;
      state = {...state, phase:'reconciling'}; publish();
      try {
        const out = await send({repo:state.target.repo, branch:state.target.branch, dry_run:true});
        // A dry-run preview/refusal cannot prove an earlier write did not land.
        state = {...state, receipt:out, phase:matches(out) && out.status === 'applied' ? 'applied' : 'uncertain'};
      } catch (error) { state = {...state, error, phase:'uncertain'}; }
      publish();
      return true;
    },
  };
  records.set(key, record);
  return record;
}
