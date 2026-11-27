# Use Faravan with a friend

After installation and download verification, joining a circle and sending a job in the desktop app need no Terminal. Lending setup and optional command-line setup are separate; repair steps may also need Terminal.
For the current team invitation, also follow [Join the Faravan team preview](team-onboarding.md).
This is the borrowing walkthrough for the desktop app. On a phone, tablet or another computer, use [paired browser access](team-onboarding.md#check-your-own-computers-from-your-phone) after setting up a supported desktop. Joining a circle and pairing a device are separate actions.

Reading on a phone? Install and open Faravan on the Linux computer or Mac you intend to use.
This is not a phone installation or remote-control guide.

## Install on Linux

Follow [Install on Linux](team-onboarding.md#install-on-linux) in the team guide. Before replacing an earlier preview, finish or confirm the stop of its jobs, quit it, and preserve its data and backups. If it cannot quit or its data location is unclear, stop and ask your inviter.

## Install on Mac

1. Use an Apple silicon Mac with macOS 14 or later. Open the [public preview download list](https://tnunamak.github.io/faravan-updates/preview/update.json). Find the Apple silicon Mac download, labeled **Darwin arm64**, and download its `Faravan-mac-arm64-<version>.zip` file. Keep the list open to compare its `sha256` value for that Mac file. If the Mac entry or ZIP is missing, stop and ask your inviter. Private repository access is not required.
   Before extracting or opening the ZIP, follow [Check the download](mac-quickstart.md#check-the-download-terminal-step). If you cannot verify the exact file, stop.
2. In Finder, open **Downloads** and extract the ZIP. Drag **Faravan.app** into **Applications**, then open it from there.
3. The app in the unsigned ZIP is ad-hoc signed, but has no Developer ID signature or Apple notarization. If macOS blocks the first open with an unverified-app warning, dismiss it. Open **System Settings → Privacy & Security** and choose **Open Anyway** for Faravan under **Security**. Authenticate if asked, then choose **Open**.
4. If **Open Anyway** is unavailable, or macOS says the app is damaged or contains malware, stop and contact your inviter. Do not disable Gatekeeper or remove quarantine attributes.

Follow the [Mac quickstart](mac-quickstart.md) if the app does not open.
The Mac app borrows and lends. To lend, see the [Mac quickstart](mac-quickstart.md#lend-from-this-mac).

## Join your friend's circle

Borrowing does not need Docker Sandboxes or an agent account.
Git is needed only for the Git-project path; **No project** jobs do not need Git.

The landing page may differ from the labels below. Use the paste-in route if opening the invitation does not open Faravan.

1. Get a fresh private invitation from your friend. A circle's public address is not an invitation.
2. Open **Circles → Join with an invitation** in Faravan. Paste the invitation and choose **Review invitation**.
3. Check the inviter and circle, then choose **Join circle**. If you only borrow, [check that Lending is off](team-onboarding.md#turn-lending-on-and-choose-a-mode); fresh saved On settings do not let jobs start until requirements are met.
4. Joining submits a request; it does not approve membership. If approval is needed, compare the **Match code** directly with the circle owner. Ask the owner to check the request and ask when the host will be online if it is offline. Choose **Check approval** when the host is available. Wait for approved membership before sending work. The host must be online to send jobs and fetch results.

Keep invitation links and sign-in codes private. If your screen differs, send the inviter the step name and redacted error.

## Send and review a job

Before you send: your prompt, selected files and returned results are shared with the circle. By default, the lender, host and all current circle members can read them. Remove passwords, tokens and other secrets yourself; filename filtering does not inspect file contents. A shared copy cannot be recalled. Treat returned text and files as untrusted.

1. Choose **Send a job**, then **No project**.
2. Choose your friend's circle and an agent it currently offers. If none is available, ask your friend to check lending. Your own provider sign-in does not supply a remote lender.
3. Enter: “In three sentences, explain what a Git branch is.” Review the prompt and circle, then send the job. At the first-send confirmation, choose **Send job**. The lender may need to approve it.
4. Open the same job under **Jobs**. It may move through **Waiting**, **Starting** and **Working**. If progress stops, follow that job's recovery action; do not send a duplicate. Keep its identifier and a redacted message for [Get help](team-onboarding.md#get-help).
5. When **Ready to review** appears, open the same job and read **What changed for you** or **Agent response**. The prompt asks for three sentences; read the answer before using it. This first task needs no Git project or branch.
6. For your next job, follow [Send a job and find the result](team-onboarding.md#send-a-job-and-find-the-result) to send a project or download files.

## Next: send a project

For a project check after the agent finishes, open **Check** and enter your project's command in **Test command**. Include any dependency installation the check needs: the returned source runs in a fresh sandbox. Asking the agent to run tests in the prompt alone does not configure Faravan's check.

Open **Job details** to review **What the agent is doing**, if shown. For files, choose the relevant download action: **Download image**, **Download file**, **Download all files**, **Download changed files**, or **Download Markdown**. For code changes, choose **Download the patch** or **Add as a branch…**. In the **Add as a branch** sheet, review **Branch name** and choose **Add the branch**. Adding a branch does not merge it. Inspect the changes and test the returned code in a disposable environment before merging.

For project work, select only the source needed for the task. Remove secrets before sending. The lender, host and circle members can read what you send. The result is not merged into your project automatically.
The composer has no network-policy picker. **AI provider only** names a narrower protection policy, not an option you can select in the composer. If the available policy does not fit your task, do not send it.

A passing Faravan check is not independent proof of correctness. The agent can change the tests, configuration and tools.
Review returned files as untrusted. A signature says who returned the result, not that the code is correct.

## Docker Sandboxes installation (lending only)

Skip this section if you only borrow. To lend, follow **Prepare Docker Sandboxes for friends’ jobs** in **Setup**.
Use **Copy install command** if shown, or the installation link shown there. On the computer running Faravan, open Terminal and run only that release's Docker Sandboxes installation command.
Return to Setup afterward. If installation fails, leave lending off and ask your inviter; do not improvise repair commands.

## Optional: lend back to your friend

**Before lending:** a friend's job runs under your AI provider account and can spend your allowance. A sandbox does not guarantee that the job cannot escape or reach your reusable agent sign-in. The borrower receives the job's returned message and files; malicious job code could expose information it can reach through that output. No daily job count or daily minute cap is set by default, although individual jobs still have limits. Review the saved approval rules and limits before allowing work. Only lend to people you trust.

Borrowing does not prepare your computer to lend. Sign in to Docker and your own agent through **Setup**.
Follow the current step shown there; the next step becomes available after the earlier checks finish.
When **Try a protected job** appears, follow its test action and wait for the result. If it fails or remains unconfirmed, leave lending off.

Under **Lending → Agents you lend**, select the agent with its **Lend with …** switch, if offered, and wait for its check.
A sign-in marked **For your own jobs** is not lent. Under **Lends to**, choose your approved circle.
Open **Edit lending limits** and review the limits. Start with **Ask me each time** so you review each job before it runs.
Turn on **Lending** only after the checks pass. Neither person signs in for the other.

If sign-in fails, finish any pending provider browser step first. Do not start another sign-in while one may still be running.
Leave lending off and send your inviter the step name and redacted error. Never send passwords, tokens, sign-in links or invitation codes.
