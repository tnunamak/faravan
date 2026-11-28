# Agent interfaces: one operation layer, four surfaces

Status: implemented (2026-10-19). Code: `lib/v1/ops/`. How to connect a client: [docs/agents.md](../agents.md).

Faravan can be driven completely by an AI agent or a script. Every action a person can take in the
web app is one **operation** in a registry, and each operation is exposed, with the same name, input
and result, as:

| Surface | Form | Example |
|---|---|---|
| HTTP | `POST /api/ops/<id>` on the local app (plus the REST route it is bound to) | `POST /api/ops/lending.on` |
| CLI | `faravan <group> <verb> [--json]`, `faravan ops call <id>` | `faravan lending on --yes --json` |
| MCP | a tool per operation on `faravan mcp` (stdio), except those the registry excludes with `mcp.excluded` and a reason; read operations also as resources | `lending_on` |
| Web UI | the REST route the operation is bound to | the Lend page's switch |

The registry also generates the OpenAPI document (`docs/protocol/app-openapi.json`,
`GET /api/openapi.json`) and the parity matrix at the end of this file.

ChatGPT can use the same registry over OAuth-protected Streamable HTTP with `faravan connect chatgpt`.
The public tunnel targets a separate allowlisted listener, with local owner consent, read/act scopes,
bounded responses and revocation. It excludes human-only operations and the local login-link operation.
See [Connect ChatGPT](../connect-chatgpt.md) for setup, limits and verification.

## Why this shape

Surveyed: Stripe, GitHub, Tailscale, Supabase, Vercel, Cloudflare, Linear, Home Assistant, Kubernetes, Ollama
and MCP (annotations, elicitation, Tasks, client support).

- No surveyed product generates every surface from one schema. What works is one authoritative layer,
  a generated contract, and hand-curated workflows on top (Stripe's CLI says so in its own architecture
  file). Faravan does the same: the registry is a table of declarations, and a few operations are
  hand-written workflows (`status.blockers`, `jobs.send_and_wait`, the `*.wait` operations).
- The app's REST routes already were the engine boundary: they hold the lending loop, approvals and
  sign-in flows that live in the app process. An operation is **bound** to its route rather than copying
  its logic, so the UI, HTTP, CLI and MCP run the same code. `POST /api/ops/<id>` calls the bound route
  on the same loopback server; field names are the route's own.
- Operations that need no app (`lending.log`, `doctor.run`, `uninstall.plan`, `app.info`, `hosting.*`)
  have a handler that runs in whichever process calls it.
- Not built: a generated UI, MCP Tasks (no client ships them by default, per the MCP research), a code-execution
  MCP mode, or a second policy language.

## The registry

`lib/v1/ops/registry.mjs`. Each operation declares:

| Field | Meaning |
|---|---|
| `id` | `group.verb`, stable. CLI: `faravan group verb`; MCP: `group_verb`; HTTP: `POST /api/ops/group.verb` |
| `title`, `description` | Human text, also the tool description |
| `input`, `output` | JSON Schema (a small subset, validated by `lib/v1/ops/schema.mjs` on every surface) |
| `safety` | `read`, `write`, `consequential` or `human` (below) |
| `idempotency` | `safe` (repeat-safe), `key` (takes an idempotency key) or `none` |
| `rest` | the bound route: method, path with `{params}`, optional fixed body fields |
| `handler(ctx, input)` | instead of `rest`: local work, or a workflow over `ctx.call(otherOp)` |
| `confirm(input)` | for consequential operations: the effect, in one sentence, shown before it runs |
| `long`, `untrusted` | long-running; result holds text from another person's computer |
| `cli.legacy`, `mcp.legacy`, `mcp.resource`, `ui` | the older names and UI screens, for the matrix |

`runOp()` (`lib/v1/ops/execute.mjs`) is the one execution path: validate input, refuse a consequential
operation without confirmation, run the route or handler, and (with `FARAVAN_OPS_STRICT=1`, set in
tests) validate the output against its schema.

## Safety classes and confirmation

