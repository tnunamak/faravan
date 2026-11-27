import {normalizeProblem, PROBLEM_CODES, LEGACY_APPLY_PROBLEMS, LEGACY_COMPOSE_PROBLEMS} from '../../../lib/v1/problem.mjs';

// Each entry owns both its explanation and its recovery intent. Pages must not
// render a transport message or invent their own fallback after this boundary.
const entries = {
  confirm_on_this_computer: ["Device connection needs attention","Confirm the pairing in the Faravan window on your computer.","use-computer"],
  phone_access_off: ["Device connection needs attention","Device access is off. Turn it on, then pair a device.","use-computer"],
  pairing_not_open: ["Device connection needs attention","That pairing has ended. Start again.","use-computer"],
  too_many_phones: ["Device connection needs attention","This computer has as many paired devices as it allows. Remove one, then pair again.","use-computer"],
  no_network: ["Device connection needs attention","This computer isn’t on a home, office or private network a device could reach.","use-computer"],
  address_not_available: ["Device connection needs attention","Choose one of this computer’s private network addresses.","use-computer"],
  invalid_hostname: ["Device connection needs attention","Use a host name like faravan.home.example.","use-computer"],
  phone_local_session_required: ["Device connection needs attention","Turn on device access in the Faravan window on your computer. A script or agent can’t open it to the network.","use-computer"],
  apply_repo_missing:['Project folder unavailable','That folder is no longer a Git project. Choose the folder where the project is now.','choose-files'],
  apply_base_missing:['Project version unavailable','This project does not have the version the job started from. Get that version or choose the original project folder. Nothing was added.','choose-files'],
  apply_branch_exists:['Branch name already used','That branch name is already here. Review the existing branch or choose another name.','review-result'],
  apply_conflict:['Changes need review','The changes conflict with your project version. Download and review the result. Nothing was added.','review-result'],
  apply_unsafe:['Changes were blocked','These changes write outside the project or create unsafe links. Nothing was added. Download the result to inspect it safely.','review-result'],
  apply_no_changes:['No changes to add','The agent made no changes. Review the result before preparing a follow-up.','review-result'],
  apply_failed:['Check the project first','Faravan could not confirm whether the branch was added. Check the project before adding changes again.','check-status'],
  apply_locked:['Check the Git lock','A Git HEAD lock exists or cannot be checked. Wait for Git operations to finish, then check the project again. If the lock remains, inspect it and remove it only after confirming no Git process is running.','check-status'],
  apply_lock_blocked:['Git lock is occupied','A Git lock is in use. Wait for the operation to finish, or check whether Faravan can recover a stopped preview.','check-status'],
  project_check_failed:['Folder could not be checked','Faravan couldn’t check this folder. Check the connection before checking the folder again.','check-connection'],
  submission_uncertain:['Checking delivery','Faravan is checking whether the job arrived. Your draft is kept. Check the current state before sending another request.','check-status'],
  source_changed:['Review the updated files','The project changed since the preview. Review the updated files before sending again.','choose-files'],
  hosting_uncertain:['Check hosting status','Faravan has not confirmed that the circle is running. Check hosting status before starting it again.','check-status'],
  previous_coordinator_other_install: ['Previous hosting process needs review', 'The recorded hosting process appears to use a different program path. Faravan could not verify it as this copy, so it was left running. Check the Faravan installation that started hosting and stop hosting there before trying again.', 'check-status'],
  host_still_running: ['Hosting is still running', 'Faravan could not stop the program that serves this circle, so it was left running. Members can still reach it. Quit that program or restart this computer, then stop hosting again.', 'check-status'],
  host_failed: ['Hosting didn’t start', 'The program that serves this circle stopped before it was ready. Nothing was deleted. Check the last output saved in the hosting folder, then start hosting again.', 'check-status'],
  host_config_unreadable: ['Couldn’t read the hosting settings', 'Faravan could not read the hosting settings saved by the host, so it changed nothing. Fix or move the file, then check hosting status.', 'check-status'],
  host_home_conflict: ['Choose which hosting folder to keep', 'Two hosting folders hold data for the same circle, so Faravan did not start hosting from either. Hosting stays off until one of them is moved away. Nothing was deleted.', 'check-status'],
  followup_pending:['Check the earlier send','An earlier send is still waiting for an answer. Open New job to check it before preparing a follow-up.','new-job'],
  followup_missing:['Follow-up unavailable','This result is missing the link needed to continue it. Prepare a new job from your project instead.','new-job'],
  followup_storage:['Draft could not be saved','Faravan couldn’t keep this follow-up draft in this browser. Your earlier draft and notes are still here. Check browser storage before preparing it again.','review-storage'],
  followup_empty:['Describe the follow-up','Write the changes or answer before continuing.','edit-fields'],
  followup_too_long:['Shorten the follow-up','Keep the follow-up under 16,000 characters. Send a smaller group of notes.','edit-fields'],
  result_index_flags: ["Review changes","Some project changes are hidden from the safety check. Add the result as a separate branch to review it. Nothing was written.","review-result"],
  result_attributes: ["Review changes","These files change how the project reads or writes other files. Add the result as a separate branch to review those rules. Nothing was written.","review-result"],
  result_dirty: ["Review changes","Your own edits are still in this folder. Keep them in project history or a separate copy before adding this result. Nothing was written.","review-result"],
  result_path_exists: ["Review changes","A file this result adds is already in the folder. Move your existing file to a safe place before adding this result. Nothing was written.","review-result"],
  result_unsafe_path: ["Review changes","A file this result changes is inside a folder that is a link. Nothing was written.","review-result"],
  result_patch_conflict: ["Review changes","These files conflict with your version. Choose fewer files or add the result as a branch. Nothing was written.","review-result"],
  result_unknown_file: ["Review changes","A chosen file is not part of this result. Check the folder again. Nothing was written.","review-result"],
  result_nothing_selected: ["Review changes","Choose at least one file.","review-result"],
  result_too_many_files: ["Review changes","This result is too large to apply file by file. Apply all of it or add it as a branch. Nothing was written.","review-result"],
  result_repo_missing: ["Review changes","The project folder could not be found. Choose an existing folder.","review-result"],
  result_not_a_repository: ["Review changes","That folder isn’t a Git repository. Choose the folder where the project is.","review-result"],
  result_repo_busy: ["Review changes","This project has conflicting edits that are not resolved. Resolve them before adding this result. Nothing was written.","review-result"],
  result_unsafe_patch: ["Review changes","Faravan didn’t apply this result: it writes outside the project or creates unsafe links. Nothing was written.","review-result"],
  result_patch_invalid: ["Review changes","Faravan could not read the returned changes. Nothing was written. Download the result for inspection.","review-result"],
  result_write_failed: ["Review changes","The files could not be written. Check the project’s current state before adding changes again.","review-result"],
  result_base_missing: ["Review changes","This project does not have the version the result started from. Get that version or use the original project folder. Nothing was written.","review-result"],
  result_base_unknown: ["Review changes","This result doesn’t say which snapshot it was made from, so it can’t be applied safely. Download the patch instead.","review-result"],
  result_branch_moved: ["Review changes","That branch has work Faravan did not add, so it was left alone.","review-result"],
  result_not_our_commit: ["Review changes","That branch doesn’t hold this result, so it was left alone.","review-result"],
  result_branch_checked_out: ["Review changes","That branch is open in your project. Open a different branch before removing it.","review-result"],
  result_not_applied: ["Review changes","Faravan has no record of adding this result as a branch here.","review-result"],
  unknown: ['Action could not finish', 'Faravan could not confirm what happened. Check the current state before taking another action.', 'check-status'],
  mutation_pending: ['Action in progress', 'This action is already in progress. Check its current state.', 'check-status'],
  mutation_uncertain: ['Check before continuing', 'Faravan could not confirm this action. Check the current state to avoid sending it twice.', 'check-status'],
  save_uncertain: ['Check the saved settings', 'Faravan could not confirm the save. Your changes are still here. Reload the saved settings before saving again.', 'check-status'],
  device_busy: ['Another action is in progress', 'Wait for the current action to finish, then check the current state.', 'check-status'],
  clipboard: ['Copy did not finish', 'Select the invitation text and copy it yourself.', 'select-text'],
  unauthorized: ['Reconnect to Faravan', 'This page is no longer connected to Faravan.', 'reconnect'],
  invalid_host: ['Reconnect to Faravan', 'This address cannot connect to Faravan. Open a new app link.', 'reconnect'],
  invalid_origin: ['Reconnect to Faravan', 'This page cannot make changes through this address. Open a new app link.', 'reconnect'],
  local_session_required: ['Approval on your computer needed', 'Open Faravan on your computer to review this action.', 'use-computer'],
  invalid_request: ['Check the form', 'Check the highlighted fields before sending.', 'edit-fields'],
  invalid_content_type: ['Request could not be read', 'Reload the page before filling in the form again.', 'reload'],
  payload_too_large: ['Too many files', 'The selected files exceed the upload limit. Remove files before sending.', 'choose-files'],
  sandbox_not_ready: ['Setup needed', 'Finish setting up the protected workspace before running jobs.', 'setup'],
  signin_failed: ['Sign-in did not finish', 'Choose the sign-in again. If it stops again, choose Check again on Setup to see what this computer still needs.', 'setup'],
  credential_writer_unresolved: ['Previous sign-in needs review', 'A previous sign-in may still be changing credentials. Contact support to verify it has stopped. Do not delete its records.', 'check-status'],
  native_credentials_owner_only: ['Native sign-in cannot be lent', 'Native sign-in is only for your own jobs. To lend a subscription, sign in to its Docker credential proxy on the Lend page.', 'choose-agent'],
  signin_unsupported: ['Sign in on your computer', 'Open the agent on your computer and sign in there, then check sign-in here.', 'use-computer'],
  signin_not_waiting_for_code: ['Start sign-in again', 'This sign-in is no longer waiting for a code. Start a new sign-in.', 'sign-in'],
  signin_code_invalid: ['Code was not accepted', 'Copy the whole code from the sign-in page and paste it again.', 'edit-fields'],
  codex_device_code_rate_limited: ['OpenAI is limiting sign-in requests', 'OpenAI received too many sign-in requests. Wait a few minutes, then start the sign-in once more.', 'sign-in'],
  codex_device_code_service_unavailable: ['OpenAI is unavailable right now', 'OpenAI did not answer the sign-in request. Start the sign-in once more in a moment.', 'sign-in'],
  codex_device_code_exchange_failed: ['The approval did not complete', 'OpenAI did not finish the approval. Start the sign-in once more.', 'sign-in'],
  codex_device_code_expired: ['The code expired', 'The code was not approved in time. Start the sign-in once more.', 'sign-in'],
  codex_device_code_unavailable: ['OpenAI did not allow a device code sign-in', 'OpenAI did not allow a device code sign-in. In ChatGPT, open Settings → Security, turn on device code login for Codex. Then sign in to Codex once more.', 'sign-in'],
  signin_redirect_mismatch: ['Address is from a different sign-in', 'That address is from a different sign-in. Start again and paste the new address.', 'sign-in'],
  agent_not_ready: ['Choose an agent', 'Choose an installed agent that is signed in.', 'choose-agent'],
  agent_unavailable: ['Agent is unavailable', 'Review the available agents before sending this job.', 'choose-agent'],
  lending_busy: ['A job is already running', 'Review the current job before starting another.', 'check-status'],
  circle_ambiguous: ['Choose a circle', 'Choose the circle you want to lend to before continuing.', 'circles'],
  origin_required: ['Join a circle', 'Start a circle or join with an invitation before sending a job.', 'circles'],
  offline: ['Connection unavailable', 'Check your connection before sending or saving.', 'check-connection'],
  config_changed: ['Settings changed', 'Nothing was saved. Reload and review the current lending settings.', 'review-settings'],
  lending_recovery_required: ['Recovery in progress', 'Faravan must finish recovering work in this circle before you can leave or switch.', 'check-status'],
  identity_changed: ['Review this request again', 'The requester’s details changed. Review the updated job before accepting.', 'review-request'],
  approval_expired: ['Request expired', 'The request was not accepted in time. Check whether the job is still waiting.', 'check-status'],
  job_expired: ['Job expired', 'This job is no longer waiting for a lender. Check its current state.', 'check-status'],
  approval_pending: ['Review needed', 'A request is waiting for your decision. Review it before continuing.', 'review-request'],
  conflict: ['The current state changed', 'Reload and review the current state before continuing.', 'reload'],
  petname_store_full: ['Too many saved names', 'Remove some saved local names before adding another.', 'review-settings'],
  action_unavailable: ['Action unavailable', 'This action is not available here. Check the current state.', 'check-status'],
  not_found: ['Item unavailable', 'This item is no longer available. Reload to see the current state.', 'reload'],
  result_unavailable: ['Result unavailable', 'The result could not be read. Check the job’s current state.', 'check-status'],
  image_preview_unavailable: ['Image preview unavailable', 'The image could not be decoded. Use Download to keep the file.', 'download-result'],
  app_closing: ['Faravan is closing', 'Reconnect after Faravan has opened again.', 'reconnect'],
  app_load_failed: ['Faravan could not open', 'Faravan could not open. Check the connection, then reload the page.', 'reload'],
  agent_check_timeout: ['Agent check is taking longer', 'Check the agent’s sign-in on your computer before checking its state here.', 'check-status'],
  not_owner: ['Owner approval needed', 'Only the circle owner can make this change. Ask the owner for help.', 'ask-owner'],
  forbidden: ['Permission needed', 'Your circle role does not allow this action. Ask the owner for help.', 'ask-owner'],
  person_link_refresh_required: ['Review the computers again', 'Refresh the circle on both computers and create new linking codes before linking them.', 'review-members'],
  invalid_person_link: ['Linking codes do not match', 'Create a new linking code on each selected computer.', 'review-members'],
  role_conflict: ['Computer roles differ', 'Ask the owner to give both computers the same role before linking them.', 'ask-owner'],
  person_blocked: ['Computer is blocked', 'Review the blocked computers before linking them or changing their circle role.', 'review-members'],
  already_linked: ['Computer already linked', 'Review the person this computer is linked to before changing it.', 'review-members'],
  ownership_transfer_required: ['New owner must accept', 'Start an ownership transfer and ask the new owner to accept it on their computer.', 'review-members'],
  ownership_transfer_pending: ['Ownership transfer is pending', 'Cancel the pending ownership transfer before deleting local data.', 'review-members'],
  circle_must_be_closed: ['Close the circle first', 'Close this circle before deleting its local membership data.', 'circles'],
  circle_closed: ['Circle is closed', 'Shared history remains available. Choose another circle to send new jobs.', 'circles'],
  publication_pending: ['Membership change in progress', 'Wait for the membership change to finish before making another change.', 'check-status'],
  authority_chain: ['Circle ownership changed', 'Refresh the circle and create a new transfer code before continuing.', 'review-members'],
  authority_rollback: ['Circle ownership changed', 'Refresh and review the circle before continuing.', 'review-members'],
  invalid_transfer_code: ['Check the transfer code', 'Paste the whole transfer code from the owner.', 'edit-fields'],
  transfer_expired: ['Transfer code expired', 'Ask the owner for a new transfer code.', 'ask-owner'],
  transfer_mismatch: ['Transfer code does not match', 'Ask the owner for a new code for this circle.', 'ask-owner'],
  host_update_required: ['Circle update needed', 'Ask the owner to update the computer hosting this circle before changing access.', 'ask-owner'],
  circle_members_need_update: ['Circle computers need an update', 'Update the circle’s computers before changing shared details or access.', 'review-members'],
  enrollment_rejected: ['Join request declined', 'Ask the owner for a new invitation.', 'ask-owner'],
  invitation_revoked: ['Invitation withdrawn', 'Ask the owner for a new invitation.', 'ask-owner'],
  invitation_expired: ['Invitation expired', 'Ask the owner for a new invitation.', 'ask-owner'],
  invite_used: ['Invitation already used', 'Ask the owner for a new invitation.', 'ask-owner'],
  enrollment_conflict: ['Computer could not join', 'Ask the owner for a new invitation for this computer.', 'ask-owner'],
  invalid_invite: ['Invitation cannot be used', 'Paste another invitation from the circle owner.', 'edit-fields'],
  invite_unreachable: ['Circle cannot be reached', 'Check the connection to the computer hosting this invitation before joining.', 'check-connection'],
  invite_preview_required: ['Review invitation again', 'Review the invitation again before joining. Its preview may have expired.', 'review-invite'],
  warning_not_acknowledged: ['Review network privacy', 'People on this local network could read code sent for jobs. Review and acknowledge this before joining.', 'review-invite'],
  protection_not_ready: ['Protection checks changed', 'Review the updated protected workspace checks before accepting.', 'setup'],
  invalid_petname: ['Check the local name', 'Use 1 to 64 visible characters for a local name.', 'edit-fields'],
  petname_label_taken: ['Local name already used', 'Add a qualifier to distinguish this member from the other person with that name.', 'edit-fields'],
  network: ['Faravan could not be reached', 'Faravan could not connect. Check the connection before continuing.', 'check-connection'],
  network_error: ['Circle cannot be reached', 'The computer hosting this circle cannot be reached. Check that it is awake and connected before sending.', 'check-connection'],
  timeout: ['Faravan did not hear back in time', 'This computer is slow to answer. Check the current state before trying again.', 'check-status'],
  read_timeout: ['Read is taking longer', 'Faravan has not finished loading. Reload to load current information.', 'reload'],
  service_unavailable: ['Faravan is unavailable', 'Check whether Faravan is reachable before continuing.', 'check-connection'],
  daily_limit: ['Done for today', 'You have reached today’s lending limit. Other lenders can take this job. Review your lending limits to run it here.', 'review-settings'],
  rate_limited: ['Please wait before continuing', 'Nothing changed. Faravan is busy for a moment; the button works again when it is ready.', 'wait'],
  invalid_source: ['Choose project files again', 'The selected project files cannot be sent. Choose another folder or a smaller set of files.', 'choose-files'],
  outside_home: ['Choose another folder', 'Choose a folder inside your home folder.', 'choose-files'],
  folder_missing: ['Folder unavailable', 'The folder could not be found. Choose an existing folder.', 'choose-files'],
  repo_missing: ['Project folder unavailable', 'Choose an existing project folder before sending.', 'choose-files'],
  not_git: ['Choose how to send this folder', 'Send a folder snapshot, or choose another project folder. A folder snapshot returns changed files for download.', 'choose-files'],
  no_commits: ['Project has no saved version', 'Save a first version in your project, or send a folder snapshot.', 'choose-files'],
  git_missing: ['Project tool is missing', 'Set up Git on your computer before sending this project, or choose files to send.', 'choose-files'],
  repo_refused: ['Project needs review', 'Review the selected project before sending. You can choose another folder.', 'choose-files'],
  apply_refused: ['Changes could not be added', 'Review the project and result before adding changes. Your current work must be kept safe.', 'review-result'],
  not_connected: ['Connection needed', 'Review your Faravan connections before continuing.', 'review-settings'],
  autostart_failed: ['Automatic start could not be saved', 'Review automatic start in Faravan settings.', 'review-settings'],
  updates_paused: ['Live updates paused', 'Live updates paused. Check the connection to resume current information.', 'check-connection'],
  upload_file_limit: ['Choose fewer files', 'Choose up to a thousand files before sending.', 'choose-files'],
  upload_size_limit: ['Choose smaller files', 'Choose files totalling no more than twenty megabytes.', 'choose-files'],
  upload_zip_selection: ['Choose files again', 'Choose one ZIP on its own, or individual files.', 'choose-files'],
  upload_read_failed: ['File could not be read', 'Choose the file again before sending.', 'choose-files'],
  attachment_storage: ['Files could not be saved or restored', 'Check this browser’s storage settings and free space. Keep your draft open while checking.', 'review-storage'],
  attachment_missing: ['Saved files are unavailable', 'The selected files are no longer saved in this browser. The original send has not been repeated. Check the job’s current state before choosing files again.', 'check-status'],
};

