import {defaultRunRequest, validRequestState} from './compose-draft.mjs';
import {accountModelKey, accountModels, accountEfforts, signedRequestBlocker} from './compose-model.mjs';
import {visibleInterval} from './display-visibility.mjs';
import {SavedRequestPreview} from './saved-request.jsx';
import {discardSavedDraft, undoDiscardedDraft} from './compose-draft.mjs';
import {SEND_ANY_AGENT_LABEL} from './problem-catalog.mjs';
import {errorMessage} from './helpers.mjs';
import {followupBaseVM} from './job-thread.mjs';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Button, Select, Icon, Spinner, Row, Sheet } from './ds/index.mjs';
import { SwingCard, SwingChip } from './ds/swing.jsx';
import { Connection, go } from './shared.jsx';
import { agentProduct } from './helpers.mjs';
import { composeVM, projectVM, skippedCircleNotice, composeCircleLabel } from './view-models.mjs';
import { hostOffline } from '../../../lib/v1/circle-host.mjs';
import {SOURCE_UNKNOWN_LINE} from './resend-result.mjs';
import { loadDraft, restoreDraft, moveDraft, saveDraft, clearDraftIfCurrent, COMPOSE_DRAFT_PREFIX, draftBody, sendUncertain, newDraftId, busyWait } from './compose-draft.mjs';
import { composeCircle, sendableCircles, circleAgents, noAgentReason, createdJobVM, offeredModels, offeredEfforts, lendersChoice, lendersAccountChoice, keepOffered, keepAuto, autoOffered, isAutoChoice, AUTO_CHOICES } from './compose-model.mjs';
import { PageSkeleton } from './shell-states.jsx';
import { ProjectPicker, ProjectRow } from './project-picker.jsx';
import {saveAttachment,loadAttachment,removeAttachment} from './source-attachments.mjs';
import {SourceChoice,OtherSource,SourceManifest} from './source-choice.jsx';
import {sourceKind,sourceReady,readUploadSelection,workingDirectoryProblem} from './source-choice.mjs';
import { homePath, createRepoChecker } from './project-picker-model.mjs';
import { JOB_DEFAULTS } from '../../../lib/v1/job-defaults.mjs';
import { CHECK_COMMAND_HELP, FIRST_SEND_COPY, circlePhrase } from './safety-copy.mjs';

const store = () => { try { return globalThis.localStorage; } catch { return null; } };
const FIRST_SEND_NOTICE_KEY = 'faravan-compose-first-send-notice-seen';
const firstSendNoticeSeen = () => { try { return store()?.getItem(FIRST_SEND_NOTICE_KEY) === 'yes'; } catch { return false; } };

// "Open Circles" in the reason is the link itself, so the sentence reads once.
const NoCircleWhy = ({ why }) => { const [lead, tail] = why.split('Open Circles'); return tail === undefined ? <>{why}{' '}<a class="ph-no-capture" href="#/circles" data-telemetry-private="compose">Open Circles</a></> : <>{lead}<a class="ph-no-capture" href="#/circles" data-telemetry-private="compose">Open Circles</a>{tail}</>; };
const Line = ({ parts }) => parts.map((part) => (typeof part === 'string' ? part : <code data-telemetry-private="compose" class="ph-no-capture">{part.code}</code>));

