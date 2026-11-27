# Faravan .54 integration, 2026-11-03

Base: `f737e8ff5`. Branch: `integrate/54-1103`. Source PRs remain open and unchanged.

## Merged heads

| PR | Head SHA | Text conflicts and resolution |
| --- | --- | --- |
| #240 | `7bfa20199ccb175729470bcb430f4e35c3ce7552` | None |
| #242 | `021e56cad352314781b50ac0136bee492faf472f` | `scripts/protocol-check.mjs`, `spec/tla/README.md`: retain all model rows and documentation; appended LaunchComposition rows restored in a follow-up commit. |
| #243 | `dcc78891d9342ac698e57095bd663e927edcb739` | `scripts/protocol-check.mjs`, `spec/tla/README.md`: retain all model rows and documentation; appended LaunchComposition rows restored in a follow-up commit. |
| #244 | `bda3e0347ac0a3ec175f709c778c05ddaea1bb6d` | `scripts/protocol-check.mjs`, `spec/tla/README.md`: retain all model rows and documentation; appended LaunchComposition rows restored in a follow-up commit. |
| #245 | `ba88a770c2b86797cd37e7182bd747e325d2f4ca` | `scripts/protocol-check.mjs`, `spec/tla/README.md`: retain all model rows and documentation; appended LaunchComposition rows restored in a follow-up commit. |
| #246 | `56bbe2e0c5fdfe312696581a18154fdd8af1e867` | `scripts/protocol-check.mjs`, `spec/tla/README.md`: retain all model rows and documentation; appended LaunchComposition rows restored in a follow-up commit. |
| #247 | `68b2d7bd8e60316eb4f2a4b9487da76385438b61` | `scripts/protocol-check.mjs`, `spec/tla/README.md`: retain all model rows and documentation; appended LaunchComposition rows restored in a follow-up commit. |
| #248 | `f02b9765b1f734b11621405c8ee0c9e726b718ed` | `scripts/protocol-check.mjs`, `spec/tla/README.md`: retain all model rows and documentation; appended LaunchComposition rows restored in a follow-up commit. |
| #256 | `8194b62ea748e9a22d181b902361d8a538fb7276` | `scripts/protocol-check.mjs`: retain all model rows and the 900-second Hosting_h4 limit. |
| #255 | `9e3550774873d2c6a02ef47291ef0d9a8fbc3026` | `tests/probe-ownership.test.mjs`: keep repaired cancellation expectations and all controls; restore all model README additions. |
| #250 | `d81f7b6334447d37a1d8846296a0c4316f4eb420` | None |
| #249 | `3079b128921770bf8b4998bbeac26d6495b9a017` | None |
| #252 | `8644d960288bfbb0033bc7fa2b4125f895d5d901` | None |
| #258 | `240946aa2e9aa15c44881f576b441af00b197071` | None |
| #251 | `e80b35ee6ff24d1b9acbd68f877be02e2b2cb27d` | None |
| #254 | `beb116d565c1faf69f79c843d4dc98dae8db3eb3` | None |
| #257 | `46ff6ac6576fdc682569dc1fd069bb5788e19135` | None |
| #259 | `d2ae7e34f2aab22c0ce91f71cc2c4133cb9c7a69` | None |
| #253 | `7c15d7e3220a7d3a47161ace161c5c76ebbb0e53` | None |
| #260 | `6b198255b66ad15473a7dffd14f5a7eb63747e4d` | None |

## Additions

1. Implemented: live bound-window rechecks retry once only after `evidence_superseded` produces `refresh_failed`. The retry rebuilds from saved fresh evidence; another refusal still stops the job. Two regression cases prove continuing with sufficient fresh room and stopping with exhausted fresh room. The sufficient-room case fails when the change is removed.
2. Skipped: the reported unknown-job `network_error` has not been reproduced. `lib/v1/cli.mjs:412` emits `not_found` for a missing prefix match, and `problemForError` preserves it. `lib/v1/client.mjs:295` creates `network_error` after a transport failure; `device.mjs` also creates it on a request deadline. A 404 is classified separately. Changing CLI copy without tracing that failure would mislabel an actual network failure. No CLI code or test was added.

## Decisions left to the lead

The instructions prohibit changing source tests to make the merge pass and require retaining all guards and refusals. These source expectations conflict with the included fixes; no assertion was removed and no safety behavior was weakened:

| Source assertion | Included behavior |
| --- | --- |
| #244: `tests/admission-exposure-paths.test.mjs:115` closes native holds even without full coverage. | #249: `lib/v1/lending-policy.mjs:1185` retains unrepresented spend and remaining holds until coverage or reset. |
| #248: `tests/admission-accounting-replay.test.mjs:172` releases holds for meter rises of zero or one point. | #249 retains the reservation envelope. |
| #247: `tests/admission-recovery-paths.test.mjs:62` expects permanent poison after a transient save fault. Its line 102 also expects an uncovered native hold to close. | #250: `lib/v1/lender-pace50.mjs:1762` reopens poisoned adapters; #249 retains uncovered native holds. |
| #249: `tests/admission-blind-exposure.test.mjs:74` expects `quota_unknown` for `native_attempt_in_flight`. | #252: `lib/v1/lender-pace50.mjs:73` deliberately maps it to `quota_reserve`. |

The accounting TLA module also needed bindings for the newer Admission parameters `CancelSafe`, `RecheckSafe` and `race`. These were added using safe flags and the idle race record. Its imported predicate `ClosedHasProof` depends only on cleanup, held and pending values, so the new bindings do not change the predicate checked.

## Generated files

Rebuilt with `TZ=America/Chicago npm --prefix ui run build`. The result is byte-identical to the merged checked-in bundle, so there is no extra bundle diff to commit. Telemetry, support schema and operation documentation generators produced no changes.

## Validation

- Full Node suite: 663/669 files passed, 8,214 tests, 3 skipped, 869.9 seconds. Failing files: `admission-exposure-paths.test.mjs` (2 assertions), `admission-blind-exposure.test.mjs` (5), `admission-accounting-replay.test.mjs` (2), `admission-recovery-paths.test.mjs` (2), `packaging-runtime.test.mjs` (1) and `stable-home-parity.test.mjs` (1). The latter two are the permitted offline Go dependency baselines.
- Auth-flow: all 41 tests passed in the full suite; no reruns required. Copy vocabulary, rename guard and UI bundle-current passed. The cold-window file passed all 26 tests, including the two new cases.
- UI suite: 2,384 total; 2,367 passed, zero failed, 1 skipped, 16 TODO.
- TLC: the full command ran once under the machine-wide lock: 139/157 expected outcomes matched; all 18 AdmissionAccounting checks stopped at semantic analysis because of missing bindings. After the interface fix, one targeted locked rerun matched 18/18. Together, all 157 final expected outcomes are verified. Hosting_h4 passed in the full run: 4,803,072 distinct states, 194 seconds; no isolated retry was needed.
- All 20 remote heads were checked against the recorded SHAs. PR #260 remained at its recorded head on the final check.
- The Node suite ran before the final accounting-interface-only correction. That correction was checked by the targeted TLC run; the full Node and full TLC commands were not repeated.
- Full suite ran in a background exec session. The requested `t3_background_wait` call returned `This provider cannot mark background work as awaited.` The session was awaited directly without ending the turn.
- No real agents, sign-ins, installed app operations or SSH were used. The safety-mac lane is intentionally excluded for the lead to add later.
