# Hosting a v1 circle

Run `faravan host` (or `node bin/faravan host` from a checkout).
Hosting uses v1; the preview shared-token runtime has been retired.

## Local owner and server

1. Choose a name with `--circle-name Friends`, or answer the prompt.
2. Choose `--tunnel public`, `--tunnel private` or `--tunnel lan`. Public and private
   are requirements. In a terminal, select an eligible offer from Gozar and approve its
   exact disclosure. Each setup effect requires its own approval. If a step opens a
   browser, complete it there and rerun the command to let Gozar check the result.
3. The coordinator binds locally before Gozar checks the route. For an existing
   HTTPS address, pass `--origin https://your-address`. Its forwarding target is the
   coordinator's local port, 8787 by default. A port you chose explicitly must be free.
4. The owner device key and circle root stay in the local Faravan home. Once Gozar
   proves the address reaches this coordinator, Faravan writes signed provisioning
   into the local database. The host publishes the signed roster and registers an
   invitation before it reports ready.
5. An installed Linux user service supervises the default coordinator home. For other
   homes the command supervises the coordinator from the terminal. A durable offer can
   resume with its existing scope. An attached offer may require approval when the
   controller process restarts.

## LAN transport

LAN selection discovers a private IPv4 or link-local interface. A public
interface is skipped. HTTP LAN permission is recorded in signed
provisioning, roster, invitations and request proofs. Every request
remains signed and replay-protected. Joiners see:

> This circle uses your local network without encryption; people on the same network could read uploaded code.

For a manually selected LAN origin, `circle create ORIGIN --lan` also
allows valid .local names and link-local IPv6. Internet-facing HTTP remains
forbidden. LAN mode is a deliberate confidentiality trade-off, not TLS.

## Re-running and recovery

Re-run `faravan host` to retain the circle id, owner/root keys, local
database, roster history, jobs and approvals, and get a new invitation.
A running managed server is reused; a stopped one is started. Local
provisioning reopens and checks an existing database instead of replacing
it. The original epoch-one provisioning file must still be fresh when
creating a new server database; an expired bootstrap is not silently
trusted or renewed.

The signed origin is fixed. If Gozar returns a different address or withdraws
verification, Faravan withholds publication. Restore the saved address to resume.
Changes to the local port, audience, or offer require review so they cannot be
mistaken for a retry of the saved exposure.

Run `faravan host --stop` to stop the coordinator and ask Gozar to remove its
exact route. Follow any remaining setup cleanup instructions. Removing a route,
disconnecting a local credential, and revoking a provider credential are separate
actions. Retain the saved state if cleanup remains unconfirmed. Legacy exposure
records require review before migration. Faravan keeps the records and credentials
in place when it cannot establish ownership through Gozar.

Coordinator state defaults to `~/.faravan/coordinator`; owner state
defaults to `~/.faravan/v1`. Keep both private and back up the root key
securely. `FARAVAN_COORDINATOR_HOME` and `FARAVAN_HOME` allow separate
local instances. A v0 host directory is never converted in place; preserve
it and choose a new coordinator home for v1.

Invites are secret-bearing single-enrollment links. Share each privately
with its intended recipient. The signed display name is shown on join.
Inviting does not turn on lending. Approve enrollment with
`faravan circle approve --circle Friends`.

## Separate server

`faravan circle create https://queue.example --name Friends` creates
locally and prints the provisioning step when the server is unreachable.
On the server, run `faravan-coordinator --v1-provision FILE`, then start
with the matching `FARAVAN_COORDINATOR_V1_ORIGIN`.
The server accepts only the v1 protocol.
Old shared-token and unsigned roster settings do not enable preview routes.

## Retiring an old host

Before upgrading a preview host, stop accepting new work in the old version.
Let running work finish, fetch and verify its results with that version, and
reconcile every queued or claimed job with its borrower. Stop its coordinator
and lenders after reconciliation. This binary cannot drain or resume preview
jobs or convert their state. Keep an old checkout available until the
outstanding work is reconciled.

For evidence from the shipped preview at commit 78e592aa, import
`verifyLegacyEnvelope` from `lib/legacy-verify.mjs`. Pass the original canonical
envelope bytes and `{publicKeyPem, keyId}` from independently retained
historical key records. The result labels `legacy`, `expired`, `revoked`
(unknown unless supplied) and `execution_authority: false`. It checks a
signature, not v1 author/holder authorization, evaluation or payment. It
never imports an old roster, signs a new envelope or executes a job.

