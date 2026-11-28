# Status

Updated 2026-10-21 for commit `a35bcae6114f1eeadae552089c6bb68d2dfe1148`.

Each capability has exactly one evidence level in State:
- **AUTOMATED**: a named test at this commit covers the bounded behavior described. It does not mean the test was run for this authoring change.
- **RECORDED-LIVE**: a named file records a real run, with its date and build limits.
- **UNVERIFIED**: the stated capability lacks sufficient evidence in this review.

This was an authoring-only review. No tests or live jobs were run. The existing
`status.json` array and row fields are retained; State carries the evidence level.
A row's limits are part of its claim, not permission to extend it to other platforms.

## How changes are checked

Hosted CI does not run for this repository. The merge gate is the full local test suite (`npm test`). macOS builds and tests run on a Mac host.

## Walks on installed builds

These dated walks are separate from the table below. Each applies only to the platform and build it names.

- **2026-10-31, release .34.** Linux lender and Apple silicon Mac borrower (macOS 26.7.1), both installed from release assets. Linux install, Mac first open after **Open Anyway**, invitation, Mac join, a No project job approved on the Linux lender with its answer back on the Mac, and the lender's Stop. Mac lending is not qualified. Intel local lending is unsupported.
- **2026-10-20.** One local Claude Code No project job on Linux; see the no-project check below.

## What changed since 2026-10-09

- Desktop launch/reuse, multiple circles, lending policy and limits, device pairing,
  results as local branches, transcript scrubbing and trust/safety controls now
  have separately named automated coverage below.
- Budget protocol coverage is separate from meter execution and display. Mixed
  live/synthetic fixtures are not a live meter acceptance run.
- One real no-project Claude job is recorded on 2026-10-20. The credential probe
  also has a dated development-build result, but neither release flag is enabled.
- `evidence/gate-green/results.json` and `evidence/gate-green/verification.md`
  record 3,054 root passes (2 skipped, 1 todo), 369 browser passes (18 skipped)
  and 929 UI passes at `d7a9f9ec1a9a928b0c85d4b326eda8322cdccc23`.
  They also record targeted strengthening at `bfaafbd6`. These are historical
  automated results, not a fresh full-suite pass at this page's commit, and not
  real-device or live-provider acceptance.

## v1 (the product going forward)