// The MVP composer as a pure view of its state, so every state can be rendered and tested (compose.local,
// compose.not-git, compose.host-offline, compose.send-uncertain).
export function ComposeBody({ vm, project, draft, home, circles = [], circle = '', agents = [], offers = [], signed = false, accountOffers = [], onRunRequest = () => {}, onModel = () => {}, onEffort = () => {}, busy = false, agentRefusal, refusalRef, sendStatusRef, headingRef, onPrompt, onPath, onInclude, onAgent, onCircle, onVerify, onCheck, onChoose, onSelectProject, suggestions = [], onSend, onSendAnyway, onConfirmFirstSend, onCloseFirstSend, sendNoticeOpen = false, onChangeJob, onCancel, onSourceKind, onUrl, onResolve, onBranch, onFiles, branches = [], ownershipBlocked = false, sourceBusy = false, sourceError = '', onWorkingDirectory, circleNotice = '', agentReason = null, projectNeeded = false, draftSaved = false, }) {
  const runRequest = draft.runRequest ?? defaultRunRequest();
  const models = accountModels(accountOffers);
  const efforts = accountEfforts(accountOffers,runRequest);
  const chosenModel = runRequest.models === 'any' ? '' : accountModelKey(runRequest.models[0]);
  const lenderChoice = draft.agent && !draft.model && !draft.effort && !draft.auto ? lendersChoice(offers, draft.agent) : '';
  const folderRefused = Boolean(vm.folderError) && draft.sourceKind !== 'none' && !draft.followup;
  // A folder refusal and its recovery buttons live in Project, and Send's reason points there, so show it.
  // A required project that is not chosen yet is never hidden behind a closed row.
  // Open while the footer is waiting on the project, or when the person opened it. Derived, not stored, so the row
  // closes to its summary as soon as the project is chosen (a suggested or typed folder).
  const [projectChosenOpen, setProjectChosenOpen] = useState(false);
  const projectOpen = folderRefused || projectNeeded || projectChosenOpen;
  const locked = ownershipBlocked || draft.sending || vm.state === 'compose.send-uncertain' || busy || Boolean(agentRefusal);
  // Each locked control says why it is locked, in the same words everywhere it is locked.
  const lockReason = ownershipBlocked ? 'This draft cannot be edited right now. Reopen it from Jobs to check its saved state.'
    : draft.sending || busy || vm.state === 'compose.send-uncertain' ? 'Wait until the current request is confirmed.'
    : agentRefusal ? 'Change the job before changing these settings.' : '';
  // The reason Send is waiting for is printed once: on the folder field, or above the buttons (#cmp-why). Send names the folder field only when it has the message.
  const sendPointer = vm.folderError && draft.sourceKind !== 'none' ? 'See the folder message above.' : '';
  const choiceLock = ownershipBlocked || draft.sending || busy || vm.state === 'compose.send-uncertain' ? lockReason : '';
  const choiceReason = !draft.agent ? 'Choose an agent first.' : choiceLock;
  // A saved automatic choice can always be cleared, even with no agent and no offers, or Send would stay off with nothing to change.
  // The list offers no new choice then; only the draft's own locks apply.
  const modelReason = draft.auto ? choiceLock : choiceReason || (!draft.model && !offeredModels(offers, draft.agent).length ? 'No lender offers a choice right now.' : '');
  const effortReason = choiceReason || (draft.auto ? 'The lender chooses the effort.' : !draft.effort && !offeredEfforts(offers, draft.agent, draft.model).length ? 'No lender offers a choice right now.' : '');
  const agentLocked = ownershipBlocked || draft.sending || busy || vm.state === 'compose.send-uncertain';
  const circleReason = draft.followup ? 'A follow-up stays in the same circle.' : locked ? lockReason : '';
  const noSource = draft.sourceKind === 'none';
  const projectLabel = noSource ? 'No project' : project?.name || (draft.followup && draft.base?.path ? draft.base.path.split('/').filter(Boolean).at(-1) : '') || (sourceKind(draft)==='git'?'Git URL':sourceKind(draft)==='files'?'Files or ZIP':'Choose project');
  const p = !noSource && project ? projectVM(project, { include: draft.includeUncommitted }) : null;
  const source = sourceKind(draft);
  const circleSummary = !circle ? 'Choose a circle to send this job.' : noSource ? 'Your circle sees this prompt.' : `Your circle sees this prompt${source === 'git' ? ' and the pinned repository URL' : source === 'files' ? ' and the selected files' : project?.kind === 'folder' ? ' and a snapshot of the selected folder' : draft.includeUncommitted ? ' and your selected source, including uncommitted changes' : project?.files != null ? ` and ${project.files} committed files` : ' and your committed source'}.`;
  return (
    <div class="cmp ph-no-capture" data-telemetry-private="compose">
      <header class="cmp-head">
        <a class="back-link" href="#/jobs" aria-label="Back to jobs" onClick={(e) => { e.preventDefault(); onCancel(); }}><Icon name="chev-l" size="sm" />Jobs</a>
        <h1 class="t-page cmp-h" ref={headingRef} tabIndex="-1" aria-label={draft.followup ? undefined : 'New job'}>{draft.followup ? 'What should change next?' : 'New job'}</h1>
        {!draft.followup && <p>Describe the task and choose what to send.</p>}
      </header>
      {vm.banner && !vm.folderError && (
        <SwingCard className="cmp-notice" role={vm.banner.tone === 'bad' ? 'alert' : 'status'} id={vm.banner.id}>
          <SwingChip tone={vm.banner.tone === 'bad' ? 'bad' : 'neutral'} icon={vm.banner.icon}>{vm.banner.chip}</SwingChip>
          <div>
            <b>{vm.banner.headline}</b>
            <p class="t-sm">{Array.isArray(vm.banner.text) ? <Line parts={vm.banner.text} /> : vm.banner.text}</p>
            {vm.banner.href && <Button kind="secondary" size="sm" href={vm.banner.href}>{vm.banner.linkLabel}</Button>}
            {vm.banner.action && !locked && !draft.followup && <Button kind="secondary" size="sm" onClick={() => onCircle(vm.banner.action.circle)}>{vm.banner.action.label}</Button>}
          </div>
        </SwingCard>
      )}
      {(draft.sending || busy || vm.state === 'compose.send-uncertain') && <p role="status">Leaving this page does not cancel the request. It may already have been sent. Keep this page open to check the same request before sending another.</p>}
      {draft.followup && <SwingCard as="section" className="cmp-previous" aria-label="Previous result">
        <p class="t-sm">{followupBaseVM(draft.base).label}</p>
        {draft.base?.path && <p class="t-xs t-2">Saved source folder: <span>{homePath(draft.base.path,home)}</span></p>}
        <p class="t-xs t-2">The circle and project stay the same.</p>
        <p class="t-xs t-2">A follow-up is a new job. The lender’s saved approval mode applies.</p>
        {followupBaseVM(draft.base).commit && <details class="job-details"><summary>Commit</summary><p class="t-sm"><code>{followupBaseVM(draft.base).commit}</code></p></details>}
      </SwingCard>}
      {circleNotice && <p role="status">{circleNotice}</p>}
      <div class="cmp-form" data-view="compose" data-state={vm.state} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !vm.send.disabled && !agentRefusal && !locked) { e.preventDefault(); onSend(); } }}>
        <div class="cmp-form-content">
          <section class="cmp-task">
            <label class="cmp-field-title" for="cmp-prompt">{draft.followup ? 'What should change next?' : 'What should the agent do?'}</label>
            <textarea id="cmp-prompt" class="textarea" aria-label={draft.followup ? 'What should change next?' : 'What the agent should do'} placeholder={noSource ? 'For example, write a welcome email and make a checklist.' : draft.followup ? 'For example, add a regression test for the change.' : 'For example, stop checkout when the arrival date is after the departure date.'} value={draft.prompt} readOnly={locked} disabled={locked && !ownershipBlocked}
              onInput={(e) => onPrompt(e.currentTarget.value)} />
            {draftSaved && draft.prompt.trim() && !draft.sending && <p class="t-xs t-2" id="cmp-saved">Your draft is saved on this computer.</p>}
          </section>
          {!draft.followup && <details class="cmp-project" id="cmp-project" aria-label="Project" open={projectOpen}>
            <summary class="cmp-setting-row" onClick={e=>{e.preventDefault();setProjectChosenOpen(!projectOpen);}}><span class="cmp-setting-label">Project</span><span class="cmp-setting-value">{projectLabel}</span><Icon name="chev-r" size="sm" /></summary>
            {draft.sourceUnknown && !draft.path.trim() && <p class="cmp-source-unknown t-sm" id="cmp-source-unknown" role="status">{SOURCE_UNKNOWN_LINE}</p>}
            {projectNeeded && <p class="cmp-project-needed t-sm" id="cmp-project-needed" role="status">Choose the project to send, or choose No project to send only your prompt.</p>}
            <SourceChoice draft={draft} locked={locked} onKind={onSourceKind}/>
            {source === 'none' && <p class="cmp-empty-source" data-view="compose" data-state="no-project"><Icon name="file"/><span><b>Just your prompt</b><br/>Start from an empty folder for writing, analysis, questions, images, data, or something new.</span></p>}
            {!['folder','none'].includes(source) && <OtherSource {...{draft,locked,branches}} busy={sourceBusy} error={sourceError} onUrl={onUrl} onResolve={onResolve} onBranch={onBranch} onFiles={onFiles}/>}
            {source === 'folder' && <div data-view="compose" data-state={project ? 'ready' : 'folder'}>
              <div class="src">
                <div class="grow">
                  <label class="row-title" for="cmp-folder">Project folder</label>
                  <div class="project-field"><input id="cmp-folder" class="input mono" value={homePath(draft.path,home)} placeholder="~/code/project" autocomplete="off" spellcheck={false}
                    disabled={locked} onInput={(e) => {setProjectChosenOpen(true);onPath(e.currentTarget.value);}} onBlur={()=>{if(!vm.folderError)onCheck(false);}}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onCheck(); } }}
                    aria-describedby={vm.help ? 'cmp-meta cmp-help' : 'cmp-meta'} aria-invalid={vm.folderError ? 'true' : undefined} /><Button kind="secondary" disabled={locked} disabledReason={lockReason} onClick={onChoose} aria-haspopup="dialog">Choose…</Button></div>
                  <div class={'row-meta' + (vm.folderError ? ' folder-error' : '')} id="cmp-meta" role={vm.folderError ? 'alert' : 'status'}>
                    {vm.folderError || (vm.plainFolder ? <>Not a git repository · {p.meta}</> : project ? p.meta : vm.meta || (vm.checking ? <><Spinner /> Looking at the folder…</> : 'Name the folder where the project is.'))}
                  </div>
                  {vm.help && <div class="folder-help" id="cmp-help">
                    <p hidden={!vm.plainFolder && !vm.help.length} class="t-sm t-2">{vm.plainFolder ? 'You can send this folder as files. Download changed files as a ZIP when it finishes.' : <Line parts={vm.help} />}</p>
                    {!vm.plainFolder && <div class="folder-help-actions">
                      <Button kind="secondary" size="sm" onClick={onChoose} disabled={locked} disabledReason={lockReason} aria-haspopup="dialog">Choose another folder</Button>
                      <Button kind="secondary" size="sm" onClick={() => onSourceKind('none')} disabled={locked} disabledReason={lockReason}>Send without a project</Button>
                    </div>}
                  </div>}
                  {suggestions.length > 0 && <div class="project-suggestions"><p class="t-sm t-2">{vm.state === 'compose.not-git' || vm.plainFolder ? 'Projects inside this folder:' : 'Did you mean…'}</p>{suggestions.map(project => <ProjectRow key={project.path} project={project} home={home} disabled={locked} onChoose={onSelectProject} />)}</div>}
                </div>
              </div>
            </div>}
            {!noSource && <div class="cmp-project-settings">
              {p && source === 'folder' && <div class="opt-row opt-col">
                <span>{p.note}</span>{project?.head && <p class="source-commit t-xs t-2">Commit <code>{project.head.slice(0,7)}</code>. Project history is not sent.</p>}
                {p.checkbox && <label class="chk-row"><input type="checkbox" checked={draft.includeUncommitted} disabled={locked} onChange={(e) => onInclude(e.currentTarget.checked)} />{p.checkbox}</label>}
                {p.sending && <span class="t-sm t-2">{p.sending}</span>}
                {!project?.sourceManifests && !project?.sourceManifest && p.notSent && (p.notSent.files.length ? <details class="t-sm source-omissions">
                  <summary><span>{p.notSent.summary}{p.notSent.credentialNote && <span class="t-2"> · {p.notSent.credentialNote}</span>}</span></summary>
                  <div role="list" class="source-omission-rows">{p.notSent.files.map(file => <Row key={file.path} role="listitem" title={<code>{file.path}</code>} meta={file.reason === 'credentials' ? 'looked like credentials' : 'not source'} />)}</div>
                  <p class="t-2">Only filenames are checked. Check file contents yourself for passwords or keys before you send.</p>
                </details> : <span class="t-sm t-2">{p.notSent.summary}</span>)}
              </div>}
              {source !== 'none' && <div class="opt-row opt-col source-working-directory"><label class="row-title" for="cmp-workdir">Working directory <span class="t-sm t-2">(optional)</span></label><input id="cmp-workdir" class="input mono" value={draft.workingDirectory || ''} placeholder="Project root, or packages/app" disabled={locked} maxLength="1024" onInput={e=>onWorkingDirectory(e.currentTarget.value)} aria-describedby="cmp-workdir-hint" aria-invalid={workingDirectoryProblem(draft.workingDirectory?.trim())?'true':undefined}/><p id="cmp-workdir-hint" class={'t-xs '+(workingDirectoryProblem(draft.workingDirectory?.trim())?'folder-error':'t-2')}>{workingDirectoryProblem(draft.workingDirectory?.trim()) || 'The agent and test command start here. The whole project is still sent.'}</p></div>}
            </div>}
          </details>}
          <div class="cmp-routing" aria-label="Job choices">
            {circles.length > 0 ? <label class="cmp-route-field"><span>Circle</span><Select class="selectish" aria-label="Circle" value={circle} disabled={Boolean(circleReason)} disabledReason={circleReason} onChange={e=>onCircle(e.currentTarget.value)}>{circles.map(c=><option key={c.id} value={c.id}>{composeCircleLabel(c)}</option>)}</Select><Icon name="chev-r" size="sm"/></label>
              : <div class="cmp-route-field"><span>Circle</span><p class="hint">No circle yet. Join or start one in <a href="#/circles">Circles</a>.</p></div>}
            <label class="cmp-route-field"><span>Agent</span><Select id="cmp-agent" class="selectish" aria-label="Agent" aria-describedby={agentReason ? 'cmp-agent-empty' : undefined} value={draft.agent} disabled={agentLocked} disabledReason={agentLocked ? lockReason : ''} onChange={e=>onAgent(e.currentTarget.value)}>
              <option value="">Let the lender choose</option>
              {draft.agent && !agents.some(a=>a.id===draft.agent) && <option value={draft.agent}>{agentProduct(draft.agent).name}</option>}
              {agents.map(a=><option key={a.id} value={a.id}>{agentProduct(a.id).name}{a.here?' · available on this computer':''}{a.effort?' · '+a.effort+' effort':''}</option>)}
            </Select><Icon name="chev-r" size="sm"/></label>
            {agentReason && <div class="cmp-route-note cmp-agent-empty" id="cmp-agent-empty" role="status"><p class="t-sm"><b>{agentReason.why}</b> {agentReason.next}</p>
              <div class="hstack-2 wrap">{agentReason.actions.map(a=><Button key={a.href} kind="secondary" size="sm" href={a.href}>{a.label}</Button>)}</div></div>}
            {signed ? <details class="cmp-model-choice" open><summary class="cmp-setting-row"><span>Model and effort</span></summary>
              <label class="cmp-route-field"><span>Model</span><Select id="cmp-model" aria-label="Model" value={chosenModel} disabled={Boolean(choiceLock)} disabledReason={choiceLock} onChange={e => {
                const pair = e.currentTarget.value ? JSON.parse(e.currentTarget.value) : null;
                onRunRequest({...runRequest,models:pair ? [{providerId:pair[0],modelId:pair[1]}] : 'any'});
              }}>
                <option value="">Any</option>
                {runRequest.models !== 'any' && !models.some(m => accountModelKey(m) === chosenModel) && <option value={chosenModel}>{runRequest.models[0].providerId + ' / ' + runRequest.models[0].modelId + ' · unavailable'}</option>}
                {models.map(m => <option key={accountModelKey(m)} value={accountModelKey(m)}>{m.providerId + ' / ' + m.modelId}</option>)}
              </Select></label>
              {runRequest.models === 'any' && runRequest.effortId === null && lendersAccountChoice(accountOffers) && <p class="cmp-route-help" id="cmp-lender-choice">{lendersAccountChoice(accountOffers)}</p>}
              <label class="cmp-route-field"><span>Effort</span><Select id="cmp-effort" aria-label="Effort" value={runRequest.effortId ?? ''} disabled={Boolean(choiceLock)} disabledReason={choiceLock} onChange={e => onRunRequest({...runRequest,effortId:e.currentTarget.value || null})}>
                <option value="">Default</option>
                {runRequest.effortId && !efforts.includes(runRequest.effortId) && <option value={runRequest.effortId}>{runRequest.effortId + ' · unavailable'}</option>}
                {efforts.map(e => <option key={e} value={e}>{e}</option>)}
              </Select></label>
            </details> : <>
            <details class="cmp-model-choice" open={Boolean(draft.model || draft.effort || draft.auto)}><summary class="cmp-setting-row"><span class="cmp-setting-label">Model and effort</span><span class="cmp-setting-value">{(draft.auto ? AUTO_CHOICES[draft.auto] ?? 'Unknown choice' : [draft.model, draft.effort && `${draft.effort} effort`].filter(Boolean).join(' · ')) || (draft.agent ? (lenderChoice || 'Let the lender choose') : 'Let the lender choose · choose an agent to change')}</span><Icon name="chev-r" size="sm" /></summary>
            <label class="cmp-route-field"><span>Model</span><Select id="cmp-model" class="selectish" aria-label="Model" value={draft.auto ? 'auto:' + draft.auto : draft.model || ''} disabled={Boolean(modelReason)} disabledReason={modelReason} onChange={e=>onModel(e.currentTarget.value)}>
              <option value="">Let the lender choose</option>
              {Object.entries(AUTO_CHOICES).filter(([intent]) => autoOffered(offers, draft.agent, intent) || draft.auto === intent).map(([intent, label])=><option key={intent} value={'auto:' + intent}>{label}</option>)}
              {draft.auto && !isAutoChoice(draft.auto) && <option value={'auto:' + draft.auto}>{'Unknown choice: ' + draft.auto}</option>}
              {draft.model && !offeredModels(offers, draft.agent).includes(draft.model) && <option value={draft.model}>{draft.model}</option>}
              {offeredModels(offers, draft.agent).map(m=><option key={m} value={m}>{m}</option>)}
            </Select><Icon name="chev-r" size="sm"/></label>
            <label class="cmp-route-field"><span>Effort</span><Select id="cmp-effort" class="selectish" aria-label="Effort" aria-describedby="cmp-effort-help" value={draft.effort || ''} disabled={Boolean(effortReason)} disabledReason={effortReason} onChange={e=>onEffort(e.currentTarget.value)}>
              <option value="">{draft.model ? 'Choose an effort' : 'Let the lender choose'}</option>
              {draft.effort && !offeredEfforts(offers, draft.agent, draft.model).includes(draft.effort) && <option value={draft.effort}>{draft.effort}</option>}
              {offeredEfforts(offers, draft.agent, draft.model).map(e=><option key={e} value={e}>{e}</option>)}
            </Select><Icon name="chev-r" size="sm"/></label>
            <div class="cmp-route-note"><p id="cmp-effort-help" class="cmp-route-help">{draft.model && 'Choosing a model means you also choose the effort. '}How hard the agent thinks. More effort uses more of the lender’s allowance.</p></div>
            </details>
            </>}

          </div>
          {!noSource && <details class="cmp-requested-check cmp-attachment"><summary class="cmp-check-summary" id="cmp-verify-heading"><span class="cmp-setting-label">Check</span><span class="cmp-setting-value">{draft.verifyCmd?.trim() ? 'Command set' : 'No check'}</span><Icon name="chev-r" size="sm"/></summary>
            <label class="row-title" for="cmp-verify">Test command</label>
            <input id="cmp-verify" class="input mono" value={draft.verifyCmd || ''} placeholder="For example, npm test" maxLength="4096" disabled={locked} onInput={(e) => onVerify(e.currentTarget.value.replace(/[\r\n]+/g, ' '))} />
            <p class="t-sm t-2">{CHECK_COMMAND_HELP}</p>
          </details>}
          <details class="cmp-run-details"><summary class="cmp-more-options"><Icon name="chev-r" size="sm" />Run settings</summary>
            <div class="cmp-settings-content"><p>Each lender chooses the model and effort (how hard the agent thinks) unless you pick them above. More effort uses more of their allowance.</p><p>Up to {Math.ceil(JOB_DEFAULTS.limits.wall_seconds / 60)} minutes. The lender’s own per-job limit can be lower.</p><p>Choices reflect recently reported lender settings. Availability can change before a lender picks up your request.</p></div>
          </details>
          <div class="cmp-privacy-row">
            <p class="cmp-privacy-note">{circleSummary}</p>
            <details class="cmp-lender-settings">
              <summary class="cmp-privacy-details" aria-label="Privacy and source details"><svg class="i sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/></svg></summary>
            <div class="cmp-settings-content cmp-consent">
              <p class="cmp-audience">{FIRST_SEND_COPY.visible}{' '}<a href="#cmp-sharing" onClick={e=>{e.preventDefault();const section=document.getElementById('cmp-sharing');section.open=true;section.scrollIntoView({block:'nearest'});}}>Review what you’re sending</a></p>
              <p>Model · {draft.auto ? AUTO_CHOICES[draft.auto] ?? 'Unknown choice' : draft.model || 'Set by the lender'}</p><p>Effort · {draft.auto ? 'Set by the lender' : draft.effort || 'Set by the lender'}</p>
              <p>Leave a choice on “Let the lender choose” and the lender picks it.</p>
              <p>Requested limits · The lender’s own per-job limit can be lower.</p>
              <details class="cmp-limits"><summary>Resource bounds <Icon name="chev-r" size="sm" /></summary><p>Up to {Math.ceil(JOB_DEFAULTS.limits.wall_seconds / 60)} minutes. These are requested limits, not an observation of a run. Disk is a preferred limit; it may not be enforced.</p></details>
              <details id="cmp-sharing" class="cmp-sharing">
                <summary>What you’re sending</summary>
                <div class="cmp-disclosure-body stack-3">{project?.sourceManifests && <SourceManifest manifest={project.sourceManifests[draft.includeUncommitted?'workingTree':'head']} preview/>}{project?.sourceManifest && <SourceManifest manifest={project.sourceManifest} preview/>}{source==='none'&&<p class="t-sm">Only your request. No project files or history.</p>}{source==='git'&&<p class="t-sm">The lender downloads the linked repository at the selected commit. The app has not checked its files, which files are left out, or their contents.</p>}{source==='files'&&<p class="t-sm">Only the files you selected are sent. Originals stay on this computer.</p>}<p class="t-sm">{vm.disclosure}</p></div>
              </details>
            </div>
            </details>
          </div>
        </div>
        <div class="cmp-sticky-footer" data-testid="compose-actions">
          <div class="send-note">
        {agentRefusal && <p class="form-error" id="agent-unavailable" role="alert" tabIndex="-1" ref={refusalRef}>{errorMessage({code:'agent_unavailable'})}</p>}
        {busy && <p class="t-sm t-2" role="status" tabIndex="-1" ref={sendStatusRef}>{vm.send.label === 'Waiting to send…' ? 'Waiting to send…' : 'Sending your job…'}</p>}
        {vm.send.why && (noSource || !vm.folderError) && <p class="t-sm t-2" id="cmp-why" role="status">{circle ? vm.send.why : <NoCircleWhy why={vm.send.why} />}</p>}
        <div class="pair cmp-pair">
          <Button kind="secondary" onClick={onCancel}>Back to jobs</Button>
          {agentRefusal && <Button kind="secondary" onClick={onChangeJob}>Change the job</Button>}
          {agentRefusal?.label && <Button kind="secondary" onClick={onSendAnyway}>{SEND_ANY_AGENT_LABEL}</Button>}
          <Button kind="primary" disabled={vm.send.disabled || Boolean(agentRefusal)} disabledReason={agentRefusal ? errorMessage({code:'agent_unavailable'}) : vm.send.why ? sendPointer : 'Review the job settings before sending.'} noHint={!agentRefusal && Boolean(vm.send.why) && !sendPointer} pending={vm.state === 'compose.send-uncertain' || busy} aria-describedby={agentRefusal ? 'agent-unavailable' : vm.folderError && !noSource ? 'cmp-meta' : vm.send.why ? 'cmp-why' : undefined} onClick={onSend}>
            {vm.state === 'compose.send-uncertain' || busy ? null : <Icon name="send" size="sm" />}{vm.send.label}
          </Button>
        </div>
          </div>
        </div>
        <Sheet open={sendNoticeOpen} onClose={onCloseFirstSend} label={FIRST_SEND_COPY.title}>
          <div class="card-pad stack-4">
            <h2 class="t-title2">{FIRST_SEND_COPY.title}</h2><p>{FIRST_SEND_COPY.body}</p>
            <details><summary>Learn more</summary><p class="t-sm t-2">{FIRST_SEND_COPY.learnMore}</p></details>
            <div class="hstack-2 wrap"><Button kind="primary" onClick={onConfirmFirstSend}>Send job</Button><Button kind="secondary" onClick={onCloseFirstSend}>Not now</Button></div>
          </div>
        </Sheet>
      </div>
    </div>
  );
}

