# Credential-proxy test (S5.2, decision T14)

The promise: **the lender's sign-in never becomes readable by the job.** A friend's job runs in a
Docker Sandboxes microVM with the lender's own Claude Code or Codex sign-in. Docker's credential proxy
keeps the real token on the host and gives the sandbox a placeholder (a "sentinel", for example
`sk-ant-oat01-proxy-managed`). This test checks, for each shipped adapter, that the job finds only
placeholders. It must pass before launch for every adapter Faravan ships. The MVP ships
`claude-code-subscription` and `codex`.

Latest results: [credential-proxy-results.md](credential-proxy-results.md).

## Run it

```sh
# On the machine whose sign-in is under test, with the Faravan sbx identity (HOME=~/.wfsbx) signed in.
node scripts/credential-proxy-check.mjs \
  --adapter claude-code-subscription --adapter codex \
  --host-credential-file ~/.claude/.credentials.json --host-credential-file ~/.codex/auth.json \
  --report-out /tmp/credential-proxy-report.json \
  --evidence-out docs/security/credential-proxy-evidence.json
```

- The script starts a sandbox with the same backend code a real job uses (`DockerSbxBackend.prepare`
  and `start`, the adapter's image, provider-only network, `sbx run`/`sbx exec`). It puts
  `lib/v1/credential-probe-guest.mjs` in the job workspace and runs it as the job's own user.
  Then it removes the sandbox and checks with `sbx ls --json` that it is gone.
- `--host-credential-file` is optional. The script hashes every token-shaped string in those files
  (SHA-256, in memory) and sends only the hashes into the sandbox. If any string in the sandbox has
  one of those hashes, the test fails. Values are never printed or sent.
- `--faravan-version X` names the build under test. By default the script reads the `VERSION` file of an
  installed tree. A source checkout has none, so the script uses `0.0.0-dev+<commit>`. **Only a record
  whose Faravan version equals the running build's `VERSION` can turn the flag on**, so a release
  needs its own run: build the release, install it, then run the script from the installed tree.
- `--label independent` is for a run by someone other than the Faravan team. The default is `internal`.
- `--canary` is a negative control. It plants a made-up GitHub token in the sandbox's `gh` config, and the
  probe must then fail without printing any part of it. A canary run writes no evidence record.
- Exit code: 0 every adapter produced a report and no sandbox is left (the report may still say
  inconclusive; read it), 1 an adapter failed, 3 a sandbox may be left behind (remove it with
  `HOME=~/.wfsbx sbx rm --force <name>`), 4 an adapter produced no report at all.
- `--without-egress-plan` skips the per-sandbox network plan, which refuses a sandbox when the global policy is wider than the
  agent kit allows. It is for finding out whether credentials are readable while that plan is broken. The egress rules are then not
  what a real job gets, so the run never writes an evidence record.
- Do not change the global sbx policy, the sbx daemon or the Docker login to make a run pass.

## What the probe looks at

The probe is one file with no dependencies. It runs as the job's user, then runs again as root through
passwordless `sudo` (the sandbox grants it), because a hostile job would do the same. It never calls a
provider API. Its only network targets are the sandbox's MCP gateway and HTTP proxy, the metadata address
`169.254.169.254`, and the local SSH-agent socket.

| Check | Looks at | Finding means |
|---|---|---|
| `env-secrets` | every environment variable (names always; values only as length and a 4-character hash prefix) | a real token is in the environment |
| `credential-files` | `~/.claude/.credentials.json`, `~/.claude.json`, `~/.codex/auth.json`, `~/.codex/config.toml`, `~/.config/gh/hosts.yml`, `~/.docker/config.json`, `.netrc`, `.git-credentials`, cloud and package-registry files, for the job user and root | a real token is in a credential file |
| `git-credential-helpers` | `.gitconfig` helpers, `GIT_ASKPASS` | a helper that could hold a login (low) |
| `sentinel-status` | whether the agent's credentials are sbx placeholders or real values, and `SBX_CRED_<SERVICE>_MODE` | a real value anywhere |
| `host-mounts` | `/proc/mounts` | a host directory other than the job workspace is mounted |
| `ssh-agent` | the agent socket (asks for the key list), and a list of the other unix sockets under `/run`, `/var/run`, `/tmp` | the agent returns keys |
| `mcp-gateway` | the sandbox's MCP gateway: initialize and list tools, with the placeholder bearer | the gateway lists a tool beyond its own management tools (high), or only its management tools (medium) |
| `link-local-metadata` | `169.254.169.254` directly and through the proxy, and `metadata.google.internal` | an answer from a metadata service |
| `process-environ` | `/proc/*/environ` and command lines of every process, as the user and as root | a real token in another process |
| `filesystem-token-scan` | up to 6000 small files under the home directory, the job workspace, `/etc`, `/run`, `/opt`, `/srv`, `/tmp`, `/mnt`, `/media`, `/home`, `/usr/local` (and `/root` as root) | a real token anywhere |
| `known-secret-match` | the host hashes above | a string in the sandbox equals a real lender credential |
| `foreign-credential-reach` | placeholders for services other than the agent's provider, for example `GH_TOKEN` | a spendable authority (medium; not a readable secret) |
| `guest-privilege` | passwordless `sudo` | information only |

Real or placeholder: a value is a placeholder if, with punctuation removed, it contains `proxymanaged`
(`proxy-managed`, `sk-ant-oat01-proxy-managed`, `oai-oat01-proxy-managed`, the `gho_…` GitHub value).
Anything else that has a known token shape (Anthropic, OpenAI, GitHub, JWT, Slack, AWS, Google, private
keys), or sits next to a secret-like name and looks random, counts as real. The probe also checks its own
classifier before every run (`self_test`): it must flag a made-up token and ignore a placeholder.

## What counts as a pass

The probe prints one JSON report: `{checks:[{id, found, evidence_redacted, severity}], verdict}`.
`found: true` always means a problem. `found: null` means the check could not run.

- **fail**: any check with `found: true` and severity `high` or `critical`: a real secret is readable
  or a usable lender authority is reachable.
- **inconclusive**: nothing failed, but the proxy could not be seen working. Reasons: no sign-in is
  bound in the sandbox (`provider_not_signed_in`), no placeholder was seen, a required check could not
  run (`found: null`), or the self test failed.
- **pass**: all ten required checks ran and found nothing high or critical, a sign-in is bound with at
  least one placeholder seen, and the self test passed.

A sign-in counts as bound when `SBX_CRED_<SERVICE>_MODE` is `oauth` or `apikey` (Codex), **or** when
`~/.claude/.credentials.json` holds placeholder access and refresh tokens with an expiry still in the
future (Claude Code). Claude Code's sandbox reports mode `none` whether or not it is signed in, so the
mode is not used for it. Placeholders with expiry 0 and empty tokens mean no live sign-in.

`lib/v1/credential-probe.mjs` does not trust the probe's verdict: it recomputes the verdict from the
checks and refuses a report that disagrees, a report with a missing or duplicate check, and a report
whose evidence contains anything shaped like a real secret.

## The evidence record and the `credential_proxy_verified` flag

A refused or accepted report becomes a record in `docs/security/credential-proxy-evidence.json`:

```json
{ "schema": 1, "kind": "credential_proxy", "label": "internal", "result": "pass",
  "adapter_id": "codex", "adapter_version": "spec-0f5ab2b8db2bea78",
  "faravan_version": "0.1.0", "sbx_version": "0.48.0+5caf923e0587d376848f6f388eca3e0f5ca00e2d",
  "tested_at": "2026-10-19T23:20:00Z", "checks": [{ "id": "env-secrets", "found": false, "severity": "none" }] }
```

`safety.credential_proxy_verified` is `true` only when the newest record for the **exact** adapter id,
adapter version, Faravan version and sbx version is a pass, every required check in it is clear and
its date is not in the future. Otherwise it is `false` (and `null` when there is no adapter). Nothing
else sets it. Adapters no longer carry the flag.

- *Adapter version* is a digest of the adapter's whole spec (image, entrypoint, auth strategy, hosts,
  credential handling). Any edit to the spec invalidates the record.