<!-- STATUS TABLE BEGIN -->
| Part | State | Claim | Evidence (test titles) |
|---|---|---|---|
| Protocol spec | AUTOMATED | Bounded schema vocabulary, signed examples and negative schema/profile cases are covered. Full OpenAPI semantics remain UNVERIFIED. | `tests/protocol-core.test.mjs`: “static schema vocabulary cannot silently expand beyond the bounded validator”<br>`tests/protocol-core.test.mjs`: “every inline signed worked example verifies and enrollment never carries its seed”<br>`tests/protocol-core.test.mjs`: “semantic schema and profile failures do not authorize signed attacker payloads” |
| Protocol core (`lib/protocol`) | AUTOMATED | Unit-test coverage for canonical JSON, domain-separated Ed25519 signatures, request proofs, rosters, invites and independently retained job/attempt identity binding. | `tests/protocol-core.test.mjs`: “golden fixed TEST-ONLY keys, fingerprints and every signed byte”<br>`tests/protocol-core.test.mjs`: “key and signature encodings reject noncanonical and invalid curve material”<br>`tests/protocol-core.test.mjs`: “roster creation, root/circle pins, temporal boundaries and anti-rollback”<br>`tests/protocol-core.test.mjs`: “invite link, context-bound enrollment and expiry”<br>`tests/protocol-core.test.mjs`: “request exact bytes, clock boundaries and atomic nonce callback order”<br>`tests/protocol-core.test.mjs`: “synchronous request proof shares validation and rejects asynchronous nonce callbacks”<br>`tests/protocol-core.test.mjs`: “identity predicates bind independently retained job and attempt” |
| Coordinator store and HTTP server | AUTOMATED | Signed job lifecycle, lease fencing, historical-roster membership checks and forged-proof rejection are covered hermetically. This is not live hosting evidence. | `tests/v1-store.test.mjs`: “v1 happy path preserves signed inputs, renewal, result and original acknowledgement”<br>`tests/v1-store.test.mjs`: “v1 lease expiry before the agent started reclaims the job, increments generation and permanently fences old completion”<br>`tests/v1-server.test.mjs`: “v1 historical roster HTTP reads require current membership and return the exact epoch”<br>`tests/v1-server.test.mjs`: “v1 JSON forged proofs and oversized signed lengths fail before the body arrives” |
| Client, CLI, MCP | AUTOMATED | Hermetic circle enrollment and the five original annotated job tools are covered. The MCP surface also exposes registry operations; it is no longer described as exactly five tools in total. | `tests/v1-cli.test.mjs`: “circle create, invite, join, approve advances signed roster and enrolls only invited device”<br>`tests/v1-mcp.test.mjs`: “stdio MCP initializes, keeps the five annotated job tools, and completes verified job journey” |
| Developer CLI and results as branches | AUTOMATED | Apply creates a new local branch and commit while preserving the current branch, index and uncommitted work. This does not prove GitHub publication or live sandbox code-change results. | `tests/v1-apply.test.mjs`: “apply creates a new branch at the base with a commit built from the prompt and receipt”<br>`tests/v1-apply.test.mjs`: “apply accepts the short job ID that run and job print”<br>`tests/v1-apply.test.mjs`: “apply never touches the current branch, index or uncommitted work” |
| Diff results | AUTOMATED | Injected-backend tests cover archive diffs and pinned Git trees; the Changes API returns a bounded diff and file list. Real sandbox code-change execution remains UNVERIFIED. | `tests/v1-lender-diff.test.mjs`: “archive job: the lender returns a signed diff against the committed snapshot, with diffstat and base tree”<br>`tests/v1-lender-diff.test.mjs`: “pinned git job: the filtered tree retains the verified commit without claiming a diff base”<br>`tests/v1-app-changes.test.mjs`: “Changes tab data: file list, bounded unified diff and the apply command for a diff candidate” |
| Joining and circles | AUTOMATED | Signed invite enrollment is covered by CLI tests. A browser test covers creating, renaming and selecting two circles on one host, including an old-member compatibility refusal. Real-device joining remains UNVERIFIED. | `tests/v1-cli.test.mjs`: “circle create, invite, join, approve advances signed roster and enrolls only invited device”<br>`tests/e2e-browser/v1-circles.spec.mjs`: “start, rename and use two circles on one host in every selector”<br>`tests/e2e-browser/v1-circles.spec.mjs`: “a legacy member blocks rename until its computer updates” |
| Short invites | AUTOMATED | Publication, public resolution, expiry and binding rejection have automated coverage. A dishonest queue landing page can still capture its fragment seed; real desktop activation and OS handlers remain UNVERIFIED. | `tests/v1-short-invite.test.mjs`: “a published invite resolves publicly to exactly its public envelope and binding”<br>`tests/v1-short-invite.test.mjs`: “resolve answers 404 for unknown or malformed codes and 410 once the invite has expired”<br>`tests/v1-short-invite.test.mjs`: “publication refuses a binding the invite key did not make and malformed bodies” |
| Lender loop | AUTOMATED | The existing lender suite covers reservations, restart reconciliation and job control with injected execution. It is not proof of real sandbox cessation. | `tests/v1-lender.test.mjs`: “M8 restart retains the reservation until cessation is verified and then reconciles” |
| Local app and web UI | AUTOMATED | One-time local handoff and evidence-bound safety facts have API coverage. Browser coverage is named separately for circles; this is not a blanket sign-in, platform or screen pass. | `tests/v1-app.test.mjs`: “local handoff expires at 60 seconds and is consumed exactly once”<br>`tests/v1-app.test.mjs`: “handoff redirects once to a clean route with a cookie that authenticates the web app”<br>`tests/v1-app.test.mjs`: “missing or invalid safety inputs stay unknown rather than becoming promises” |
| Desktop app | AUTOMATED | The macOS supervisor is covered with injected boundaries and Linux-compatible process tests: launch, duplicate reuse and tray ownership. Real Finder, LaunchServices, launchd, installers and Windows execution remain UNVERIFIED. | `tests/macos-launch.test.mjs`: “first interactive launch starts the app, opens the one-time handoff (never the token URL) and owns the tray”<br>`tests/macos-launch.test.mjs`: “a duplicate launch reuses the running one: it opens a handoff for it, starts nothing and signals nobody” |
| Lending limits and policy | AUTOMATED | Atomic policy saves, scoped circle rules, stale evidence rejection, owner activity, caps and reservations are covered. These tests do not establish provider-meter accuracy or live stopping. | `tests/v1-app-lending-policy.test.mjs`: “policy settings save atomically and desktop observations are accepted”<br>`tests/v1-app-lending-policy.test.mjs`: “scoped rules use the settings version and enable only circles with a live rule”<br>`tests/v1-lending-policy.test.mjs`: “objective candidate requires exact account-week identity and a verified rollover”<br>`tests/v1-lending-policy.test.mjs`: “objective admission reserves the selected total spend across every linked resource” |
| Signed budget contract | AUTOMATED | Budget fields are signed, require the matching capability and exclude private provider-account details. This is protocol coverage, not meter execution evidence. | `tests/v1-budget-protocol.test.mjs`: “budget extension is signed and requires matching capability”<br>`tests/v1-budget-protocol.test.mjs`: “closed budget fields reject provider window/account details and invalid effort” |
| Lending meter execution and display | UNVERIFIED | No current-commit live meter run or directly inspected meter-execution test is established by this refresh. tests/fixtures/lending/README.md describes mixed live and synthetic inputs, not an end-to-end pass. evidence/gate-green/verification.md explicitly leaves the historical quiet-meter cause unproven. | No test |
| Device pairing | AUTOMATED | Synthetic HTTPS/API tests cover pairing, restart persistence and declining a review card. Real iPhone/Android, passkeys and installed Home Screen notifications remain UNVERIFIED. | `tests/v1-app-phone.test.mjs`: “a phone pairs through the app, stays paired across a restart, and never reaches the local app”<br>`tests/v1-app-phone.test.mjs`: “over HTTPS a paired phone sees a real review card and declines it for this computer” |
| Transcript scrubbing and relay | AUTOMATED | Tests preserve safe transcript lines, withhold oversized media, normalize local project paths and keep known lender values out of signed handoffs. Relay availability distinguishes older hosts; no claim of universal secret detection is made. | `tests/v1-app-transcript.test.mjs`: “live and stored app transcripts preserve safe lines and withhold oversized media before framing metadata”<br>`tests/v1-lender-diff.test.mjs`: “lender known values never enter the signed handoff, even without a token-shaped format”<br>`tests/v1-lender-diff.test.mjs`: “public transcript normalizes saved project paths before live events and signing”<br>`tests/v1-app-live-transcript.test.mjs`: “borrower app identifies an older host without claiming a lender failed to report” |
| Trust and safety controls | AUTOMATED | Frozen audiences, audit-write failure, atomic refusal of limit changes and responsive pause/stop during a hung mutation have regression coverage. These do not prove the sandbox boundary on every platform. | `tests/v1-app-trust.test.mjs`: “freeze audience refuses an old host before uploading prompt or source”<br>`tests/v1-app-trust.test.mjs`: “an audit write failure cannot enable automatic lending”<br>`tests/v1-app-trust.test.mjs`: “a refused combined limits and mode save leaves every limit unchanged”<br>`tests/v1-app-safety-lane.test.mjs`: “pause, skip and stop answer while a network mutation hangs” |
| Source manifest and network policy | AUTOMATED | Manifest bytes and signed capability binding are tested. Network policy tests use a stateful model, not a live sandbox boundary audit. | `tests/source-manifest.test.mjs`: “manifest describes the frozen filtered bytes, never source file contents”<br>`tests/source-manifest.test.mjs`: “signed manifests bind the archive digest and require an upgraded lender capability”<br>`tests/s5-4-network.test.mjs`: “registry policies use exact named hosts and retain private-network denials” |
| Host flow | AUTOMATED | The real-process loopback host command, invite, member join, approval and queueing are covered. Live LAN discovery, HTTPS hosting and ngrok remain UNVERIFIED. | `tests/v1-host-flow.test.mjs`: “host command on loopback creates a circle, prints an invite, approves a member and queues its job” |
| Independent reviews | UNVERIFIED | evidence/gate-green/test-review.md and evidence/gate-green/verification.md record a test-strength review at d7a9f9ec, not a complete independent security review or release acceptance at this commit. | No test |
| Real sandbox execution of v1 jobs | RECORDED-LIVE | docs/testing/no-project-jobs.md records one local Claude Code no-project job on 2026-10-20 through real Docker Sandboxes, including Markdown and CSV delivery and browser copy/download. Cross-device jobs, other agents and other operating systems remain UNVERIFIED. | `docs/testing/no-project-jobs.md`: “Live check on 2026-10-20” |
| Credential-proxy probe on a development build | RECORDED-LIVE | docs/security/credential-proxy-results.md records a Claude probe pass at 2026-10-20T00:12:36Z for dev build 0.0.0-dev+d4734c7ab896 and sbx 0.48.0. Codex was inconclusive. Neither release verification flag is enabled; this is not current-release or independent evidence. | `docs/security/credential-proxy-results.md`: “2026-10-20T00:12:36Z” |
<!-- STATUS TABLE END -->

