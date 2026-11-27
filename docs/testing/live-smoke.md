# Live smoke test

`scripts/live-smoke.mjs` runs the real two-machine Faravan loop with one command:

1. The borrower (a container on another machine) creates a fresh tiny git repo with one failing `node --test`, then submits a job to the circle.
2. This computer (the lender) claims the job, shows an approval card, and the script accepts it through the local app API.
3. The lent agent runs the job. The script follows lending activity until it finishes.
4. The borrower waits for the job, applies the result to a new branch, and runs the test on that branch.

It prints one `RESULT PASS|FAIL …` summary line and exits 0 on pass, 1 on fail.

```sh
node scripts/live-smoke.mjs --preflight-only      # checks only; changes nothing
node scripts/live-smoke.mjs                       # full run
node scripts/live-smoke.mjs --update-borrower     # full run; first updates the borrower checkout
```

## Preconditions

The script fails with a plain message when one is missing:

- The Faravan app is running and answers on its local API (`~/.waspflow/faravan/v1/app.json`).
- A circle named `Faravan test` exists, and lending is on for it, not paused, in `ask` mode, and idle.
- Today's lending limit (UTC) is not used up, and no approval card is already waiting.
- The `codex` agent is installed, signed in, and enabled for lending.
- The borrower answers over SSH (`root@10.23.1.60`, run as user `borrower`).
- The borrower checkout (`/home/borrower/faravan`) is at the lender's committed HEAD. With `--update-borrower`, the script bundles HEAD, copies it over, and resets the borrower checkout. It refuses to reset a checkout with local changes.

Override the defaults with `SMOKE_CIRCLE`, `SMOKE_BORROWER_SSH`, and `SMOKE_BORROWER_USER`.

## Output

- Each lender status change is printed with a timestamp.
- On failure, the script prints the stage, the newest entry in `~/.waspflow/faravan/v1/lending-errors.jsonl` (message only, 500 characters at most), and the borrower's job status.
- The summary line gives the job id (first 8 hex characters) and four durations:
  - `submit->claim`: from the borrower's `run --detach` returning to the lender's `awaiting-approval` event.
  - `approve->start`: from the accept call to the lender's `running` event.
  - `run`: from `running` to `finished`.
  - `result->applied`: from the borrower's `job wait` returning to the end of `faravan apply`.
- `usage` is the last `turn.completed` event in the lender's transcript: input, output and reasoning tokens.

The script never prints the app token or an invite link. Remote output passes through a redactor that drops `faravan://` and `/join` or `/i/` URLs.

## Cost and limits

Every full run submits one real job to the lender's Codex allowance. The test prompt is tiny and the lender runs it at low effort. The lender's daily job limit applies, and the preflight stops the run when it is used up.

The borrower leaves its scratch repo at `~/smoke/<timestamp>/repo` after each run, for inspection. The result branch is named `smoke-<timestamp>`.

## Known limits

- Timings come from the lender app's own clock, which is the same clock as this script, but the borrower's `run` and `job wait` returns are sampled over SSH. Expect about a second of jitter.
- The script follows the lender's single lending state, not a job-specific stream. It is only correct while lending is idle before the run, which the preflight enforces.
- It tests one job type (one failing test, one prompt). It does not cover cancel, expiry, or declined jobs.