| Class | What it covers | CLI | HTTP | MCP |
|---|---|---|---|---|
| read | changes nothing | runs | runs | `readOnlyHint: true` |
| write | local changes, or work that is easy to stop (agent checks, a sign-in flow) | runs | runs | `readOnlyHint: false`, `destructiveHint: false` |
| consequential | acts for the person in a way that reaches other people or is hard to undo: send a job, lending on or resume, approve a job, select an agent for lending, auto mode, stop a running job, cancel or delete a job, apply a branch, join a circle, admit or remove a computer, open-join mode, leave a circle, host or stop hosting, quit; and `limits.set` when it switches a circle to auto | `--yes`, or typing `yes` at a terminal; else exit 6 | header `Faravan-Confirm: yes`; else `428 confirmation_required` with `effect` | `confirm: true` argument; if absent and the client supports elicitation, the server asks the person; else `confirmation_required` with `effect`. `destructiveHint: true` |
| human | uninstall | `faravan uninstall` only | `403 human_only` | not offered |

Confirmation is a guard against an agent's mistakes, not access control: the app has one principal
(the person who owns the computer), and anyone with the session token can call the REST route directly.
MCP annotations and elicitation are hints that clients may ignore or auto-answer (Claude Code hooks,
Codex `approval_policy="never"`); the research notes Supabase's warning that elicitation is not
guaranteed human approval. The web UI keeps its own confirmation dialogs on the same routes.

## Long-running operations

Jobs, sign-in flows, agent checks and the doctor keep running on their own;
they are durable resources with an id, and a caller can always come back.

| Work | Start | Poll | Wait (bounded) | Stop |
|---|---|---|---|---|
| Job | `jobs.submit` | `jobs.get`, `jobs.progress`, `jobs.transcript` | `jobs.wait` | `jobs.cancel` |
| Job, one call | `jobs.send_and_wait` (submit, wait, return the changes) | | | |
| Sign-in | `signin.start` (returns a URL for the person) | `signin.get` | `signin.wait` (`until: browser\|done`) | `signin.cancel` |
| Agent check | `agents.check` (synchronous, about a minute; 504 `agent_check_timeout` if longer) | `agents.list` | | |
| Doctor | `doctor.run` (synchronous, up to a few minutes) | | | |
| Everything | | `events.list` (cursor, optional long-poll) | `events.list --follow` (CLI NDJSON), `GET /api/events` (SSE) | |

Every wait takes `timeout_seconds` (0 to 300, default 50, because Codex gives an MCP call 60 s by default)
and answers `{done, ...}`: `done: false` means still running, not failed. Each read inside a wait is bounded
too, so a stalled app cannot hold a wait past its deadline, and every call to the app has a 15-minute limit. The CLI exits 5 then. MCP
wait tools send `notifications/progress` when the request carries a `progressToken`. MCP Tasks are not
used: Claude Code ships them behind a flag that is off by default, and Codex has none (see the research entry).

## Idempotency

- `safe` operations (most of them) give the same outcome when repeated: on/off, set-to-value, accept
  of an approval that is already answered (`not_found`).
- `Idempotency-Key` (HTTP header, CLI `--idempotency-key`): the app remembers the first answer, success
  or failure, for 24 hours after completion per operation and key, in memory (an app restart forgets it). It never forgets a
  request that is still running; with 500 unexpired or running keys held it refuses new keyed requests
  (`503 idempotency_busy`). A repeat with the same input returns it with
  `Idempotent-Replayed: true`; a different input is `409 idempotency_key_reused`. The CLI and MCP send
  their app operations through `/api/ops`, so one cache serves every surface.
- `jobs.submit` and `jobs.send_and_wait` also turn a key (8-64 of `A-Za-z0-9-`) into the job's
  `draft_id`, which the app stores durably: a retry after an app restart still returns the same job.
- `none`: `circles.create`, `circles.invite`, `app.open_link`, `signin.submit_code`. Use a key to retry them safely.

## Output contract

- HTTP and `--json` print the operation's result, exactly. Errors are `{code, message, ...detail}`;
  `code` is stable, `message` is for people. Extra detail fields: `field` (invalid input), `effect`
  (confirmation), `apply_code`, `repo_code`, `state`, `warning`.
- MCP returns the same value as `structuredContent` (an array result is wrapped as `{items}`) and as
  JSON text. Results holding another person's text (`jobs.transcript`, `jobs.changes`, `jobs.result`,
  `approvals.list`, `jobs.send_and_wait`) are wrapped in `<untrusted-result-from-another-computer>`.
- Output objects may gain fields; they never lose or rename one within version 1.
- CLI exit codes: 0 ok, 1 failed, 2 invalid input, 3 not found, 4 refused or conflict, 5 still running
  or timed out, 6 needs `--yes`, 7 app not running, 8 only a person can do this. Progress lines go to
  stderr; stdout is only the result.

## Authentication

