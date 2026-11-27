# Windows native acceptance

**Status: not yet run on Windows.** This pack does not qualify Windows support.
Linux tests, injected Win32 branches and cross-compilation cannot close release-gap
rows 10, 11 or 20. The macOS record in `docs/internal/macos-acceptance.md` applies the
same distinction for row 19. A completed receipt qualifies only its exact MSIX
hashes, source commits, Windows build and tested scenarios.

## Preconditions

Use a disposable, fresh Windows 11 x64 VM with an interactive desktop. Keep
Developer Mode off, Defender and SmartScreen on, and use a standard user without
elevation. No Node, Go, Git Bash, WSL, developer symlink privilege or source checkout
may be needed to install, launch, restart or use the CLI. Git is needed later for
the project fixture. This pack uses Windows PowerShell 5.1 or newer and the
installed Node runtime; no `npm ci`, SDK, administrator access or API key is needed.

Before the baseline snapshot, have the VM administrator create two standard users.
Use a real non-ASCII profile directory, such as `C:\Users\Faraván测试`, for the
primary run. Check the actual directory, since Windows can shorten account names.
Sign into OneDrive with a test account and redirect Documents using its normal
Known Folder Backup setting. The second user is for the access-denial check.
These two profile conditions must be present in this run; changing `HOME` is not
equivalent. Record VM image, architecture, account type and this preparation.

Prepare two signed MSIX files: the candidate and a strictly newer upgrade with
the same publisher/package identity. Obtain their full source commits, SHA256s,
four-part package versions and build provenance from the release builder. Do not
use the placeholder WinGet manifests. No installer exists in this pack. Missing
signed bytes or provenance are blockers, not permission to use a loose layout,
enable Developer Mode, import a test root or disable security tools. PRs #13,
#21 and #23 are prerequisites to test on the integrated candidate; this pack
does not merge them or presume that their fixes work.

Copy `verify.ps1`, `native-probes.mjs`, this guide and the two artifacts to a
user-writable folder outside the installation and outside OneDrive. Keep evidence
there too. Review downloaded scripts under the normal execution policy. If policy
blocks them, record the block and use an authorized signed copy; the runner does
not change policy. Budget about 60 minutes plus OneDrive setup and VM restarts.
Hypervisor/sbx setup can require additional time and an administrator; it is a
separate check, not a borrower installation prerequisite.

Create `candidate.json` in that folder (replace every placeholder):

```json
{
  "packageName": "Faravan.Faravan",
  "build": {
    "commit": "REPLACE_WITH_40_LOWERCASE_HEX_SOURCE_COMMIT",
    "artifact": "C:\\Qualification\\Faravan-0.1.0-x64.msix",
    "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_SHA256",
    "version": "0.1.0.0"
  },
  "upgrade": {
    "commit": "REPLACE_WITH_40_LOWERCASE_HEX_SOURCE_COMMIT",
    "artifact": "C:\\Qualification\\Faravan-0.1.1-x64.msix",
    "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_SHA256",
    "version": "0.1.1.0"
  }
}
```

Use the actual manifest identity; `Faravan.Faravan` is the current builder's
default. The commit is asserted by the supplied provenance; a file hash alone
does not prove which source produced it (WIN-20). Freeze this JSON throughout
the run. A changed candidate needs a new receipt directory.

Save candidate, fixture and manual JSON as UTF-8. The runner reads and writes
JSON as UTF-8 explicitly and decodes native stdout/stderr as UTF-8, independently
of the Windows system code page. Windows PowerShell 5.1 under a non-UTF-8 locale
still needs native qualification; Linux round-trip tests cannot establish it.

## Run and receipt contract

From the pack folder, use the same command for each phase, changing only `-Phase`:

```powershell
.\verify.ps1 -Phase Baseline -Candidate .\candidate.json -OutputDirectory .\receipt
```

