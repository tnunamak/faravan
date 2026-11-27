# Decision journeys: release gap 29

## Stacked journey follow-up

At the prior reviewed head `1dad44e648c39cfaa9f671da36785a15602da578`, the targeted browser command below ran all four journeys: **4 passed, 0 failed, 0 skipped** in 77 seconds. PR #48 head `52d94560a05af69e6aabaf4ae5b34825013b710d` was its base.

After merging the ship branch and #48, the same command at `d89b799c128bc5d032eef44dd3926e4bc4b3d4b5` ran the updated four journeys: **4 passed, 0 failed, 0 skipped** in 210 seconds. The updated Decline journey starts the later job, both returned Pause offers have deadline assertions, and the restart journey attaches structured evidence. This evidence-only commit does not alter the tested code.

After the parity correction, the same command at `037de2dbe1692fe8d9f740432a3122c4b5d26807` passed all four journeys in 218 seconds. Subsequent merges updated a lender test fixture, journey cleanup and ship-branch tests. The same command ran at the final head containing this paragraph: **4 passed, 0 failed, 0 skipped**. To read that exact SHA from the repository, run `git log -1 --format=%H -- docs/testing/decision-contracts-1028.md`. The PR body also records the SHA and elapsed time. A commit cannot contain its own literal SHA.

Not now sends no decision traffic, survives a lender-app restart, and the returned offer can run. Decline produces one coordinator refusal, leaves the job queued for other lenders, preserves both circle members, and remains excluded after the coordinator and lender restart. A later job from the same borrower reaches review. The requester sees an anonymous decline message. Pause checks the dialog's explanatory paragraph, leaves running work active, holds both an existing offer and a job sent during Pause, preserves circle membership, and shows both offers after a real Resume. The follow-up attributes the decline and the held offers to their circle and checks Pause survives a lender restart; it uses one circle and does not test isolation from a second circle.

Author-run mutation checks: forcing a declined job view to report `failed` made the Decline journey fail at the `queued` assertion; omitting the persisted refusal made it fail at the decline-count assertion; blocking all later offers from a borrower whose earlier job was declined made the later-job review assertion fail. Adding a skip POST to Home's Not now made that journey fail while waiting for the attributed request to settle; deleting the waiting-offer sentence made the Pause copy assertion fail. Discarding the saved Pause deadline on startup made the new restart journey fail at the paused-state assertion. Each mutation was reverted. The logs are retained locally under `/home/example/.tmp/faravan-pr41-mutation-*.log` and `/home/example/.tmp/faravan-pr41-r3-mutation-pause-restart.log`. The prior review's head-evidence finding is a provenance issue, not a runtime behavior to revert; the commit and command above make its tested snapshot explicit. The historical baseline and earlier results below describe prior snapshots, not this test commit.

The earlier provenance check compared the tested files against the prior test commit; adding a temporary line to the spec made the check fail and removing it restored the match. The head run above is direct evidence of execution, not an inference from that comparison.

## Pause clarification

The owner clarified that Pause is temporary: waiting modern offers are held for later review, not declined, and return on Resume if still available. Another lender can take an offer, and its deadline still applies. No backend Pause behavior changes in this follow-up. The confirmation at `ui/v1/src/lend.jsx:419` now states that behavior explicitly and says running jobs continue within their saved limits. The existing return-on-Resume lender test at `tests/v1-lender-offers.test.mjs:239` is unchanged.

The original seventh finding required waiting offers to be declined. That requirement was retired after the clarification; it is not reported as a backend fix. The obsolete allowance is removed, and the Pause journey instead requires zero coordinator declines for the waiting offer, its return after a real Resume, no execution of that waiting job, and continued output from the same running attempt. The earlier results below record the previous contract.

At that earlier snapshot, the journey did not restart the app while paused; the current follow-up adds that check. Timed expiry and Stop recovery remain outside the browser journey.

Earlier focused follow-up results at a three-journey snapshot: all three journeys passed in 38 seconds with zero allowances, failures or skips; 21 Lend UI/copy tests and the unchanged lender return-on-Resume regression passed. The Pause journey made zero waiting-offer declines, returned the offer after Resume without starting it, and retained the original running attempt with zero cancellations and visible output afterward.

