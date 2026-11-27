# Local source lending check

Run from any directory. Pass the source checkout explicitly:

```sh
bash /path/to/source/packaging/journey/local-lend.sh /path/to/source --synthetic
SMOKE_OWNER_SBX_HOME=/home/example/.fsbx/29a653 bash /path/to/source/packaging/journey/local-lend.sh /path/to/source --preflight
SMOKE_OWNER_SBX_HOME=/home/example/.fsbx/29a653 LOCAL_LEND_CONFIRM=1 bash /path/to/source/packaging/journey/local-lend.sh /path/to/source --live
```

The live command submits exactly one job per kit and one Git-source job, once,
with no retries. Use the final merged checkout for the live command. Node 22.13 or later,
repository dependencies and the source checkout's coordinator are required.
The source tree must contain the `autoRepair` and `scratchJournal` backend
options added here: use the merged ship tip after PR #290 lands, not an older
source tree. These options disable recovery and isolate scratch records.
This runs the local JavaScript source through the journey's app child, not an
installed Faravan app. It checks the loaded module path. There is no package
installation or update. The existing public UI assets are not rebuilt because
this check drives the product operations API.

The three jobs run in order: a Claude Haiku message, a Codex message using the
cheapest model in the app's allowed models with known Codex credit prices, and
a Claude message from the pinned public octocat/Hello-World Git repository.
The Git result must contain the README's first line. The Git receipt must name
the requested commit and the backend's verified commit.

Every result requires one completed execution on the owner, a result accepted
by the friend, a nonempty final message and transcript, durable guard model
and spend evidence, and proven sandbox cessation and cleanup. Isolation must
pass in the lender before it records execution start. Synthetic mode replaces
the sandbox and isolation check with fixtures; its passes test the check's
plumbing, not the guest runtime. The live run is still required to prove the
sbx 0.51 guest node paths.

Expect 3–8 minutes for live execution, with a five-minute timeout per job plus
startup and cleanup. The owner guard limit is $1.50 per job. The check monitors
provider counters and app spend against $1.50 per job and $4 in total, stopping
the active job on a breach or missing evidence. These are list-price estimates,
not a receipt of a cash charge; polling can detect a breach after it occurs.
The prompts request only one line. Synthetic runs usually take 20–40 seconds.

Preflight starts both fresh app homes and checks both agent kits with
`agents.check`, which may create temporary probe sandboxes but never signs in
or submits a job. It then forms a local circle and turns automatic lending on
only in the disposable owner home. A missing or unknown existing proxy sign-in
blocks the check. It never runs a sign-in operation. The owner sandbox home is
`/home/example/.fsbx/29a653`, shared with the signed-in Linux app. Set
`SMOKE_OWNER_SBX_HOME` explicitly as shown above (`LOCAL_LEND_SBX_HOME` remains
a compatibility alias). It does not copy provider credentials.
`agents.check` can return while a lending identity sandbox is still booting:
its three-second display wait does not end the background probe. The runner
polls the agents view until both kits leave `Checking`, with a ten-minute cap,
before deciding whether their installed and signed-in evidence passed.

Before either live-mode invocation starts an app, the runner verifies daemon
3230418 is running for that home. It reads HOME, XDG variables and
DBUS_SESSION_BUS_ADDRESS from `/proc/3230418/environ` and uses those values for
every sandbox command. It prints variable names only. A missing daemon blocks
the run; the runner starts nothing. Live app backends have automatic daemon
and policy recovery disabled.

The filesystem holding the owner sbx home must have at least 16 GiB available.
The runner waits for all sandboxes in that home to stop, with a 30-minute cap,
and checks disk space again before starting the apps. It repeats these guards
before each live job. An unreadable listing fails the check. This avoids sharing
the daemon with an installed-app job and leaves headroom above the backend's
2 GiB low-disk floor. If a low-disk stop times out, the backend can kill all
sandboxes in the shared identity. These startup checks cannot reserve disk space
or prevent another app from starting a job later.

A run-owned command wrapper rejects all daemon commands, login with arguments, logout, policy
reset/init, and secret mutations (including `secret` and `secrets` aliases).
Only secret listing is allowed. Generic `sbx policy rm` is blocked. A removal
requires an exact network rule ID present in the current snapshot and absent
from the baseline, scoped to the named sandbox. Before and after snapshots use
`sbx ls --json` and `sbx policy ls --json --include-inactive`. After closing both
apps, cleanup removes only new sandbox-scoped rules proven by that diff, then
verifies every older rule is identical and the sandbox name set is unchanged.
Policy output contains rule IDs only; old leaked rules stay as evidence.
Policy allow/deny commands require an exact sandbox name registered in this
run's private cleanup journal and absent from the baseline sandbox set. Global
policy changes are blocked. Run-owned name markers also constrain final cleanup.

The only login exception is exactly bare `sbx login` as a status read, after
`sbx diagnose` reports authenticated in the same environment. Standard input
is closed, DISPLAY and WAYLAND_DISPLAY are empty, and BROWSER points to a
no-op that records calls and exits 1. The wrapper captures both output streams
and kills that child on a code/URL prompt, a browser call, or a 30-second
timeout. It never relays interactive output. A durable safety-stop marker makes
the runner stop even if the app catches the command failure. Refusal logs
contain verb names only. No interactive sign-in is permitted.

The runner prints each disposable app data directory. Both apps get fresh state
homes and device identities under the run root, outside the installed app's
data directories. Their cleanup journals and lock directories belong to those
fresh homes; no installed-app state or cleanup records are used.

Each invocation creates `~/.tmp/local-lend-<random>/`. Its contents are:

- `bin/`, containing the live-only sandbox command wrapper;

- `owner/` and `friend/`, each with `home/`, `tmp/`, `run/`, `claude/`, `codex/`,
  `coordinator/` and `app.log`;
- app state, circle keys, result cache and coordinator data under those homes;
- synthetic fixture roots and backend scratch directories under each child's
  `tmp/`, removed by the fixture cleanup;
- live backend scratch under each child's `tmp/`; sandbox images, probe workspaces
  and service logs use the existing sandbox identity's normal storage.

Cleanup turns lending off, stops the run-owned circle coordinator, closes both
apps and waits for their exit. An unresponsive app receives TERM and then KILL
only through the child-process handle created by this runner; forced termination
fails the check and preserves its root for diagnosis. The backend removes job and probe sandboxes.
A passing run deletes its entire disposable root and prints only a nonsecret
JSON summary. A failed run retains its root for diagnosis and reports the path;
remove it after verifying no process or sandbox still uses it. Existing sandbox
identity data and daemon processes are preserved. Only the policy removals
proved by the snapshot diff are permitted; daemon restart is never permitted.

Spend-monitor regression checks cover missing or corrupt active ledgers,
resource replacement, conversion changes, counter regression, and terminal
charges that remain in the run total after sixty seconds. An unresponsive
app cleanup test verifies termination and reaping of only the process started
by the test. The live runner's command fence never signals a sandbox daemon.

```sh
node --test tests/local-lend-spend.test.mjs tests/local-lend-process.test.mjs tests/local-lend-safety.test.mjs
```