Run phases in order: `Baseline`, `Install`, `Inspect`, `AfterCrash`,
`AfterReboot`, `Upgrade`, `Uninstall`, `SignOff`. The person performs the UI,
kill/reopen and reboot steps between phases. Open a **new terminal** before
`Inspect`; this tests the installed PATH and alias without session repair.
For `Inspect`, also pass `-RetainedFixtures .\retained-fixtures.json` as described
below. Other phases reuse that recorded declaration.
The runner never reboots, elevates, changes protection settings or starts a
provider job. Install/Upgrade use `Add-AppxPackage`; Uninstall invokes the app's
`uninstall --yes --keep-data` before `Remove-AppxPackage` for this user only.
These phases intentionally change this disposable VM.

`receipt/receipt.json` contains schema version, run ID, supplied source commits,
observed MSIX hashes/signers, exact Windows build/boot/user, installed payload
verification, per-check results, timestamps and log paths. Each invocation has
its own directory; prior logs remain. Review observations start as `not yet run`.
The runner snapshots authenticated app readiness, device-key hash and circle-state
hash without logging keys, tokens or response bodies. Keep the directory private:
paths, SIDs and screenshots can still identify the tester.

Exit codes: **0** means all required checks passed and a person signed off;
**1** means a failure; **2** means incomplete or awaiting sign-off. Intermediate
phases normally exit 2. An absent prerequisite, process timeout, unsupported host
or failed native command cannot become a pass. After a failure, retain evidence
and diagnose it separately. Do not silently repair the VM and reuse the receipt
as evidence of a fresh install.
A recorded failure remains failed for that run, including after a diagnostic
retry, receipt reload, later phase or sign-off. A clean qualification requires
a new receipt directory and a restored fresh baseline; retries retain their own
logs but cannot turn the failed qualification green.

Only one invocation may use a receipt directory at a time. Each invocation holds
an exclusive `receipt.lock` handle before loading the receipt until all receipt,
evidence and digest writes finish. A concurrent invocation fails before loading
or changing the receipt; retry after the owner exits. The empty lock file remains
and is reused; it is not evidence of a stuck process. Do not delete it. Windows
releases the handle if the owning process exits or crashes. Keep the receipt on
the VM's local disk, outside OneDrive or other synchronization software. Native
Windows lock behavior remains unverified.

## Retained fixture declaration

Before `Inspect`, list the actual saved files that must survive uninstall in
`retained-fixtures.json`. Use absolute paths inside the actual Faravan data or
coordinator home. The device key, circle state and app settings are included
automatically with SHA256 comparisons; do not repeat them. Declare at least one
additional fixture and include the actual result/history and coordinator files
created for this run. These example paths must be replaced with observed paths:

```json
{
  "files": [
    {"path": "C:\\Users\\Faraván测试\\.faravan\\results\\saved-result.txt", "comparison": "sha256"},
    {"path": "C:\\Users\\Faraván测试\\.faravan\\history-export.json", "comparison": "sha256"},
    {"path": "C:\\Users\\Faraván测试\\.faravan\\coordinator\\v1\\coordinator.sqlite", "comparison": "exists"}
  ]
}
```

Use `sha256` for saved immutable files and `exists` for an active database that
can checkpoint during shutdown. The receipt records each comparison. An existence
check proves the file remains, not that its contents are intact: WIN-12 Review must
also inspect the retained-data evidence. If a fixture class was not created without
a provider call, record that limitation as `not yet run`; do not invent job results.
The declaration is pinned on the first Inspect. Changing it requires a new run.

```powershell
.\verify.ps1 -Phase Inspect -Candidate .\candidate.json -OutputDirectory .\receipt -RetainedFixtures .\retained-fixtures.json
```

## Acceptance steps

1. **[WIN-01] Stock-machine baseline.** Run `Baseline` before installing. Expected:
   Windows build 22000 or later, client OS, non-elevated standard user, Developer
   Mode off, no candidate package or existing Faravan data. Attach VM preparation
   evidence. Requiring admin or Developer Mode for ordinary use is a failure.

