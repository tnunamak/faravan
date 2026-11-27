# Linux preview quickstart

Use this guide when your inviter sends you a private Faravan preview invitation.
After installation, joining a circle and sending a job in the desktop app need no Terminal. Lending setup and repair steps are separate.

You can also use [paired browser access](team-onboarding.md#check-your-own-computers-from-your-phone) from a phone, tablet or another computer once Faravan is running on this supported desktop. Pairing does not join a circle.
This is not a phone installation or remote-control guide.

## Install and open Faravan

Follow [Install Faravan on Linux](install.md#linux). It uses your desktop's software installer and needs no Terminal. Before replacing an earlier preview, finish its jobs and quit it. Keep its data and backups. Ask your inviter for help moving data from a dated preview.

## Join and borrow

1. Open **Circles → Join with an invitation** in Faravan.
2. Paste your private invitation and choose **Review invitation**.
3. Check the inviter and circle, then choose **Join circle**. This submits a request; it does not approve membership. If approval is needed, compare the **Match code** directly with the circle owner. Ask when the host will be online if it is offline, then choose **Check approval**. Wait for approved membership before sending work.
4. If you only borrow, confirm that **Lending** is off. Fresh saved On settings do not let jobs start until setup, approved membership and a ready selected agent allow them. Follow [Send and review a job](getting-started-with-a-friend.md#send-and-review-a-job) for your first job.

Borrowing needs no Docker Sandboxes or AI provider account. Git is needed only for the Git-project path; **No project** jobs do not need Git.
If the screen differs, stop and send the inviter the step name and redacted message.

## Docker Sandboxes installation (lending only)

Skip this section if you only borrow. To lend, follow **Prepare Docker Sandboxes for friends’ jobs** in **Setup**.
Use **Copy install command** if shown, or the installation link shown there. On this Linux computer, open Terminal and run only the Docker Sandboxes installation command for this release.
Return to Setup when installation finishes. If installation fails, leave lending off and ask your inviter; do not improvise repair commands.

## Optional: prepare lending

**Before lending:** a friend's job runs under your AI provider account and can spend your allowance. A sandbox does not guarantee that the job cannot escape or reach your reusable agent sign-in. The borrower receives the job's returned message and files; malicious job code could expose information it can reach through that output. No daily job count or daily minute cap is set by default, although individual jobs still have limits. Review the saved approval rules and limits before allowing work. Only lend to people you trust.

Follow the current step shown in **Setup**; the next step becomes available after the earlier checks finish.
Sign in personally through Setup. An existing sign-in outside this preview does not prove it is ready.
When **Try a protected job** appears, follow its test action and wait for the result.
If the check fails or remains unconfirmed, leave lending off and send the inviter the step name and redacted message.

Return to **Lending**. Under **Agents you lend**, select your agent with its **Lend with …** switch, if offered.
Wait for its check to finish. A sign-in marked **For your own jobs** is not lent.
Under **Lends to**, choose your approved circle. Open **Edit lending limits** and review the limits before turning on **Lending**.
If the agent or circle is unavailable, leave lending off and ask your inviter.

## Get help, update or remove

Send your inviter the release, Linux distribution/version, failed step and installer error. If Faravan opens, follow [Get help](team-onboarding.md#get-help) to preview support information; if it does not, in-app help is unavailable.
Never send passwords, tokens, private invitations, sign-in links, private prompts or whole data folders.
If migration or ownership is uncertain, stop retries and preserve the files.

Faravan updates itself between jobs. Before removing it, wait for jobs to finish or use their stop controls and confirm each job stopped. A request to stop is not confirmation.
Removing the program is not proof that its separately stored data was removed. Keep data and backups unless you deliberately choose to remove them.