// The circle a page opens on, and the circle it passed over because that host is not answering (so the page can say why).
function openingCircle(circles, last, current) {
  const id = composeCircle(circles, last, current), sendable = sendableCircles(circles);
  const preferred = sendable.find(c => c.id === last) || sendable.find(c => c.selected);
  return {id, skipped: preferred && preferred.id !== id && hostOffline(preferred) ? preferred.id : ''};
}
function storedCircle() { try { return store()?.getItem('faravan-compose-circle') || ''; } catch { return ''; } }
// Opening a page never rewrites a pending or uncertain record: restore has just read it as stored, so it counts as saved as is.
function openDraftSaved(storage, circle, draft, onSaved) {
  if (draft.sending || draft.agentRefusal || draft.uncertainSince != null) return true;
  return saveDraft(storage, circle, draft, onSaved);
}
// The page. A draft carries one id; whatever happens to the request, asking again with that id answers about the same job.
export function Compose(props) {
  const { circles, api, refresh } = props;
  const available = sendableCircles(circles);
  const [circleNotice, setCircleNotice] = useState('');
  // The circle is decided once: when the page opens, or when the person picks one. A later circle list (a host that
  // starts or stops answering) does not move an open page; the offline notice offers the way to another circle.
  const [chosen, setChosen] = useState(null);
  const last = chosen ? chosen.id : storedCircle();
  const pinned = Boolean(chosen) && available.some(c => c.id === chosen.id);
  // A send that is in flight or was refused, and a saved follow-up, stay with their circle, even if that circle leaves the list.
  const held = last && !pinned ? loadDraft(store(), last) : null;
  const keep = pinned || Boolean(held?.sending || held?.agentRefusal || held?.followup);
  const live = openingCircle(circles, last, props.circle);
  const opening = keep ? {id: last, skipped: chosen?.skipped ?? ''} : live;
  const circle = opening.id;
  // A kept opening is pinned too: another tab's circle choice must not move it on a later render.
  useEffect(() => { if (keep) { if (!chosen && last) setChosen({id: last, skipped: ''}); } else if (live.id) setChosen(live); }, [keep, last, live.id, live.skipped]);
  const selected = circles.find(c => c.id === circle);
  const passedOver = circles.find(c => c.id === opening.skipped);
  const skipped = skippedCircleNotice(passedOver && hostOffline(passedOver) ? passedOver : null, selected);
  useEffect(()=>{if(circle)try{store()?.setItem('faravan-compose-circle',circle);}catch{}},[circle]);
  const setCircle = (id, notice = '') => { setCircleNotice(notice); setChosen({id, skipped: ''}); try { store()?.setItem('faravan-compose-circle', id); } catch {} props.setCircle(id); };
  if (props.data && !Array.isArray(props.data.circles)) return props.errors?.circles
    ? <div class="compose ph-no-capture" role="status" data-telemetry-private="compose"><p>Circles could not be loaded. Your saved request has not changed.</p><Button kind="secondary" onClick={()=>refresh()}>Retry circles</Button><Button kind="quiet" href="#/jobs">Back to jobs</Button><Button kind="quiet" href="#/circles">Open Circles</Button></div>
    : <PageSkeleton label="Loading the composer" />;
  return <ComposePage key={circle} {...{ circleNotice:circleNotice || skipped, circle, selected, api, refresh, viewerSession:props.viewerSession, computerName:props.computerName }} circles={available} headingRef={props.headingRef} setCircle={setCircle} />;
}
// Retain both byte records when metadata cannot be verified: it may still refer to either one.
export async function commitAttachmentReplacement({previous, selection, attachmentId, change, removeAttachment}) {
  if (!change({...selection, attachmentId}, {rotate:true, requireSaved:true}))
    throw new Error('This browser couldn’t confirm your draft was saved. Your previous files are kept. Keep this page open and copy your request before leaving. Try choosing the files again.');
  // A failed move or another tab can still reference previous bytes. Retain them
  // until reference-safe reclamation is available; metadata success is not ownership.
}

