# People and circle authority

Update the host and **every member's Faravan app before first using person links,
roles, a backup steward, ownership transfer, archive or close**. Older members reject
the new signed membership fields. Existing circles keep their old format until an
owner uses these features. Ordinary invitation history and revoke keep their
previous compatibility contract. The owner app and host require capability declarations
for new features and grants. Removing or blocking people and revoking delegated
authority do not depend on member declarations, including declarations from other
members who remain in the circle. Open the updated app on each computer before
using other new features. Capability-only
heartbeats report support without turning lending on. Ordinary roster renewals
that carry unchanged fields remain available.

## One person, several computers

Members start as separate people. Matching display names or local nicknames never
merge identities. In Circle → Settings → Person identity, select the person's
original computer and the new computer. Both must already belong to the circle.
Create a proof on each computer for that same pair, then give both proofs to the
owner. The owner verifies them and links the computers. No private signing key is
exported or copied.

Both computers must have the same role and be unblocked before linking. A linked
computer cannot silently move between people. Each computer keeps its own key,
name and lending consent. Member pages combine the requests and runs available in
this computer's circle history, and show a lending cap for each of that person's
computers. These are this lender's local caps, not a circle-wide or cross-computer
budget.

## Roles and blocks

- **Owner:** manages roles, delegated authority and circle lifecycle.
- **Co-admin:** manages ordinary membership, circle details and invitations. Cannot
  change roles, owner or backup steward.
- **Member:** can ask for and run jobs, subject to local lending consent and limits.
- **Borrow only:** can ask for jobs; cannot claim new work to run.
- **Lend only:** can run jobs; cannot submit new requests.

Block pauses new requests and runs from every linked computer. It keeps membership
and shared history readable, and can be reversed. Jobs already running can finish.
Remove ends access and permanently revokes those enrolled computer identities;
they cannot rejoin with another invitation. Shared copies cannot be recalled.
No circle role can approve another person's lending or turn it on.

## Steward and transfer

Choose a backup steward's computer in Circle → Settings. A steward can manage
membership and invitations while the owner is away. They cannot transfer ownership
or grant circle authority. This is delegated membership administration, not recovery
of a lost owner key or migration of the host.

To transfer ownership, choose an enrolled computer and create a transfer code.
Share it privately. The chosen computer pastes it into Accept ownership and confirms
within 24 hours. Until acceptance, the old owner remains owner. The new owner signs
its acceptance; no private key is shared. Cancel outstanding transfer codes before
acceptance to invalidate their exported copies. Reopening the app does not make a
cancelled or expired code usable.

Owner, steward and co-admin grants are anchored to the original circle root by a
signed sequence of authority changes. Members retain the accepted sequence and
refuse older or forked authority. The host checks the predecessor again when it
commits a change. Authority changes retire unused invitations, including changes
that first enable this protocol. Approved computers stay enrolled; create fresh
invitations after the change. Hosting stays on the same computer after transfer.

## Separate exits

**Leave circle** stops this computer's lending, resolves recovery work, cancels its
waiting requests and forgets its membership locally. The owner must transfer
ownership or close the circle first. The leave request still needs the owner's or
an administrator's membership update; an offline host cannot confirm immediate
remote removal.

**Archive circle** stops new work while keeping shared history and current runs.
The owner can reopen it. **Close circle** permanently stops new work; it cannot be
reopened. Current runs can finish and history remains readable.

**Delete local data**, offered after closing, removes this computer's cached
membership, invitation history and circle signing data. It refuses pending recovery
or membership publication. It leaves the host's shared history and downloaded
results in place. **Stop hosting** is separate and affects every circle hosted on
this computer; it does not delete them.

Host migration, account recovery, and deleting the host's stored shared history
are not implemented by these controls. The host's existing job-retention and
per-job deletion rules still apply.
