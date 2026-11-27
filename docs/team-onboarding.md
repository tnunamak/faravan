# Join the Faravan team preview

Start by borrowing: install Faravan, join the private group your friend invited you to, and send a small task. Lending your own computer is optional and comes later.

- **Circle:** the private group you share work with.
- **Borrower:** the person sending a task.
- **Lender:** the person whose computer runs it with their agent.
- **Host:** the computer that stores the circle's jobs and results. It must be online to send work or retrieve results.
- **Circle owner:** the person who manages membership. The owner, host and lender need not be the same person or computer.

## Choose your route

1. **Borrow only (start here).** [Install on Linux](#install-on-linux) or [Install on Mac](#install-on-mac), then [join the circle](#join-the-circle), then [send a job](#send-a-job-and-find-the-result). You do not need Docker or your own AI sign-in.
2. **Lend as well (optional).** Finish the borrow route first. Then follow [Optional: prepare to lend](#optional-prepare-to-lend) and [Turn lending on and choose a mode](#turn-lending-on-and-choose-a-mode).

If you only borrow, the Home page can still show **Jobs can’t start** and setup items such as **Free disk space** under **Needs your attention**. Those items are about lending from this computer. You can still send jobs.

Reading on a phone, tablet or another computer? Install and open Faravan on the supported Linux computer or Mac that will run it. Then use [paired browser access](#check-your-own-computers-from-your-phone). Joining a circle and pairing a device are separate actions.

Use [Install Faravan](install.md) for the Mac and Linux desktop installation steps. Lending setup is separate.

## Install on Linux

Follow [Install Faravan on Linux](install.md#linux), then [join the circle](#join-the-circle).

## Install on Mac

Follow [Install Faravan on Mac](install.md#mac), then [join the circle](#join-the-circle).

## First open

Keep any one-use local sign-in link private. The browser page controls Faravan on this computer; it does not create a Faravan cloud account. Fresh settings save lending as On with automatic rules for applicable new circles, but execution begins disabled until setup, an approved circle and a ready selected agent permit it. If you only borrow, turn Lending off and confirm the displayed state. Older installations keep saved choices. Next, [join the circle](#join-the-circle).

## Join the circle

1. Open **Circles**. Choose **Join with an invitation**. Paste `<INVITE_LINK>` into **Invitation**. Use the real invitation your inviter sent, not this placeholder.
2. Choose **Review invitation**. Check the inviter, circle name, expiry, and sharing disclosure. Choose **Not now** if anything is unexpected.
3. Choose **Join circle** only when the details match. Opening or reviewing an invitation does not join the circle. Approved membership can start lending under saved On choices only when the required setup and agent are ready.
4. If the circle asks for approval, compare its **Match code** with the circle owner through your trusted conversation. The owner opens **Settings → Waiting to join** and chooses **Approve [computer name]** only after checking the code.
5. If the host must come online, wait for it. Choose **Check approval** when offered. If Faravan says the join is saved and will retry, check the circle status before trying another invitation. Pending or unknown membership is not approved membership.
6. Wait for the circle to show you as approved before you send work. Keep the full invitation out of support messages and screenshots. Default invitations last 24 hours and admit one computer. Group invitations can admit up to ten. Ask your inviter for a new invitation if yours has expired.

## Send a job and find the result

Before you send: your prompt, selected files and returned results are shared with the circle. By default, the lender, host and all current circle members can read them. Remove passwords, tokens and other secrets yourself; filename filtering does not inspect file contents. A shared copy cannot be recalled. Treat returned text and files as untrusted.

1. Open **Send a job**. Start with a small task that contains no private information. Use **No project** for a question or writing task; the project section shows **Just your prompt**. A good first task is: "In three sentences, explain what a Git branch is." A lender must be online for the job to run. If none is, the job waits.
2. Select the circle in **Circle**. Write the task in **What should the agent do?**. Choose an **Agent**, or use **Let the lender choose**. With **Let the lender choose**, the lender sees one request for each agent they lend; approving one runs the job. Review the prompt, files, and circle before sending. Each lender chooses the model and effort; **Run settings** explains these choices. The host confirms availability when you send.
3. Use the submit control to send the job. The first-send confirmation is **Before your first job goes to a friend**. Read it, then choose **Send job** to continue or **Not now** to go back. The lender may need to approve the job. A submitted job has not necessarily started.

   If sending shows **Checking whether it was sent…** or **Waiting to send…**, your request may already have been sent or the host may be busy. Keep the page open while Faravan checks; while it is busy, Faravan will retry this same request, and your request and destination stay locked until the outcome is known. After a reload, check **Jobs** before preparing another request. Do not create a duplicate request for work that may already be running.

4. Open the job under **Jobs** to read its progress and returned message or files. For the first task above, success is the state **Ready to review** and a three-sentence answer in that same job. No Git or branch is involved. The host must be online to send jobs and fetch results. If work is still running, follow the same job instead of sending it again.
5. Treat returned text and files as untrusted. Review them before use. Depending on the result, choose **Download image**, **Download file**, **Download all files**, or **Download changed files**. **Download Markdown** saves the returned message. For code changes, choose **Download the patch** or **Add as a branch…**. In **Add as a branch**, review **Branch name** and choose **Add the branch**. **Add as a branch** creates a separate branch and leaves your checked-out files alone. **Apply to working tree** previews which files will change and writes the files you confirm into your current project folder. That action leaves the changes uncommitted. Review and test your changes before merging or committing.

## Check your own computers from your phone

1. On the awake computer running Faravan, open its device-pairing settings, turn on device access and select an address the other device can reach.
2. Choose requests-only access, or full-app access if offered. Plain HTTP can view requests, not answer them; answering needs trusted HTTPS. Full-app access requires trusted HTTPS or a Tailscale address Faravan confirms. It does not grant actions reserved for the host, including pairing other devices.
3. On the other device, scan the QR code or open the displayed address, then enter the eight-character code. Dashes and letter case do not matter. Compare the three words on both screens before confirming on the host.
4. Each browser connects directly to its host, without a Faravan relay. Keep the host awake and reachable. There are no device notifications yet. Removing a device from the host's paired devices signs it out immediately.

For HTTPS, supply a host name and certificate file paths in the host's connection settings. The other device must trust that certificate. Faravan does not configure your network or create the certificate. Do not proceed through a browser certificate warning.

The phone browser can view job and request status. Answering requests requires a connection with an HTTPS certificate the phone trusts. With HTTP, viewing is the only available action.

## Stop

1. **A job you sent:** open it under **Jobs** and use its stop control. In **Stop this job?**, choose **Stop job** to confirm or **Keep going** to leave it running. Before a job starts, the dialog is **Cancel this job?** with **Cancel job** to confirm. If it started since the last check, cancellation also asks it to stop.
2. **A job running on your computer for a friend:** on **Lending** or **Home**, choose **Stop this job…** or the stop button named for your friend. In **Stop this job?**, choose **Stop job** to confirm or **Keep going** to leave it running. Faravan asks the agent to stop, returns the work done until then, which may be nothing, and turns lending off. To lend again, turn lending on under **Lending**.
3. A stop request is not confirmation. Keep the same job open until its status confirms the stop; only the computer running the job can confirm that it stopped. A graceful lender stop can return work done so far; other stopped outcomes may not preserve changes.
4. To prevent new jobs without stopping a running one, turn lending off under **Lending**. A running job may finish.
5. If the person lending stops your job, your job says so: either **Didn’t finish** with “[name] stopped this run”, or the result with “[name] stopped this job early. This is the work done until then.”

## Optional: prepare to lend

Turning on lending lets a friend's jobs run on your computer, using your subscription account under your name with your AI provider. A sandbox is meant to keep each job from reaching the rest of your computer. It does not hide what a job sends or produces from you, your AI provider, or logs on your computer.

**Before lending:** a friend's job runs under your AI provider account and can spend your allowance. A sandbox does not guarantee that the job cannot escape or reach your reusable agent sign-in. The borrower receives the job's returned message and files; malicious job code could expose information it can reach through that output. No daily job count or daily minute cap is set by default, although individual jobs still have limits. Review the saved approval rules and limits before allowing work. Only lend to people you trust.

You make two choices: how much allowance to lend (**Automatic** or **Fixed share**) and whether jobs may start automatically or must wait for your approval. Read **What lending means** in **Setup** before you turn lending on.

1. Open **Setup** to prepare lending. Read **What lending means**. Open **What Faravan checks** to see **Your setup**. Fix the first item marked **Needs you**. Later checks wait for earlier ones.
2. If Docker Sandboxes is missing, use the separate installation section below. If it is installed but stopped, open and start it on this computer, then return to Setup.
3. Under **Connect your sandbox account**, complete the Docker sign-in offered by the app. **Create a Docker account** is available if you need one. The page shows **Checking automatically…** while checks are active.
4. Follow the current step shown in **Setup**; the next step becomes available after the earlier checks finish. When **Try a protected job** appears, follow its test action and wait for the result. Do not treat starting the test as passing it. If the check fails or remains unconfirmed, leave lending off and send the inviter the step name and redacted message. Open **What Faravan checks → Details** to review the protection results. Use **Copy details** if that action is offered.
5. Complete the Claude Code or Codex sign-in step if Setup requires it. If the app says sign-in is unavailable, leave lending off and ask your inviter. Do not assume that a previous sign-in passed the preview's checks.

   Finish the sign-in in the provider's browser page, then return to Faravan. If **Paste the code Claude shows you** appears, paste that code into Faravan and choose **Finish sign-in**. If you see **Continue sign-in in this tab**, it opens the existing sign-in's progress page. Do not start another flow just because waiting takes time. On that progress page, **Check now**, when shown, checks the existing flow; a cancellation is not complete until Faravan confirms it.

   Being signed in does not by itself mean this account can lend. If lending checks are not confirmed, open Lending and follow the explanation and recovery steps shown there. If the displayed explanation says your account or plan cannot lend yet, leave lending off; do not repeatedly sign in as a substitute for resolving that limitation. You can still borrow after your circle membership is approved.

6. To lend, join the circle and wait for approval first (see [Join the circle](#join-the-circle)). Open Lending and choose the installed agent you intend to lend, keeping lending off. Return to Setup, complete the required checks, and wait until the selected agent’s lending checks are confirmed and **Your computer is ready** appears. Review your saved choices, then turn lending on.
7. If you only borrow, you can skip all of this. Home can still show **Jobs can’t start**; that message is about lending from this computer, and you can still send jobs.

If your screen differs from these directions or shows an error you cannot resolve, stop and send the inviter the step name and redacted message, not the private invitation or sign-in link. Joining and being approved are separate steps; do not send work until membership is approved.

## Docker Sandboxes installation (terminal step for lending)

Skip this section if you only borrow. On a Mac, open **Setup** and choose **Install the sandbox**. Then choose **Sign in to Docker** and **Sign in to your agent**. Faravan runs the protected test automatically after the sign-ins. On Linux, follow the package installation instruction shown in Setup.
On the computer running Faravan, open Terminal and run only that release's Docker Sandboxes installation command. Return to Setup afterward.
If installation fails, leave lending off. Return to Setup, follow its current recovery action, and keep the installer error for support. No in-app replacement for the failed installer is available. Do not improvise repair commands.

## Turn lending on and choose a mode

1. Wait for Setup to pass and for circle membership to be approved. On Home, **Turn lending on** enables lending with your saved choices. Open **Lending** to review them first. In Setup, **Open Lending** appears when lending is already on. **Change these** opens the lending limits. Review the circle, agent, approval rules, and limits before enabling lending.
2. Return to **Lending**. Under **Agents you lend**, select the agent you want to share using its **Lend with …** switch, if offered. Wait for its check to finish; being signed in or selected does not by itself mean it is ready. A sign-in marked **For your own jobs** is not lent. Under **Lends to**, choose your approved circle. Open **Edit lending limits** and review the limits before turning on **Lending**. If the agent or circle is unavailable, leave lending off and ask the inviter. To change circles, turn lending off and wait for any running job to end.
3. A new installation uses automatic approval for new circles. When a new computer adopts a circle and the default rule covers an available agent and current member, that person's job may start without another prompt once setup, readiness and lending conditions permit. A member or agent not covered by a rule is shown to you first. Open **Review request** on Home or **Review** on Lend. Read the request and safety details. Choose **Run it** to approve, **Not now** to leave it pending, or **Decline** to remove it from this computer. Other lenders can still take a declined request.
4. Under **What you lend**, choose **Edit** to open the limits. **Automatic** lends what the app estimates you probably will not use before your quota resets. It does not guarantee a particular allowance for your own work. Under **Who**, review the people and agents covered by each saved rule. A friend without a matching rule is shown to you first. To review every matching job, set the circle to **Ask me each time** before choosing an agent to lend. An older setup may instead show **Requests**; choose **Ask me first** to stop its saved automatic approvals. Review **Account plan and consent** before allowing jobs without asking.
5. **Fixed share** uses **Share of each week friends can use**, entered as a percentage. The page describes a default share of 20% of weekly quota and 30% kept for your use. Review the saved **Lending explanation** and choose **Save** after changing limits. Confirm the allowed minimum and maximum with your inviter before changing this value.
6. Lending uses the available allowance estimate. A new account can lend without history; older readings keep their age and missing readings use the starting estimate. History improves that estimate. An unavailable usage check alone does not pause lending. Saved limits and actual account, sandbox and authority failures still apply; follow the action shown for a failure.
7. Turning lending on uses the saved approval mode and limits. A ready computer does not override your saved Off choice. Keep lending off when readiness or sign-in is uncertain.

## Get help

1. Ask your inviter for help. Give the platform, preview label, job identifier if relevant, and error text. Do not send passwords, sign-in links, invitation links, or sign-in codes. A circle **Match code** is only for checking membership directly with its owner.
2. In Setup, inspect **What Faravan checks → Details**. Use **Copy details** when offered. Circle invitation errors also offer **Copy details**.
3. Open the support section under **You → Your data**. Preview the support export or refresh its existing preview, then save an archive if needed. The preview is separate from the archive. Saving downloads to your computer and does not send anything to support. Inspect the archive itself and redact private information before sharing.
4. If Docker, Claude Code, or Codex sign-in stalls, finish any pending provider browser step first. Do not start a second sign-in while the first may still be running. Keep lending off and tell your inviter which sign-in failed.
5. On Mac, ask the inviter for this release's configured data home. The launcher log is `v1/logs/launcher.log` beneath it. A labeled Mac preview may use `~/Library/Application Support/Faravan Preview LABEL`; stable installations may use `~/.faravan` or an older `~/.faravan` data folder. Do not assume a stable path belongs to your preview. In Finder, choose **Go → Go to Folder** and enter that path without the file name. The launcher writes this log only when it has something to report, so a missing log after a normal start is expected. If the log is missing after a failed start, report that along with the release name and the exact alert or error text; do not keep reopening Faravan to generate a log. Review the log before sharing it and remove secrets, sign-in/invitation links or codes, tokens, and unrelated private details. Do not send the entire data folder.
6. On Linux, send your inviter the distribution/version and the last lines the install command printed, or the visible error text. If Faravan cannot open, say which install or open step failed. Do not delete data or repeatedly open the app to produce diagnostics.

A quick guide to the most common problems:

| What you see | Safe check | What to expect | If it does not clear |
|---|---|---|---|
| Joined, but cannot send | Open **Circles** and read the membership state | **Approved** before you send. **Pending** is not approved | Ask the circle owner to approve your **Match code**, and check that the host is online |
| **Checking whether it was sent…** or **Waiting to send…** | Keep the page open, then reload and open **Jobs** | The job appears once, or Faravan retries the same request | Do not send a copy. Send your inviter the job identifier |
| Job stays **Waiting** | Open the job and read its status line | A lender must be online and, if asked, approve it | Ask the person lending to check their lending page |
| **Stop not confirmed** | Open the job and read the status line again later | The lender's computer confirms the stop | Send your inviter the job identifier |
| Install command stops | Read the `no` lines it printed | Nothing is installed when it stops | Send your inviter the last lines it printed |
