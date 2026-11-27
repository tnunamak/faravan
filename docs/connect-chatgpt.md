# Connect this computer's Faravan to ChatGPT

Run these steps separately on each person's computer. Each computer has its own MCP URL, OAuth clients,
permissions, and revoke button. Keep Faravan running and the computer awake while using ChatGPT.

## Before you start

The dedicated ChatGPT gateway needs a stable public HTTPS address. Gozar lists
matching offers and supplies the relevant setup steps. Joining a friend's circle
does not require setting up this gateway.

Use the command that selects the exact Faravan installation and profile you want to connect. For a labeled preview, obtain its registered command from the inviter before running the examples below. Do not assume that bare `faravan` or `/usr/bin/faravan` selects that preview, and do not use a launch-only executable. In every example, replace `faravan` with that confirmed command. For an installation using the standard Mac app path, the command is `/Applications/Faravan.app/Contents/MacOS/faravan`; confirm the preview and profile before using it.

## 1. Publish the MCP endpoint

Open the Faravan app first. This signs your browser into its local interface.
If the app was already running when Faravan was updated, its owner must restart it before connecting
so it loads the new interfaces.
In a terminal on that same computer, run:

```sh
faravan connect chatgpt
```

You should see an **MCP URL** ending in `/mcp`, a local connection-screen URL, and numbered instructions.
In an interactive terminal the command stays open to print matching codes. That is expected. Ctrl-C
stops this watcher but does not disconnect ChatGPT or immediately close the pairing window. To stop
access, use `faravan connect chatgpt --stop`.

Select an offer shown by Gozar and approve its scope. Review each setup
action when prompted. If Gozar asks you to continue in a browser, finish that step
and rerun the command so Gozar can check its outcome. The MCP URL appears after
Gozar verifies that the route reaches this computer's dedicated MCP/OAuth listener.
The local app and its browser handoff stay on a separate loopback port.

A verified connection can reopen pairing from **You → Account → Connect ChatGPT**.
The 10-minute window is one-shot. The first approval or denial cancels the other
pending requests. Automatic resume keeps pairing closed. A stopped attachment may
need another approval before it can resume.

To share a local folder, use an absolute path.

```sh
faravan connect chatgpt --root /absolute/path/to/code
```

To change folders, disconnect first and finish any outstanding cleanup. Then
reconnect and pair again.

To preview or apply a job's result remotely, name the target repository explicitly, for example
`"repo":"/home/you/code/app"`. It must be inside a configured root. Faravan never picks an
apply target by itself. A job's repository snapshot is source only, so the original path recorded in it
is not an automatic target. A request without a repository, or with one outside the roots, is refused.

Git URLs do not require a local root. The app remembers the tunnel settings and tries to resume the same
connection on restart. A changed public origin requires disconnecting, reconnecting, adding the new URL
in ChatGPT, and fresh consent.

## 2. Add it in ChatGPT

The current [OpenAI setup instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt)
use the Plugins screen. Account and workspace policies can restrict custom servers.

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select **+**, then **Add custom MCP server**.
2. Enter **Faravan** and a description. Under **Connection**, paste the printed HTTPS MCP URL,
   including `/mcp`.
3. Choose **OAuth**. Leave client ID and client secret blank. Faravan advertises dynamic registration
   for public clients; ChatGPT registers its own client. Review ChatGPT's warning and continue.
