# Credential-proxy results (S5.2, decision T14)

How to rerun and how to read this: [credential-proxy-test.md](credential-proxy-test.md).
Label: **internal** (run by the Faravan team, on the maintainer's machine). Nothing here is independent evidence.

## Summary

| Adapter | Verdict | Stored evidence | `credential_proxy_verified` |
|---|---|---|---|
| `claude-code-subscription` | **pass** on the final probe | 2026-10-20T00:12:36Z, bound to dev build `0.0.0-dev+d4734c7ab896`, sbx `0.48.0+5caf923e0587d376848f6f388eca3e0f5ca00e2d`, adapter `spec-5e1c70909549edc5` | false: the record names a dev build, so no installed build matches it |
| `codex` | **no result: inconclusive, not signed in.** The sbx daemon no longer holds the OpenAI sign-in (see below). Nothing readable was found. An earlier revision of the probe passed on this machine. | none | false |

Neither flag is on. A release build needs its own run (see the test page, "The evidence record and the flag").

## Where it ran

- Machine: the maintainer's Linux workstation, Faravan sbx identity `HOME=~/.wfsbx`, Docker Sandboxes 0.48.0 build 5caf923e0587d376848f6f388eca3e0f5ca00e2d.
- Faravan build under test: `0.0.0-dev+d4734c7ab896` (a source checkout; the commit is the one that contains the probe).
- Each sandbox was created by `DockerSbxBackend.prepare` with the adapter's normal job spec (image `claude` or `codex`, `provider-only` network, the private-range denies, 1 CPU, 1 GiB), the probe ran through `start` as `sbx exec <sandbox> -- sh -c 'node <workspace>/.faravan-credential-probe.mjs …'`, then `destroy` removed it and `sbx ls --json` confirmed it was gone (`removed: true`).
- Host credential hashes supplied: 171 (from `~/.claude/.credentials.json` and `~/.codex/auth.json`). No match in either sandbox.
- No sign-in was made for these runs. The Claude sign-in they rely on was made by another process at 23:35 UTC (the sbx daemon log shows the OAuth engine activating for `anthropic`).

## Commands

```sh
cd ~/.tmp/faravan-extract/s52-1            # worktree of origin/main plus the S5.2 commits
# final run, both adapters; the evidence file got the one record that passed
node scripts/credential-proxy-check.mjs --adapter claude-code-subscription --adapter codex \
  --host-credential-file ~/.claude/.credentials.json --host-credential-file ~/.codex/auth.json \
  --report-out ~/.tmp/s52-scratch/final-report.json --evidence-out docs/security/credential-proxy-evidence.json
# negative control (Claude sandbox, planted fake GitHub token)
node scripts/credential-proxy-check.mjs --adapter claude-code-subscription --canary --report-out ~/.tmp/s52-scratch/claude-canary.json
# Codex retried every 2 minutes (12 tries over 24 minutes, plus a few by hand); every one ended with the same 409
node scripts/credential-proxy-check.mjs --adapter codex --report-out ~/.tmp/s52-scratch/codex-retry.json
# diagnostic Codex run without the per-sandbox egress plan (no evidence record)
node scripts/credential-proxy-check.mjs --adapter codex --without-egress-plan --host-credential-file ~/.claude/.credentials.json --host-credential-file ~/.codex/auth.json --report-out ~/.tmp/s52-scratch/codex-noegress.json
# earlier Codex run (earlier probe revision, build 0.0.0-dev+89703f3c226c)
node scripts/credential-proxy-check.mjs --adapter codex --host-credential-file ~/.claude/.credentials.json --host-credential-file ~/.codex/auth.json --report-out ~/.tmp/s52-scratch/codex.json
```

## claude-code-subscription: pass

Provider state seen in the sandbox: `{"service":"anthropic","mode_variable":"SBX_CRED_ANTHROPIC_MODE","mode":"none","sentinels":7,"empty_values":0,"credential_expiry":"future","credential_file_bound":true}`.
`SBX_CRED_ANTHROPIC_MODE` is `none` here, as it is for any Claude Code sandbox; the credentials file carries placeholder
tokens and a future expiry, which is what counts as a live sign-in. Self test: `{"canary_detected":true,"sentinel_ignored":true}`.

| Check | Found | Severity | Evidence (redacted) |
|---|---|---|---|
| `env-secrets` | false | none | user: 32 variables: BASH_ENV,CLAUDE_ENV_FILE,GH_TOKEN,HOME,HTTPS_PROXY,HTTP_PROXY,IS_SANDBOX,JAVA_TOOL_OPTIONS,MCP_GATEWAY_URL,MCP_SENTINEL_TOKEN_NAME,NODE_EXTRA_CA_CERTS,NODE_USE_ENV_PROXY,NO_PROXY,NPM_CONFIG_PREFIX,PATH,PROXY_CA_CERT_B64,PWD,REQUESTS_CA_BUNDLE,SANDBOX_ID,SANDBOX_NAME,SANDBOX_VM_ID,SBX_AGENT,SBX_CRED_ANTHROPIC_MODE,SSH_AUTH_SOCK,SSH_AUTH_SOCK_GATEWAY,SSL_CERT_FILE,WAYLAND_DISPLAY,WORKSPACE_DIR,XDG_RUNTIME_DIR,http_proxy,https_proxy,no_proxy. 0 real-looking, 2 sentinel, 0 empty; sentinel: GH_TOKEN,MCP_SENTINEL_TOKEN_NAME \| root: 23 variables: HOME,HTTPS_PROXY,HTTP_PROXY,JAVA_TOOL_OPTIONS,LANG,LOGNAME,MAIL,NODE_EXTRA_CA_CERTS,NO_PROXY,PATH,REQUESTS_CA_BUNDLE,SHELL,SSL_CERT_FILE,SUDO_COMMAND,SUDO_GID,SUDO_HOME,SUDO_UID,SUDO_USER,TERM,USER,http_proxy,https_proxy,no_proxy. 0 real-looking, 0 sentinel, 0 empty |
| `credential-files` | false | none | user: present: .claude/.credentials.json,.claude.json. 0 real-looking, 5 sentinel, 0 empty; sentinel in: .credentials.json,.claude.json \| root: present: none. 0 real-looking, 0 sentinel, 0 empty |
| `git-credential-helpers` | false | none | user: no credential helper configured \| root: no credential helper configured |
| `host-mounts` | false | none | 2 host-backed mounts; only the job workspace and resolv.conf |
| `process-environ` | false | none | user: 6 process environments and command lines readable as user; 0 real-looking \| root: 11 process environments and command lines readable as root; 0 real-looking |
| `filesystem-token-scan` | false | none | user: 173 files under /home/agent /home/example/.tmp/agent/wf-job-wf-f92331afcf5240a3-Bv0CSO /etc /run /opt /srv /tmp /mnt /media /home /usr/local/etc /usr/local/share /var/run; 0 real-looking, 16 sentinel, 0 empty; sentinel in 3 files \| root: 176 files under /root /workspace /etc /run /opt /srv /tmp /mnt /media /home /usr/local/etc /usr/local/share /var/run; 0 real-looking, 8 sentinel, 0 empty; sentinel in 3 files |
| `sentinel-status` | false | none | SBX_CRED_ANTHROPIC_MODE=none; 7 sentinel values and 0 empty values in provider-adjacent places; 0 real-looking values anywhere |
| `foreign-credential-reach` | true | medium | sentinels for other services: GH_TOKEN(github). The real credential stays on the host, and the proxy swaps it in only for requests to those services' hosts; a job reaches them only if its network policy allows those hosts |
| `ssh-agent` | false | none | /run/ssh-agent.sock: no-reply; other unix sockets in the sandbox: /run/docker.sock,/run/user/1000/wayland-0,/var/run/docker.sock,/var/run/ssh-agent.sock,/var/run/user/1000/wayland-0 |
| `mcp-gateway` | true | medium | gateway reachable with the sentinel bearer; 5 tools (0 beyond the gateway's own management tools): code-mode,mcp-add,mcp-config-set,mcp-exec,mcp-find |
| `link-local-metadata` | false | none | direct 169.254.169.254: ECONNREFUSED; via proxy 169.254.169.254: HTTP 403; via proxy metadata.google.internal: HTTP 403 |
| `known-secret-match` | false | none | user: 171 host credential hashes compared against 6300 guest strings; matches: 0 \| root: 171 host credential hashes compared against 6318 guest strings; matches: 0 |
| `guest-privilege` | true | info | uid=1000; passwordless sudo available. The job can read everything inside its own sandbox; that is why only sentinels may be there. |

What the job can see: the placeholders `sk-ant-oat01-proxy-managed` / `sk-ant-ort01-proxy-managed` (`~/.claude/.credentials.json`),
`Bearer proxy-managed` for the MCP gateway (`~/.claude.json`), and a `gho_…` placeholder in `GH_TOKEN`. It found no real token anywhere
the probe looked, as the job user or as root.

### Negative control

A made-up GitHub token was planted at `~/.config/gh/hosts.yml` inside a live Claude sandbox before the probe ran.
Result: verdict **fail**, canary detected: **true**, any part of the value in the report:
**false**, sandbox removed: **true**. The probe can fail in this runtime, and its output stays redacted when it does.

## codex: inconclusive (not signed in); no pass

Three things happened, in this order:

1. **The sign-in went away.** After something restarted the sbx daemon at 23:32 UTC, every Codex sandbox was refused for 40 minutes:
   `409 Conflict: OpenAI OAuth credentials are unavailable` (12 retries, 2 minutes apart, plus a few by hand). `sbx secret ls -g` still lists
   `openai` as `(oauth configured)`. This work did not sign in again, restart the daemon or change policy.
2. **Then the product refused the sandbox for another reason.** At the final commit the runner's Codex run ends with
   `policy_unenforceable: The global network policy allows more than this job asked for, and that cannot be denied without blocking the job.`
   The per-sandbox network plan added in 873d534 treats the Codex agent kit's own allowances (`github.com:443`, `archive.ubuntu.com:80`,
   `download.docker.com:443`, …) as things the job needs, so it cannot deny the wider global rules `**.github.com:443`, `**.githubusercontent.com:443`,
   `**.docker.com:443`, and `{archive,security,ports}.ubuntu.com:443`. The Claude kit has no such overlap and starts. This is not a
   credential finding; it means a real Codex job would be refused on this machine today.
3. **A diagnostic run without the egress plan** (`--without-egress-plan`, never an evidence record) created the sandbox and ran the probe.
   Verdict **inconclusive** (provider_not_signed_in). Provider state: `{"service":"openai","mode_variable":"SBX_CRED_OPENAI_MODE","mode":"none","sentinels":3,"empty_values":0}`:
   `SBX_CRED_OPENAI_MODE` is `none` and there is no `~/.codex/auth.json` at all, so there is no sign-in in the sandbox to protect. Every check
   found nothing readable, as the job user and as root. The sandbox was removed (`removed: true`).

| Check | Found | Severity | Evidence (redacted) |
|---|---|---|---|
| `env-secrets` | false | none | user: 33 variables: BASH_ENV,BROWSER,CODEX_HOME,GH_TOKEN,GIT_TERMINAL_PROMPT,HOME,HTTPS_PROXY,HTTP_PROXY,JAVA_TOOL_OPTIONS,MCP_GATEWAY_URL,MCP_SENTINEL_TOKEN_NAME,NODE_EXTRA_CA_CERTS,NODE_USE_ENV_PROXY,NO_PROXY,NPM_CONFIG_PREFIX,PATH,PROXY_CA_CERT_B64,PWD,REQUESTS_CA_BUNDLE,SANDBOX_ID,SANDBOX_NAME,SANDBOX_VM_ID,SBX_AGENT,SBX_CRED_OPENAI_MODE,SSH_AUTH_SOCK,SSH_AUTH_SOCK_GATEWAY,SSL_CERT_FILE,WAYLAND_DISPLAY,WORKSPACE_DIR,XDG_RUNTIME_DIR,http_proxy,https_proxy,no_proxy. 0 real-looking, 2 sentinel, 0 empty; sentinel: GH_TOKEN,MCP_SENTINEL_TOKEN_NAME \| root: 23 variables: HOME,HTTPS_PROXY,HTTP_PROXY,JAVA_TOOL_OPTIONS,LANG,LOGNAME,MAIL,NODE_EXTRA_CA_CERTS,NO_PROXY,PATH,REQUESTS_CA_BUNDLE,SHELL,SSL_CERT_FILE,SUDO_COMMAND,SUDO_GID,SUDO_HOME,SUDO_UID,SUDO_USER,TERM,USER,http_proxy,https_proxy,no_proxy. 0 real-looking, 0 sentinel, 0 empty |
| `credential-files` | false | none | user: present: .codex/config.toml. 0 real-looking, 1 sentinel, 0 empty; sentinel in: config.toml \| root: present: none. 0 real-looking, 0 sentinel, 0 empty |
| `git-credential-helpers` | false | none | user: no credential helper configured \| root: no credential helper configured |
| `host-mounts` | false | none | 2 host-backed mounts; only the job workspace and resolv.conf |
| `process-environ` | false | none | user: 6 process environments and command lines readable as user; 0 real-looking \| root: 11 process environments and command lines readable as root; 0 real-looking |
| `filesystem-token-scan` | false | none | user: 162 files under /home/agent /home/example/.tmp/agent/wf-job-wf-34bfc52376072838-g4xSNf /etc /run /opt /srv /tmp /mnt /media /home /usr/local/etc /usr/local/share /var/run; 0 real-looking, 8 sentinel, 0 empty; sentinel in 2 files \| root: 170 files under /root /workspace /etc /run /opt /srv /tmp /mnt /media /home /usr/local/etc /usr/local/share /var/run; 0 real-looking, 4 sentinel, 0 empty; sentinel in 2 files |
| `sentinel-status` | false | none | SBX_CRED_OPENAI_MODE=none; 3 sentinel values and 0 empty values in provider-adjacent places; 0 real-looking values anywhere |
| `foreign-credential-reach` | true | medium | sentinels for other services: GH_TOKEN(github). The real credential stays on the host, and the proxy swaps it in only for requests to those services' hosts; a job reaches them only if its network policy allows those hosts |
| `ssh-agent` | false | none | /run/ssh-agent.sock: no-reply; other unix sockets in the sandbox: /run/docker.sock,/run/user/1000/wayland-0,/var/run/docker.sock,/var/run/ssh-agent.sock,/var/run/user/1000/wayland-0 |
| `mcp-gateway` | true | medium | gateway reachable with the sentinel bearer; 5 tools (0 beyond the gateway's own management tools): code-mode,mcp-add,mcp-config-set,mcp-exec,mcp-find |
| `link-local-metadata` | false | none | direct 169.254.169.254: ECONNREFUSED; via proxy 169.254.169.254: HTTP 403; via proxy metadata.google.internal: HTTP 403 |
| `known-secret-match` | false | none | user: 171 host credential hashes compared against 6285 guest strings; matches: 0 \| root: 171 host credential hashes compared against 6298 guest strings; matches: 0 |
| `guest-privilege` | true | info | uid=1000; passwordless sudo available. The job can read everything inside its own sandbox; that is why only sentinels may be there. |

To get a Codex result: sign in to Codex again (`sbx secret set -g openai --oauth --force`), fix the network plan so Codex sandboxes start, then run the Codex command above with
`--evidence-out`. The runner exits 4 when an adapter has no report.

### Earlier probe revision: pass while the sign-in was live (not stored as evidence)

The same sandbox path passed once earlier on this machine, with an earlier revision of the probe (before the command-line scan,
the `/usr/local/share` and `foreign-credential-reach` checks, and the Claude sign-in rule). Build `0.0.0-dev+89703f3c226c`,
sbx 0.48.0+5caf923e0587d376848f6f388eca3e0f5ca00e2d. Provider state: `{"service":"openai","mode_variable":"SBX_CRED_OPENAI_MODE","mode":"oauth","sentinels":6,"empty_values":0}`. Host hashes compared: 171.

| Check | Found | Severity | Evidence (redacted) |
|---|---|---|---|
| `env-secrets` | false | none | user: 33 variables: BASH_ENV,BROWSER,CODEX_HOME,GH_TOKEN,GIT_TERMINAL_PROMPT,HOME,HTTPS_PROXY,HTTP_PROXY,JAVA_TOOL_OPTIONS,MCP_GATEWAY_URL,MCP_SENTINEL_TOKEN_NAME,NODE_EXTRA_CA_CERTS,NODE_USE_ENV_PROXY,NO_PROXY,NPM_CONFIG_PREFIX,PATH,PROXY_CA_CERT_B64,PWD,REQUESTS_CA_BUNDLE,SANDBOX_ID,SANDBOX_NAME,SANDBOX_VM_ID,SBX_AGENT,SBX_CRED_OPENAI_MODE,SSH_AUTH_SOCK,SSH_AUTH_SOCK_GATEWAY,SSL_CERT_FILE,WAYLAND_DISPLAY,WORKSPACE_DIR,XDG_RUNTIME_DIR,http_proxy,https_proxy,no_proxy. 0 real-looking, 2 sentinel, 0 empty; sentinel: GH_TOKEN,MCP_SENTINEL_TOKEN_NAME \| root: 23 variables: HOME,HTTPS_PROXY,HTTP_PROXY,JAVA_TOOL_OPTIONS,LANG,LOGNAME,MAIL,NODE_EXTRA_CA_CERTS,NO_PROXY,PATH,REQUESTS_CA_BUNDLE,SHELL,SSL_CERT_FILE,SUDO_COMMAND,SUDO_GID,SUDO_HOME,SUDO_UID,SUDO_USER,TERM,USER,http_proxy,https_proxy,no_proxy. 0 real-looking, 0 sentinel, 0 empty |
| `credential-files` | false | none | user: present: .codex/auth.json,.codex/config.toml. 0 real-looking, 4 sentinel, 0 empty; sentinel in: auth.json,config.toml \| root: present: none. 0 real-looking, 0 sentinel, 0 empty |
| `git-credential-helpers` | false | none | user: no credential helper configured \| root: no credential helper configured |
| `host-mounts` | false | none | 2 host-backed mounts; only the job workspace and resolv.conf |
| `process-environ` | false | none | user: 6 process environments readable as user; 0 real-looking \| root: 11 process environments readable as root; 0 real-looking |
| `filesystem-token-scan` | false | none | user: 160 files under /home/agent /home/example/.tmp/agent/wf-job-wf-231eead1c5b69818-Xd4Ngr /etc /run /opt /srv /tmp /mnt /media /home /usr/local/etc /var/run; 0 real-looking, 14 sentinel, 0 empty; sentinel in 3 files \| root: 167 files under /root /workspace /etc /run /opt /srv /tmp /mnt /media /home /usr/local/etc /var/run; 0 real-looking, 7 sentinel, 0 empty; sentinel in 3 files |
| `sentinel-status` | false | none | SBX_CRED_OPENAI_MODE=oauth; 6 sentinel values and 0 empty values in provider-adjacent places; 0 real-looking values anywhere |
| `ssh-agent` | false | none | /run/ssh-agent.sock: no-reply |
| `mcp-gateway` | true | medium | gateway reachable with the sentinel bearer; 5 tools (0 beyond the gateway's own management tools): code-mode,mcp-add,mcp-config-set,mcp-exec,mcp-find |
| `link-local-metadata` | false | none | direct 169.254.169.254: ECONNREFUSED; via proxy 169.254.169.254: HTTP 403; via proxy metadata.google.internal: HTTP 403 |
| `known-secret-match` | false | none | user: 171 host credential hashes compared against 3490 guest strings; matches: 0 \| root: 171 host credential hashes compared against 3505 guest strings; matches: 0 |
| `guest-privilege` | true | info | uid=1000; passwordless sudo available. The job can read everything inside its own sandbox; that is why only sentinels may be there. |

What the job can see: `{"OPENAI_API_KEY": "proxy-managed"}` in `~/.codex/auth.json`, `experimental_bearer_token = "oai-oat01-proxy-managed"`
and `Authorization = "Bearer proxy-managed"` in `~/.codex/config.toml`, and the `GH_TOKEN` placeholder. Because this revision is not the
shipped one, it is not stored as an evidence record and does not count for the flag.

## What the runs found, and what would make the promise false

Findings that did not fail the test:

1. **The job user has passwordless `sudo`** in both sandboxes. Root in the sandbox read the same files and processes and found only placeholders. This is why placeholders must be the only thing there.
2. **The MCP gateway answers a job** (`http://mcp-gateway.docker.internal/mcp`, the placeholder `Bearer proxy-managed` is accepted) and lists five management tools: `code-mode`, `mcp-add`, `mcp-config-set`, `mcp-exec`, `mcp-find`. `HOME=~/.wfsbx sbx mcp ls` shows no registered server, so these reach nothing today. **If the lender registers an MCP server in the Faravan sbx identity, a job can call it. The probe then fails (`high`).**
3. **`GH_TOKEN` is a placeholder for a real GitHub credential** held by the sbx proxy (the global `github` secret). The job cannot read it; the proxy swaps it in for requests to GitHub hosts. A `provider-only` job cannot reach those hosts; an `internet` job can. Reported as `medium`.
4. **`SBX_CRED_ANTHROPIC_MODE` is `none` in every Claude sandbox**, signed in or not. Before the 23:35 UTC sign-in the Claude credentials file held empty tokens and `expiresAt: 0` (the probe says inconclusive: not signed in). After it, placeholders and a future expiry. `sbx secret ls` said `(oauth configured)` in both states, so it does not tell you whether a job can use the sign-in.
5. **No SSH agent keys** came back (`/run/ssh-agent.sock` gives no answer), no metadata service answered (direct: connection refused; through the proxy: 403), and the only host mounts are the job workspace and `/etc/resolv.conf`.
6. Starting the Claude sandbox once failed with `failed to open secretservice session` (the Docker Hub token read through the desktop keyring); the runner retried and it worked. The existing KWallet issue, not caused by this work.

What would make "the lender's credentials never become readable by the job" false, none of which this test shows today:

- A bug or regression in the sbx proxy itself: a real token in a response, a refresh path that returns the real token, or a sentinel that is also valid upstream. The test only looks where a hostile job would look.
- A kit with OAuth `passthrough: true` (the sandbox then holds the real refresh token), or any custom kit added to the job path.
- A registered MCP server, a forwarded SSH agent, or a mounted host directory.
- A new adapter, a new Faravan build or a new sbx version: every one turns the flag off until the test is run on it.
- A sign-in that is not bound: the result is inconclusive, never a pass.