2. **[WIN-02] Authentic release bytes (audit B3).** `Baseline` checks both MSIX
   SHA256s and Windows signature validation, recording signer thumbprints. Expected:
   exact candidate matches and valid trusted signatures. A placeholder, missing
   package, hash mismatch or untrusted signer fails before installation.

3. **[WIN-03] Install (audit B3).** Run `Install`. Expected: per-user MSIX installation
   succeeds without elevation, package identity/version match, and installed app
   payload bytes match the signed archive. In Settings > Apps and Start, confirm
   Faravan is listed; capture this with WIN-04. WinGet publication/validation is
   not covered by this MSIX qualification.

4. **[WIN-04; manual] First launch and retained fixture.** Open Faravan from Start
   twice. Expected: one working app/tray, browser opens the local UI, Setup is usable,
   and no missing `node.exe`, dependency, symlink or fsync error appears. Borrower
   setup must work without sbx. Create a local test circle, set a recognizable device
   name and a harmless setting; save screenshots and a small local result/history
   fixture if available without a provider call. Record what exists and what could
   not be exercised. Run `Inspect` only after saving this fixture; its authenticated
   readiness and identity/circle hashes become the recovery baseline, and its
   declared retained-file inventory is saved. Keep settings and circle membership
   unchanged until after `AfterReboot`.

5. **[WIN-05; manual] Tray and deliberate Quit.** Check the taskbar overflow, open
   the app from the tray, inspect the menu, quit normally, then reopen from Start.
   Expected: one tray icon, no console flash, working menu actions, no duplicate
   backend, and deliberate Quit stays quit. Enable notifications using normal
   Windows UI and trigger a local test notification if available; verify click
   routing. Save captures and process counts. An unavailable notification test is
   `not yet run`, not a pass. Finish with the app running before `Inspect`.