4. During authorization, ChatGPT's browser tab shows **Approve on your computer** and a matching code
   in the form `XXXX-XXXX`. That page does not link to your computer. Return to the Faravan app that is
   already open on the computer running Faravan, open **Connect ChatGPT** (refresh it if already open),
   and select **Review** next to the new connection request.

   Every connection request has its own matching code. Faravan shows it in three places: the public
   authorize tab, the **Connect ChatGPT** screen (next to each pending request, and on the consent page),
   and the terminal. While `faravan connect chatgpt` runs in an interactive terminal, it polls every two
   seconds and prints the code of each new request.

   **Compare the code only with the authorize tab of your own ChatGPT session, which you started a
   moment ago.** A code in a screenshot, in a link that someone sent you, or in the pending list on this
   computer is not proof. Anyone can copy a code from the list. The code only lets you tell two requests
   apart. It does not prove whose ChatGPT account made the request. If the codes differ, deny the request.
   If more than one request is waiting, Faravan shows a warning: someone else may be trying to connect.
   Match the code against your own tab. If you deny a request or are not sure, select **Connect** again
   and start a fresh authorization from your own ChatGPT account; denying cancels the other requests too.
5. For ChatGPT's own callback, the title is **Allow ChatGPT to use Faravan on this computer?** The page shows
   the client's name (the client supplies it, so it proves nothing), the host it returns to, when the client
   registered, and what read access shares:
   - your name and this computer's name;
   - the names of people in your circles;
   - invitation previews with the circle name, host, owner, known member names, expiry and network warning;
   - membership checks for saved joins: pending, approved, expired, rejected or unknown;
   - circle presence: which computers are lending, resting or offline;
   - agents and models that circle lenders offer;
   - job prompts, including other people's prompts for jobs this computer ran;
   - job status, changes and records;
   - repository information only inside the folders you allowed;
   - transcripts only after you approve each request locally. Applying a result or previewing an apply also needs local approval, because Git may store objects during a preview.

   If the callback is not ChatGPT's (for example a loopback address used by MCP Inspector), the title is
   generic and a red **This is not ChatGPT** warning appears. Deny it unless you set up that client yourself.
   Check the matching code, then select **Allow read-only** or **Allow read and request actions**, only
   for the request you just started. Choose **Allow read-only** only for inspection; skip the action
   test in section 3. Choose **Allow read and request actions** only if you want to test locally reviewed
   actions. Existing connections stay in place when you approve or deny a
   new request; revoke them one by one if you no longer want them.
   The browser returns to ChatGPT. Finish **Create as a plugin**
   and install it. ChatGPT should show the discovered Faravan tools, including `status_blockers`.

