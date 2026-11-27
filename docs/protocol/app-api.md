# v1 local app API

startApp(options) binds only 127.0.0.1 and returns {server, origin, url, token, device, close}.
Options include home, port (0 chooses an available port), token, backendFactory, clock, fetch,
adapters, identityProbe, identityCacheMs (default 1800000), quotaReader and idleReader. A function clock returns Unix seconds; an object clock.now
returns milliseconds. Tests inject temporary homes, loopback fetch, synthetic devices and fake backends.

## Local session boundary

Use x-faravan-session-token on every request. The existing daemon's ?token= fallback is also
supported for EventSource. The printed URL contains this session secret. Do not log or share it.
Host must be localhost, 127.0.0.1 or [::1], optionally with a port; the listener itself is IPv4
loopback only. Wrong Host returns 403; missing/wrong token returns 401. Cross-origin requests
are rejected and no CORS headers are emitted. Responses are no-store and no-referrer.
The v0 daemon imports the same unchanged validation/token behavior from loopback-security.mjs.

POST bodies are application/json objects, at most 28 MiB. Successful actions return 200.
Errors are {code,message}, with no exception stack, remote error body, invite fragment or raw path.
Only the invite response contains the invitation secret; it is never written to app activity.
GETs do not launch browsers, authentication, repairs or enrollment.

## Endpoints

