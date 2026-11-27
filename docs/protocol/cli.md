# Faravan v1 borrower CLI and MCP

These adapters use the verified v1 client. Hosting uses v1.
They do not run a provider, clone a repository, or start lending. `faravan apply` is the one command that writes Git objects, and only on a new branch.

## Commands

- `faravan run "<prompt>" [--circle C] [--harness H] [--model M] [--egress internet|provider-only] [--include-uncommitted] [--detach] [--follow] [--timeout SECONDS] [--json]`
- `faravan run --attach JOB-ID [--timeout SECONDS] [--json]`
- `faravan status [--json]`
- `faravan <command> --help`, `faravan <command> <action> --help`, `faravan help <command>`
- `faravan circle create <origin> [--name N] [--lan]`
- `faravan name ["Your name"]` (shows or sets the name new invitations sign as `owner_name`; until set, the OS account's full name, else the host name; `--json`: `{name}`)
- `faravan circle invite [--circle ID-or-name]` (prints a short link, `https://HOST/i/CODE#SEED`, when the server publishes it; otherwise the long `/join#invite=...` link and a one-line note; the invitation carries your name as `owner_name`; `--json`: `{invite, note?}`)
- `faravan circle join <invite-link> [--name DEVICE-NAME] [--accept-lan-warning]` (default: host name; signed into the enrollment request; accepts a short link, a long link, the bare invitation text, or a `faravan://join?link=...` URL; old `faravan://` links remain accepted)
- `faravan open-link <faravan://join?link=URL | invitation-link>` (hidden from top-level help; the target of both the `faravan://` handler and its `faravan://` alias. It reuses the running app, or starts it, and opens the browser at the join review with the invitation filled in. It never joins by itself and never prints the invitation or the session token)
- `faravan circle approve [--circle ID-or-name]` (lists each approved device name and key fingerprint)
- `faravan circle list`
- `faravan job submit --source DIR|--git URL@COMMIT|--no-source --prompt TEXT|--prompt-file F [--result branch|message|files] [--harness H] [--model M] [--egress internet|provider-only] [--circle C] [--json]`
  `--no-source` sends no files and needs `--result message` or `files`. `branch` (or no `--result`) is the legacy code-change job.
- `faravan job status JOB-ID [--json]`
- `faravan job wait JOB-ID [--timeout SECONDS] [--json]`
- `faravan job cancel JOB-ID`
- `faravan job result JOB-ID --out EMPTY-DIRECTORY`
- `faravan job list [--json]`
- `faravan apply JOB-ID [--branch NAME] [--dry-run] [--circle C] [--json]` (run inside the repository; see below)
- `faravan mcp`

## Run, job IDs, help and status

`run` works inside a git repository. It sends the committed HEAD (the
source-packing helper's `git archive HEAD` path). If `git status` shows any
changed or untracked file, `run` exits 2 and lists up to 10 of them.
`--include-uncommitted` instead packs tracked plus untracked, non-ignored files
from the working tree (deleted files omitted), prints `Including N uncommitted
files:` with each file and its status code to stderr, and adds
`uncommitted_files` to JSON. The circle is `--circle`, or the only circle that
has a server. Human output prints `Job <8 hex> submitted to <circle>`, then one
line per status change (`Waiting`, `Starting`, `Running`, `Finished`, `Failed`,
`Expired`, `Cancelled`, `Stop requested`), then the `faravan job result`
command. `Running` means a claimed attempt has execution proof (UX_V1 §6).
Exit codes: 0 Finished; 1 Failed, Expired or Cancelled; 5 `--timeout` reached
(the job keeps running); 130 interrupted; 2 usage. `--detach` returns after submit.
`--json` prints one final value; with `--follow` it prints JSONL events
(`submitted`, `status`, `finished`). `--attach` streams an existing job.

A JOB-ID is a full `sha256:` digest or any unique prefix of at least 6 hex
characters, with or without `sha256:`. Prefixes resolve against jobs this
device submitted first, then against the circle's job list. An ambiguous prefix
exits 2 and lists the matches; no match exits 3. Human output prints the first 8
hex characters; JSON always carries the full digest.

Top-level help lists run, status, apply, app, host, job, circle, name, mcp and doctor.
The preview commands and their legacy aliases have been retired.
`faravan status` shows this device, its circles, lending state (read from a
running app, otherwise "Not running") and up to 5 recent jobs per circle.
Old member configuration is preserved without being interpreted as v1 state.

Job lookup accepts an optional `--circle`. Locally submitted digests retain
their circle mapping. Circle IDs and unique display names are accepted.
Use per-command help for `--json` support; help itself is text. For circle
and job commands, `--json` prints one JSON value; errors contain code/message.
Human errors use stderr. These adapters use exit codes: 0 success, 2 usage,
3 not found, 4 conflict, 5 retryable/timeout, 1 other.

`faravan apply` takes a verified diff result and creates a new branch
(default `faravan/<first 12 hex of the digest>`) in the repository of the
current directory. The branch starts at the job's base commit (for an archive
job, the commit in your history whose tree equals the receipt's `base_tree`)
and holds one commit: subject is the first line of your prompt; the body has
the agent, model, duration and diffstat from the receipt. It uses a temporary
index, so your current branch, index and working tree (including uncommitted
changes) are never touched and no hook runs. `--dry-run` runs the same checks
and creates nothing. It refuses, with exit 1 and no changes, when the result is
not a diff, the base is missing from the repository, the patch names a path
inside `.git`, an absolute or `..` path, a submodule or an outward symbolic
link, or `git apply --check` fails. Review and merge the new branch yourself.

First use creates a mode-0600 device key and private My devices circle under
`FARAVAN_HOME/v1`, or the normal Faravan home. With no configured service,
My devices is offline with null origin. `FARAVAN_V1_ORIGIN` supplies an
explicit service; otherwise create a circle at an explicit HTTPS origin.
Literal loopback HTTP is allowed for local services. Explicit `--lan` permits only private IPv4, .local and link-local HTTP, bound in root-signed provisioning, invites and request proofs. Join prints the unencrypted-network warning before enrollment. Invites carry the signed display name and optional owner name. A short link is resolved with one public `GET /v1/invites/CODE` and verified with the seed in its fragment before anything in it is trusted (protocol section 5.1); the seed is never sent. Invitations contain
secrets: share them privately, never paste them into diagnostics.

The server must be locally provisioned for this circle and pinned root.
Circle create writes a public provisioning.json file and prints
faravan-coordinator --v1-provision FILE. Transfer that public file privately
to the server operator and run the printed command there. An unprovisioned
service fails with exit 3 and a clear setup message; it never adopts a new root
from the network. If the transport is unreachable, create succeeds locally, marks publication pending and prints the provisioning step; it retains the exact pending roster for retry. Retrying create retains the same circle. A colocated host
integration may inject provisionCircle to invoke the server's local provisioning
function; a loopback URL alone is not evidence of an authorized local host.

State writes use private temporary files, fsync and atomic rename. Per-state
lock directories fail closed on contention. A process crash can leave a stale
lock: recovery requires confirming no other process owns the home, then
removing only that stale lock directory. Never erase trust or intent records.

## Shared operations

`createJobOperations(options)` supplies submit/get/wait/cancel/readResult/list.
`runV1Command(argv, options)` returns an exit code; it does not exit the process.
Tests may inject device, clock, fetch, stdout/stderr and client options.
MCP uses the same operations and exports no separate job semantics.

`JOB_DEFAULTS` is the single exported default contract: 3 attempts, 24-hour
deadline, internet egress, 1200 wall seconds, 2 CPUs, 4 GiB memory, 4 GiB disk,
16 MiB output. CPU, memory, wall and output are required; disk is preferred.
The signed requirements.limit_modes makes this explicit. An omitted mode is
required for backward compatibility. MCP uses the identical signed defaults.
Unenforced preferred disk is reported as storage in receipt.unenforced.
Harness/model constraints are omitted unless selected, never
silently substituted after selection. Provider-only egress is explicit.

Folder inputs use the shared source-packing helper then gzip. In a Git repository
that helper packages committed HEAD; it does not include uncommitted changes.
Outside Git it packages the folder excluding .git. Review the source before
submission: this helper does not guarantee secret detection. The coordinator
and authorized circle members can read source and prompt. Git inputs must be
credential-free HTTPS URLs with an immutable full lowercase SHA-1/SHA-256
commit; the adapter never fetches them.

Submission persists exact signed payload and operation key before publishing.
An unresolved submission with matching source/prompt/options reuses that
intent; an acknowledged submission followed by a new submit creates a new job.
Cancellation likewise retains exact payload/key. These records are not deleted
on timeout. Submission success acknowledges publication, not execution.
Waiting is abortable and bounded to 300 seconds per call.

Wire queued maps to Waiting; claimed maps to Starting, since a claim alone
does not prove execution. Result acceptance maps to Finished, not Result ready.
Cancellation without cessation proof maps to Stop requested. Human status/wait output adds an explanation and next action; queued jobs say “Waiting for a lender. Nobody has picked it up yet.” JSON vocabulary remains stable.

Results are fetched only through signature/job/attempt/hash verification of
both candidate and transcript. A gzip candidate is extracted by extractArchive
into an empty directory; a verified text patch is saved as changes.patch and
never applied. Without an explicit destination, `readResult` creates a directory
under the Faravan home's `results` directory. Before each new extraction,
entries older than seven days and all but the newest 20 are pruned. The result
includes its local path and up to 4096 bytes of patch/summary preview. Users
manage explicit output directories; failed temporary extraction is cleaned up.
A verified result proves provenance/integrity, not correctness or safety.

## MCP

Newline-delimited JSON-RPC 2.0 over stdio. Versions 2025-11-25 and 2025-06-18.
Methods: initialize, ping, tools/list, tools/call; cancellation notifications
abort a pending wait. Tools: submit_job, get_job, wait_job, cancel_job,
read_result. Submit/cancel are annotated writes, the other tools read-only.
Submit and cancel are consequential, like jobs_submit and jobs_cancel: without
`confirm: true` (or an accepted elicitation) they answer confirmation_required
with the effect, and nothing is sent or cancelled.
Tool text is bounded; large artifacts are returned by local file handle.
