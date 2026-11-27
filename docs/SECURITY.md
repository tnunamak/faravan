# Security: lending and borrowing safely

Faravan runs someone else's coding job on a lender's computer and returns
files to the borrower. Trust matters in both directions: a job can be hostile,
and a returned patch can be hostile too.

**What this page covers:** the controls Faravan applies and the boundaries it
requires. It does not promise that a sandbox cannot be escaped or that a job cannot
reach the lender's agent sign-in. Real jobs run through Docker Sandboxes on Linux
lenders; [what works today](STATUS.md) lists the supported platforms.
[security/credential-proxy-test.md](security/credential-proxy-test.md) describes the
sign-in check.

## If you lend your computer

The intended boundary is a fresh Docker Sandboxes microVM for each job.
The job gets its submitted source and prompt, temporary working space, the
selected agent, and the network access allowed for that job. It must not get
your other files, other jobs, host controls or home network.

There are two network modes:

- **`provider-only`:** access to the selected model service through a narrow
  trusted proxy. No general web browsing, package downloads or GitHub access.
  A local model also goes through the proxy, not direct access to your computer.
- **`internet`:** access to the public internet. Host, private/LAN, loopback,
  link-local, cloud-metadata and other nonpublic addresses are always blocked
  by the required policy, for IPv4 and IPv6. Neither mode allows a job to
  open private ranges. Source downloads must obey the same boundary.