The app listens on 127.0.0.1 only, checks the Host and Origin headers, and needs its session token
(`x-faravan-session-token`). The token is in `<FARAVAN_HOME>/v1/app.json` (default `~/.faravan/v1/app.json`,
mode 0600), written when the app starts. The CLI and the MCP server read it there, so an MCP client
needs no secret in its configuration: it runs `faravan mcp` as the same user. If the app is not
running they start it in the background (no browser); `FARAVAN_NO_AUTOSTART=1` makes them answer
`app_not_running` (exit 7) instead. The MCP server never forwards a client's token anywhere.

MCP folder roots: operations that name a folder on this computer (`jobs.submit` `repo.path`,
`jobs.apply` `repo`, `repo.inspect`) accept only folders inside `--root` folders
(default: the folder the server starts in), after following symlinks. Source operations accept
Git and plain folders. Applying changes and the original `submit_job` still require Git.
The checked real path, not the client's text, is what reaches the app, which runs with its own working directory.

## Versioning

`OPS_VERSION` is 1 (`Faravan-Ops-Version` header, `GET /api/ops`). Operation ids are stable. Additive
changes (a new operation, a new optional input, a new output field) keep the version. A breaking change
gets a new operation id and the old one stays until the next major version. The MCP protocol versions
are 2025-11-25 and 2025-06-18.

## Tool list size

The operations offered on MCP plus the five original job tools fit within 64 KiB without
output schemas. Claude Code defers MCP tools behind tool search, so this
costs little there; other clients load them all. `faravan mcp --toolsets` narrows it: `borrow`, `lend`,
a list of groups, or `meta` (3 tools, about 1.5 KB: `ops_list`, `ops_describe`, `ops_call`).
`--read-only` keeps only read tools. `--output-schemas` adds output schemas (about 76 KB). A test
holds the budget.

## Tests

- `tests/v1-ops.test.mjs`: every operation is well formed; validation; route bindings; confirmation on
  every surface; `/api/ops` against a real app (same answers as the REST routes, 428, idempotent replay,
  key reuse); the committed OpenAPI equals the generated one.
- `tests/v1-ops-parity.test.mjs`: fails when an operation lacks a CLI, HTTP or MCP exposure, when a
  documented app route or a route the web UI calls has no operation, when the MCP input schema or CLI
  flags drift from the registry, or when this file's matrix is stale; holds the tool-list budget.
- `tests/v1-ops-e2e.test.mjs`: two real app instances (temporary homes, synthetic sandbox backend, real
  loopback coordinator) driven only through MCP (lender) and the CLI binary (borrower): blockers,
  limits, agent selection, lending on with confirmation, sending a job, approving it, waiting, reading
  its changes.

## What is left

- The REST routes still live inline in `lib/v1/app.mjs`. Moving each route body into its operation's
  handler (so the registry becomes the engine and the REST route a thin alias) is the next step, done
  route group by route group while other lanes edit `app.mjs`.
- The web UI still calls REST routes, not `/api/ops`; both run the same code, so this is cosmetic.
- `GET /api/jobs/{digest}/result` (binary download) is a UI-only route; agents use `jobs.result`, which
  unpacks the same verified result to a folder.
- The coordinator protocol (`docs/protocol/v1.md`) is another plane (device to circle server) and is not
  part of this registry, the way Tailscale's tailnet API is not its local API.
- `update.check` / `update.apply` (tarball self-update) are CLI-only (`faravan update`).

## Parity matrix

<!-- GENERATED:parity-matrix (npm run gen:ops) -->

| Surface | Before the registry | After |
|---|---|---|
| UI (web app or tray) | 129 of 141 | 129 of 141 (unchanged; the UI calls the bound routes) |
| CLI | 23 of 141 | 141 of 141 |
| HTTP | 118 of 141 (REST routes) | 139 of 141 (`POST /api/ops/<id>`; the 118 REST routes still work) |
| MCP | 5 of 141 | 123 of 141 |
| All four | 4 of 141 | 123 of 141 on CLI, HTTP and MCP (2 human-only: CLI only; 16 excluded from MCP: CLI and HTTP) |

Before: UI screen, CLI command, REST route and MCP tool that existed before the registry. After: generated names. A dash means none.

