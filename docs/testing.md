# Testing

## Run it

| Command | What runs | Use |
|---|---|---|
| `npm test` | Every Node test file and the two shell suites, one command | Before you push, and for the checker's `default` gate |
| `npm run test:fast` | The fast tier: every Node file except `SLOW_FILES`, plus the shell suites | Edit loop; about 70 s on this host |
| `npm run test:slow` | The 18 `SLOW_FILES` (each takes more than 10 s alone) | When you change the app or its fixtures; about 4 minutes |
| `npm run test:ui`, `npm run test:tray` | The UI and tray suites | Unchanged |
| `npm run test:e2e` | Playwright browser tests | Opt-in; not part of `npm test` |

`npm test` exits 1 on any failure. Each failing file prints the tail of its output, within a
240 KB budget. Full per-file logs are kept in `test-artifacts/node-tests/` (git-ignored).
A file that is quiet for 180 s is killed and reported as stalled.

The live two-machine check (`scripts/live-smoke.mjs`) is not part of the suite. See
`docs/testing/live-smoke.md`.

## How the runner works (`scripts/run-tests.mjs`)

- **One `node --test` process per file**, four at a time (`--concurrency=N` or
  `TEST_CONCURRENCY` to change it). Node's own `--test-concurrency` has no per-file watchdog, so
  one stuck file stalls the whole run.
- **Per-file watchdog** (600 s, `TEST_FILE_TIMEOUT_MS`), and a **silence watchdog** (180 s with no
  output, `TEST_STALL_MS`). Node's `--test-timeout` is set to the file budget (it caps the file as well as each test), so a test
  that must fail sooner sets its own `timeout`, and a file that prints nothing for 180 s is stuck. Either watchdog kills the file's whole process group and fails it by name.
- **A file passes only if** it exits 0, registers at least one test, and reports no failed and no
  cancelled test. Node reports a file with no tests as one file-level entry; the runner does not
  count that as a test.
- **Leaked children fail the file.** A child process still running after its file ends is killed,
  and the file is reported with the leak.
- **Scratch is on RAM** (`/dev/shm`, when it has at least 2 GB free). The run makes one scratch
  directory there and removes it on every exit. Each file gets its own directory inside it as `TMPDIR`,
  removed when the file ends, also when the watchdog killed the file. Otherwise the file uses the default `TMPDIR`.
- **Suites that make temporary directories** use `tests/helpers/temp-dir.mjs` (`tempDir(prefix)`), which
  removes them at process exit, also after a failure. `tests/shm-cleanup.test.mjs` checks that a failed
  run and a watchdog-killed file leave nothing behind.
- `NODE_TEST_CONTEXT` is removed from the child environment. A test that runs under `node --test`
  sets it for its children, and a nested `node --test` then prints no summary.

### Why four files at a time

Measured on this host (24 threads, 124 GB RAM) with the fixed suite. At concurrency 4 the full run
took 156 to 159 s, with 437 to 441 CPU-seconds (about 2.8 cores on average) and a peak of 0.9 to
1.0 GB resident across the processes. The critical path is `v1-app.test.mjs`, which takes about
140 s with RAM scratch. The rest of the suite, run one file at a time, is about 230 CPU-seconds and
about 575 s of wall time, much of it waiting, so it fits in the shadow of `v1-app` once a few files
run side by side. Concurrency sweep (on the tree before the rebase onto `origin/main`, same host,
same afternoon):

| Concurrency | Wall | CPU-s | Peak resident MB | Result |
|---|---|---|---|---|
| 2 | 251 s | 446 | 1000 | 80/81 (`copy-vocabulary` only) |
| 4 | 156 to 159 s | 437 to 441 | 867 to 1041 | 80/81 in two runs; 79/81 in one (intermittent `v1-lender`, below) |
| 6 | 173 s | 463 | 1069 | 80/81 (`copy-vocabulary` only) |

Four keeps the run's average CPU near three cores, which is a fair share of a shared host, and it
reaches the critical path with headroom. Raise it only after you have measured the critical path on
the new file split.

Wall time is set by the slowest file, and the slowest file is set by where its scratch lives. The
v1 stores fsync on every commit. With scratch on disk, `v1-app.test.mjs` ran alone in 392 s; with
scratch on RAM it ran in 139 s, with the same 101 passes.

## Isolation rules for new tests

1. The first line of every `tests/*.test.mjs` is `import './helpers/no-browser.mjs';`.
   `tests/no-browser-guard.test.mjs` enforces it.
2. **Own everything you start.** Close each server, stop each loop or timer, and kill each child in
   `t.after`. A child that outlives its file fails the run. Teardown must close every resource even
   when one close fails; `tests/helpers/v1-app-fixture.mjs` shows the pattern.
3. **Listen on port 0.** Never a fixed port. Ports are reused across test processes, so a client
   that keeps retrying a closed server can reach another test's server. Treat a request that does
   not carry your fixture's proof as a stray, not as a failure of your test
   (`tests/helpers/v1-lender-fixture.mjs`).