- GET /api/home and /api/status: {state,reason,until,intent,execution,blockers,headline,needs_you,iconState,allowance,today,activeCircle,runningJob,lending,desktop,currentJob,attention,circles,lendingPrompts}.
  `lendingPrompts` lists pending owned-circle choices as {circle,name,atRuleLimit}. Joined circles and circles with a saved mode or rule are excluded. Read this list on desktop, phone or agent clients; answer through POST /api/lending/mode. A successful answer saves an explicit mode and audit receipt, so the choice does not return after restart.
  `runningJob` is {requester} while a job runs (the name this lender gave the requester, else the name their device signed;
  never prompt text, paths or source), else null; it is optional and a client must work without it.
  `stoppedJob` is {requester} (name or null) while lending is off because this lender stopped a job; it is absent otherwise and clears when
  lending is turned on again. A client uses it to say why lending is off.
  `today` is {jobs,jobLimit,minutes,minuteLimit} for the lender's current day, or null before the lender has counters.
  `desktop` is {platform,tray,pinPrompt,pinSettingsUri,noTrayNote} (see POST /api/desktop/*).
  `setup` is {resume}: null, or {step:"hypervisor"|"kvm", reason:"restart"|"logout", state:"waiting"|"returned", since} (D8).
  `waiting`: the person has not restarted / logged out yet. `returned`: they did, so the setup screen resumes at `step`.
  state is off, paused, blocked, running, resting, ready or starting, in that precedence.
  reason is a machine code or null; until is epoch milliseconds or null.
  intent {state: off|paused|outside|resting|ready|starting|blocked|update, reason, until} is what lending is
  set to do. execution {state: idle|running|finishing|stopping, job, person, stops_by} is what runs now and is never
  hidden by the intent (a paused or off intent with a running job is `finishing`). blockers is a list of
  {kind, agent?}. headline is the sentence ("Paused · Sam's job is finishing, stops by 3:01 PM"). `state`, `reason`
  and `until` keep the old single-axis answer for older clients. Pause new jobs (POST /api/lending/pause) and Stop
  the running job (POST /api/lending/stop {attemptId, confirmed:true}) are separate actions: pausing never stops a job.
  `docker` is null, or {code:'docker_signed_out', message, action:{kind:'docker-signin', label, href:'#/setup', step:'docker-signin'}}
  when Faravan's own Docker sign-in expired (the preflight's docker_login check failed). The same code appears as `reason`
  of a safety block, as a blocker and a need ({kind:'docker_signed_out'}), on every row of GET /api/agents
  (`code`, `message`, `action`, `signInState` 'Docker sign-in needed', no 'Check failed'), in GET /api/readiness, and as the
  409 error of POST /api/lending/on|resume and POST /api/signin/<agent>. While it is set, agent checks and agent sign-in
  are not attempted. Sign-in to Docker itself (POST /api/signin/docker) is still allowed.
  needs_you is independent: {kind:'approval',approvalId}, {kind:'agent_signed_out',agent},
  or {kind:'safety_check_failed'}. One signed-out agent does not block another ready agent.
  Starting lasts at most ten seconds while initial facts are unknown.
  Attention rows contain label and remedy.
  iconState is exactly "Lending on", "Paused" or "Needs attention". Safety/unknown blockers and
  actionable attention take precedence; expected daily caps and allowance reserve show "Paused",
  while eligible automatic waiting for idle keeps "Lending on". This is text for the native icon client.
- GET /api/activity?after=ID: polling array of ordered {id,type,data,at} events.
- GET /api/events?after=ID: SSE replay and live updates; Last-Event-ID also supported. Event types include
  lending, approval, agents, limits, job and attention. IDs are process-local increasing integers.
  Replay retains at most 2,000 events / 2 MiB. An individual event over 256 KiB becomes
  {refresh:true,truncated:true}; refetch the affected resource. Slow readers are disconnected.
- GET /api/circles: circle array, including the offline first-run My devices circle.
- POST /api/circles: {origin,name,publish?}; returns the circle. publish:false only creates local
  provisioning material; it does not enroll or configure a server.
- POST /api/circles/join-preview: {link}; locally validates the signed fragment-only invitation,
  seed/key and origin binding, plus expiry/future-created time. No enrollment. {link} may be a long
  link or a short link (`https://HOST/i/CODE#SEED`); a short link costs one public
  `GET /v1/invites/CODE` to its origin, and the invite binding is verified with the link's seed before
  anything is used (an unreachable origin is invite_unreachable 502, an expired invite invitation_expired).
  Returns {name,origin,ownerName?,lanMode,warning,expiresAt}, never the private seed or link.
  The name is signed by the root in the invitation; that root is not yet independently pinned.
  warning is the exact LAN disclosure for a signed lan_mode:true invite, otherwise null.
- POST /api/circles/join: {link,acknowledgedWarning?}; revalidates the invitation and expiry
  before enrollment. A signed LAN invite requires acknowledgedWarning:true; otherwise returns
  warning_not_acknowledged (409), with message and warning containing the exact LAN disclosure,
  without enrolling. Non-LAN invitations continue to accept {link}. Joining never enables lending.
  The web app binds confirmation to the exact locally previewed link, shows its signed name
  and LAN warning before a separate Join circle action, and sends acknowledgedWarning:true
  only for that reviewed LAN invite. Edits, Not now and leaving invalidate the local preview.
  Unknown enrollment outcomes are never automatically retried. A computer the owner removed gets
  device_removed (403, "This computer was removed from that circle, and a removed computer can't join it again.")
  on any later invitation; nothing is queued for the owner.
- POST /api/circles/:id/invite: {}; returns {invite}, a short link when the server publishes it, else the long link. Treat the entire returned link as secret.
- The local app page opened with `#/circles?join=<encoded link>` (made by `faravan open-link`) removes that fragment on load and shows the link in the join review. It never joins by itself.
- GET /api/circles/:id/approvals: pending enrollments excluding durable local declines. Each item adds
  device_fingerprint (key ID of the requesting device) and device_name (the name signed by the joining
  device with the invite key, or null if absent or unverifiable). Joining sends this app's device name
  (`POST /api/devices`, default: host name).
- POST /api/circles/:id/check: {}; the joining computer asks the queue for the current signed roster
  (and, while its enrollment is pending, the enrollment state). Returns {state:'approved'} once the roster
  includes this device, else {state:'pending'}. Emits an 'enrollment' event with state 'joined' on the
  change. The web app calls it from Check again and every 5 seconds while a join is pending. Safe to repeat.
- POST /api/circles/:id/approve: {enrollmentId?}; targeted approval, or bulk verified approval when omitted.
- POST /api/circles/:id/reject: {enrollmentId}; a durable local decline. The server enrollment expires;
  this endpoint does not pretend the server supports an immediate rejection contract.
- POST /api/circles/:id/remove-member: {keyId}; owner publishes a new signed roster excluding the
  member. Owners cannot remove their own signing device through this action.
- POST /api/circles/:id/leave: {}; pauses/stops local lending, cancels this device's own locally tracked
  waiting requests, then forgets circle metadata. Unresolved execution/claim/result recovery blocks
  forgetting. For a joined circle it first sends the owner a signed leave request (protocol section 5.2),
  best effort. Response: {id,left:true,rosterMembershipUnchanged:true,leaveRequested,leaveError?}.
  rosterMembershipUnchanged stays true because the roster changes only when the owner's device applies the
  request (its sweep does, automatically); leaveRequested:false means the owner must remove this device by hand.
  Leaving cannot retract previously shared data. The owner's app emits a `member-left` activity event.
- GET /api/devices: {name,fingerprint,circles:[{circle,members}]} using verified cached rosters.
- POST /api/devices: {name}; updates this computer's display name.
- GET /api/agents: {id,name,installed,signedIn,signInState,account,models,credential_in_guest,
  useForLending,checkedAt,stale,remedy,evidence} rows. Unknown installation/sign-in is null, never guessed.
  GET reads only the in-memory cache (or explicitly injected adapter facts); it never runs probes.
- GET /api/jobs/:digest/retention?circle=: {state, ended_at, retained_until, deletable} for the host's 30-day deletion ("Kept on Ana's MacBook until 18 November"); `host_too_old` for a host without retention_v1. POST /api/jobs/:digest/delete {circle}: deletes a finished job and its stored files now (its author or the owner device; a running job must be cancelled first).
- POST /api/hosting/keep-awake: {on:boolean}; the keep-awake switch of the circle this computer hosts (H2, docs/protocol/hosting.md). 404 when this computer hosts nothing. Returns the hosting view, which carries `keepAwake` {enabled, active, reason} and `lastWake` {at, gapSeconds}|null.
Each lent job checks network and credential isolation in its prepared sandbox before the agent starts. A failed check declines the job with `isolation_check_failed` and pauses lending; resume lending to try again. An inconclusive check declines with `isolation_check_inconclusive` without pausing. No check result from an earlier job enables lending.
- POST /api/agents/refresh: {} or {agents:[id...]}. A plain check looks only at the agents selected for lending and the ones
  last seen installed (on a fresh install, at those whose stored sign-in can be read without a sandbox); an unselected,
  uninstalled agent never starts a sandbox. {agents:[...]} names the ones to check (400 for an unknown id or an empty list).
  Up to three agents are checked at once, each in its own sandbox with its own limit (90 s, `agentProbeTimeoutMs`) and its
  own result: one that runs out of time gets `Check failed` / "took too long", the others are unaffected. Each row has
  `checking` while it is being checked, and the app emits an `agents` event when the check starts (rows marked checking)
  and again as each agent finishes ({refreshed:false, id, agents}), then a last {refreshed:true}; the response is the
  final rows. A stored sign-in that is gone (the agent's secret is missing from sbx's credential store) is read from the
  store without a sandbox and shows as `signInState:'Sign-in needed'`, `signInReason:'credential_missing'` and
  "<agent> needs you to sign in again.", with the Sign in action (`signInSupported`), not `Check failed`.
  Runs bounded status-only commands in temporary sandboxes, then destroys them. Never signs in,
  repairs identity or runs model requests. Display evidence becomes stale after 30 minutes by default;
  age alone never clears the last-known installed/sign-in state. Each evidence fact has
  {fact,value,source,observed_at}; failed checks retain those facts and their ages.
  Before claiming with aged evidence, lent agents get one bounded sandbox-free sign-in probe;
  successful probes are cached for 30 minutes, unknown/negative probes retry after 30 seconds.
  Two definite negative checks establish sign-out; timeout/error/unreadable output never does.
  Lending also retains the background sandbox check for stale or missing lent-agent evidence
  while no job runs. A proven job sign-out takes effect immediately.
  Evidence is keyed by harness ID, not shared service ID. checkedAt is an ISO timestamp or null.
  OpenCode credential listing cannot establish authenticated state and therefore remains unknown.
- POST /api/agents/:id: {useForLending:boolean}; explicit selection, initially off.
- Agent rows also carry signInSupported: true when the app can drive that agent's browser sign-in
  (host URL flow adapters such as codex and claude-code-subscription). API-key, environment-variable and
  interactive adapters report false and POST /api/signin returns signin_unsupported for them.
- POST /api/signin/:target: {}; target is "docker" (Docker Sandboxes device login), "github" (task access) or an
  agent ID. Starts one explicit browser sign-in and returns {flowId,target,status,message,url?,code?}. Nothing
  opens a browser: the client opens url only after the user's click. Only url (https only), the one-time code,
  status and fixed copy are returned; process output, tokens and error text never are. status is
  awaiting_browser, complete (already signed in), failed, cancelled or timed_out. A second start for a target
  with an active flow returns that flow. Errors: not_found 404, signin_unsupported 409, signin_failed 409
  (also when the sandbox is not ready). This route is not serialized with other mutations so a pending
  start never blocks a cancel.
- GET /api/signin/:flowId: the same view; url and code are present only while awaiting_browser. Reads only
  in-memory state, so polling runs no probe and opens nothing. Finished flows are kept for ten minutes.
- POST /api/signin/:flowId/cancel: {}; stops the flow and its child process (idempotent). Flows time out after
  about 5 minutes (timed_out) and are cancelled when the app closes.
  On success the app refreshes agent evidence (the same probe as POST /api/agents/refresh) before reporting
  complete; GET /api/readiness is computed per request, so it reflects the new sign-in immediately.
  Each status change emits a "signin" event {flowId,target,status} (no url or code).
- GET /api/lending: enabled, circle, mode, limits and lender snapshot with label/current/paused.
- POST /api/lending/on and /resume: {circle?}; enforce readiness, selected agent and membership.
  A blocker never turns lending off (S1.1c). A failed baseline check (Docker missing, stopped or signed out, the sandbox safety
  test, the circle's host) holds new claims through the lender's gate and is named in the status; `intent.on` stays what the
  person set, the lender stays enabled, and the next passing check lets claims resume without any action. Nothing is latched
  or saved (older `safetyBlocked` settings are dropped on load). Turning lending on while a blocker is set succeeds.
  `GET /api/status.lending_blockers` is the ordered model (lib/v1/blockers.mjs, from docs/design/experience/mockups/src/blockers.mjs):
  {headline, first, items[], needsYou[], canLend}, items in the order Docker installed, Docker running, Docker sign-in, readiness requirements, any
  isolation failure, lending, the circle's host, then each agent in Lending-page order (Claude Code, Codex, and any other chosen agent).
  Each item has {key, status ok|blocked|waits|unknown|off, label, detail, detail_code, waits_for, action?, agent?}. The status
  `reason` is the first blocker's: docker_not_installed, docker_not_running, docker_signed_out, isolation_check_failed, circle_unreachable or circle_update_needed. The circle row comes from the host's GET /capabilities (P22), read at
  start, when lending starts and about once a minute: two misses in a row make it `circle_unreachable` (no button; it retries by
  itself); a host older than this build's minimum (`minHostVersion`) makes it `circle_update_needed`. A member older than the host's
  `min_member` gets `GET /api/status.update` = {required:true, circle, needVersion, haveVersion}, state `update`, reason `update_required`,
  and claims nothing until it is updated; the switch stays on. `GET /api/status.host` = {reachable: true|false|null, lastReachedAt, faravan, minMember}
  (null before the host was first read) is what the member's host-offline banner reads (H3).
- POST /api/lending/off and /pause: {}; stop new work; running work continues within its saved limits. Waiting review cards close. Unclaimed modern offers are not durably declined and can return on Resume.
  /pause also accepts {until} (epoch milliseconds, later than now and within 7 days): a timed pause. Intent stays on, the
  state is `paused` with `until`, and lending resumes by itself at `until` (also after a restart). Only when lending was on;
  otherwise it is a plain pause. /off ignores `until`.
- POST /api/setup/progress: {step:"hypervisor"|"kvm"}; the setup screen calls it when the person turns on the Windows Hypervisor
  Platform (a restart is needed) or runs the kvm group command (a new login is needed). The app saves the step in
  `v1/setup-progress.json` and installs a one-shot resume hook (Windows RunOnce, Linux autostart) that runs `faravan open-setup`.
  Returns {resume, openedByItself}. `GET /api/readiness` drops the saved step when its own check (`hypervisor_platform`,
  `kvm_access`) passes. POST /api/setup/progress/clear: {} drops it by hand and removes the hook.
- POST /api/shutdown: {attemptId?,confirmed?}; the tray's Quit. The app first validates waiting legacy reviews and running work,
  then fences new claims while preserving the saved On or Pause intent. Quit preserves accepted preparation for the next start;
  use /api/lending/off for durable Off. A running job with no `attemptId` gives 409 `job_running` and is left alone; a different attempt, or no
  `confirmed:true`, gives 409 `job_changed`. With the running attempt confirmed it stops that job. It answers 202 and then closes through its own
  cleanup (the lender loop ends, which stops the sandbox); the caller waits for the process to exit and never kills it.
  It answers 202 only after every sandbox is proven gone: a pending recovery needs the durable cessation proof bound to its own
  attempt. Without it (waiting up to 60 s) the answer is 409 `cessation_unverified` and the app stays open, with `execution.state`
  `stopping` ("Stopping a job; not confirmed yet") and lending still fenced; a later Quit succeeds once removal is proven.
- POST /api/handoff: {}; returns {url}, a one-time sign-in link for the browser (the tray uses it, so no long-lived token is in a URL).
- POST /api/desktop/tray: {tray:boolean}; the tray helper reports whether the desktop has a status area (Linux).
- POST /api/desktop/pin-prompt: {}; marks the one-time Windows pin prompt as shown.
- POST /api/lending/stop: {attemptId,confirmed:true}; stops this exact current local attempt.
  The web app displays "Stop this job" while busy and confirms:
  "The job stops now. The person who asked will see it was stopped."
  Missing confirmation/invalid fields return invalid_request (400); a stale attempt, no active
  execution, or an attempt already committing its result returns no_current_job (409).
  Lending is disabled and saved before aborting. The response acknowledges the stop request,
  not sandbox removal. Follow lending events/status for stopping, cessation_unverified,
  stop_report_pending or stopped. The executor's abort path cancels and destroys the sandbox;
  release with reason {"code":"stopped_by_lender"} and /stopped are sent only after a
  cleanupReceipt.removed:true or attempt-bound backend recovery proof. Unknown removal keeps
  the reservation and blocks new work. Persisted stop intent/proof and report idempotency keys
  survive restart; report failures are retried without treating abort as cessation evidence.
  The borrower's job view (GET /api/jobs/:id) therefore shows state queued (or failed when no attempts
  remain) with current_attempt.state 'released' and current_attempt.reason '{"code":"stopped_by_lender"}'.
  The web app reads that to say the lender stopped the job. The lender writes the reason, so it is
  treated as the lender's statement, not as proof of anything else.
  If cancellation, expiry or supersession already fenced the attempt, a fresh verified queue
  view permits /stopped after removal proof; its existing terminal reason is preserved.
  Starting the app's lending loop to recover a saved stop keeps enabled:false, including on disk.
  After recovery completes, a separate /resume can enable new work.
  Stop retains the conservative reserved daily budget. Lending remains paused afterward;
  resuming is a separate explicit action. A confirmation is bound to the displayed attempt,
  so a delayed click cannot stop the next job. Result publication already in progress cannot
  be retracted by this endpoint.
- POST /api/lending/limits: a subset of dailyJobs, dailyMinutes, maxWallSeconds, quotaReserve,
  idleOnly, timeZone, lendingPolicy. Defaults: no daily job or minute cap, no fixed wall-time cap,
  30% reserve, a per-job quota cap of 10% of the weekly allowance, idle-only off, stop-on-return off, the computer’s time zone. Presence settings are opt-ins; account-wide provider readings include the owner’s concurrent use. Once a usable reading shows the cap or reserve floor has been reached, Faravan requests a stop within its 145-second app control budget. Jobs admitted from an older cached reading have a 235-second startup app control budget until the first live read. Provider reporting lag can delay the reading by an amount Faravan cannot bound. These budgets do not guarantee when the job stops running. Its hold lasts until the meter shows its use or the weekly reset. Limit edits while busy fail.
- POST /api/lending/mode: {circle,mode:"ask"|"auto"}. Both choices are audited, including Ask without any rule to revoke. New owned circles default to automatic when rule capacity permits. On upgrade, owned circles without a mode or rule stay on Ask and get a pending choice; missing saved state is not consent.
  Automatic work requires fresh quota evidence. Idle evidence is required only when idle-only lending is enabled, enforced by createLender.
- POST /api/lending/prompts/dismiss: {circle}. Hides a pending choice for this app process, across clients, page loads and polls. It returns at the next app start unless a mode or rule has since been saved. At 100 standing rules, defaulting is skipped and atRuleLimit is true; remove a rule before choosing automatic.
- GET /api/lending/history-learning: {enabled}. Learning from local Claude Code and Codex logs is on by default and imports
  automatically without a prompt. POST /api/lending/history-learning: {enabled}. Turning it off deletes imported scores and
  samples and keeps meter records.
- GET /api/lending/owner-settings: the saved per-job lending limit ({maxJobUsd, weeklyOverrunPoints, shortOverrunPoints}, null when unset)
  and its audit trail. POST /api/lending/owner-settings: {maxJobUsd (USD, above one worst-case call), reason}. Unset means the runtime
  default of $4 applies when it covers one call. For a Claude model whose worst-case call costs $4 or more, the unset default is that call allowance plus $4 for useful work ($9.28 for the default model at current catalog prices). A saved cap is always used exactly. Changes are audited with the value they replace. Available only with the internal pace-50 option.
- GET /api/lending/presence: jobs the owner allowed to run while present that are still usable, and the audit trail.
  POST /api/lending/presence/allow-once: {digest (sha256:<64 hex>), reason, minutes (1-30, default 15)}. One named job, spent by its
  own admission, expiring. Nothing else is allowed. Available only with the internal pace-50 option.
- GET /api/lending/window-origins: the window records (lent, or opened by the owner) and the open short windows the lender saw recently.
  POST /api/lending/window-origins/attest: {instance, reason}. The owner attests a window the lender saw open recently; a window a lent
  job opened cannot be attested. Available only with the internal pace-50 option.
- GET /api/approvals: review cards with id, verified requester key (the UI resolves the roster device_name and shows a key code), circle/job, source reference with archive artifact.bytes, full prompt,
  source reference, harness, model options, runtimeSeconds, network, credentialInGuest, startsNow and
  protection. Protection is evaluated for this card's exact requirements, not just app defaults.
  Manual acceptance says it starts now even while using this computer. Each card also has `allowance`
  ({remaining, checked_at}: the whole week's Claude allowance as last read, omitted as null when unknown,
  older than 5 minutes or for another provider) and `friendMinutes` (minutes Faravan counted for friends in
  the last 7 days, null when the local log is unreadable). Neither is a share of this job.
  Approval cards, job list/detail items and `job` events carry `safety`: {network:{mode,registries,git,kit_hosts}, provider,
  provider_hosts, credential_in_guest, credential_proxy_verified, boundary_verified, budget_minutes,
  quota:{remaining}}. These are facts only. A value that is unknown or unsupported is null, and
  `credential_proxy_verified` is true only on a passing S5.2 record for this exact adapter, Faravan and sbx version
  (`docs/security/credential-proxy-test.md`); otherwise false, and null with no adapter. `network.git` is true when the
  code comes from a Git repository (false for an archive, null when unknown): GitHub is then reachable while the
  lender's sandbox fetches the code. This build denies it again before the agent starts, unless the agent's provider
  hosts include GitHub; the result receipt's `network_scope` (`clone_only` or `whole_run`, absent from an older lender)
  is the lender's record of which. `network.kit_hosts` lists the hosts the agent's own kit allows beyond the provider (the
  adapter's declaration; null when none is declared); the receipt's `kit_hosts` has the real ones. A view must not say "provider only" for a Git job without that. Borrower views leave the
  lending computer's `boundary_verified` and `quota.remaining` null.
- POST /api/approvals/:id/accept or /decline: {}. Accept freshly rechecks protection before resolving the
  approval; missing/unsatisfied evidence returns protection_not_ready (409) and updates the card.
  The lender also rechecks policy after acceptance.
  Decline sends one coordinator decline for an unclaimed modern offer (host capability `offer_decline_v1`); the host persists this device's refusal, excludes it from offers and claims, and leaves the job available to other lenders. On a legacy held approval it releases the attempt without cancelling the borrower's job. `Not now` is a UI-only deferral: no HTTP request or persisted decision.
  The compatibility `/skip` route keeps its prior behavior: hide a modern offer locally until expiry, or release a legacy attempt. Paired-device dismissal still uses it.
- Mutating requests that use the network run one at a time and each stops after 30 seconds
  (`timeout`, 504; `mutationTimeoutMs` option). Local safety actions (lending pause/off/stop/resume
  while lending exists, approval skip) do not wait behind them. Shutdown aborts the one in flight.
- GET /api/jobs?circle=ID: job array using the shared borrower operation/status vocabulary.
- GET /api/jobs (without circle): jobs this device submitted or ran across its circles,
  newest submission first, with each existing job projection extended by circle:{id,name}
  and role:'sent' or 'ran'. Self-run jobs appear once with role:'sent' and ran:true;
  other executed jobs also carry ran:true. Review, acceptance or skipping alone does not count.
  Ownership comes from local signed submit intents. Execution comes from retained local
  run/runtime/delivered contributions or a verified current attempt held by this device
  with execution_observed_at. Submission time uses the local intent for sent jobs and the
  verified signed job for lender jobs. No matching jobs returns [].
  Only currently visible circle job projections are included; contributions do not grant
  access or restore pruned server jobs. Prompt/result contents are not added. Explicit-circle
  lists and per-job access remain unchanged.
- POST /api/jobs: {circle?,prompt,harness?,model?,egress?,result?,budget_v1?,repo? | git? | files? | noSource?}. `budget_v1` is the signed requester's list-price ceiling (`{max_list_usd}` with a whole-dollar value from 1 to 100000, optionally with `effort`). Automatic lending uses this signed ceiling as its request-side value evidence and subtracts the selected model's worst-call headroom before execution.
  Choose exactly one source: `repo:{path,includeUncommitted?}` for a Git folder on this computer;
  `git:{url,commit}` for an HTTPS Git URL and full commit; `files:[{path,base64}]`; or `noSource:true`
  to start in an empty folder. No source field is an error, not an empty-folder request.
  `result:{kind:"branch"|"files"|"message"}` chooses the primary result. Empty-folder jobs require
  message or files. Branch is the default for existing source jobs and retains the legacy signed
  encoding. Message/files jobs require the host and lender to support `results_v1`; an older host
  refuses with `host_too_old`. The signed source for `noSource:true` is exactly `{kind:"none"}`.
  A local folder path (`source`) is rejected with invalid_request. The server drops secret-looking
  uploaded files (lib/v1/secret-files.mjs: environment files, private keys and certificate bundles,
  .ssh/.aws/.kube directories, .npmrc, .netrc, .git-credentials, .pypirc, kubeconfig; case-insensitive)
  and lists their paths in `excluded`; an upload with nothing left is rejected. Uploads permit at most 1,000 files and 20 MiB decoded bytes;
  absolute paths, traversal, backslashes, duplicate names and malformed base64 are rejected.
  Prompt-file paths are not accepted over HTTP. Returns {jobDigest,operationKey} plus excluded:[path] for uploads.
- GET /api/jobs/:digest?circle=ID: projected verified status.
- GET /api/jobs/:digest/transcript?circle=ID: {text,live,truncated}. This lender's live tail is
  bounded to 256 KiB; completed remote transcript is verified before display.
- GET /api/jobs/:digest/progress?circle=ID&after=N: {entries:[{seq,at,step,kind}],nextAfter}. Coarse steps the
  lender sent for a job this device sent or ran (optional channel; empty when the coordinator has none).
  `after` is the last `seq` already shown.
- POST /api/jobs/:digest/cancel: {circle?}; response preserves compute_stopped versus Stop requested.
- GET /api/jobs/:digest/changes?circle=ID: a branch result keeps the existing diff view. For a
  message/files result, returns `{format,message:{markdown,truncated,url},files,more_files,warning}`.
  The primary text is the final assistant message from the verified signed transcript. The preview
  is limited to 256 Ki characters; `message.url` downloads the full Markdown. Each file has
  `{path,bytes,url,text?,truncated?,preview?,download_only?}`. Only regular files under `faravan-output/` are listed.
  Text previews are limited to 32 KiB per file and 512 KiB total, with at most 200 listed files.
  A file above 16 MiB is download-only. If the preview scan exceeds 64 MiB expanded or 2,000
  archive entries, the verified final message is still returned with `download_only:true` and a
  download action for the files. Unsafe archive paths, links and malformed entries are still refused.
  PNG, JPEG, GIF and WebP previews require at most 4,096 pixels per edge and 4,000,000 pixels,
  and encoded bytes below 10 MiB. GIF frames share the pixel budget and are limited to 100;
  APNG and animated WebP are download-only. Previews load on request, with at most two open;
  hiding a preview or leaving the page releases its object URL. Raw HTML and remote images in Markdown
  stay inert; links permit only HTTP(S) URLs and fragments.
- GET /api/jobs/:digest/message?circle=ID: downloads the full final assistant message as `message.md`.
- GET /api/jobs/:digest/file?circle=ID&path=faravan-output/NAME: downloads one verified regular
  output file as an attachment. Unsafe archive entries and paths outside the output folder are refused.
- GET /api/jobs/:digest/image?circle=ID&path=PATH: previews an added image from a branch diff, or
  a raster image under `faravan-output/` from a message/files result. Responses use `nosniff` and
  a sandbox content policy. Tree results do not inline SVG or HTML.
- GET /api/jobs/:digest/result?circle=ID: verifies signed result and both artifact hashes;
  returns a patch or bounded ZIP converted from the verified gzip result using the existing extractor.
  Every typed-result entry must be under `faravan-output/` before any write. A typed result that
  exceeds ZIP-conversion limits downloads as the original `.tar.gz`, after complete archive safety
  and namespace validation. Signature verification never substitutes for these checks.
- GET /api/jobs/:digest/changed-files?circle=ID: for a job sent from this computer with an archive source,
  rebuilds the verified patch against the sent source artifact in a disposable directory. Downloads a
  bounded ZIP of added and modified regular files. Deleted files are omitted. Unsafe paths and symbolic
  links are refused. The original source folder is never read or changed.
- POST /api/jobs/:digest/open-folder: {circle?,out?}; verifies and materializes result, returning
  {status,preview,path}. This returns a path; it does not launch the desktop file manager.
- GET /api/readiness: {ready,checks:[{name,ok,label,remedy}],protection}; raw diagnostics are omitted.
  Uses default job requirements (CPU, memory, wall and output required; disk preferred).
  protection contains source:"read-only-preflight", backend_id, observed_at, sandbox_ready,
  version_gate:{ok,status}, egress:{requested,enforceable,source_enforceable,source_reason},
  limits:{required,preferred,enforced,unenforced,satisfied}, satisfied and disclosure.
  Limit lists use protocol names (cpu, memory_bytes, wall_seconds, disk_bytes, output_bytes).
  source:"unavailable" and satisfied:false mean no explicit backend evidence. Missing requirements
  limit_modes entries mean required. Preferred gaps remain listed without blocking readiness.
  This is preflight evidence, not proof of real isolation or a guarantee about a future execution.

## Persistence, shutdown and recovery

The native status icon discovers the app through `<home>/v1/app.json`, where home follows
FARAVAN_HOME and configHome(). After the IPv4 loopback listener is ready, the app atomically
publishes {port,token,pid,started_at}; started_at is an ISO timestamp. The private temporary file
is mode 0600, fsynced, renamed, then its directory is fsynced. Clean close removes only this
instance's matching record before releasing app.lock; a replacement record is preserved.
The token is a local session secret. Clients check process liveness, pin requests to loopback,
use x-faravan-session-token, and must not follow redirects with that secret.
A live v1 record takes precedence over v0 even if its API is unreachable. Only a missing or
confirmed stale v1 record permits v0 fallback or the Start Faravan action.

Private app-settings.json and app-counters.json live below the v1 home. Writes fsync the private
temporary file, rename, then fsync its directory. A per-home app.lock prevents multiple active
app lenders. Counters apply across circles; pending claims/results are bound to their original circle.
Pending decline retries are also bound to that circle. Declined jobs remain locally excluded until
their deadline, with at most 64 retained digests. A full exclusion set pauses new claims and produces
the attention label "You skipped many jobs; new ones will appear as old ones expire" with a waiting
remedy. Declines back off at least three seconds. Local policy is checked before claiming, and the
execution-start protocol transition is required immediately before the backend's first start.
Pre-execution release does not spend the borrower's execution-attempt budget.
Lending that was on resumes after a restart for the saved circle, after checking the lent agents
when evidence is missing or stale (unless resumeLending:false). The persisted intent is on or off,
  migrated from legacy enabled. Readiness still gates startup. A saved safety failure forces
  Blocked until explicitly resumed, including after restart. Effective state is never persisted.
If resuming fails, Home says "Lending didn't turn back on after Faravan restarted."
Saved stop recovery keeps lending off and requires a separate /resume. Interrupted result delivery
and uncertain cessation remain recoverable through the same circle, never replayed elsewhere.
Shutdown rejects new mutations, drains in-flight mutation work, aborts/awaits the lender, closes SSE
and the HTTP server, then releases its lock. An unclean process exit can leave app.lock; no stale-lock
takeover is attempted automatically.

## Integration and honest UI gaps

The stock DockerSbxBackend is instantiated by default. Its protection summary uses read-only
doctor/version preflight and explicit limit/egress admission. Disk remains unenforced; preferred
disk requests can pass, but required disk requests cannot. Pinned Git execution must verify HEAD
against the requested commit. Provider-only Git remains blocked unless the trusted adapter permits
the source host and the current Git admission guard is satisfied; Faravan never broadens egress
to make cloning succeed. Per-job protection includes this source-egress check. Advertised resource
maxima are parser/admission bounds, not measurements of available host capacity. Fake tests do not prove real Docker isolation, provider execution
or credential behavior. Missing or failed protection evidence is never relabelled ready.

Adapter detection uses probeFaravanIdentity through the source-controlled harness registry,
on explicit refresh and the lending background/restart checks above. Unlike doctor preflight, this observational probe has disposable
sandbox creation/destruction side effects. It checks binary presence in the execution template,
not host CLI installation. It never invokes the repairing capability probe, sign-in or a model.
Status output is parsed into per-harness installed/signedIn evidence. For Codex, the probe reads
only SBX_CRED_OPENAI_MODE (oauth/apikey, none, or unknown); guest login-status output alone cannot
establish authentication because the sandbox uses an API-key-shaped proxy sentinel. This reports
configured authentication evidence, not a successful live provider request. In all cases, raw output, Docker account
and exceptions are not returned. Sign-in runs only through the explicit /api/signin routes; no implicit browser launch, provider-terms
gate or account-eligibility gate is added. Agent choices cannot override backend limits or
unknown quota/idle evidence. GET /api/agents reads cached identity without running a probe.

Only one lender context runs in-process. A different circle cannot replace an existing lender;
pause/stop and restart the app before selecting another context. Pending recovery must complete
in its original circle first. This conservative limitation is explicit rather than moving an active job.
Job list/status uses the established borrower vocabulary; live local lending events provide Running
and Sending the result information. Remote live transcript transport is not invented.
Source review currently includes verified source kind/digest/size or Git URL/commit, not an archive
filename preview. Cached member rosters require normal circle operations to refresh.
SSE history is bounded and not durable; reconnecting after a process restart requires a full refresh.
The v1 web app is served from public/v1 at GET /. Static assets retain the same Host, token and
Origin checks as the API, with no-store and no-referrer headers. Only recognized HTML, JavaScript,
CSS and SVG file extensions are served; mutations and traversal paths are rejected.
The first page may carry ?token=. A CSP-hashed inline bootstrap removes it from the address bar,
keeps it in the tab's sessionStorage, fetches the self-contained JavaScript and CSS with
x-faravan-session-token, then imports the module through a short-lived blob URL. Asset URLs never
contain the session. The page uses header-authenticated fetch SSE with polling fallback.
Reloading the tab keeps working: GET / and GET /index.html return the static shell without a token
(Host is still checked), and the bootstrap reads the saved session. A 401 on an asset deletes the
saved session, so a stale tab asks for the local app link again. Drafts and file selections are
memory-only.

Security tradeoff: sessionStorage is scoped to one tab and one origin (127.0.0.1 plus port), is
cleared when the tab closes and is never sent to the server, in a URL or in a cookie. Script from
the app's own origin can read it, but that script already holds the token in memory, and the CSP
allows only the hashed bootstrap and blob scripts. localStorage and cookies are not used because
other tabs and requests could reach them. The shell is identical on every install and holds no
data, so serving it without a token reveals nothing; every asset and API path still requires the
header token, the Host check and the Origin check. Another tab opened from this one with
window.open can inherit a copy of the session, the same as a duplicated tab.
The UI explicitly discloses unavailable pairing, sign-in for unsupported agents, independent protection proof,
remote-live transcript transport, granular network inference, safe apply and pull-request creation.
Manual Accept requires the review's satisfied, per-job protection evidence; app-wide readiness alone
does not constitute that evidence. The HTTP Accept endpoint independently refreshes that evidence. Submit uses provider-only egress, and ambiguous POST outcomes
are not retried automatically because repeated submission can create a second job.

faravan app [--port PORT] prints the token-bearing local URL and keeps the service running.
FARAVAN_NO_BROWSER suppresses an embedding-provided openUrl callback. Without that callback
the CLI prints the URL only. No test opens a browser.

## Known limits

The three recovery limits reported by the independent v1 review (H2, H3,
H4) were fixed in the lower layers (commit 6745a55): a definitive
completion rejection ends the retry and claiming resumes; a committed
claim the client rejects is released and replaced with a fresh key;
missing roster epochs are fetched and verified on demand. A pending
completion older than ten minutes still surfaces "A finished job could
not be delivered; Faravan keeps retrying" while transient failures
continue.

## Support export

`POST /api/ops/diagnostics.preview` with `{}` prepares a local support archive in
memory. It requires the same local authentication as other app operations. The
response has `filename`, `bytes`, `archiveBase64` and one `entries` item whose
`name` is `support.json` and whose `body` is the exact JSON in the archive. Preview
and save must use this same response; a save must not collect again. The operation
saves no archive and uploads nothing; the app first updates its sanitized readiness
cache on disk. It makes no coordinator request. It also runs without
the app through the CLI operation handler. It is not offered through MCP.

The [support schema](../support/diagnostics.schema.json) is the closed allowlist.
See [support exports](../support/troubleshooting.md) for fixed input paths, bounds,
unknown states and the interactive `faravan diagnostics export` command.