## Earlier implementation follow-up

The implementation branch starts at PR #41's `54ea14e9`. Six of the seven original findings are fixed and their allowances removed. Not now changes only component state on Home and Review request. The signed request stays pending, with no coordinator call or local HTTP mutation, and returns after navigation and reload. Review request now has a separate Decline action. The coordinator records this device's refusal without claiming or cancelling the job, excludes it from offers and both claim paths, and retains the refusal across coordinator restart. Other lenders can still claim the job. This requires host capability `offer_decline_v1`; an older host returns an update error.

The compatibility `/api/approvals/{id}/skip` endpoint remains unchanged for paired-phone dismissal and direct API callers. It hides a modern offer locally until expiry or releases a legacy held attempt. The canonical `approvals.decline` operation now uses `/api/approvals/{id}/decline`.

At that earlier snapshot, Pause closed modern reviews without durably declining their unclaimed offers, and the confirmation said: “Pause new jobs. Waiting reviews close on this computer. Unclaimed requests can return when you resume. Running jobs continue within their saved limits.” That copy is superseded. The current confirmation says: “Pause new jobs. Waiting offers are held, not declined, and return on Resume if still available. Running jobs continue within their saved limits.” The earlier `R29-pause-waiting-copy` allowance was removed after the contract clarification.

The final decision run executed all three journeys in 69 seconds: **2 contract passes, 1 expected failure, 0 unexpected failures, 0 skips**. Not now produced 0 action-attributed coordinator calls and 0 local writes; Decline produced exactly 1 coordinator decline and did not return after reload. Pause retained the same active attempt, produced 0 cancellations and displayed new output afterward. This does not satisfy the complete Pause contract.

The full UI suite passed with 1,555 passes, 16 existing TODOs and no failures or skips. Affected headless browser checks covered 20 scenarios across desktop/phone, light/dark, retry, expiry, signed deadlines in UTC and Chicago, and Pause/Resume. Fifteen passed initially; the four legacy-clock cases expected “Answer within” although `54ea14e9` already says “Review window closes in.” After correcting that stale test expectation, all four passed on a focused recheck, as did the Pause/Resume check. Module syntax checks, generated app-operation-document checks and `git diff --check` passed. Those app-operation checks did not cover the coordinator OpenAPI route; the separate coordinator parity test failed until the decline operation was documented in Round 2.

The targeted backend batch executed 345 tests with 343 passes and two failures from old Pause-copy expectations. Those expectations were corrected; the focused Pause/Stop app test and all 52 lending-state/copy tests passed on the final files. No other backend failures or skips occurred. The batch covered app approvals, legacy lender skip, modern offer hide, paired-phone compatibility, running-work continuation, coordinator offers and operation parity. It also passed the new coordinator restart/idempotency tests and the existing proof that Pause/Resume returns unclaimed offers. The full backend and browser suites, native sandbox, real providers, cross-machine networking and an independent code review remain unverified.

The baseline evidence below describes the unchanged product at the start of PR #41.

## Baseline

A lender can permanently pass on a request by choosing Not now, and can pause without seeing every consequence.

These three headless Chromium journeys exercise the real UI, local app, signed coordinator HTTP calls and SQLite store. Only execution and allowance/readiness evidence are synthetic. The tested product base is `67ffcf319d57ca862ffd70044fb128b63e6b790d` on `fix/mac-sbx-keychain-1027`. The intended behavior comes from PR #6's `PLAN.md` and `CONCEPT-MODEL.md`, inspected on `design/ui-overhaul-1027` separately from this base.