export const CATALOG_CODES = Object.freeze(Object.keys(entries));
export const PROBLEM_SURFACES = Object.freeze(['desktop', 'phone']);
export const SEND_ANY_AGENT_LABEL = 'Send to any available agent';
export function settingsFailureText(error, uncertain, context = browserProblemContext()) {
  if((error?.problem??error)?.code==='config_changed')return 'Your lending settings changed since you opened this page, on another tab or device. Your changes are still here. Reload and review the saved settings.';
  const view=problemView(uncertain?{code:'save_uncertain'}:error?.problem??error,context);
  return view.detail+(uncertain?'':' Your changes are still here.');
}
export const SIGN_IN_RETRY_LABEL = 'Start sign-in again';
export function problemResult(code) {
  return {ok:false,code,error:problemView({code},browserProblemContext()).detail};
}
const applyActions = {
  apply_repo_missing:['choose'], apply_base_missing:['retry','choose'], apply_branch_exists:['rename'],
  apply_conflict:['patch'], apply_unsafe:['details'], apply_no_changes:['followup'], apply_failed:['details'], apply_locked:['retry','recover'], apply_lock_blocked:['recover'],
};
export function applyProblemView(refusal, context = browserProblemContext()) {
  const state = Object.hasOwn(LEGACY_APPLY_PROBLEMS,refusal.state)?refusal.state:'job.apply-failed';
  const code = LEGACY_APPLY_PROBLEMS[state];
  const view = problemView({code}, context);
  const local = context.surface==='desktop' && context.capabilities?.localApp===true;
  return {state,text:view.detail,actions:local?[...new Set([...applyActions[code],'details'])]:['details'],reference:''};
}
export function composeProblemView(state, context = browserProblemContext()) {
  const code = Object.hasOwn(LEGACY_COMPOSE_PROBLEMS,state)?LEGACY_COMPOSE_PROBLEMS[state]:'repo_missing';
  const view = problemView({code}, context);
  return {headline:view.title,text:[view.detail],meta:view.title,why:view.detail,detail:view.detail,help:[]};
}
export function readStateView(state, context = browserProblemContext()) {
  if (state.kind === 'unavailable' || state.kind === 'stale-with-data') {
    const view = problemView(state.problem, context);
    return {title:view.title,text:view.detail,action:view.action.label,kind:view.action.kind};
  }
  const rows = {
    loading:['Loading jobs','Wait for the jobs to load.','Check current state','check-status'],
    'loaded-empty':['No jobs yet','Ask a friend’s agent to fix a bug, add a page or write tests. Jobs you run for friends show here too.','New job','new-job'],
    'filtered-empty':['No matching jobs','No jobs match your search or filters. Clear them to see the loaded jobs.','Clear filters','clear-filters'],
    'no-membership':['Join a circle','Start a circle or join with an invitation to send your first job.','Go to Circles','circles'],
  };
  const row = rows[state.kind];
  if (!row) return null;
  const [title,text,action,kind] = row;
  return {title,text,action,kind};
}
export function browserProblemContext() {
  // Surface is a layout proxy, not a device fact; capabilities come from the host below.
  const phone = globalThis.matchMedia?.('(max-width: 899px)').matches === true;
  const hostname = globalThis.location?.hostname;
  const localApp = ['localhost','127.0.0.1','[::1]','::1'].includes(hostname);
  return {surface:phone?'phone':'desktop',capabilities:{localApp,manageSettings:localApp}};
}
const actionLabels = {
  'check-status':'Check current state', 'select-text':'Select invitation', reconnect:'Open a new app link',
  'use-computer':'Continue on your computer', 'edit-fields':'Review fields', reload:'Reload and review',
  'choose-files':'Choose files or folder', setup:'Open setup', 'sign-in':'Start sign-in',
  'choose-agent':'Choose an agent', circles:'Go to Circles', 'check-connection':'Check connection',
  'review-settings':'Review settings', 'review-request':'Review request', 'ask-owner':'Ask the owner',
  'review-members':'Review circle computers', 'review-invite':'Review invitation', wait:'Wait before checking',
  'review-result':'Review project and result',
  'review-storage':'Check browser storage',
  'new-job':'Open New job',
  'download-result':'Download result',
};