| Operation | Safety | UI | CLI before | REST route (HTTP before) | MCP before | CLI | MCP tool |
|---|---|---|---|---|---|---|---|
| `sandbox.repair_owner` Repair sandbox service ownership | consequential | - | - | - | - | `faravan sandbox repair-owner` | `sandbox_repair_owner` |
| `command_path.status` Command-line tool status | read | Setup | - | - | - | `faravan command-path status` | `command_path_status` |
| `command_path.install` Install command-line tool | write | Setup | - | - | - | `faravan command-path install` | `command_path_install` |
| `command_path.uninstall` Remove command-line tool link | write | Setup | - | - | - | `faravan command-path uninstall` | `command_path_uninstall` |
| `update.status` Update status | read | Settings, Tray | - | `GET /api/updates` | - | `faravan update status` | `update_status` |
| `update.check` Check for updates | write | Settings, Tray | - | `POST /api/updates/check` | - | `faravan update check` | `update_check` |
| `phone.status` Device access status | read | Settings | - | `GET /api/phone` | - | `faravan phone status` | `phone_status` |
| `phone.pair_start` Start pairing a device | write | Settings | - | `POST /api/phone/pairing` | - | `faravan phone pair-start` | `phone_pair_start` |
| `phone.revoke` Remove a paired device | consequential | Settings | - | `POST /api/phone/phones/{id}/revoke` | - | `faravan phone revoke` | `phone_revoke` |
| `desktop.autostart` Set start at login | write | You | - | `POST /api/desktop/autostart` | - | `faravan desktop autostart` | `desktop_autostart` |
| `accounts.list` Agent accounts | read | Settings | - | `GET /api/accounts` | - | `faravan accounts list` | - |
| `accounts.enroll` Add an agent account | write | Settings | - | `POST /api/accounts` | - | `faravan accounts enroll` | - |
| `accounts.flow` Account sign-in status | read | Settings | - | `GET /api/accounts/flows/{id}` | - | `faravan accounts flow` | - |
| `accounts.complete` Finish an account sign-in | write | Settings | - | `POST /api/accounts/flows/{id}/complete` | - | `faravan accounts complete` | - |
| `accounts.cancel` Cancel an account sign-in | write | Settings | - | `POST /api/accounts/flows/{id}/cancel` | - | `faravan accounts cancel` | - |
| `accounts.remove` Remove an agent account | consequential | Settings | - | `POST /api/accounts/{id}/remove` | - | `faravan accounts remove` | - |
| `accounts.settings` Agent account settings | write | Settings | - | `POST /api/accounts/{id}/settings` | - | `faravan accounts settings` | - |
| `status.get` Lending status | read | Home | - | `GET /api/status` | - | `faravan status get` | `status_get` |
| `status.blockers` What blocks lending | read | Home, Lend | - | - | - | `faravan status blockers` | `status_blockers` |
| `status.borrowing` What blocks borrowing | read | Home, Borrow | - | - | - | `faravan status borrowing` | `status_borrowing` |
| `events.list` Activity events | read | Activity | - | - | - | `faravan events list` | `events_list` |
| `cleanup.retry` Clean up now | write | Lend, Tray | - | `POST /api/cleanup/retry` | - | `faravan cleanup retry` | - |
| `readiness.get` Readiness checks | read | Setup, Lend | - | `GET /api/readiness` | - | `faravan readiness get` | `readiness_get` |
| `doctor.run` Sandbox doctor | write | - | `faravan doctor` | - | - | `faravan doctor run` | `doctor_run` |
| `setup.sandbox_status` Sandbox installation | read | Setup | - | `GET /api/setup/install-sandbox` | - | `faravan setup sandbox-status` | - |
| `setup.install_sandbox` Install the sandbox | write | Setup | - | `POST /api/setup/install-sandbox` | - | `faravan setup install-sandbox` | - |
| `setup.cancel_sandbox` Cancel sandbox installation | write | Setup | - | `POST /api/setup/cancel-sandbox` | - | `faravan setup cancel-sandbox` | - |
| `setup.mark_step` Remember a setup step | write | Setup | - | `POST /api/setup/progress` | - | `faravan setup mark-step` | `setup_mark_step` |
| `setup.clear` Forget setup progress | write | Setup | - | `POST /api/setup/progress/clear` | - | `faravan setup clear` | `setup_clear` |
| `lending.get` Lending settings and state | read | Lend | - | `GET /api/lending` | - | `faravan lending get` | `lending_get` |
| `lending.readiness` Lending readiness checks | read | Setup | - | `GET /api/lending/readiness` | - | `faravan lending readiness` | `lending_readiness` |
| `lending.strategies` Lending strategies and the dial | read | - | - | - | - | `faravan lending strategies` | `lending_strategies` |
| `lending.set_circle` Choose the lending circle | write | Lend | - | `POST /api/lending/circle` | - | `faravan lending set-circle` | `lending_set_circle` |
| `lending.on` Turn lending on | consequential | Lend, Home, Setup | - | `POST /api/lending/on` | - | `faravan lending on` | `lending_on` |
| `lending.resume` Resume lending | consequential | Lend, Home | - | `POST /api/lending/resume` | - | `faravan lending resume` | `lending_resume` |
| `lending.off` Turn lending off | write | Lend | - | `POST /api/lending/off` | - | `faravan lending off` | `lending_off` |
| `lending.pause` Pause lending | write | Lend, Tray | - | `POST /api/lending/pause` | - | `faravan lending pause` | `lending_pause` |
| `lending.stop_job` Stop the running job | consequential | Lend, Home | - | `POST /api/lending/stop` | - | `faravan lending stop-job` | `lending_stop_job` |
| `lending.set_mode` Set approval mode | consequential | Lend, Home | - | `POST /api/lending/mode` | - | `faravan lending set-mode` | `lending_set_mode` |
| `lending.dismiss_prompt` Defer lending choice | write | Home | - | `POST /api/lending/prompts/dismiss` | - | `faravan lending dismiss-prompt` | - |
| `lending.set_rules` Set standing rules | consequential | Limits | - | `POST /api/lending/rules` | - | `faravan lending set-rules` | `lending_set_rules` |
| `lending.log` Lending problem log | read | Lend | `faravan lending log` | - | - | `faravan lending log` | `lending_log` |
| `lending.history.settings.get` Local agent log learning setting | read | Lend | - | `GET /api/lending/history-learning` | - | `faravan lending history settings get` | `lending_history_settings_get` |
| `lending.history.settings.set` Change local agent log learning | write | Lend | - | `POST /api/lending/history-learning` | - | `faravan lending history settings set` | `lending_history_settings_set` |
| `lending.history.import` Import local agent usage history | consequential | Lend | - | - | - | `faravan lending history import` | `lending_history_import` |
| `limits.get` Lending limits | read | Limits | - | - | - | `faravan limits get` | `limits_get` |
| `limits.set` Change lending limits | write | Limits | - | `POST /api/lending/limits` | - | `faravan limits set` | `limits_set` |
| `limits.set_requester` Limit one requester | write | Lend | - | `POST /api/lending/requester-limits` | - | `faravan limits set-requester` | `limits_set_requester` |
| `agents.list` Coding agents | read | Lend | - | `GET /api/agents` | - | `faravan agents list` | `agents_list` |
| `agents.check` Check agents | write | Lend | - | `POST /api/agents/refresh` | - | `faravan agents check` | `agents_check` |
| `agents.select` Use an agent for lending | consequential | Lend | - | `POST /api/agents/{id}` | - | `faravan agents select` | `agents_select` |
| `agents.set_run` Set agent model and effort | write | Lend | - | `POST /api/agents/{id}/run` | - | `faravan agents set-run` | `agents_set_run` |
| `signin.start` Start a sign-in | write | Lend, Setup | - | `POST /api/signin/{target}` | - | `faravan signin start` | `signin_start` |
| `signin.get` Sign-in status | read | Lend, Setup | - | `GET /api/signin/{flowId}` | - | `faravan signin get` | `signin_get` |
| `signin.wait` Wait for a sign-in | read | Lend, Setup | - | - | - | `faravan signin wait` | `signin_wait` |
| `signin.submit_code` Enter a sign-in code | write | Lend, Setup | - | `POST /api/signin/{flowId}/code` | - | `faravan signin submit-code` | `signin_submit_code` |
| `signin.cancel` Cancel a sign-in | write | Lend, Setup | - | `POST /api/signin/{flowId}/cancel` | - | `faravan signin cancel` | `signin_cancel` |
| `lending.decisions` Lending decisions | read | - | - | `GET /api/decisions` | - | `faravan lending decisions` | `lending_decisions` |
| `circles.set_agent_borrowing` Stop agents sending jobs | write | Circles | - | `POST /api/circles/{circle}/agent-borrowing` | - | `faravan circles set-agent-borrowing` | `circles_set_agent_borrowing` |
| `jobs.list` Jobs | read | Jobs | `faravan job list` | `GET /api/jobs` | - | `faravan jobs list` | `jobs_list` |
| `jobs.get` Job status | read | Jobs | `faravan job status` | `GET /api/jobs/{digest}` | `get_job` | `faravan jobs get` | `jobs_get` |
| `jobs.submit` Send a job | consequential | Borrow, Compose | `faravan job submit` | `POST /api/jobs` | `submit_job` | `faravan jobs submit` | `jobs_submit` |
| `jobs.wait` Wait for a job | read | Jobs | `faravan job wait` | - | `wait_job` | `faravan jobs wait` | `jobs_wait` |
| `jobs.send_and_wait` Send a job and wait for it | consequential | Borrow | `faravan run` | - | - | `faravan jobs send-and-wait` | `jobs_send_and_wait` |
| `jobs.cancel` Cancel a job | consequential | Jobs | `faravan job cancel` | `POST /api/jobs/{digest}/cancel` | `cancel_job` | `faravan jobs cancel` | `jobs_cancel` |
| `jobs.progress` Job progress | read | Jobs | - | `GET /api/jobs/{digest}/progress` | - | `faravan jobs progress` | `jobs_progress` |
| `jobs.transcript` Job transcript | read | Jobs | - | `GET /api/jobs/{digest}/transcript` | - | `faravan jobs transcript` | `jobs_transcript` |
| `jobs.receipt` How a job ran | read | Jobs | - | `GET /api/jobs/{digest}/receipt` | - | `faravan jobs receipt` | `jobs_receipt` |
| `jobs.changes` Job changes | read | Jobs | - | `GET /api/jobs/{digest}/changes` | - | `faravan jobs changes` | `jobs_changes` |
| `jobs.result` Unpack a job result | write | Jobs | `faravan job result` | `POST /api/jobs/{digest}/open-folder` | `read_result` | `faravan jobs result` | `jobs_result` |
| `jobs.apply_preview` Preview adding a job as a branch | read | Jobs | `faravan apply --dry-run` | `POST /api/jobs/{digest}/apply` | - | `faravan jobs apply-preview` | `jobs_apply_preview` |
| `jobs.apply` Add a job as a branch | consequential | Jobs | `faravan apply` | `POST /api/jobs/{digest}/apply` | - | `faravan jobs apply` | `jobs_apply` |
| `jobs.retention` When a job is deleted | read | Jobs | - | `GET /api/jobs/{digest}/retention` | - | `faravan jobs retention` | `jobs_retention` |
| `jobs.delete` Delete a job | consequential | Jobs | - | `POST /api/jobs/{digest}/delete` | - | `faravan jobs delete` | `jobs_delete` |
| `jobs.set_title` Rename a job | write | Jobs | - | `POST /api/jobs/{digest}/title` | - | `faravan jobs set-title` | `jobs_set_title` |
| `jobs.set_outcome` Record whether a result was useful | write | Jobs | - | `POST /api/jobs/{digest}/outcome` | - | `faravan jobs set-outcome` | `jobs_set_outcome` |
| `repo.resolve` Resolve a repository branch | read | Compose | - | `POST /api/repo/resolve` | - | `faravan repo resolve` | `repo_resolve` |
| `source.preview` Preview files to send | read | Compose | - | `POST /api/source/preview` | - | `faravan source preview` | `source_preview` |
| `repo.inspect` Inspect a project folder | read | Compose | - | `POST /api/repo/inspect` | - | `faravan repo inspect` | `repo_inspect` |
| `folders.suggest` Folders to send from | read | Compose | - | `GET /api/folders/suggest` | - | `faravan folders suggest` | `folders_suggest` |
| `folders.list` Browse folders | read | Compose | - | `GET /api/folders` | - | `faravan folders list` | `folders_list` |
| `approvals.list` Jobs waiting for approval | read | Home, Request | - | `GET /api/approvals` | - | `faravan approvals list` | `approvals_list` |
| `approvals.accept` Accept a job | consequential | Request | - | `POST /api/approvals/{id}/accept` | - | `faravan approvals accept` | `approvals_accept` |
| `approvals.decline` Decline a job | write | Request | - | `POST /api/approvals/{id}/decline` | - | `faravan approvals decline` | `approvals_decline` |
| `circles.list` Circles | read | Circles | `faravan circle list` | `GET /api/circles` | - | `faravan circles list` | `circles_list` |
| `circles.create` Create a circle | write | Circles | `faravan circle create` | `POST /api/circles` | - | `faravan circles create` | `circles_create` |
| `circles.set_profile` Set circle details | write | Circles | - | `POST /api/circles/{circle}/profile` | - | `faravan circles set-profile` | `circles_set_profile` |
| `circles.invite` Invite to a circle | write | Circles | `faravan circle invite` | `POST /api/circles/{circle}/invite` | - | `faravan circles invite` | `circles_invite` |
| `circles.invitations` Invitation history | read | Circles | - | `GET /api/circles/{circle}/invitations` | - | `faravan circles invitations` | `circles_invitations` |
| `circles.revoke_invitation` Revoke an invitation | consequential | Circles | - | `POST /api/circles/{circle}/invitations/revoke` | - | `faravan circles revoke-invitation` | `circles_revoke_invitation` |
| `circles.preview_join` Preview an invitation | read | Circles, Join | - | `POST /api/circles/join-preview` | - | `faravan circles preview-join` | `circles_preview_join` |
| `circles.join` Join a circle | consequential | Circles, Join | `faravan join` | `POST /api/circles/join` | - | `faravan circles join` | `circles_join` |
| `circles.check` Check membership | read | Circles | - | `POST /api/circles/{circle}/check` | - | `faravan circles check` | `circles_check` |
| `circles.leave` Leave a circle | consequential | Circles | - | `POST /api/circles/{circle}/leave` | - | `faravan circles leave` | `circles_leave` |
| `circles.enrollments` Computers asking to join | read | Circles | - | `GET /api/circles/{circle}/approvals` | - | `faravan circles enrollments` | `circles_enrollments` |
| `circles.approve_device` Admit a computer | consequential | Circles | `faravan circle approve` | `POST /api/circles/{circle}/approve` | - | `faravan circles approve-device` | `circles_approve_device` |
| `circles.reject_device` Turn away a computer | write | Circles | - | `POST /api/circles/{circle}/reject` | - | `faravan circles reject-device` | `circles_reject_device` |
| `circles.remove_member` Block a computer | consequential | Circles | - | `POST /api/circles/{circle}/remove-member` | - | `faravan circles remove-member` | `circles_remove_member` |
| `circles.set_approval_mode` How new computers join | consequential | Circles | - | `POST /api/circles/{circle}/approval-mode` | - | `faravan circles set-approval-mode` | `circles_set_approval_mode` |
| `circles.presence` Who is lending | read | Circles, Compose | - | `GET /api/circles/{circle}/presence` | - | `faravan circles presence` | `circles_presence` |
| `circles.compose` What a circle can run | read | Compose | - | `GET /api/circles/{circle}/compose` | - | `faravan circles compose` | `circles_compose` |
| `members.names` Your names for members | read | Circles | - | `GET /api/circles/{circle}/petnames` | - | `faravan members names` | `members_names` |
| `members.set_name` Name a member | write | Circles | - | `POST /api/circles/{circle}/petnames` | - | `faravan members set-name` | `members_set_name` |
| `members.forget_name` Forget a member name | write | Circles | - | `POST /api/circles/{circle}/petnames/delete` | - | `faravan members forget-name` | `members_forget_name` |
| `device.get` This computer and members | read | Devices | - | `GET /api/devices` | - | `faravan device get` | `device_get` |
| `device.rename` Rename this computer or yourself | write | Devices | `faravan name` | `POST /api/devices` | - | `faravan device rename` | `device_rename` |
| `contributions.get` Saved lending results | read | Home | - | `GET /api/contributions` | - | `faravan contributions get` | `contributions_get` |
| `hosting.get` Hosting status | read | Host | - | `GET /api/hosting` | - | `faravan hosting get` | `hosting_get` |
| `hosting.set_keep_awake` Keep this computer awake for the circle | write | Host | - | `POST /api/hosting/keep-awake` | - | `faravan hosting set-keep-awake` | `hosting_set_keep_awake` |
| `hosting.start` Host a circle | consequential | - | `faravan host` | - | - | `faravan hosting start` | `hosting_start` |
| `hosting.stop` Stop hosting | consequential | - | `faravan host --stop` | - | - | `faravan hosting stop` | `hosting_stop` |
| `people.list` Circle people | read | Circles | - | `GET /api/circles/{circle}/people` | - | `faravan people list` | `people_list` |
| `people.link_proof` Prove a computer link | write | Circles | - | `POST /api/circles/{circle}/people/link-proof` | - | `faravan people link-proof` | `people_link_proof` |
| `people.link` Link computers to a person | consequential | Circles | - | `POST /api/circles/{circle}/people/link` | - | `faravan people link` | `people_link` |
| `people.set_role` Set a circle role | consequential | Circles | - | `POST /api/circles/{circle}/people/role` | - | `faravan people set-role` | `people_set_role` |
| `people.set_block` Block or unblock a person | consequential | Circles | - | `POST /api/circles/{circle}/people/block` | - | `faravan people set-block` | `people_set_block` |
| `people.remove` Remove a person | consequential | Circles | - | `POST /api/circles/{circle}/people/remove` | - | `faravan people remove` | `people_remove` |
| `circles.set_lifecycle` Archive, reopen or close a circle | consequential | Circles | - | `POST /api/circles/{circle}/lifecycle` | - | `faravan circles set-lifecycle` | `circles_set_lifecycle` |
| `circles.set_steward` Set a backup steward | consequential | Circles | - | `POST /api/circles/{circle}/steward` | - | `faravan circles set-steward` | `circles_set_steward` |
| `circles.propose_transfer` Offer circle ownership | consequential | Circles | - | `POST /api/circles/{circle}/ownership/propose` | - | `faravan circles propose-transfer` | `circles_propose_transfer` |
| `circles.accept_transfer` Accept circle ownership | consequential | Circles | - | `POST /api/circles/{circle}/ownership/accept` | - | `faravan circles accept-transfer` | `circles_accept_transfer` |
| `circles.cancel_transfer` Cancel ownership transfer codes | consequential | Circles | - | `POST /api/circles/{circle}/ownership/cancel` | - | `faravan circles cancel-transfer` | `circles_cancel_transfer` |
| `circles.delete_local` Delete local circle membership data | consequential | Circles | - | `POST /api/circles/{circle}/delete-local` | - | `faravan circles delete-local` | `circles_delete_local` |
| `diagnostics.preview` Preview a support export | write | You → Your data | - | - | - | `faravan diagnostics preview` | - |
| `app.info` Is the app running | read | - | - | - | - | `faravan app info` | `app_info` |
| `app.start` Start the app | write | - | `faravan app` | - | - | `faravan app start` | `app_start` |
| `notifications.list` Borrower notifications | read | Tray | - | `GET /api/notifications` | - | `faravan notifications list` | `notifications_list` |
| `update_settings.get` Updates | read | Setup | - | `GET /api/update-settings` | - | `faravan update-settings get` | `update_settings_get` |
| `update_settings.set` Set update settings | write | Setup | - | `POST /api/update-settings` | - | `faravan update-settings set` | - |
| `notification_settings.get` Notification settings | read | You | - | `GET /api/notification-settings` | - | `faravan notification-settings get` | `notification_settings_get` |
| `notification_settings.set` Set notification settings | write | You | - | `POST /api/notification-settings` | - | `faravan notification-settings set` | `notification_settings_set` |
| `app.open_link` One-time browser link | write | Tray | - | `POST /api/handoff` | - | `faravan app open-link` | `app_open_link` |
| `app.quit` Quit the app | consequential | Tray | - | `POST /api/shutdown` | - | `faravan app quit` | `app_quit` |
| `uninstall.plan` What uninstall would do | read | - | `faravan uninstall --dry-run` | - | - | `faravan uninstall plan` | `uninstall_plan` |
| `telemetry.status` Telemetry status | read | Settings | - | `GET /api/telemetry` | - | `faravan telemetry status` | `telemetry_status` |
| `telemetry.off` Turn telemetry off | write | Settings | - | `POST /api/telemetry/off` | - | `faravan telemetry off` | `telemetry_off` |
| `telemetry.set` Turn telemetry on | human | - | `faravan telemetry on [--level counts|diagnostics] [--region CC]` | - | - | `faravan telemetry on [--level counts|diagnostics] [--region CC]` | - |
| `telemetry.notice_shown` Record that the telemetry notice was shown | write | - | - | `POST /api/telemetry/notice` | - | `faravan telemetry notice-shown` | - |
| `telemetry.preview` Show what telemetry sends | read | Settings | - | `GET /api/telemetry/preview` | - | `faravan telemetry preview` | `telemetry_preview` |
| `telemetry.reset_id` Get a new random ID | write | Settings | - | `POST /api/telemetry/reset-id` | - | `faravan telemetry reset-id` | - |
| `uninstall.run` Uninstall Faravan | human | - | `faravan uninstall` | - | - | `faravan uninstall` | - |

<!-- /GENERATED:parity-matrix -->