| Contract | Required assertion | Observed at this base |
| --- | --- | --- |
| Not now | Zero coordinator requests, zero local mutations, request available on a later visit before its deadline | **FAIL.** Modern Review request has no Not now. Home's Not now sends one local `POST /api/approvals/{id}/skip`, causes coordinator resource reads, and hides the request across navigation and a full reload. The job remains queued and unclaimed. |
| Decline | A separate explicit Review request action, exactly one coordinator decline, no return on a later visit | **FAIL.** Review request has no Decline control. No decline can be initiated, so the observed decline count is zero and the request remains. The exactly-one and nonreturn assertions remain in the journey but are blocked by the missing control. |
| Pause | Show no new jobs, decline waiting requests, and continue running work before confirmation; preserve running work after confirmation | **FAIL on copy; PASS on execution continuation.** The dialog says “Pause new jobs. A running job is stopped before reset.” It omits the waiting-request decline and an explicit statement that running work continues. The original attempt stays active, receives zero cancellations and produces visible output after Pause. |

The Pause journey has a real waiting approval for a second synthetic provider while the first provider runs. Before confirmation it asserts zero Pause/Off browser writes, lending still enabled, and that approval still pending. After confirmation it asserts exactly one local Pause POST, an empty approval list, no attempt for the waiting job, the same active running attempt, zero executor cancellations, and new output through the real transcript path.

The defect sites are:

- `ui/v1/src/home.jsx:54`: Not now calls `mutate(.../skip)`.
- `ui/v1/src/request.jsx:215,260-263`: passing calls skip; modern offers expose Not for me and Run it, with no local Not now or separate Decline.
- `lib/v1/app.mjs:1205` and `lib/v1/lender.mjs:1031-1052`: skip finishes the approval and persists its offer hide until expiry.
- `ui/v1/src/lend.jsx:419` and `lib/v1/lending-status-copy.mjs:44`: the confirmation uses only the new-jobs line and the stop-before-reset sentence.

The request spy records every coordinator dispatch before sending it and every coordinator receipt before authentication, without truncation. It retains failures and non-2xx responses. A transparent browser route adds an action tag; `AsyncLocalStorage` carries that tag through the local HTTP handler to coordinator fetches. The Not now assertion counts every method attributed to the action and checks dispatches against real coordinator receipts. All background traffic remains in the full trace. The local-mutation assertion is separate because skipping can wake a pre-existing lender task outside the browser request's async context. Coordinator GETs are not reported as coordinator declines.

The tests use the browser lane's existing per-problem expected-failure mechanism, described in `docs/testing-browser.md` and implemented in `verify.spec.mjs`. Seven named entries cover only the reproduced findings: four for Not now, one for missing Decline, and two for Pause copy. A new problem fails the run. A finding that disappears also fails until its allowance is removed. No journey is skipped, and hard assertions about execution, request tracing and fixture setup remain outside the allowances. A passing allowance run does **not** mean these contracts pass.

Final targeted result on October 28: **3 journeys executed, 3 expected-failure cells, 7 named findings, 0 unexpected failures, 0 skips**, in 83.2 seconds. Not now produced 5 action-attributed coordinator requests and 1 local skip POST; the coordinator received every attributed dispatch, and the request did not return. Decline produced 0 decisions because its control is absent. Pause produced 0 Pause/Off writes before confirmation, 1 Pause POST afterward, 0 executor cancellations and new output from the same active attempt. The request-spy snapshots contain 55, 42 and 131 coordinator requests for the three journeys, respectively. The UI build and both module syntax checks passed. Confidence is high for these findings at this tested base.

Run from a checkout after installing dependencies:

```sh
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY DISPLAY= WAYLAND_DISPLAY= FARAVAN_NO_BROWSER=1 nice -n 10 npm run test:browser -- tests/browser-verify/decision-contracts.spec.mjs
```

This command builds the current UI before the targeted run. The standard browser report identifies the three `R29` cells as expected failures. Each test attaches `decision-contract.json` and `decision-request-spy.json` to `test-artifacts/browser-verify/results.json`. They contain the findings, action counts, complete request traces and retained fixture root. The fixture closes its apps, coordinator, database and browser context but keeps its scratch under `$TMPDIR/faravan-decision-*` for inspection.

PR #24 is not required for the tested running-work continuation or for reproducing the missing confirmation copy. It remains an unmerged dependency for the stronger row-25 guarantees about durable waiting-offer decline, Pause intent across restart and scoped Stop recovery. This lane does not merge it or claim those guarantees. These journeys do not qualify a native sandbox, real provider sign-in, cross-machine networking or the full browser suite.