4. **Temp directories come from `mkdtemp`** under `os.tmpdir()`, and you remove them in `t.after`.
   Never write the real `$HOME` or the XDG directories. Give each test its own `HOME`.
5. **Hang guards, not latency budgets.** A timeout in a test must only stop a call that never ends.
   Do not assert that something takes less than N ms, and do not set a 1 s or 5 s guard on anything
   that talks to a child process or a server. On this host the load changes by 10x during a run.
   The test timeout (60 s or 120 s) and the `waitFor`/`until` deadlines bound a hang.
6. **Wait for a condition, not a clock.** Poll for observable state with `waitFor` or `until`. Do
   not use a real `sleep` as synchronization. A sleep that waits for something to not happen is
   allowed only as a short, named window.
7. **Do not depend on where `TMPDIR` points.** A hard link (`cp -al`) fails across filesystems. The
   packaging build keeps its scratch next to the stage tree for this reason.
8. **Make the oracle fail first.** Every fix comes with a test that fails on the old code and passes
   on the new code. `tests/v1-app-close-race.test.mjs` is an example.

## Flake policy

- **No automatic retries.** A retry can turn a real contention bug into a green run. Kubernetes bans
  retries outright. The projects that allow them still route every flake to an owner.
- **Reproduce, root-cause, fix.** Reproduce the failure under load (run the suite governed, at
  concurrency 4 or 6), find the cause, and fix it at the root. Say how you proved it.
- **Quarantine only with a named reason.** If a test is flaky and you cannot fix it yet, record it in
  `tests/QUARANTINE.md` with the failure, the evidence, an owner, and an exit date. A deterministic
  failure is not a flake and is not quarantined; it stays red until its owner decides.
- **Deterministic failures stay red.** `tests/copy-vocabulary.test.mjs` failed on `main` for the join
  page's banned copy until the join lane changed the copy and its allowances. That is a product
  decision, not a flaky test.

## Measured baseline and results

| | Before (`main` at 169089d, one file at a time, load 20 to 86) | After (fixed tree, one file at a time, load 9 to 28) |
|---|---|---|
| Files | 77 | 79 |
| Wall, sum of files | 1250.5 s | 966.9 s |
| CPU, sum of files | 435.4 s | 378.8 s |
| Peak resident memory, one file | 310 MB | 295 MB |
| `v1-app.test.mjs` wall | 539.7 s (2 tests failed under load) | 391.6 s |
| Failing files | `copy-vocabulary`, `v1-app` | `copy-vocabulary` |

The "after" column ran with scratch on disk, the default for the shell that measured it. With scratch
on RAM, `v1-app.test.mjs` alone took 139 s (101 passes, the same as on disk).

The load differed between the two sets. Treat the wall times as indicative. The CPU-seconds are the
steadier comparison. A paired, interleaved A/B is the way to state a precise number.

Governed `npm test` runs on the fixed tree (the same command the checker runs):

| Run | Concurrency | Wall | CPU-s | Peak MB | Result |
|---|---|---|---|---|---|
| Before the fixes, governed `node --test` at concurrency 6 | 6 | 912 s | 582 s | 1254 | 76/80: `v1-app` hit the 900 s watchdog; `auth-flow` leaked a `sleep`; `packaging-runtime` failed on hard links; `copy-vocabulary` |
| Fixed tree, scratch on the governor's tmpfs | 4 | 159 s | 441 s | 867 | 80/81: `copy-vocabulary` only |
| Fixed tree, RAM scratch | 4 | 156 s | 437 s | 1041 | 79/81: `copy-vocabulary`, and one intermittent `v1-lender` failure (see below) |
| Fixed tree, RAM scratch, lender diagnostics on | 4 | 159 s | | | 80/81: `copy-vocabulary` only |
| Final base (`origin/main` 0d1da8e plus these commits), run 1 | 4 | 280 s | | | 102/102 files, 1604 tests |
| Same, run 2 | 4 | 228 s | | | 102/102 files, 1604 tests |
| Same, run 3 | 4 | 226 s | | | 102/102 files, 1604 tests |
| `npm run test:fast` on the final base | 4 | 66 s | | | 85/85 files, 819 tests |
| `npm run test:slow` (measured before the final base) | 4 | 244 s | | | 17/17 files, 785 tests |

## Open items

- The v1 app split is partly on `main`: the new `tests/v1-app-*.test.mjs` files are in the fast tier
  unless listed in `SLOW_FILES`, and `tests/v1-app.test.mjs` is still 2208 lines at 0d1da8e. Re-measure
  the tiers when the split lands.
- `v1-lender.test.mjs` failed once in three full runs, with two errors from the fixture's HTTP
  handler: one request had no proof, and one carried another key's proof. Neither reproduced when
  the file ran alone (3 of 3 passes) or with four heavier files at concurrency 4 (468 of 468). The
  proof-less case is now recorded as a stray (`strays`), not as a test error. The key-mismatch case
  is still an error. It may be a stray from a reused port, and is the next thing to check.