- *Faravan version* is the installed tree's `VERSION`. A source checkout has none, so it never verifies.
- *sbx version* includes the build hash. An `apt upgrade` of sbx therefore turns the flag off until the
  test is run again on the new version. This is deliberate: the proxy is sbx's code.
- A later `fail` or `inconclusive` record for the same binding takes the flag back.
- `label: internal` means the Faravan team ran it. `independent` is for a run by someone else; only that
  label may be described as independently tested.
- The records ship in the package (`packaging/stage-app.sh`) and the app reads them at start.

## Known limits

- A pass is evidence from one machine, one sbx build, one run, using the real job path. It does not prove
  the sbx proxy has no bug. The test looks where a hostile job would look; it does not attack the proxy
  itself (TLS interception, the OAuth refresh path, the daemon's local API).
- **Not signed in is not a pass.** With no live sign-in bound in the sandbox, there is nothing for the
  proxy to protect, and the result is inconclusive. Sign in through Faravan, then run again. `sbx secret ls`
  can say "oauth configured" while a new sandbox still gets no live credential; the probe goes by the sandbox.
- If `sbx` refuses to create the sandbox (for example `409 Conflict: OpenAI OAuth credentials are
  unavailable`), the run has no result for that adapter: the script reports the error and exits 4. It never
  signs in, restarts the daemon or changes policy for you.
- The real credentials live in the sbx daemon's own store, which the test cannot read. The
  `known-secret-match` check compares against the host files you pass in (a normal Claude Code or Codex
  login on the same machine). With no files, it compares nothing and says so.
- The SSH-agent check treats "no answer in 2.5 seconds" as no keys. A forwarded agent on another host
  would answer; the Faravan sbx identity strips `SSH_AUTH_SOCK`, so none is forwarded.
- The MCP gateway always answers, with its management tools (`mcp-find`, `mcp-add`, `mcp-config-set`,
  `mcp-exec`, `code-mode`). That is `medium` while the lender has registered no MCP server in the
  Faravan sbx identity (`HOME=~/.wfsbx sbx mcp ls`). After `sbx mcp add`, any server tool is `high` and the
  test fails until the server is removed.
- A `GH_TOKEN` placeholder is present in every sandbox. The proxy swaps the real GitHub token in for
  requests to GitHub hosts. Provider-only jobs cannot reach those hosts; `internet` jobs can. This is a
  spendable authority, not a readable secret, so it is reported as `medium` and does not fail the test.
- The job user has passwordless `sudo` inside the microVM. That is why only placeholders may be present: root
  in the sandbox can read everything the sandbox holds.
- The scan reads at most 6000 small text files and skips package trees, so a secret in a large or
  binary file is not found. The file scan only recognises known token shapes and secret-looking
  assignments; an unusual home-made secret format can be missed.
- Network checks use the provider-only job path. The metadata check is meaningful there, because
  `169.254.0.0/16` is denied for every job, but a job with `internet` network is not tested separately.
- The Windows and macOS paths are untested; the script was run on Linux only.
