# Saved-state upgrade fixtures

Each directory holds state written by that release's own app and state writers.
All identities are synthetic. No installer, real sbx, Docker daemon, provider,
credentials or owner data was used. The headless apps listened on loopback with
port 0 and lending off. Browser and autostart were disabled, display variables
were empty, all homes pointed at throwaway directories, and failing sbx/docker
stubs were first on PATH.

| Directory | Published version | Source commit |
| --- | --- | --- |
| 59 | 0.1.0-preview.20261104.59 | aa216472d727bbdccc965f3080093cfd54b9869d |
| 60 | 0.1.0-preview.20261104.60 | b85c5b11c8f53826e321e424160f555c1f698627 |
| 61 | 0.1.0-preview.20261104.61 | f57df1e0 |
| 62 | 0.1.0-preview.20261106.62 | d561d36e |

The .59/.60 source identities come from their release build scripts; .61/.62
are the release source identities. These four releases are the initial corpus,
not a claim that every earlier published release has been captured.

## Contents and provenance

`capture.mjs` is the exact capture procedure. It imports the selected release's
`startApp`, its synthetic test backend and its state writers. The app's own
`POST /api/lending/limits` saves seven daily jobs, 91 daily minutes, a 1200-second
wall cap, reserve 35, explicit UTC with Monday/Wednesday/Friday 09:15–16:45,
policy per-job percentage 9, warning 17, three machine slots, both provider
consents and non-default account plans. Other app settings come from startup.

The API rejects or cannot produce the following edge cases. They are written
through the old release's own exported writer functions, not claimed as normal
API captures:

- `app-settings.json`: after the API capture, `saveJsonFile` removes
  `timeZoneChosen` to model a saved UTC schedule from before that marker existed.
  All four source releases already have the UTC startup defect; their normal
  explicit-UTC API writes include the marker and would not reproduce U4.
- `invalid-policy.json`: `saveJsonFile` saves a copy with `warningPct:150`.
  This is rejected by each release's API. Every other policy value is valid.
- `app-counters.json`: `createLenderCounterStorage.acquire/set` writes an
  interrupted pending attempt under `accounts.codex:0` with a clear root.
  This proves reader compatibility, not reachability through an ordinary lender:
  the normal lending pool mirrors account journals to the root. No real job ran.
- `sessions.json`: `openSessionStore.create/close` writes a phone-kind device
  session with inbox and request scopes. Its cookie secret is discarded. Only
  the non-secret hash remains. Synthetic timestamps keep the fixture independent
  of the capture date; this does not exercise cookie authentication or transport.
- `cleanup/*.json`: `createSandboxCleanupJournal.register` writes an interrupted
  prepare record. Releases .59–.61 write version 1; .62 writes version 2 with
  ownership and a reserved create. Locks are discarded after capture. The .62
  ownership identifier comes from `ensureSbxOwner` and is a synthetic installation
  ID, not a credential. Its executable is relocated to the failing stub.

`@ROOT@` replaces only throwaway absolute locations. The test substitutes its
fresh root before loading. The .62 owner file is placed at the current install's
owner-file path while retaining its captured ID. Fixtures contain no real names,
hostnames, cookie secrets, access tokens or pairing codes.

## Assertions

Each fixture is copied before use. Current `startApp` loads and saves settings;
a second start verifies the saved result. Each original setting is compared,
including consent, UTC schedule, daily limits and account plans. A rejected
policy must retain valid fields and consent and show the rejected value in an
unacknowledged notice. The device record must remain visible.

The updater's actual timer receives each of the eight per-account pending keys
with a clear root; every one must report non-idle. Empty counters are the positive
control. Keys other than `pending` are test-derived variants of the captured
counter writer output, not separate historical job captures.

Recovery uses the real DockerSbxBackend with injected daemon/listing/process
observations: one live daemon, readable empty sandbox inventory, complete empty
process scan. No sandbox commands execute. The real lender then recovers the
stored pending row through the real counter storage. Pending must clear and the
full reservation must remain charged. This verifies the counter reservation,
not a historical provider ledger, because the synthetic attempt never ran one.

U3 (portable/package installer fallback) is outside this saved-state suite. No
installer is executed. U1/U2/U4/U5 are the saved-state risks covered here.

## Adding a release

1. Create a detached checkout of the exact published source commit outside /tmp.
   Link its dependencies to an existing compatible node_modules tree.
2. Run `node tests/fixtures/upgrade/capture.mjs SOURCE THROWAWAY DESTINATION` from
   the new checkout's tests branch. Use a fresh throwaway directory, with no real
   credentials in its environment. Read the capture before running it. Then run
   `node tests/fixtures/upgrade/consent-variants.mjs SOURCE DESTINATION`.
3. Review every output for secrets and absolute paths, add its source identity
   above, and add its directory to the test's release list. If a storage format
   changes, update capture/load explicitly rather than replacing older fixtures.
4. Run this one test file with `test-sandbox --net none` and the no-browser and
   no-autostart environment flags. Remove the throwaway directories and checkouts.

## Regression proof (2026-11-06)

Every run used this one file under `test-sandbox --net none`, with browser and
autostart flags set and display variables empty. The suite has 34 parent tests
and 32 journal subtests (66 counted by Node).

Red/green was measured on current `origin/ship` (3a3c821e). The green run merged
the then-current heads of the two fix PRs into a local copy of this branch (not
pushed): PR 398 at 3decabce and PR 399 (fix/legacy-hold-upgrade) at 76033286.

| Code under test | Pass | Fail | Failing cases |
| --- | --- | --- | --- |
| origin/ship 3a3c821e | 11 | 55 | U1 recovery on .59–.61; U2, U4 and all three U5 variants on all four |
| ship + PR 398 3decabce + PR 399 76033286 | 66 | 0 | None |

The 11 passes on ship are the fail-closed cases (they must hold before and after
the fixes) and the .62 U1 recovery, which already worked there.

## Fail-closed and consent cases

- U1 fail-closed (.59–.61): unreadable sandbox listing, incomplete process scan,
  and two live daemons at one HOME. Recovery must not prove removal, and the real
  lender must keep the pending hold, the reservation, and call no release or
  stopped. .62 rows resolve through the cleanup journal's own create receipt, not
  a listing or scan, so its fail-closed case is an owner scope that does not match
  this installation.
- U4 requires each fixture to hold the seven setting groups, compares the values
  the app serves from `/api/lending` (not only the file), makes a supported save
  of one unrelated limit, restarts, and compares again.
- U5 runs the rejected-policy fixture three ways: all consents true, all false,
  and mixed (claude true, codex false). The latter two are saved with that
  release's own writer by `consent-variants.mjs`. Migration may withhold active
  consent (the owner confirms again) but must never grant one, and the saved
  choice must remain active or recorded in the migration note.