6. **[WIN-06] CLI on a fresh PATH (audit B3/#23).** In a new PowerShell terminal run
   `Inspect`. It checks the WindowsApps `faravan.exe` alias, candidate manifest,
   forwarded help output and exit status. Also run `faravan.exe --help` in a fresh
   cmd.exe terminal and attach the output to WIN-04. Expected: both work without
   modifying PATH or invoking `node`, `.cmd` or an installation path by hand.

7. **[WIN-07] Native process locks (audit B1/#13).** `Inspect` runs installed lock
   code with its native platform and filesystem. Expected: regular owner files,
   a live holder blocks another acquisition, killing that child permits recovery,
   release is idempotent, and malformed published records remain blocked/untouched.
   Two instrumented write-boundary crashes leave empty/partial staging files;
   subsequent acquisition must work without manual deletion. The instrumentation
   pauses the real Windows write, without substituting platform or liveness.
   PID-reuse availability and sudden power-loss durability remain separate limits.

8. **[WIN-08] Coordinator ownership (audit B2/#21).** `Inspect` starts an isolated
   real coordinator with a config path containing spaces. Expected: the actual
   PowerShell process-identity query allows stopping its own coordinator and
   refuses both an unrelated live process and a coordinator bound to another
   config, leaving them alive. No injected process listings qualify this check.
   In the UI, stop/restart hosting the test circle and retain roster evidence in
   WIN-09; unknown identity must refuse safely, not kill another application.

9. **[WIN-09; manual] Killed-process recovery.** Record the app PID from
   `receipt/before.json`. In Task Manager > Details, confirm its executable belongs
   to the installed package and end that specific backend process. Reopen from
   Start if the supervisor does not restart it. Repeat with the tray process.
   Expected: reopening works without deleting locks/discovery/state, one app/tray
   remains, and the fixture, device identity and circle roster survive. Record
   whether recovery was automatic or needed reopen; do not claim supervision from
   a successful manual reopen. Run `AfterCrash` to verify authenticated readiness,
   a different process creation time in the same boot, and unchanged identity/state.

10. **[WIN-10; manual] Reboot and setup resume.** With the app running, use Windows
    Restart and sign back into the same account. Record automatic launch behavior;
    reopen from Start if needed. Expected: no duplicates or stuck lock; saved
    fixture/identity/circle/settings survive. Run `AfterReboot`; the observed boot
    timestamp must change and readiness/state checks must pass. Separately interrupt
    Setup at a restart-required step (WIN-19), restart, and confirm it resumes the
    correct unfinished step once, without a false completed safety test. Ordinary
    launch-at-login and one-shot Setup RunOnce are different behaviors; record both.

11. **[WIN-11; manual] Upgrade.** Quit via the tray and run `Upgrade` with the app
    stopped. The runner snapshots saved data without relaunching it. Expected:
    the strictly newer, trusted MSIX of the same identity
    replaces the original; installed bytes match that archive. Reopen from Start;
    inspect the same device, circle, settings, history/result fixture and CLI.
    Capture the new version and preserved data. Stop on an install-in-use refusal
    and record it; do not force-close unrelated processes. `Uninstall` also compares
    the pre/post-upgrade identity/circle hashes before removing anything.

12. **[WIN-12; manual] Keep-data uninstall and leftovers.** After all UI checks, run
    `Uninstall`. Expected: app uninstall succeeds, MSIX registration, alias, startup
    entries/shortcut, protocol handlers, toast identity and installed processes are
    absent; the device key, circle state and settings are retained unchanged.
    Before removal the runner records hashes/existence for those core files and
    the predeclared fixtures. After removal it verifies them using only saved
    absolute paths, without calling the removed runtime. Losing all data except
    the key must fail. Expected leftovers: the actual
    data home (default `~/.faravan`, or the channel-selected home), circle/coordinator
    data, job/history/results, sbx installations/VMs and provider sign-ins, test Git
    repositories, OneDrive fixtures, downloaded MSIXs and this receipt directory.
    Browser sessions/cache and Windows event/protection history can also remain.
    List observed leftovers in the required WIN-12 Review note, confirm each
    declared file remains, and attach post-uninstall directory/Settings/Start
    evidence. Distinguish actual job/history data from synthetic local fixtures;
    unavailable fixture classes stay untested. This pack tests `--keep-data`;
    destructive data purge and third-party tool removal are not qualified.
    Do not delete the evidence.

13. **[WIN-13] Non-ASCII profile.** `Inspect` checks the real `USERPROFILE` contains
    non-ASCII characters; the entire install, native probes, restart, upgrade and
    uninstall run under that profile. Expected: no mojibake, split arguments or
    alternate data home. A synthetic `HOME` override is a failure of this scenario.

14. **[WIN-14; manual] OneDrive Documents.** `Inspect` resolves the Windows Documents
    known folder and checks it is under OneDrive. In that folder create a tiny Git
    fixture with spaces/non-ASCII in its name, mark it Always keep on this device,
    and select it through Faravan's folder picker. Expected: correct repository,
    preserved bytes and an understandable offline/files-on-demand error instead of
    silently sharing the wrong folder. Capture selection and before/after hashes.
    No paid job is required; actual borrowing/apply remains a separate live gate.

15. **[WIN-15; manual] Defender and SmartScreen.** Download the signed candidate
    normally in Edge, preserving Mark of the Web. Record the signer shown, all
    prompts or their absence, Protection History and whether installation/launch
    was blocked. Expected: truthful publisher identity and working normal path,
    with no disabled protection, exclusions or certificate imports. Capture the
    dialog before any permitted approval and record every action. A CI sideload
    cannot establish download reputation or first-person prompt behavior.

16. **[WIN-16; manual] Actual DACL privacy.** `Inspect` records owner/SDDL for the
    actual data home and core private files. Also save `icacls` output for OAuth
    state if created and coordinator/job files.
    Sign into the second standard user and attempt to open those exact paths
    read-only. Expected: access denied; save only success/denial, never private file
    contents. An unexpected successful read fails. Inherited profile DACLs decide
    access; POSIX modes, DPAPI, and the app's `windows_file_permissions` result do
    not prove privacy. Missing OAuth/job fixtures remain explicitly untested.

17. **[WIN-17; manual] Sign-in cancellation and shutdown.** If sbx is available,
    start Docker/provider sign-in and cancel before entering any credentials.
    Record parent/helper PIDs and callback listeners before/after with Task Manager
    and Resource Monitor. Expected: no leftover helper or listening callback port,
    and another sign-in can start. Quit with no work running; no orphan app,
    coordinator or sandbox child may remain. Process-group injection on Linux does
    not qualify this. No login, model call or metered API is authorized by the pack.

18. **[WIN-18; manual] Windows filesystem/runtime edges.** `Inspect` exercises the
    installed atomic writer/device provisioning and Windows `tar.exe` flags in
    isolated scratch. Using the OneDrive fixture, check a CRLF file round trip,
    deep paths near/over 260 characters, file selection under spaces/non-ASCII,
    and `.exe`/`.cmd` prerequisite discovery. Expected: preserved bytes or an honest
    actionable path/prerequisite error; no false healthy status or silent truncation.
    Record the actual Git/tar/sbx versions and the observed sbx socket/pipe transport
    if available. No assumption about NTFS journaling waives a failed durability test.

19. **[WIN-19; manual] Prerequisite restart, sleep and power.** Confirm missing sbx
    blocks lending while borrowing stays usable. If testing lending prerequisites,
    only an administrator enables Hypervisor Platform using the command in
    `packaging/windows/README.md`; restart when Windows asks, then finish Setup.
    Expected: truthful restart/resume, real safety checks, and no lending from a
    missing/failed check. Sleep/wake the VM and record reconnection and stale-job
    handling without executing a provider job. Battery policy requires a device/VM
    exposing a battery; otherwise record `not yet run`. This is not a qualification
    of real sbx isolation, allowance accounting, power-loss recovery or live jobs.

20. **[WIN-20; manual] Source/build binding.** Compare the builder's provenance for
    each MSIX to candidate.json: full source commit, artifact hash, package identity,
    version and architecture. Retain that provenance and its source location as
    evidence. Expected: both exact hashes trace to the reviewed integrated source,
    including the intended Windows fixes. A supplied commit label or matching
    version without provenance is `not yet run`, never a source-binding pass.

21. **[manual] Review and sign off.** Copy one invocation's `manual-template.json`
    to `manual.json`. For every Review entry, set `result` to `pass`, `fail` or
    `not yet run`, add an ISO-8601 observation timestamp, specific notes and absolute
    evidence-file paths. A pass covers the entire numbered scenario; any required
    part not exercised keeps that observation `not yet run`. Use this command:

```powershell
.\verify.ps1 -Phase SignOff -Candidate .\candidate.json -OutputDirectory .\receipt -ManualEvidence .\manual.json -Operator 'Full name or CI approver identity'
```

## Sign-off and limits

Read the final verdict and every failed/unrun check. Sign-off can acknowledge a
failed or incomplete run; it cannot turn either into a pass. This is a named
operator attestation, **not a cryptographic signature or proof of identity**.
The sidecar `receipt.sha256` permits checking receipt bytes when retained separately;
archive the whole evidence directory under the normal review/access controls.
For CI, upload that directory and require a person to supply Review evidence and
approve SignOff. Do not auto-fill UI observations from CI success.

Native Windows checks in this change are **not yet run**. PSScriptAnalyzer and
Node contract tests on Linux check the pack, not the product. A passing receipt
does not qualify WinGet, ARM64, destructive data purge, other OS builds, sudden
power loss, PID-reuse availability, live provider work or the independent-machine
borrow/review/apply journey required by `docs/design/PLATFORM-PLAN.md`.