The callback allowlist follows [OpenAI's authentication documentation](https://developers.openai.com/plugins/build/auth):
`https://chatgpt.com/connector_platform_oauth_redirect` and
`https://chatgpt.com/connector/oauth/{callback_id}`. Faravan advertises issuer identification and returns
`iss`, so ChatGPT should use the stable first address. HTTP or HTTPS loopback callbacks are also accepted
for tools such as MCP Inspector; they get the **This is not ChatGPT** warning. Other HTTPS hosts and
other ChatGPT paths are refused.

Some accounts still show the older interface: **Settings → Apps** (or **Connectors**) → **Advanced** →
**Developer mode**, then **Create**. Enter the same URL, choose OAuth, and follow the same local consent.
The available screens and labels depend on your account and workspace. Follow the linked OpenAI
setup instructions, use the MCP URL printed by Faravan and choose OAuth.

If the local page says **Open the local app link again**, open Faravan normally, then return to
**Connect ChatGPT**. A request expires after five minutes; start authorization again if it expires. A new
client is never approved automatically. A declared client name does not prove its publisher's identity.

## 3. Prove the connection

Start a new chat, type **@**, and select Faravan. On older accounts use the tools/apps picker.

1. Ask **“What blocks lending on this computer? Use status_blockers.”** You should receive the actual
   blockers for this computer, with proposed next actions.
2. Ask for a read, such as **“Show my lending settings.”** It should call `lending_get`.
3. For an action, such as turning lending on, ChatGPT only *requests* it. Faravan queues the request and
   shows it on this computer: a tray notification (**Allow ChatGPT to …**) and **Needs you** in the app.
   Select **Review** to see the exact effect. The page reads from top to bottom in plain sections, in the
   same look as the app: the effect and the circle by name, the title and prompt, who may receive the job
   (people and computer names), and the code (every file's text, or a hash for binary and large files).
   A Git URL shows the repository and immutable commit instead of downloading its code for review.
   Other inputs appear as readable labels and values. For **lending mode** set to auto, the page says
   "Run jobs from *circle name* without asking each time." Accepting a job shows the job's title, its
   requester and its prompt. If no such job is waiting, Faravan refuses the request. Keys, signatures and
   private IDs are never shown. A collapsed **Technical details** section at the bottom is for debugging
   only; everything you need to decide is above it.

   A request to **join a circle** shows the circle's name and host, the owner who signed the invitation,
   and any members that this computer already knows. An invitation contains names but no member list, so
   Faravan cannot show the others. When the list may be incomplete, the page says: "Other members of this
   circle aren't shown until you join." Faravan adds no new protocol request to find out more. The
   invitation link itself is never shown on the page.

   Then select **Allow ChatGPT to …** or **Decline**. A confirmation in
   ChatGPT does not count; only **Allow** on this computer runs the action. The tray can also decline.

Remote MCP uses the same operation registry as the CLI and app, but only a subset of it is offered
remotely. Human-only uninstall and the local browser sign-in link are unavailable. **Read** permits
inspection; **read and request actions** also lets ChatGPT queue writes for your local approval. Allowing
requires the app's browser session on this computer. ChatGPT and any other remote OAuth client cannot
allow an action. Processes on this computer that hold the owner's CLI or session token are trusted:
they can obtain a browser cookie through the local handoff route and then allow an action. This is
intentional. A local agent with shell access as you
already has that access. Secrets that an action creates, such as an invitation link, appear only in the
local result on this computer. ChatGPT's copy of the result does not include them.

Prompts, titles, branches and names with invisible formatting characters are refused. Use plain text
and retry. The local review page makes hidden characters in code and other fields visible as Unicode
escapes, so they cannot silently alter the text you review.

Calls return within 15 seconds. A slow call returns `pending: true` and `call_id`; ChatGPT must poll
`remote_call_get` with that ID. It must not repeat the write. Wait operations are capped at ten seconds.
Writes also accept `idempotency_key` for safe retries through the existing operation layer.

## Limits

- **Pending actions.** Each connection can have at most four actions waiting. Reads that need no
  approval have four separate slots per connection and sixteen globally. Actions have a global cap of
  thirty-two. A connection that parks four actions
  therefore cannot block another connection's reads.
- **Registration budget.** The hourly budget of 30 counts only new, valid, successful client
  registrations. Requests refused because pairing is closed do not use it.
- **Client address.** Gozar resolves the address from verified ingress evidence when
  available. Otherwise connections share the socket peer's rate budget. Addresses
  are used for rate limits only.
- **Slow connections.** Up to 256 slow-header connections to the public listener can deny the MCP
  endpoint until their header timeout ends. The local app runs on its own port and is not affected.
  Faravan makes no claim of resistance to denial of service.

## 4. Review activity or disconnect

Open **You → Account → Connect ChatGPT** or the printed local connection-screen URL.
**Connections** lists each client with its scope, the host it returns to, its registration time, and a
**Revoke** button for that connection only. **Activity** is kept per client: the operation, its outcome,
a short effect, and the local time, without tokens. It stays until you select **Clear** on this computer;
ChatGPT cannot clear it. Repeated reads show a count and their first and last times. They do not use
the space reserved for action history. When a client's action log is full, that client cannot request
another action until you clear it locally.
Select **Disconnect ChatGPT** to revoke all clients' access and refresh tokens and stop the tunnel.
The terminal equivalent is:

```sh
faravan connect chatgpt --stop
```

Also remove the plugin/connector in ChatGPT if you no longer want it listed. Disconnect does not undo
completed actions or stop a job that already started. If tunnel cleanup fails, tokens are still revoked
and the local gateway is closed; follow the remaining steps from Gozar before reconnecting.