export function DraftRestoreFailure({state, message, onRetry, onBack}) {
  const malformed = state === 'malformed';
  return <div class="compose ph-no-capture" data-telemetry-private="compose"><p class="form-error" role="alert">{message || (malformed
    ? 'The saved request could not be restored. It has been kept unchanged on this computer. Choose Retry, or go back to Jobs.'
    : 'This browser couldn’t open your saved draft. Try opening it again.')}</p><Button kind="secondary" onClick={onRetry}>Retry</Button><Button kind="secondary" onClick={onBack}>Back to jobs</Button></div>;
}
function ComposePage(props) {
  const [initial,setInitial]=useState(null),[restoreError,setRestoreError]=useState(''),[retry,setRetry]=useState(0);
  const [showSaved,setShowSaved]=useState(true),[discarded,setDiscarded]=useState(null),[draftActionError,setDraftActionError]=useState('');
  useEffect(()=>{
    let stopped=false;setRestoreError('');
    const restored=restoreDraft(store(),props.circle);
    if (!restored.draft) { setRestoreError({state:restored.state}); return; }
    const saved=restored.draft;
    (async()=>{try{const attachment=saved.attachmentId?await loadAttachment(saved.attachmentId):{};if(!stopped)setInitial({...saved,...attachment});}catch(error){if(!stopped)setRestoreError({message:errorMessage(error)});}})();
    return ()=>{stopped=true;};
  },[retry]);
  if(restoreError)return <DraftRestoreFailure {...restoreError} onRetry={()=>setRetry(value=>value+1)} onBack={()=>go('jobs')}/>;
  if(!initial)return <PageSkeleton label="Restoring your draft"/>;
  const discard = () => {
    try {
      const storage=store(), raw=storage?.getItem(COMPOSE_DRAFT_PREFIX+props.circle), current=JSON.parse(raw);
      if (!current || current.id!==initial.id || current.prompt!==initial.prompt || !discardSavedDraft(storage,props.circle,raw))
        throw new Error();
      const empty={...loadDraft(null,props.circle),sourceKind:'none',path:''};
      setDiscarded({raw,emptyId:empty.id});setInitial(empty);setShowSaved(false);setDraftActionError('');
    } catch { setDraftActionError('The saved request changed in another tab or could not be discarded. Reopen it before trying again.'); }
  };
  const undo = () => {
    if (!undoDiscardedDraft(store(),props.circle,discarded.raw,discarded.emptyRaw ?? null)) {
      setDraftActionError('The saved request changed or could not be restored. Your current text has been kept.');return;
    }
    setDiscarded(null);setInitial(null);setShowSaved(true);setDraftActionError('');setRetry(value=>value+1);
  };
  return <>
    {showSaved && initial.prompt.trim() && !initial.sending && initial.uncertainSince==null && !initial.agentRefusal && <SavedRequestPreview key={initial.id} text={initial.prompt} circle={props.selected?.name || props.circle}>
      <Button kind="primary" onClick={()=>{setShowSaved(false);requestAnimationFrame(()=>document.getElementById('cmp-prompt')?.focus());}}>Continue editing</Button>
      <Button kind="quiet" onClick={discard}>Discard</Button>
    </SavedRequestPreview>}
    {discarded && <div class="ph-no-capture" role="status" data-telemetry-private="compose"><p>Saved request discarded.</p><Button kind="secondary" onClick={undo}>Undo</Button></div>}
    {draftActionError && <p class="ph-no-capture" role="alert" data-telemetry-private="compose">{draftActionError}</p>}
    <ReadyComposePage key={initial.id} {...props} initialDraft={initial} onDraftChange={next=>{if(next.id!==initial.id || next.prompt!==initial.prompt || next.sending || next.agentRefusal)setShowSaved(false);}} onInitialSave={raw=>setDiscarded(current=>current?.emptyId===initial.id ? {...current,emptyRaw:raw} : current)}/>
  </>;
}
function ReadyComposePage({ circle, selected, circles, setCircle, api, refresh, headingRef, initialDraft, viewerSession, computerName, circleNotice, onDraftChange, onInitialSave }) {
  const reach = useContext(Connection);
  const [home,setHome]=useState('');
  useEffect(()=>{const request=new AbortController();api.get('folders?path=',request.signal).then(value=>{if(!request.signal.aborted)setHome(value.home || '');}).catch(()=>{});return()=>request.abort();},[api]);
  const [draft, setDraft] = useState(initialDraft);
  const [draftSaved, setDraftSaved] = useState(false);
  const [repo, setRepo] = useState({ status: 'idle' }), [state, setState] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [branches,setBranches]=useState([]), [sourceBusy,setSourceBusy]=useState(false),[sourceError,setSourceError]=useState('');
  const sourceEpoch=useRef(0);
  const [error, setError] = useState(''), [now, setNow] = useState(() => Date.now());
  const [firstSendAcknowledged, setFirstSendAcknowledged] = useState(firstSendNoticeSeen);
  const [sendNoticeOpen, setSendNoticeOpen] = useState(false), [sendNoticeOverride, setSendNoticeOverride] = useState(false);
  // Keep a refused send waiting on its original draft and host deadline across reloads.
  const [submission, setSubmission] = useState(() => draft.sending
    ? (draft.retryNotBefore == null ? 'uncertain' : 'busy')
    : draft.agentRefusal ? 'agent-unavailable' : 'idle');
  const [agentRefusal, setAgentRefusal] = useState(() => draft.agentRefusal);
  const draftRef = useRef(draft), alive = useRef(true), lock = useRef(false), ownershipLost = useRef(false);
  const [moveBlocked,setMoveBlocked]=useState(false);
  const pending = useRef(draft.sending || draft.agentRefusal ? {draft: {...draft}, circle, name: selected?.name} : null);
  const refusalRef = useRef(null), sendStatusRef = useRef(null);
  draftRef.current = draft;
  useEffect(() => { if (agentRefusal) refusalRef.current?.focus(); }, [agentRefusal]);
  useEffect(() => { if (submission === 'sending') sendStatusRef.current?.focus(); }, [submission]);
  useEffect(() => {
    if (submission !== 'uncertain') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [submission]);
  useEffect(() => () => { alive.current = false; }, []);
  const change = (patch, { rotate = false, requireSaved = false } = {}) => {
    if (!alive.current || ownershipLost.current) return false;
    const old = draftRef.current;
    if (rotate && old.sending) return false;
    const next = { ...old, ...patch, ...(rotate ? { id: newDraftId() } : {}) };
    const saved = saveDraft(store(), pending.current?.circle || circle, next);
    setDraftSaved(saved);
    if (requireSaved && !saved) return false;
    draftRef.current = next;
    setDraft(next);
    if (typeof onDraftChange === 'function') onDraftChange(next);
    return saved;
  };
  useEffect(() => { setDraftSaved(openDraftSaved(store(), circle, draftRef.current, onInitialSave)); }, []);
  const apiRef = useRef(api), resultRef = useRef(null), checkerRef = useRef(null);
  apiRef.current = api;
  resultRef.current = next => {
    setRepo(next);
    if (next.status === 'ok' && !draftRef.current.sending && !draftRef.current.agentRefusal && !draftRef.current.verifyEdited)
      change({verifyCmd: next.info.testCommand || ''});
  };
  checkerRef.current ??= createRepoChecker({
    inspect: (path, signal) => apiRef.current.post('repo/inspect', {path}, signal),
    // Keep suggestion rows mounted when input blur starts a check before their click.
    onChecking: () => setRepo(old => ({...old,status:'checking'})),
    onResult: next => resultRef.current(next),
  });
  const check = (path = draftRef.current.path) => checkerRef.current.check(path);
  const changePath = path => {
    change({path, includeUncommitted:false, verifyCmd:'', verifyEdited:false, sourceUnknown:false}, {rotate:true});
    setRepo({status:'idle'});
    checkerRef.current.schedule(path);
  };
  const selectProject = path => {
    if (draftRef.current.sending) return;
    if(sourceKind(draftRef.current)!=='folder')changeSource('folder');
    changePath(path);
    setPickerOpen(false);
    check(path);
  };
  // A new draft with no folder takes the obvious project: the last one used, or the only one found. It shows as a
  // summary that can be changed. With no obvious project, the Project row opens and says a choice is needed.
  const [autoPick,setAutoPick]=useState(()=>!draft.followup&&!draft.sourceUnknown&&sourceKind(draft)==='folder'&&!draft.path.trim()?'pending':'done');
  useEffect(()=>{
    if(autoPick!=='pending')return undefined;
    const request=new AbortController();
    api.get('folders/suggest',request.signal).then(found=>{
      if(request.signal.aborted)return;
      const recent=(found?.recent??[]).filter(p=>!p.stale&&p.is_git!==false),repos=found?.repos??[];
      const pick=recent[0]?.path||(repos.length===1&&!found.truncated?repos[0].path:'');
      const d=draftRef.current;
      if(pick&&!d.sending&&sourceKind(d)==='folder'&&!d.path.trim())selectProject(pick);
    }).catch(()=>{}).finally(()=>{if(!request.signal.aborted)setAutoPick('done');});
    return()=>request.abort();
  },[]);
  useEffect(() => { if (draft.followup) {} else if (sourceKind(draft)==='folder' && draft.path.trim()) check(); else if(sourceKind(draft)==='none')setRepo({status:'ok'}); else if(sourceKind(draft)==='git'&&draft.gitCommit)setRepo({status:'ok'}); else if(sourceKind(draft)==='files'&&(draft.files?.length||draft.zip))previewUploads(draft); return () => {sourceEpoch.current++;checkerRef.current.dispose();}; }, []);
  const changeSource = kind => {
    if (draftRef.current.sending) return;
    sourceEpoch.current++; checkerRef.current.cancel(); setSourceError('');setSourceBusy(false);setBranches([]);
    change({sourceKind:kind,workingDirectory:'',includeUncommitted:false,gitCommit:'',verifyCmd:'',verifyEdited:false,sourceUnknown:false},{rotate:true});
    setRepo({status:kind==='none'?'ok':'idle'});
    if(kind==='folder' && draftRef.current.path.trim())check();
  };
  const changeUrl = gitUrl => {sourceEpoch.current++;setBranches([]);setRepo({status:'idle'});setSourceError('');change({gitUrl,gitCommit:'',gitBranch:''},{rotate:true});};
  async function resolveGit(ref) {
    const epoch=++sourceEpoch.current;checkerRef.current.cancel();setSourceBusy(true);setSourceError('');setRepo({status:'checking'});
    try {const out=await api.post('repo/resolve',{url:draftRef.current.gitUrl.trim(),...(ref?{ref}:{})});if(epoch!==sourceEpoch.current)return;
      change({gitUrl:out.url,gitCommit:out.commit,gitBranch:out.branch},{rotate:true});setBranches(out.branches);setRepo({status:'ok'});
    }catch(error){if(epoch===sourceEpoch.current){setSourceError(errorMessage(error));setRepo({status:'idle'});}}
    finally{if(epoch===sourceEpoch.current)setSourceBusy(false);}
  }
  async function previewUploads(input, epoch=++sourceEpoch.current) {
    setSourceBusy(true);setRepo({status:'checking'});setSourceError('');
    try {const out=await api.post('source/preview',input.zip?{zip:input.zip}:{files:input.files});if(epoch===sourceEpoch.current)setRepo({status:'ok',info:{sourceManifest:out.sourceManifest}});}
    catch(error){if(epoch===sourceEpoch.current){setSourceError(errorMessage(error));setRepo({status:'idle'});}}
    finally{if(epoch===sourceEpoch.current)setSourceBusy(false);}
  }
  async function chooseFiles(files) {
    if(!files?.length)return;
    const epoch=++sourceEpoch.current;setRepo({status:'checking'});setSourceBusy(true);setSourceError('');
    try {const selection=await readUploadSelection(files);if(epoch!==sourceEpoch.current)return;
      const attachmentId=newDraftId();await saveAttachment(attachmentId,selection);if(epoch!==sourceEpoch.current){await removeAttachment(attachmentId);return;}
      const previous=draftRef.current.attachmentId;
      await commitAttachmentReplacement({previous,selection,attachmentId,change,removeAttachment});
      if(epoch===sourceEpoch.current)await previewUploads(selection,epoch);}
    catch(error){if(epoch===sourceEpoch.current){setSourceError(errorMessage(error));setRepo({status:'idle'});setSourceBusy(false);}}
  }
  const reloadCircle = useRef(null);
  // Who hosts the circle, whether it answers, and who is lending now.
  useEffect(() => {
    if (!circle) return undefined;
    let stop = false, loading = false;
    setState(old => ({...(old?.circle === circle ? old : {circle,networked:Boolean(selected?.origin)}),readStatus:'checking'}));
    const load = async () => {
      if (loading || stop) return;
      loading = true;
      try {
        const next = await api.get('circles/' + encodeURIComponent(circle) + '/compose');
        if (!stop) { setState({...next,readStatus:'ready'}); setNow(Date.now()); }
      } catch {
        if (!stop) setState(old => ({...old,readStatus:'failed'}));
      } finally { loading = false; }
    };
    reloadCircle.current = load;
    const stopPolling = visibleInterval(load, 15000);
    return () => { stop = true; reloadCircle.current = null; stopPolling(); };
  }, [circle]);

  const signed = draft.requestMode === 'signed' || (!draft.requestMode && state?.circle === circle && state.runRequestSupported === true);
  async function send(override = false) {
    if (lock.current || ownershipLost.current || !alive.current) return;
    if (override !== (submission === 'agent-unavailable')) return;
    if ((submission === 'idle' || override) && ['checking','failed'].includes(state?.readStatus)) return;
    const manifest=repo.info?.sourceManifest || repo.info?.sourceManifests?.[draftRef.current.includeUncommitted?'workingTree':'head'];
    let current = pending.current?.draft ?? {...draftRef.current,...(sourceKind(draftRef.current)==='folder'&&manifest?{sourceExpectedDigest:manifest.archive_digest}:{})};
    if (!validRequestState(current)) return;
    // Offer availability is mutable. Recover an already-persisted send using
    // its original request; the host resolves the durable draft identity.
    const recovering = !override && current.requestMode === 'signed' &&
      draftRef.current.sending && pending.current?.circle === circle &&
      (submission === 'uncertain' || submission === 'busy');
    if (signedRequestBlocker(state?.circle === circle ? state : null,current,{recovering})) return;
    if (vm.send.disabled && submission === 'idle') return;
    // Freeze the request mode and signed selector on first send, including remount recovery.
    if (!current.requestMode) current = {...current,...(signed
      ? {requestMode:'signed',runRequest:defaultRunRequest()} : {requestMode:'legacy'})};
    pending.current ??= {draft: {...current}, circle, name: selected?.name};
    if (override) pending.current.draft = {...pending.current.draft, sendAnyway:true};
    const destination = pending.current;
    const persisted = saveDraft(store(), destination.circle, {...destination.draft, sending:true, retryNotBefore:null, uncertainSince:draftRef.current.uncertainSince || Date.now()});
    setDraftSaved(persisted);
    if (!persisted && !draftRef.current.sending) {
      pending.current = null;
      setError('This browser couldn’t save your draft for sending. Nothing was sent. Keep this page open and copy your request before leaving. Try Send again after browser storage is available.');
      return;
    }
    sourceEpoch.current++;
    lock.current = true; setError('');
    if (submission === 'idle' || override) setSubmission('sending');
    if (override) setAgentRefusal(null);
    change({ ...current, ...(current.sourceExpectedDigest?{sourceExpectedDigest:current.sourceExpectedDigest}:{}), sending: true, retryNotBefore:null, uncertainSince:draftRef.current.uncertainSince || Date.now(), ...(override ? {sendAnyway:true, agentRefusal:null} : {}) });
    try {
      const out = await api.post('jobs', draftBody(destination.draft, destination.circle));
      try { store()?.setItem(FIRST_SEND_NOTICE_KEY, 'yes'); } catch {}
      if (alive.current) setFirstSendAcknowledged(true);
      clearDraftIfCurrent(store(), destination.circle, destination.draft.id);
      // Older drafts may share these bytes. Retain them until reference-safe reclamation is available.
      if (!alive.current) return;
      setSubmission('idle');
      go('job', out.jobDigest, destination.circle);
      history.replaceState({...history.state,createdJob:createdJobVM(out,destination.draft,{id:destination.circle,name:destination.name})},'');
      refresh();
    } catch (e) {
      if (!alive.current) return;
      const refused = e.outcome === 'not_applied';
      const refusal = refused && e.code === 'agent_unavailable' && e.agentRefusal?.message ? e.agentRefusal : null;
      // These refusals happen before an intent is saved, including on a retry of an unanswered send.
      if(refused&&e.code==='source_changed'){pending.current=null;change({id:newDraftId(),sending:false,uncertainSince:null,sourceExpectedDigest:null,agentRefusal:null,sendAnyway:false});setAgentRefusal(null);setSubmission('idle');setError(errorMessage(e));await check();}
      else if (refusal) { change({sending:false,uncertainSince:null,agentRefusal:refusal}); setAgentRefusal(refusal); setSubmission('agent-unavailable'); }
      else if (refused&&e.repoRefusal) { pending.current = null; change({ id:newDraftId(), sending: false, uncertainSince:null, sendAnyway:false, agentRefusal:null }); setSubmission('idle'); setRepo({ status: 'refused', refusal: e.repoRefusal }); }
      else if (refused&&e.code === 'rate_limited') {
        const receivedAt = Date.now();
        change({ ...(current.sourceExpectedDigest?{sourceExpectedDigest:current.sourceExpectedDigest}:{}),
          sending:true, uncertainSince:draftRef.current.uncertainSince || receivedAt,
          retryNotBefore:receivedAt + Math.ceil(busyWait(e, receivedAt)) });
        setSubmission('busy');
      }
      else if (refused&&e.code === 'invalid_request') { pending.current = null; change({ id:newDraftId(), sending: false, uncertainSince:null, sendAnyway:false, agentRefusal:null }); setSubmission('idle'); setError(errorMessage(e)); }
      else if (sendUncertain(e)) { change({ ...(current.sourceExpectedDigest?{sourceExpectedDigest:current.sourceExpectedDigest}:{}), sending: true, uncertainSince:draftRef.current.uncertainSince || Date.now() }); setSubmission('uncertain'); }
      else { pending.current = null; change({ id:newDraftId(), sending: false, uncertainSince:null, sendAnyway:false, agentRefusal:null }); setSubmission('idle'); setError(errorMessage(e)); }
    } finally { lock.current = false; }
  }
  const requestSend = (override = false) => {
    if (firstSendAcknowledged) return send(override);
    setSendNoticeOverride(override);
    setSendNoticeOpen(true);
  };
  const confirmFirstSend = () => {
    setSendNoticeOpen(false);
    return send(sendNoticeOverride);
  };
  useEffect(() => {
    if (!draft.sending || submission !== 'busy' || draft.retryNotBefore == null) return undefined;
    const remaining = Math.max(0, draft.retryNotBefore - Date.now());
    const timer = setTimeout(() => { if (draftRef.current.sending) send(); }, remaining);
    return () => clearTimeout(timer);
  }, [draft.sending, draft.id, submission, draft.retryNotBefore, state]);
  // A send that was not answered is asked about, with its own id, until the host says; never as a second send.
  useEffect(() => {
    if (!draft.sending || submission !== 'uncertain') return undefined;
    let stopped = false, timer;
    const retry = async () => {
      if (stopped || !draftRef.current.sending) return;
      await send();
      if (!stopped && draftRef.current.sending) timer = setTimeout(retry, 3000);
    };
    timer = setTimeout(retry, 3000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [draft.sending, draft.id, submission, state]);
  // A follow-up stays in its circle, so it never offers another one.
  const instead = draft.followup ? null : circles.find(c => c.id !== circle && !hostOffline(c)) ?? null;
  const composeRepo = draft.followup ? {status:'ok'} : sourceReady(draft,repo)?repo:repo.status==='ok'?{status:'idle'}:repo;
  const baseVM = useMemo(() => ({ ...composeVM({ prompt: draft.prompt, repo:composeRepo, circle: { id: circle, name: selected?.name, state: state?.circle === circle ? state : { networked: Boolean(selected?.origin) } }, submission, now, uncertainSince:draft.uncertainSince,sourceKind:sourceKind(draft),draftSaved,viewerSession,computerName,clientOffline:reach?.offline === true, choice:signed ? {} : {agent:draft.agent,model:draft.model,effort:draft.effort,auto:draft.auto}, instead }), checking: repo.status === 'checking' }),
    [signed, instead, draft.prompt, draft.uncertainSince, draft.sourceKind, draft.followup, repo, circle, selected, state, submission, now, draftSaved, viewerSession, computerName, reach?.offline, draft.agent, draft.model, draft.effort, draft.auto]);
  const directoryError=!draft.followup && sourceKind(draft)!=='none' && workingDirectoryProblem(draft.workingDirectory?.trim());
  const signedWhy = signedRequestBlocker(state?.circle === circle ? state : null,draft);
  const vm=signedWhy && submission==='idle' ? {...baseVM,send:{...baseVM.send,disabled:true,why:signedWhy}} : moveBlocked ? {...baseVM,send:{...baseVM.send,disabled:true,why:'Changing circles could not be confirmed. Copy your request before leaving, then check the saved requests in both circles before sending.'}} : directoryError && submission==='idle' ? {...baseVM,send:{...baseVM.send,disabled:true,why:directoryError}} : baseVM;
  const offeredAgents=circleAgents(state?.circle===circle?state:null);
  const agentReason=state?.circle===circle&&state.readStatus==='ready'&&(state.host?.reachable!==false||state.sendReachable===true)?noAgentReason(state,selected?.name||state.name):null;
  const source=sourceKind(draft);
  // The same blocker the footer names. It does not wait for the folder suggestion: a row that stays closed while
  // the footer says "until you choose a project" reads as a broken form.
  const projectNeeded=!draft.followup&&source!=='none'&&!sourceBusy&&(Boolean(directoryError)||
    !['ok','checking'].includes(repo.status)&&!(source==='folder'&&draft.path.trim()&&repo.status==='idle'));
  const offers=state?.circle===circle?(state.offers??[]):[];
  // Choosing an agent or a model keeps the other choices only while the circle's lenders still offer them.
  const pick=patch=>{
    const next={agent:draftRef.current.agent,model:draftRef.current.model,effort:draftRef.current.effort,auto:draftRef.current.auto,...patch};
    // A preset replaces the model and effort; a model or an agent change keeps a preset only while a lender still offers it.
    const auto=keepAuto(offers,next);
    return {...patch,...(auto?{model:'',effort:''}:keepOffered(offers,next)),auto};
  };
  const editRefusedJob = patch => {
    pending.current = null;
    setAgentRefusal(null); setSubmission('idle');
    change({...patch,id:newDraftId(),sending:false,uncertainSince:null,sendAnyway:false,agentRefusal:null});
  };
  const changeCircle = id => {
    if (id === circle || ownershipLost.current || draftRef.current.sending || draftRef.current.agentRefusal || pending.current) return;
    const result = moveDraft(store(), circle, id, draftRef.current);
    if (result.state === 'moved' || result.state === 'occupied') {
      // The source was already persisted by change(). Do not overwrite a newer
      // source record when merely opening an occupied destination.
      ownershipLost.current = true;
      sourceEpoch.current++; checkerRef.current.cancel();
      setCircle(id, result.state === 'occupied' ? `This circle already has a saved request. We opened that request. Your previous draft is still saved in ${circlePhrase(selected?.name)}.` : '');
      return;
    }
    if (result.state === 'changed' || result.state === 'unconfirmed') {
      ownershipLost.current = true;
      sourceEpoch.current++; checkerRef.current.cancel();
      setMoveBlocked(true);
      setError(result.state === 'changed'
        ? 'The saved request no longer matches this page. Copy your request before reloading, then check the saved draft before changing circles.'
        : result.sourceKept === true
          ? "We couldn't confirm the move. Your request is still in this circle. Don't send it from the other circle."
          : "We couldn't confirm the move or where your request is saved. Keep this page open and copy your request before leaving. Check the saved requests in both circles before sending anything.");
    } else setError('Couldn’t open that circle’s saved request. Your current request is still here.');
  };
  const changeJob = () => {
    editRefusedJob({});
    requestAnimationFrame(() => document.getElementById('cmp-agent')?.focus());
  };
  return (
    <div class="compose ph-no-capture" data-telemetry-private="compose">
      {pickerOpen && <ProjectPicker api={api} onChoose={selectProject} onClose={() => setPickerOpen(false)} viewerSession={viewerSession} computerName={computerName} />}
      {!draftSaved && <p class="form-error" role="alert">{draft.sending ? 'This request may already have been sent. Keep this page open while Faravan checks. After a reload, check Jobs before preparing another request.' : 'This browser couldn’t save your draft. Keep this page open and copy your request before leaving.'}</p>}
      {state?.readStatus === 'failed' && <Button kind="secondary" onClick={() => reloadCircle.current?.()}>Check again</Button>}
      {error && <p class="form-error" role="alert">{error}</p>}
      <ComposeBody home={home} vm={vm} circleNotice={circleNotice}
        project={repo.status === 'ok' ? repo.info : null} draft={draft} ownershipBlocked={moveBlocked} circles={circles} circle={circle} agents={offeredAgents} agentReason={agentReason} projectNeeded={projectNeeded} draftSaved={draftSaved} offers={offers} signed={signed} accountOffers={state?.circle===circle ? state.accountOffers ?? [] : []} onRunRequest={runRequest => { const patch={requestMode:'signed',runRequest}; agentRefusal ? editRefusedJob(patch) : change(patch,{rotate:true}); }} busy={['sending','busy'].includes(submission)} agentRefusal={agentRefusal} refusalRef={refusalRef} sendStatusRef={sendStatusRef} headingRef={headingRef}
        onPrompt={(prompt) => change({ prompt }, { rotate: true })}
        onWorkingDirectory={workingDirectory=>change({workingDirectory},{rotate:true})} onSourceKind={changeSource} onUrl={changeUrl} onResolve={resolveGit} onBranch={resolveGit} onFiles={chooseFiles} branches={branches} sourceBusy={sourceBusy} sourceError={sourceError}
        onPath={changePath} onChoose={() => setPickerOpen(true)} onSelectProject={selectProject} suggestions={repo.refusal?.suggestions || repo.info?.suggestions || []}
        onInclude={(includeUncommitted) => change({ includeUncommitted }, { rotate: true })}
        onAgent={(agent) => agentRefusal ? editRefusedJob(pick({agent})) : change(pick({agent}), {rotate:true})}
        onModel={(value) => { const patch = value.startsWith('auto:') ? {auto: value.slice(5), model: '', effort: ''} : {auto: '', model: value}; agentRefusal ? editRefusedJob(pick(patch)) : change(pick(patch), {rotate:true}); }}
        onEffort={(effort) => agentRefusal ? editRefusedJob({effort}) : change({effort}, {rotate:true})}
        onVerify={(verifyCmd) => change({verifyCmd, verifyEdited: true}, {rotate: true})}
        onCircle={changeCircle} onCheck={(force=true) => {if(force || repo.status!=='ok')check();}} onSend={() => requestSend()} onSendAnyway={() => requestSend(true)}
        sendNoticeOpen={sendNoticeOpen} onConfirmFirstSend={confirmFirstSend} onCloseFirstSend={() => setSendNoticeOpen(false)} onChangeJob={changeJob} onCancel={() => go('jobs')} />
    </div>
  );
}
