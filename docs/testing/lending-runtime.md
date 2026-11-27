# Lending budgets and recovery

This implements a slice of Phases 2–4. The remaining acceptance checks and missing start gates below prevent treating the whole design as complete.

The local lending runtime reserves allowance before preparing a friend's job. A shared ledger serializes reservations across account workers. Standing rules also share one daily and weekly ceiling across those workers. An uncertain claim is replayed with its original key, then its standing rule is checked again before work starts.

Claude uses the CLI's reported dollar cost and its native budget flag. Codex uses cumulative rollout tokens priced in pinned credits. Cached input and reasoning output are not counted twice. Fast mode remains disabled. An unknown plan or missing conversion keeps automatic lending off; an explicitly accepted job can use a time cap when allowance is unknown.

The guest guard asks the agent to stop and collects its partial result. It escalates from SIGINT to SIGTERM after 20 seconds and SIGKILL after another 10 seconds. The host independently checks stop evidence and requires guard heartbeats. Budgeted Codex jobs also require usage evidence within 60 seconds of starting and within 120 seconds of the last usage event. Missing evidence stops the job with an error and keeps the full allowance reservation as spent. These deadlines bound an unmeasured interval; they cannot impose a strict per-call ceiling.

After a crash, the lender proves every recorded sandbox has stopped before clearing its journal. `reconcileAttempt` releases a hold only when work is known not to have started. Otherwise missing measurements charge the full reservation. Repeated recovery does not charge twice. Owner and error stops refund the person's limit, while allowance already spent remains lent use.

The allowance page uses the same policy evaluator as admission. Watch-only mode keeps the previous policy in force until the owner explicitly turns watch-only off and saves. Backtests simulate one admission per hour, independent of reading frequency, and require at least seven days of history without gaps over six hours. They estimate available lending capacity, not demand.

## Verified scenarios

Targeted tests cover shared rule ceilings, revoked-rule recovery, missing Codex metering, partial-result delivery, concurrent account journals, conservative crash charges, and observation-independent replay. UI tests and browser journeys cover versioned policy saves, scoped rule add/revoke, narrow layouts, keyboard focus and light/dark themes.

Live checks through the normal signed-in sandbox path established:

- Doctor reports ready with `test_workspace.ok: true`.
- Claude stops on its native budget and delivers a partial diff. The latest run stopped at $0.0463534 with a $0.05 guard budget and a $0.044 native flag.
- Codex rollout readings arrive during execution, and an owner stop delivers the partial diff.
- The latest Codex run stopped at 2.00001 credits against a 2-credit budget and delivered the counter change from 0 to 10. Its live meter reported the requested model and effort, and its sandbox was removed. This small run does not validate the weekly conversion prior.
- Both providers' idle usage GETs run through the guest proxy using the production Python probe and populate the ledger.

Raw account identifiers and rollout files are not included in public receipts. The guard shares the guest with the agent and is intended for cooperative workloads; it does not isolate itself from a hostile agent inside that guest.

## Remaining verification and scope

The same-account comparison has unit tests but no production host-observation source. Its hour-separated live check and the week-long reset-model check remain outstanding. Forecasts therefore cannot rely on imported host history. Claude's short-window conversion priors are labeled guesses, and unknown plans remain uncalibrated.

Live tests have not established time-stop escalation, heartbeat-loss fallback, or provider-limit stops. Stand-in backend tests cover those stop paths. The Codex `rollout_budget` CLI backstop is not enabled because its behavior has not been verified. AC-power, metered-network and thermal start gates are not implemented. The borrower effort UI and cross-harness effort registry remain deferred. The real-account page comparison and a 1%-of-week budget/delta check remain outstanding; the browser page checks use fixtures.

A rare recovery limitation remains: if a kept acceptance has lost its recorded rule use and reserving it hits a rule ceiling, that worker keeps waiting for the ceiling rather than releasing the acceptance. Other workers continue. Ordinary retained entries cover seven days; the acceptance would need to outlive that history or lose it through trimming for this case to occur.
