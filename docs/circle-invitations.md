# Circle invitations

The owner can open a circle's Invitations tab to see invitations created on this
computer, their expiry, and approvals confirmed by a signed member list. Links and private invitation
seeds are not included in that history. A link appears only when it is created.

The default invitation admits one computer within 24 hours. The group-chat preset
admits up to ten computers within 24 hours. Anyone with the whole link can use it.
Both presets keep lending off when a computer joins. The protocol currently caps
invitation lifetime at 24 hours; the proposed seven-day preset needs a separate
compatibility change.

Revoke stops new joins and declines requests still waiting for approval. Computers
already approved keep their access, and previously shared files stay shared. The
owner app stops approving from that invitation before contacting the host. If the
request fails or its reply is lost, history says “Revoke not confirmed”; retry it
to obtain confirmation. A confirmed revoke survives a host restart and cannot be
undone by publishing the same invitation again. A revoke also works if the
original publication never reached the host: it blocks a delayed publication.

History stays readable while the host is offline. Local confirmed approvals and
revokes remain visible; the waiting count says it is unavailable.

In a legacy circle, only the circle root can authorize a revoke. After delegated
circle authority is enabled, its current owner, steward or co-admin can authorize
one with their own device key. The coordinator verifies the authority and exact
revoke action inside the normal authenticated member request. Other member keys
cannot revoke invitations. The new route is advertised as
`invite_revoke_v1`; an older coordinator is refused with an update instruction.
Declining one join request uses the same signed authority on
`POST /enrollments/reject` (`enrollment_reject_v1`). The coordinator records the
decline, so the joining computer sees `rejected` and a roster signed before the
decline cannot admit it. With an older coordinator the decline stays on the
owner's computer and the request expires by itself.
Update the owner app and coordinator to use revoke. Existing members need no
update for legacy revoke. Enabling delegated authority changes the signed schemas
and requires the update described below.

Person links, roles, reversible blocks, backup stewardship and ownership transfer
are documented in [People and circle authority](circle-people.md). They require all
members and the host to update before first use. Authority changes retire unused
invitations; approved members keep access.