Back up the old host and member directories, including keys, jobs and results.
The app leaves old member configuration unchanged. Hosting refuses an old
host configuration instead of interpreting its keys or queue as v1.
Choose a separate private directory with `FARAVAN_COORDINATOR_HOME`, then
run `faravan host` to create a new circle and send new invitations.
Members join and approve devices through the v1 flow; no old membership or
job is imported. Keep outstanding recovery bound to the original circle.

The app provides explicit Docker, provider and GitHub sign-in and a confirmed
stop-now action. `faravan doctor --fix-policy` remains available. Automatic
lending still requires fresh quota and idle evidence; retiring the preview
does not establish schedule parity. Private Git/branch resolution and real
sandbox archive execution retain the limitations documented in the CLI,
lender and security references.

## Many circles on one coordinator (R1)

One coordinator process can serve several circles on one origin. Add each circle with
`faravan-coordinator --v1-provision-circle <provision.json>`; it is stored in
`<coordinator home>/v1/circles/<circle id>/` with its own `coordinator.sqlite` and `blobs/`. The
provision file may carry `quotas` (the store's limit names, for example `circleBytes`), fixed when the
circle is added. The coordinator picks a circle by the id in `/v1/circles/<id>/...`; an unknown id answers
`circle_not_provisioned`. A public invite code (`/v1/invites/<code>`) is looked up across circles, limited
to 30 lookups per minute per source. The single circle made with `--v1-provision` keeps working beside them.

## Keep-awake and wake gaps (H2)

While a computer hosts a circle and is on power, the host process holds an idle-sleep assertion (`systemd-inhibit` on Linux, `caffeinate -i -w <pid>` on macOS; nothing on Windows yet), tied to its own process so it cannot outlive it. It is on by default; the host config's `keep_awake: false` (set by `POST /api/hosting/keep-awake {on:false}` from the app) turns it off, and the host reads the file every few seconds, so no restart is needed. On battery the assertion is released and the computer sleeps as it normally would; a computer that cannot tell (a desktop) counts as on power. The status file carries `keep_awake: {enabled, active, reason}` (reason: `on`, `off_by_choice`, `on_battery`, `unsupported`) and, whenever the host finds its own five-second timer paused for more than thirty seconds, `last_wake: {at, gap_seconds}`. `GET /api/hosting` returns both (`keepAwake`, `lastWake`) for the host page's switch and its "the computer was asleep" banner.

## Several circles on one computer

After hosting the first circle, choose **Circles → Start a circle** or run
`faravan circle create --name 'Another circle'`. `circles.create` uses the
configured local host when its `origin` is omitted. `faravan host --new-circle
--name 'Another circle'` also creates a new circle, including when another
circle has the same name.

The original circle keeps its database at `v1/coordinator.sqlite`, its blobs
at `v1/blobs`, and its signed circle ID and origin. Additional circles live in
`v1/circles/<circle ID>/`, each with a database, blob directory and quotas.
They share the host's port and address. The router loads a new circle when
its first request arrives. An older single-circle process is stopped and
started automatically once; its data is not migrated. Stopping hosting
makes all circles on this computer unavailable.
For a host outside the installed service, automatic restart checks the process
command, configuration path and start time before stopping it. If those checks
cannot establish ownership, stop the old host and start hosting again.

**Circle → Settings** lets the owner set the name and an optional purpose.
The CLI equivalent is `faravan circles set-profile CIRCLE-ID --name 'New name'
--purpose 'What this circle is for'`. An empty purpose clears it. The root
signs these details in a new roster epoch; members adopt them only after
verifying that roster. Creating a circle and renewing a legacy roster keep
the previous wire format until the owner edits its details.

The host must advertise `circle_profile_v1` before the owner can publish
these details. Members also need a version that understands the optional
roster `profile` field; older members reject that new roster. Update the
host and member apps before editing details in an existing circle.

Lending uses one selected circle at a time. Turn lending off and use
**Lend → Lends to → Choose a circle** to change it. The server refuses a
change while a job or recovery is pending. Choosing a circle keeps lending
off; Home, Jobs and New job can still show work from every joined circle.