## Preview retirement

The preview runtime, commands, UI and research runner have been removed.
Existing preview state is preserved, but this binary cannot resume its jobs.
The read-only `lib/legacy-verify.mjs` retains historical signature checks;
its output grants no current execution authority.
Use the [retirement steps](../protocol/hosting.md#retiring-an-old-host) before
upgrading a host with outstanding work. V1 behavior and its live-execution
limitations above still apply.

## Known gaps

- The [local no-project check](../testing/no-project-jobs.md), dated 2026-10-20,
  covers one Claude job, not cross-device jobs, all agents or other OSes.
- Real macOS launch/install, Windows execution, physical phone passkeys and
  Home Screen push are not established by the named automated tests.
- Sandbox isolation and credential promises require matching OS, sbx, adapter
  and release-build evidence. Development-build records do not enable them.
- The historical quiet-meter failure remains unexplained in
  `evidence/gate-green/verification.md`; a passing run is not proof it is fixed.
- Current publication and licensing were not checked: those sources are outside
  this authoring review's read scope.
- The previous one-circle-per-server gap is superseded by the named automated
  two-circle browser scenario; production HTTPS hosting remains UNVERIFIED.
- A job's wall-time limit is enforced only by the running app. If the app
  crashes, a process the job detached can keep running until the next start
  removes the sandbox.