/** Capabilities describe access, never inferred from viewport width. Missing capabilities
 * fail closed: a device or remote browser cannot be told to operate local desktop tools.
 * Actions are intents for the UI to handle, not permission to retry a write.
 */
export function problemView(input, {surface = 'desktop', capabilities = {}, now = Date.now()} = {}) {
  const problem = normalizeProblem(input);
  const [title, baseDetail, intent] = entries[problem.code];
  let detail = baseDetail, kind = intent, label = actionLabels[intent];
  const local = surface === 'desktop' && capabilities.localApp === true;
  const phone = surface === 'phone';
  if (intent === 'reconnect') {
    detail += local ? ' Open it again from Faravan on this computer.' : phone ?
      ' Open Faravan on your computer, go to Settings → Pairing, then pair this device again.' :
      ' Ask the computer’s owner for a new app link.';
    kind = local ? 'open-app' : phone ? 'pair-phone' : 'request-link';
    label = local ? 'Open Faravan' : phone ? 'Pair this device again' : 'Request a new app link';
  }
  if (['network', 'offline'].includes(problem.code) && !local) {
    detail = 'Can’t reach your computer. Check that it’s awake and on the same network.';
  }
  if (['setup', 'sign-in', 'choose-files', 'choose-agent', 'review-result'].includes(intent) && !local) {
    detail = phone ? 'Open Faravan on your computer to continue this step.' : 'Ask the computer’s owner to continue this step in Faravan.';
    kind = 'use-computer'; label = actionLabels[kind];
    // Keep the actual refusal explanation alongside the recovery instruction.
    detail = baseDetail + ' ' + detail;
  }
  if (intent === 'review-settings' && capabilities.manageSettings !== true) {
    kind = 'ask-owner'; label = actionLabels[kind]; detail += ' Ask the computer’s owner to review these settings.';
  }
  // Only the boundary supplies retry timing. Re-normalizing a Problem must retain it.
  const retry = problem.retryPolicy;
  const until = retry?.kind === 'wait-until' && Number.isFinite(retry.until) ? retry.until : null;
  const waiting = problem.code === 'rate_limited';
  if (waiting) {
    if (until === null) detail = 'Nothing changed. Faravan is busy. Wait a minute, then reload to check the current state.';
    kind = 'wait'; label = actionLabels.wait;
    if (until !== null && until <= now) {kind = 'check-status'; label = 'Check current state';}
  }
  return Object.freeze({title, detail, action:Object.freeze({kind, label, ...(waiting ? {notBefore:until, disabled:until === null || until > now} : {})})});
}

// Fail at import if adding a problem leaves a copy/action hole (also covered by tests).
if (PROBLEM_CODES.some(code => !Object.hasOwn(entries, code)) || CATALOG_CODES.some(code => !PROBLEM_CODES.includes(code)))
  throw new Error('Problem catalog must cover exactly the problem codes');
