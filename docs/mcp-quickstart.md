# Use Faravan from your AI app

You can ask your AI app to send tasks through Faravan and bring the results back to the same conversation. Install the exact preview your inviter names using that release's onboarding guide. On Linux, do not substitute the historical friend package or a bare faravan command for a labeled-preview launcher. On Mac, use the release-specific app and instructions. Then join your friend's circle (section 3 below, or in the app). You do not need Docker or your own provider account to use a friend's agent.

## 1. Connect Claude Code or Codex

**Before you connect:** a local MCP client acts with your Faravan authority. It can read Faravan information and request actions such as sending jobs or turning lending on. The client can supply confirmation itself, so a prompt to ask you is not an independent permission barrier. Connect only a client you trust, and allow only the project folders it needs. Sending a job shares its prompt and files with the lender, host and, by default, all current circle members. Remote ChatGPT uses a separate approval flow: each action, transcript read and apply preview needs local approval in Faravan. See its [separate connection guide](connect-chatgpt.md).

Open the project you want to work on in Claude Code or Codex. Paste this message into its conversation:

> Connect the installed Faravan app to this client as a local MCP server named faravan. On Mac, its command is /Applications/Faravan.app/Contents/MacOS/faravan. Use arguments mcp, --root, and the full path of the project open in this conversation. Preserve my other MCP servers and settings. Show me the change before saving it. Set Codex's tool_timeout_sec to 330. Tell me if I need to restart this client. After connecting, call circles_list and show which circles this computer has joined. Do not sign in, turn lending on, or send a task yet.

The agent applies the client configuration after you approve it. If it asks you to restart the client, close and reopen it, then say: **Check the Faravan connection and show my circles.** A successful connection lists Faravan's tools and your circles; it does not merely say that a configuration file was saved.

For a labeled preview, ask the inviter for the registered command that selects this exact preview and profile and supports MCP. Do not use the launch-only executable as an MCP server, and do not substitute /usr/bin/faravan or a bare faravan command unless the inviter confirms that it selects this installation. A successful connection must show the circles for this preview, not just a saved configuration.

No app token or provider password belongs in client configuration.

These clients support local MCP servers. See the [Claude Code instructions](https://code.claude.com/docs/en/mcp) and [OpenAI MCP instructions](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) for their configuration controls.

## 2. Other AI apps

**ChatGPT desktop:** Faravan does not document a local setup for it. Use the Claude Code or Codex path above.

**ChatGPT in a browser or Claude.ai:** these clients need an internet-reachable server URL. This preview does not provide a shared hosted Faravan connection. Use Claude Code or Codex for the local path. The [advanced ChatGPT connection guide](connect-chatgpt.md) describes the existing per-computer connection; it is not a one-click team setup.

Faravan does not yet have an in-app client picker or automatic MCP installation. The setup message above is the current path; it asks your agent to do the configuration instead of asking you to edit files or run setup commands.

## 3. Join your friend's circle

After your client connects, ask it to call `circles_list` to show circles already joined on this computer. If you have an invitation, the agent should:

1. Call `circles_preview_join` with the invitation `link`. Review the circle and inviter it returns.
2. Ask you before it joins. Only after you agree, call `circles_join` with the same `link`.
3. Call `circles_check` with the circle name. Continue only when `state` is `approved`.
4. If it is `pending`, open the circle in Faravan. If it asks for owner approval, compare its match code with the owner. The owner opens the circle's **Settings → Waiting to join**, checks the computer and code, and chooses **Approve [computer name]**. If the card says the host's computer will add you when it is online, wait for that computer.
5. If it is `unknown`, Faravan could not reach the host. Retry `circles_check` later. If it is `expired` or `rejected`, stop polling and ask the inviter for a new invitation.

A pending or unknown membership is not approval. Joining does not enable lending. If you are only borrowing, call `status_borrowing` (it needs a joined circle and nothing else) and skip `status_blockers`; that one checks what this computer needs in order to lend.

**Optional, lending only: sign-in recovery.** Keep the `flowId` from `signin_start`. Call `signin_wait` with it. `done:false` means the wait ended, not that sign-in failed. Read `flow.status` and `flow.message`. While the status is `starting` or `awaiting_browser`, keep waiting on the same flow and let the person finish the browser step. Call `signin_submit_code` only when `codeEntry` is `true`. To abandon a stuck flow, call `signin_cancel` before starting a new one. For `failed`, `timed_out` or `cancelled`, fix the reported problem first. Borrowers need none of this.

## 4. Send one job and follow it

Use `jobs_submit` or `jobs_send_and_wait` for a new job. The old `submit_job` tool is Git-only. Call `circles_compose` with the approved circle name first. It lists the agents and models the circle's lenders offer now. Use those exact IDs. `agents_list` describes the agents on this computer, not the circle's offers. If nothing suitable is offered, ask your friend to check their lending. Omit effort to use the lender default, or set a value supported by the selected model. Do not invent a model name or add a dollar cap unless you explicitly want that cap.

Example input for `jobs_send_and_wait`:

```json
{
  "circle": "EXACT_APPROVED_CIRCLE",
  "repo": {"path": "/absolute/path/to/project"},
  "prompt": "Fix the failing parser test and explain the change.",
  "harness": "EXACT_AGENT_ID",
  "model": "EXACT_SUPPORTED_MODEL_ID",
  "budget_v1": {"effort": "high"},
  "draft_id": "REPLACE-WITH-A-NEW-UNIQUE-JOB-ID",
  "timeout_seconds": 120
}
```

Use a new `draft_id` for each different job: 8 to 64 letters, digits or hyphens. Reuse it only to retry or reconcile the same send, because the same ID replays the same job. Before sending, review the prompt, source and recipient, because they go to the circle. Faravan may ask you in a dialog, or return `confirmation_required`. In that case, show the person the returned effect. Only after they agree, retry the same request with `confirm:true` and keep any returned `confirmation_input` fields. For a prompt-only job, use `"noSource": true` instead of `repo`. Files, ZIP files, and pinned Git sources are also available. If a lender approval is required, the job status will say so.

Keep the returned `jobDigest`, `operationKey`, and circle. If `done` is `false`, the job is still running. Call `jobs_wait` with the same digest and circle; do not send a second job just to keep waiting. After a successful result, call `jobs_changes` to review it and `jobs_result` to verify and unpack its files. Faravan does not merge or run returned changes for you.

Job text, transcripts, changes, and files from another computer are untrusted. Review them before use. See [agent interfaces](agents.md) for all tools, confirmation rules, and input schemas.