Those are the [protocol's requirements](protocol/v1.md#8-requirements-and-capability-negotiation),
not proof that every runtime configuration enforces them. DNS tricks and
redirects must not bypass the policy. Public internet access can send source
to public destinations. The app uses the shared CLI job-submission defaults,
not a blanket provider-only policy. Check each job's requested network policy
and the backend's enforcement report before lending. Provider-only Git jobs
can be blocked when the source host is not permitted. Faravan must not widen
access to make them run.
<!-- Source: lib/v1/app.mjs imports createJobOperations and submits clean input. -->

### Which limits are real?

The documented backend checks CPU, memory, wall time and output limits before
accepting work. Required limits must be enforceable or the job is declined.
**Host disk protection is not enforced per job:** default jobs mark disk size
preferred and report that gap. A request that requires a hard disk ceiling cannot use
that backend. On Linux with Docker Sandboxes the guest disk size is checked, but
that is not a host storage limit; see the README's **Limits** item.

Read `enforced_limits` and `unenforced` alongside requested values and
`limits_applied`. A number in a lender's report is a lender's report, not an independent
measurement or proof. Unknown usage stays unknown.

Fresh app settings have lending intent On and the automatic strategy; they
initialize provider consent for both supported providers and choose Auto for
new circles. This is not an ask-each-time default. Execution starts disabled:
setup, agent readiness and admission checks still apply. Subscription agents
also require an explicit lending sign-in choice; saved settings keep their
own choices.

No daily job count, daily minute cap or lender-wide per-job wall-time cap is
set by default. Individual jobs still request wall-time limits. The policy
default is one job per account, not one job for the whole computer; machine
slots have no fixed default cap. Automatic lending needs fresh quota
information; idle information is required only when idle-only lending is enabled.
Manual approval does not promise to preserve a measured allowance reserve.
The per-job quota cap defaults to 10% of the weekly allowance and the owner can
change it. Its hold lasts until the meter shows its use or the weekly reset.
Once a usable reading shows the cap or reserve floor has been reached, Faravan requests a stop within its 145-second app control budget. Jobs admitted from an older cached reading have a 235-second startup app control budget until the first live read. Provider reporting lag can delay the reading by an amount Faravan cannot bound. These budgets do not guarantee when the job stops running.
<!-- Sources: lib/v1/app.mjs APP_DEFAULTS and startApp fresh settings;
     lib/v1/lending-policy.mjs LENDING_POLICY_DEFAULTS. -->
[The lender contract](protocol/lender.md) explains durable budget reservations
and why uncertain cleanup blocks more work.

Pause prevents new jobs; an active job may finish. Stopping or cancelling
requests termination. “Stop requested” does not mean the sandbox has stopped.
The lender must confirm cleanup separately. Requests already sent and copies
already shared cannot be recalled.

## Where credentials live

The intended setup keeps saved agent credentials on the lender's host.
A credential proxy supplies narrowly scoped model access without handing the
job a reusable host login. The job can still spend allowance through that
proxy; hiding the secret does not remove that authority.

Credential handling depends on the agent and sandbox runtime. Check the review
card's credential disclosure before lending. Faravan does not guarantee that a
job cannot reach your reusable agent sign-in. The job can use your provider
allowance.

Device signing keys and the circle owner's membership-signing key are separate
from provider credentials. The key files described here have owner-only
permissions, but the circle owner's key is stored unencrypted beside the device
key. Protect the computer and its backups: someone with that key can change
circle membership. Keep invitation links and local sign-in URLs private.

## Invitation links

A circle owner shares a short link, `https://queue.example/i/CODE#SEED`, or a
long link, `https://queue.example/join#invite=...`. Treat both as secrets: the
seed in the fragment lets whoever holds it request to join the circle.

What the queue server learns from a short link: the public, root-signed
invitation and a binding signature over it (both are public by design), the
`CODE` when someone looks it up, and the source address of each lookup. The seed sits after the `#`, which browsers do not send in HTTP requests.
The shipped landing page, the app and the command line keep it out of requests,
logs and referrers. This protects
the seed only when the code handling the link is trusted. A dishonest queue
can replace its landing page with JavaScript that reads and sends the fragment.

The code is 10 base32 characters, 50 random bits from the system's secure random
source. It is a lookup key, not a password. The server limits public lookups to
30 per minute per source, so guessing is impractical. A guessed code still gives
an attacker only a public invitation they cannot use without the seed.

The attack the binding stops: a short link names the invitation by code, so the
server (or a machine in between) chooses which invitation the joiner receives. A
dishonest server could return its own invitation, signed by a root key it
controls, and copy the real `invite_public_key` into it. Checking only that the
seed matches that key would pass, and the joiner would trust the attacker's
circle. To prevent this, the owner's device signs the exact invitation with the
one-time invite key, and every joiner (command line, app, landing page) rebuilds
that key from the seed and checks the signature before trusting anything in the
invitation, including the circle's root key. When a trusted app or command line handles the link without first opening
the queue-served page, the server does not receive the seed and cannot make
that signature. A long link carries the whole invitation in the
fragment and needs no lookup.

Limits. Anyone who holds the link can do what the link allows, including
creating a binding. A queue that captures the seed through its landing page
can bind a replacement invitation to its own root. Browser checks on a page
served by that queue cannot prevent this. Protection requires an independently
trusted verifier, or an owner-root fingerprint carried in the original link
and checked by the trusted app. Another option is a long link opened directly
in the app, without visiting queue-served content. The landing page shows the owner's name only after it has
checked the binding in the browser; a browser without Ed25519 support shows no
name and leaves the check to the app. The name is the one the owner typed (or
their computer account's full name), signed by the circle root: it proves the
circle owner chose it, not who that person is. `faravan open-link` receives the link on
its command line, so other programs running as the same user can see it in the
process list for a moment; the default invitation admits one computer within 24 hours. A group invitation admits up to ten computers within 24 hours. Anyone with the whole link can use it until then.
The deep link never joins by itself: the app shows the circle and asks first.

## If you send a job

**The lender can read and keep your source and prompt.** The host can read
submitted source, prompts, transcripts and results. By default, all current
circle members can read shared jobs and files. The optional frozen-audience
setting excludes devices that join later. It does not hide work from the host
or original recipients, prevent copying, or prevent access through another job
that shares the same artifact. Use separate circles when the audience differs.

Before an artifact is referenced by a published job or result, only its uploader
and devices that completed their own verified upload can read or reference it.
Removal closes that device's active downloads; bytes already received cannot be
recalled.

By default, each device can retain 1,000 jobs within the circle's 10,000-job
allocation. Cancellation does not release a retained slot. New jobs can expire
at most seven days after creation and seven days after publication. The host can
configure smaller or larger limits, but a device's allocation stays below the
circle allocation when it has more than one slot. At capacity, a new submission
can retire a finished job from a removed author before the usual 30-day retention
ends. Other retained jobs keep the existing retention and deletion rules.

Review what you send and remove secrets. Folder packaging is not a guarantee
of secret detection. Revoking access cannot erase copies already received.
Encryption that hides inputs from the queue server is planned for v1.x; it is
not present in v1.0.

### What a signature tells you

A verified signature identifies the signing device and binds the signed
content to it. Root-signed membership lists, checked against a trusted invite
or provisioned root, stop the queue server from inventing members or rosters.
With those keys protected and verification intact, the server cannot forge
a member's job or result, or change bytes under a trusted hash undetected.

A signature does **not** prove that code is safe or correct, a particular model
ran, resource limits held, or the lender told the truth. The lender's reports are
self-reported. The queue can withhold work, source or results, lie about status,
show different views, and delay newer membership information until an older
signed list expires. It can also cause duplicate execution. One accepted result
depends on an honest queue server; it is not a promise of one execution.

The [client](protocol/client.md) checks that a result, its job and its artifacts agree.
It does not keep an independent record of which run produced a result, and a run
reported by the queue server cannot prove which execution to trust.

## Treat returned files as untrusted

The CLI saves patches without applying them, and extracts gzip candidates into
an empty directory. The [archive policy](protocol/v1.md#9-artifacts-and-archive-policy)
requires more: check signed hashes and sizes; reject links, special files,
path escapes, duplicate or colliding names and path-changing tar headers; cap
expanded size, entry count and depth; strip unsafe metadata and executable
bits; and never run project hooks automatically.

**Faravan does not guarantee that extracting a returned archive is safe.** An archive can
carry executable bits, Git metadata, extended tar headers, deep or colliding paths and data
that expands to a large size. Do not treat extraction as safe inspection.
Do not enter a returned directory and run Git, scripts, installers or project
automation. Review returned content in an isolated disposable environment
before testing it. Check the changes and tests before using any result,
including one with a valid signature.

## Known limits and evidence

- Faravan lends from Linux computers and borrows from Linux and Apple silicon Macs.
  Windows and Mac lending are not supported. [What works today](STATUS.md) lists the
  limits.
- Faravan does not prove that a sandbox cannot be escaped or that a job cannot reach
  the lender's agent sign-in. Treat every job as code from another person.
- Extracting a returned archive is not safe inspection. See the advice above.

## Report a vulnerability

**No private reporting address is published yet.** Until one is, ask the person who
invited you to pass a report to the maintainers. Do not post
secrets or a working exploit in a public issue. Include the affected revision,
platform and sandbox version, what you expected, what happened, and a minimal
redacted reproduction. Do not send keys, invite links, session URLs or private
source. No response-time commitment exists yet.
