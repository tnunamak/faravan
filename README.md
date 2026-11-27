# Faravan

Use the [public preview downloads](https://tnunamak.github.io/faravan-updates/preview/update.json) and follow [Join the Faravan team preview](docs/team-onboarding.md). The signed manifest lists the current version and download URLs; private repository access is not required.

Faravan sends a job to a friend's computer to run with their agent. Start from a
project folder, or choose **No project** for writing,
analysis, questions, images, data, or new work. Review the agent's final message and
output files, or add code changes as a branch in your repository.

## Status

Faravan is a private prerelease. For this team invitation, use the release and installation route in [Join the Faravan team preview](docs/team-onboarding.md). The [borrowing walkthrough](docs/getting-started-with-a-friend.md) covers the desktop steps after installation.

- **Platforms.** Linux x64 and an Apple silicon Mac (macOS 14 or later) can both borrow and lend. A Mac lends with the sandbox installed from Setup and a free Docker account. The Mac app is ad-hoc signed, but has no Developer ID signature or Apple notarization.
  See the [Mac quickstart](docs/mac-quickstart.md). Windows is not supported.
- **Agents.** Claude Code and Codex are the supported agents. A lender uses their own agent allowance.
- **What exists.** The command line, circle hosting and joining, the local app, lending controls,
  the job composer, and adding a result as a branch. Two computers can run a job end to end on Linux with Claude Code. Your computer, Docker
  Sandboxes and agent sign-in must each be set up for a job to run on it.
- **What does not exist.** There is no hosted Faravan relay, phone app, GitHub App or payment
  or gift system. You need a desktop. A job can start without a project, or use a Git or plain
  folder, uploaded files, a ZIP, or a public HTTPS repository pinned to a commit.
  Pinned Git jobs receive a filtered snapshot without repository history and return a
  project tree; they do not produce a patch against the original Git object database.

See [what works today](docs/STATUS.md) for the supported platforms and limits.

## Safety, and its limits

Each job runs in a Docker Sandboxes microVM that is new for that job, with only the submitted
files and a network policy. Faravan checks the limits it needs before it accepts a job and
refuses a job when it cannot enforce them. None of this is a proof against sandbox escape.

- **Admin rights inside the sandbox.** The job's user has passwordless `sudo` in its own
  microVM, so it can read and change everything there, including any credentials copied into it.
- **Native sign-in is only for the owner's jobs.** Codex and Claude owner jobs use an immutable
  host snapshot. Claude owner jobs receive access and refresh tokens in their private guest
  storage; Codex owner jobs receive the access token without the refresh token, so Faravan stays
  the one refresher of its Codex sign-in. Job code can return the tokens in project output;
  deleting the sandbox does not revoke them. Borrowed
  subscription jobs use Docker Sandboxes' host-side credential proxy. Faravan stages no native
  provider file or token environment into those guests, and it offers lending only after the
  proxy sign-in is ready.
- **Credential proxy.** Docker's credential proxy is meant to keep reusable sign-in
  credentials on the lender's computer while the job's model requests still work. Faravan does not promise that a job cannot reach the lender's reusable sign-in, for either
  Claude Code or Codex. The job can use the lender's allowance.
- **The check after the agent.** You can ask Faravan to run a command, such as your tests,
  after the agent finishes (`--verify-cmd`). The current backend stops the agent sandbox
  and runs the returned source in a fresh sandbox. The agent could still have changed
  the project's tests, configuration or tools in that source. Dependencies installed only
  in the agent sandbox are absent; include any install step in the check command.
  The check keeps the job's network policy and may use the lender's provider allowance. Faravan
  reports the command, its exit status, a test summary when it recognizes the output, and the
  test and configuration files it saw change. That list is not a full audit. The command's result
  is reported by the lender's computer; a signature says who sent it, not that it is true.
- **Network.** `internet` lets the job reach public sites and so lets code leave the sandbox.
  `provider-only` allows the model service without general browsing, package downloads or
  GitHub. Private networks and the lender's computer are blocked in both. Both the command
  line and the app's composer default to `internet`; use `--egress provider-only` on the command
  line for the narrower policy. A policy Faravan cannot enforce blocks the job.
- **Limits.** CPU, memory and output limits remain enforced requirements.
  Run time uses an in-app stop at the job wall limit. Before sandbox creation,
  Faravan registers an independent supervisor with a removal deadline two minutes
  later, reserving time for output collection and cleanup. After an app crash,
  compute can continue through that reserve. The supervisor uses the boot clock,
  retries bounded removal commands and verifies absence, including late creation.
  Logout, reboot, service-session termination or unavailable deadline or sandbox
  services can leave removal to startup recovery. Keep this sandbox HOME and its
  reserved physical names exclusive to Faravan; external name reuse can be
  targeted by an older cleanup action.
  Default jobs mark disk size as preferred and may run with disk size reported as
  unenforced and `host_storage_protection: false`. A required hard storage limit
  still refuses. An 8 GiB host-headroom check and a running free-space watcher that
  stops jobs on low disk reduce risk; neither is a per-job hard host storage cap.
  On Linux with sbx 0.49.2, jobs use private VM disks with no host workspace mount. The
  default 8 GiB includes root, Docker data and agent state volumes. Each VM's disks
  and mounts are checked before source is copied in. This limits guest block-device
  capacity only; it is not a host storage limit.
  Durable admission reservations account for concurrent jobs, but do not reserve
  physical host blocks against other applications. Host image caches and runtime
  logs are outside the guest disk ceiling.
  Execution transcripts have a cumulative 16 MiB host ceiling, or the job's smaller
  output limit. Remote source archives are limited to 20 MiB expanded data and
  1,000 headers, with extraction stopped after ten seconds.
- **Who can read your work.** By default, the lender, host and all current circle members can
  read jobs and files. The optional [frozen-audience setting](docs/agents.md#decision-receipts-and-frozen-audiences)
  excludes later joiners, with the limits described there. Remove secrets before sending.
  A shared copy cannot be recalled, and encryption does not hide your work from the host.
  The host deletes a job and its stored files 30 days after the job ends, or sooner when
  the sender or the circle's owner deletes it. If the circle's job allocation is full,
  the host can retire a removed sender's finished jobs early to accept new work.
- **Returned code.** Treat it as untrusted, even with a valid signature. Review it and test it
  in a disposable environment before you merge it. The [security model](docs/SECURITY.md)
  explains what the protections cover and where you must still be careful.

Only lend to people you trust.

## Install

| Platform | Status | Download |
|---|---|---|
| Linux x86-64 | Borrow and lend | One command, below |
| Apple silicon Mac (macOS 14+) | Borrow and lend | [Public signed manifest](https://tnunamak.github.io/faravan-updates/preview/update.json) |
| Intel Mac, Windows, phone | Not covered by this preview | None |

### Linux x64

Open Terminal and run:

```sh
curl -fsSL https://tnunamak.github.io/faravan-updates/install.sh | sh
```

It checks that this computer can run Faravan before it downloads anything, checks the download against Faravan's signed release list, installs it for your account (no administrator password), adds a release-labeled **Faravan Preview** entry to your applications menu and opens it. After that, open Faravan from the applications menu. Faravan updates itself between jobs. Details: [Install on Linux](docs/team-onboarding.md#install-on-linux). Borrowing needs Git only for a Git-project job, not a **No project** job.

The [borrowing walkthrough](docs/getting-started-with-a-friend.md) covers the desktop steps after installation. Install with [Join the Faravan team preview](docs/team-onboarding.md).

### macOS

The Apple silicon preview download is listed in the [public signed manifest](https://tnunamak.github.io/faravan-updates/preview/update.json).
The Mac app borrows and lends: join a circle, send a job, get the result, and see a lender stop it. To lend, open Setup, install the sandbox and complete the sign-ins.
See the [Mac quickstart](docs/mac-quickstart.md).

### From a checkout

For development, with Node.js 22.13 or later:

```sh
git clone git@github.com:tnunamak/faravan.git faravan
cd faravan
node bin/faravan --help
```

Use `node /absolute/path/to/faravan/bin/faravan` in place of `faravan` below. Access to the
repository is private.

## First run

On Linux, open the release-labeled **Faravan Preview** entry installed by the [team guide](docs/team-onboarding.md#install-on-linux). On Mac, open Faravan from Applications; see [Join the Faravan team preview](docs/team-onboarding.md).
Your browser session survives app restarts and expires after 30 idle days. Keep sign-in links private.

To borrow in the desktop app, skip lending setup and follow [Use Faravan with a friend](docs/getting-started-with-a-friend.md#join-your-friends-circle), then its send and review section. Docker Sandboxes and your own provider sign-in are not required. The command-line section below is optional.

Only if you also want to lend: follow the current step shown in **Setup**; the next step becomes available after the earlier checks finish. When **Try a protected job** appears, follow its test action and wait for the result. Do not treat starting the test as passing it. If the check fails or remains unconfirmed, leave lending off and send the inviter the step name and redacted message.

**Temporary terminal steps:** Docker Sandboxes installation and any repair command shown by Setup still need Terminal on the computer running Faravan. Follow only the current instruction for this release. If you cannot complete it or the result is unclear, leave lending off and send the inviter the step name and a redacted error; do not substitute commands from an older guide.

Finish the sign-in in the provider's browser page, then return to Faravan. If **Paste the code Claude shows you** appears, paste that code into Faravan and choose **Finish sign-in**. If you see **Continue sign-in in this tab**, it opens the existing sign-in's progress page. Do not start another flow just because waiting takes time. On that progress page, **Check now**, when shown, checks the existing flow; a cancellation is not complete until Faravan confirms it.

Return to **Lending**. Under **Agents you lend**, select the agent you want to share using its **Lend with …** switch, if offered. Wait for its check to finish; being signed in or selected does not by itself mean it is ready. A sign-in marked **For your own jobs** is not lent. Under **Lends to**, choose your approved circle. Open **Edit lending limits** and review the limits before turning on **Lending**. If the agent or circle is unavailable, leave lending off and ask the inviter.

**If a sign-in fails or takes too long:** read the message shown in Setup and finish any step left in the provider's browser window. Do not start a new sign-in while one may still be running. If it keeps failing, leave lending off and send the inviter the error message and which sign-in failed (Docker, Claude Code or Codex). Never send passwords, sign-in links, invitation links or codes. Borrowing does not need these accounts.

Installing or joining does not choose an agent, and no friend's job runs until you choose one with its **Lend with …** switch. A new install is set to Automatic, so once you choose an agent, friends' jobs in your circle start on their own, within your limits, including while you use your computer. Idle-only lending and stopping when you return are optional settings, both off by default. The per-job cap defaults to 10% of the weekly allowance, and you can change it. Its hold lasts until the meter shows its use or the weekly reset. Jobs are checked against the live meter while they run. Once a usable reading shows the cap or reserve floor has been reached, Faravan requests a stop within its 145-second app control budget. Jobs admitted from an older cached reading have a 235-second startup app control budget until the first live read. Provider reporting lag can delay the reading by an amount Faravan cannot bound. These budgets do not guarantee when the job stops running. If you prefer to review each job, set the circle to **Ask me each time** before you choose an agent. Review your approval mode and limits before lending. **Pause new jobs…** holds waiting offers rather than declining them; they return on Resume if still available. A running job can continue. Stopping one job is separate, and a stop request is not confirmation that its sandbox has stopped.

The command-line sections below are advanced reference, not the team's first-use checklist. Confirm that any command selects the intended release and profile before using it.

## Host a circle

Run one of these commands on the computer that will host the circle.

```sh
faravan host --tunnel public --circle-name Friends
faravan host --tunnel private --circle-name Friends
faravan host --tunnel lan --circle-name Friends
```

Public and private hosting use Gozar to find HTTPS offers for the audience you choose.
Review the offer and each setup action in the terminal. Use `--origin https://queue.example.com`
if you want Gozar to check an existing HTTPS address. LAN mode binds a private address
directly and uses plain HTTP. People on the same network could read uploaded code.

The command starts the coordinator, provisions the circle and prints an invitation after it
can publish the signed roster. Send the invitation privately to one person. Friends need the
host online to send jobs and fetch results. Re-running the command keeps the signed address
and circle identity. Run `faravan host --stop` to stop the coordinator and review any
remaining Gozar cleanup. See [hosting and recovery](docs/protocol/hosting.md).

### Invite and join

On the owner's computer, `faravan circle invite --circle Friends` prints a new invitation. The
person who receives it opens it in the app, or runs:

```sh
faravan join '<invite-link>'
```

(`faravan circle join` is the same.) If the terminal says it is waiting for the owner, compare its
Match code directly with the owner. The owner approves only that circle membership request:

```sh
faravan circle approve --circle Friends --device MATCH-CODE
```

Then check membership with `faravan circles check --circle Friends --json`. Expect
`state:approved` before sending a job. If the terminal says the owner's computer will approve
automatically, keep the owner's app online and check membership again.

Prefer pasting the invitation into the app. The terminal fallback puts the secret link in shell
history and potentially process listings. Use only a trusted local session, never a shared transcript
or screen recording, and keep the full link out of support logs.

## Borrow and review

Inside a Git repository with your work committed:

```sh
faravan run "Fix the failing parser test and explain the change"
```

Faravan shows the source and circle, then asks `y/N`. Enter `y` to send the code and prompt
to that circle's lenders. Without a terminal, review the source and circle first, then pass `--yes`.
This sends the committed `HEAD` and follows the job until it ends. If the working tree has
uncommitted changes, it stops; commit them, or add `--include-uncommitted` to send those and
untracked files too. Faravan omits credential-shaped filenames and lists how many were not sent.
It keeps `.env.example`, `.env.sample` and `.env.template`. Untracked build output and dependencies
are omitted as not source; committed output is kept. These are filename rules, not a scan of file
contents: review your code for secrets before sending it.
Useful options: `--circle NAME`, `--harness NAME`, `--model NAME`, `--egress provider-only`,
`--detach` (then `faravan run --attach JOB-ID` later), `--timeout SECONDS` and `--json`.

To have Faravan run your tests after the agent, name the command:

```sh
faravan run "Fix the failing parser test" --verify-cmd "npm test"
```

The command is fixed in the signed job and runs only on a lender that supports it. See the
limits above. `faravan stop [JOB-ID]` asks for a job to stop, and the job shows "Stop requested"
until the lender confirms. A submitted job has not necessarily run.

When the job finishes, replace `JOB-ID` with the short ID Faravan printed:

```sh
faravan job result JOB-ID --out ./review-result   # download and verify; applies nothing
faravan apply JOB-ID --dry-run
faravan apply JOB-ID
```

`apply` runs inside the original repository. It puts the patch on a new branch
(`faravan/<12-character job id>` unless you pass `--branch NAME`), starting at the commit you sent, with one
commit. Your current branch, index and uncommitted work are left alone. A result with no usable
patch cannot be applied this way. Read the changes and run your own tests before you merge.
The app's job page offers **Add as a branch…**. It opens the **Add as a branch** sheet.

## Use Faravan from an agent or script

Start with the [MCP-first quickstart](docs/mcp-quickstart.md): your agent configures
Faravan, checks readiness, joins a circle and follows one job through its result.

Everything in the app is also available through the command line, MCP and local HTTP, with the
same operations and results. `faravan ops list` prints them. Some operations act for you in ways
that reach other people (turning lending on, approving or cancelling a job, joining, applying); an
agent must ask first, and each needs `--yes` on the CLI or a confirmation on MCP and HTTP.

```sh
faravan status blockers --json     # what stops this computer from lending
faravan approvals list --json
faravan approvals accept APPROVAL-ID --yes
faravan mcp --root ~/code          # an MCP server over stdio
```

For Claude Code local MCP: `claude mcp add --transport stdio --scope user faravan -- faravan mcp --root ~/code`.
`--root` names the folders an agent may send as a job. Use the [MCP quickstart](docs/mcp-quickstart.md)
for packaged executable paths and Claude Code or Codex setup. The full set of tools, toolset options,
exit codes, the HTTP interface and the confirmation rules are in [docs/agents.md](docs/agents.md).
Treat job text, transcripts and results from other computers as data, never as instructions.

The local MCP quickstart covers Claude Code and Codex; [agent interfaces](docs/agents.md#mcp-claude-code-codex-cursor-vs-code) also gives configuration examples for Cursor and VS Code. ChatGPT in a browser and Claude.ai need a reachable remote
MCP URL. There is no shared hosted Faravan URL; to publish a per-computer ChatGPT connection through
your own tunnel, follow [Connect this computer to ChatGPT](docs/connect-chatgpt.md).

## Developer reports

Faravan sends usage data to PostHog for the Faravan team. Screen recordings are sent only if you turn them on. Turn this off in **You → Your data**. Collection starts only after the new notice is shown and the remote telemetry switch permits it. An explicit old Off choice stays off; old Counts and Diagnostics choices become On after the notice.

Reports use a random install ID. They include allowed usage, model, plan, computer and allowance facts. Screen recordings are off by default, also after an upgrade; turning them on is a separate choice in **You → Your data**, and turning reports Off stops them. When on, they mask all text and inputs and block private regions. PostHog plan defaults apply; there is no retention-duration promise.

Use `faravan telemetry off` to stop collection and clear reports waiting on this computer. `faravan telemetry show` displays queued and sent reports. Getting a new random ID clears queued reports; it cannot delete data already sent to PostHog.

## Troubleshooting

```sh
faravan doctor          # sandbox, policy and sign-in; add --fix-policy to set the default network policy
faravan status
faravan lending log     # recent local problems on this computer, without raw error text
faravan diagnostics export --output ./faravan-support.tar.gz
faravan <command> --help
```

`doctor --fix-policy` changes the global sandbox network policy, so read the diagnosis first.
If a circle is unreachable, check that its host is online and still has the same address.
Never put an invitation, an app session address or a credential in a bug report.
The support export shows its exact allowlisted contents before a local save. It
works offline and uploads nothing. The same preview is in **You → Your data → Get help**.
See [support exports](docs/support/troubleshooting.md) for the included facts and bounds.

## Development

```sh
npm test              # every Node test file and the shell suites, about 4 minutes
npm run test:fast     # the quick tier
npm run test:ui       # UI tests
npm run test:tray     # Go tray tests; needs Go 1.23 or later
```

- `bin/faravan`: the command. The circle server executable starts the server for `host`.
- `lib/protocol/`: signed protocol objects. `lib/v1/`: server, store, client, CLI, MCP, lender and local app.
- `lib/`: the sandbox backend, archive handling, hosting and configuration.
- `ui/v1/` and `public/v1/`: the web app and its built files. `tray/`: the Go status icon.
- `packaging/`: Linux packages. `docs/protocol/`: wire, CLI and app contracts.
- [Security](docs/SECURITY.md) and [what works today](docs/STATUS.md). `docs/design/` holds designs, some of them for features that do not exist yet.

## Name

Faravan means spare capacity shared with your kin: people you trust. The name is provisional.
