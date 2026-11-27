# Join a friend on Mac

This guide is for an Apple silicon Mac running macOS 14 or later. The preview is distributed as an unsigned ZIP: the app is ad-hoc signed, but has no Developer ID signature or Apple notarization. This Mac borrows and lends: join a circle, send a job, get the result, see a lender stop it, and lend your own Claude Code or Codex allowance. To lend, follow **Lend from this Mac** below.

You do not need a Faravan account, Docker Sandboxes, or a Claude Code or Codex account to borrow a friend's agent. On another computer, tablet or phone, use [paired browser access](team-onboarding.md#check-your-own-computers-from-your-phone) after Faravan is running here; pairing does not join a circle.

## Install and open Faravan

Follow [Install Faravan on Mac](install.md#mac) for the download, Applications, macOS approval, and Local Network steps. No Terminal or manual checksum step is needed to install and borrow.

## Review and join the invitation

1. Get the private invitation from your friend. Copy it.
2. In Faravan, open **Circles → Join with an invitation**. Paste the invitation and choose **Review invitation**.
3. Check the circle name, inviter, and sharing details. Choose **Join circle** only if they match. Opening or reviewing an invitation does not join by itself. If this Mac should only borrow, confirm **Lending** is off; saved On becomes effective only after setup, an approved circle and a ready selected agent allow it.

If you would rather start from the invitation link, the landing page may differ from the labels below. Ask the inviter if it does. Open the link in the browser on this Mac and check that the page names the expected inviter and circle. Choose **I already have Faravan**. The page tries to open the app, then shows a copy-and-paste fallback. This Mac preview does not register the `faravan://` link handler, so use the fallback even if the browser reports that it is opening Faravan. Choose **Copy invitation**, or select and copy the full invitation shown, then continue at step 2.

Joining submits a request; it does not approve membership. If the membership card asks the owner to approve this computer, send the owner the match code shown on your screen. The owner should open the circle's **Settings** tab, compare the code in **Waiting to join** with the code on your screen, then choose **Approve [computer name]**. If the card says the host's computer will add you when it is online, wait for that computer to come online. If Faravan cannot reach the host, it will retry; choose **Check approval** when the host is available.

If your screen differs from these directions or shows an error you cannot resolve, stop and send the inviter the step name and redacted message, not the private invitation or sign-in link. Joining and being approved are separate steps; do not send work until membership is approved.

## Send a job

Before you send: your prompt, selected files and returned results are shared with the circle. By default, the lender, host and all current circle members can read them. Remove passwords, tokens and other secrets yourself; filename filtering does not inspect file contents. A shared copy cannot be recalled. Treat returned text and files as untrusted.

1. Choose **Send a job**, then **No project**.
2. Choose your friend's circle and an agent it offers. If no suitable agent is available, ask your friend to check lending before continuing.
3. Enter: “In three sentences, explain what a Git branch is.” Review the prompt and circle, then use the send control. At the first-send confirmation, choose **Send job**. The lender may need to approve it.
4. Follow the same job under **Jobs**. It may show **Waiting**, **Starting** or **Working**. If progress stops, follow its recovery action, then keep its ID, state and redacted message for support. Do not send a duplicate.
5. Your first success is **Ready to review** with an answer in **What changed for you** or **Agent response**. Read the answer. No project, Git or branch is needed. For your next job, follow [Send a job and find the result](team-onboarding.md#send-a-job-and-find-the-result) to send a project or download files.

The result is not merged into your project automatically.

## Lend from this Mac

Skip this section if you only borrow. Lending on a Mac needs the sandbox and a free Docker account. Setup installs the sandbox for you.

1. Open **Setup** and choose **Install the sandbox**, then **Sign in to Docker**. Finish the sign-in in your browser and return to Faravan.
2. If the sandbox is already installed, Setup uses it and skips installation. After both sign-ins below, Faravan runs the protected test automatically.
3. In **Setup**, sign in to Claude Code or Codex once. Faravan opens the provider's sign-in page. If it shows **Paste the code Claude shows you**, paste the code and choose **Finish sign-in**. That one sign-in serves both your usage readings and the jobs you lend.
4. Follow the rest of **Setup**. Wait for the protection check to pass before you lend. A check that is still running has not passed. Then turn lending on as described in [Join the Faravan team preview](team-onboarding.md#turn-lending-on-and-choose-a-mode).

## Get help

If the browser page or menu bar icon is missing, contact your inviter with what appeared, your macOS version and package filename; do not keep reopening it. If there is no Quit control, ask the release owner for help stopping it rather than repeatedly launching it. Send the existing launcher log after reviewing it for private information, or report that no log exists.

Ask the inviter for this release's configured data home. The launcher log is `v1/logs/launcher.log` beneath it. A labeled Mac preview may use `~/Library/Application Support/Faravan Preview LABEL`; stable installations may use `~/.faravan`. Do not assume a stable path belongs to your preview. It keeps launch/tray diagnostics, not a complete job transcript or a capture of all standard output/error. When it exceeds 1 MiB, it is trimmed to the last 512 KiB. It may miss failures before logging starts. Error messages are not generally redacted: do not send passwords, sign-in or invitation links/codes, tokens, or unrelated private paths. Ask the owner to locate the configured data home if the file is absent; do not retry merely to produce a log.

## Connect a local MCP client

If you want Claude Code, Codex, or another local desktop client to control Faravan, use the [MCP quickstart](mcp-quickstart.md).
