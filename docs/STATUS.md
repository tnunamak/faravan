# What works today

Faravan is a private prerelease. This page states what it supports.

## Platforms

| Platform | What you can do |
|---|---|
| Linux x86-64 | Borrow and lend. Lending needs Docker Sandboxes, a free Docker account and your own Claude Code or Codex sign-in. |
| Apple silicon Mac, macOS 14 or later | Borrow and lend: join a circle, send a job, get the result; lend with the sandbox installed from Setup and a free Docker account. |
| Intel Mac | No desktop app. Use paired browser access to a supported desktop. |
| Windows | No desktop installer. Use paired browser access to a supported desktop. |
| Phone, tablet or another browser | Pair with Faravan on a supported desktop. Plain HTTP can view requests; trusted HTTPS can also answer them. Full-app mode needs trusted HTTPS or a Tailscale connection Faravan confirms. |

The Mac app is ad-hoc signed. It has no Developer ID signature or Apple notarization, so macOS asks you to confirm the first open. See the [Mac quickstart](mac-quickstart.md).

## Agents

Claude Code and Codex. A lender's jobs use the lender's own agent allowance.

## What a job can do

- Start with no project, or from a Git or plain folder, uploaded files, a ZIP, or a public HTTPS repository pinned to a commit.
- Return a written answer, output files, or a project tree you can add to your repository as a branch.
- Run on a computer in your circle after manual approval or under its owner's saved automatic rules, subject to setup, sign-in and lending limits.
- Stop at any time from the lender's computer.

## Pair another device

Pairing is separate from joining a circle. The browser connects directly to the awake, reachable computer running Faravan, not through a relay. See [Check your own computers from your phone](team-onboarding.md#check-your-own-computers-from-your-phone).

## What does not exist

- A hosted Faravan relay, native phone app, GitHub App, or payment or gift system. Paired browsers connect directly to their host.
- A per-job hard limit on host disk use. Faravan checks free space before and during a job and stops it when space is low; see [Security](SECURITY.md).
- Protection against a hostile job on the lender's computer. Read [Security](SECURITY.md) before you lend.

## Hosting

One host can serve more than one circle. Hosting reachable over HTTPS from outside your network needs a public address that you provide.

## Preview retirement

The earlier preview runtime, commands and UI have been removed. A host with old preview jobs cannot resume them. Use the [retirement steps](protocol/hosting.md#retiring-an-old-host) before you upgrade a host that has outstanding work. The read-only `lib/legacy-verify.mjs` keeps historical signature checks; its output grants no current execution authority.

## Known limits

- Before sandbox creation, Faravan durably records the deadline and acknowledges
  an independent supervisor. It uses the boot clock so suspend plus wall-clock
  rollback cannot renew the Linux deadline. A never-observed create keeps supervision
  alive even while the sandbox is absent; removal commands and absence checks have
  five-second timeouts and one-second retry delays. Failures remain recorded while
  supervision continues. A bound materialization observation is saved before
  removal; verified absence ends supervision and recovery consumes the observation.
- An inert create may release the lending hold after its absence wait and verified
  revocation of its scoped credentials and network rules. Its cleanup record and
  independent supervisor remain until the named sandbox is observed and removed.
- The fixed two-minute reserve after the job wall limit gives normal output
  collection and cleanup time. After an app crash, compute can continue through
  that reserve. Independent removal starts at the later deadline; verified removal
  completion depends on the sandbox service responding.
- Logout, reboot, service-session termination or unavailable deadline or sandbox
  services can leave removal to startup recovery. Recovery removes overdue
  sandboxes before lending resumes or another sandbox is created. The sandbox HOME
  and reserved physical names must remain exclusive to Faravan; external name reuse
  can be targeted by an older cleanup action.
- Docker's credential proxy and the sandbox are a defense, not a guarantee; see [Security](SECURITY.md).
- Merging code changes: check a returned branch and run your tests before you use it.
- By default, disk-space cleanup reports what it could free and warns when the sandbox-image drive runs low; automatic removal for disk-space recovery is disabled.
