# Faravan status icon

The native helper polls the v1 local app every two seconds. It discovers
`<home>/v1/app.json`, honoring `FARAVAN_HOME` and the same default/legacy
home selection as the app. The private record contains port, token, PID and
start time. The helper reads no other discovery file; the retired v0
`daemon.json` is ignored.

## Run from source (macOS and Linux)

Start `faravan app`, then build/run the helper from `tray` with
`go build ./...` and `go run ./cmd/faravan-tray`. The menu can also start the
installed CLI: `faravan` starts or reuses the resident with `FARAVAN_NO_BROWSER=1`,
and the helper waits up to ten seconds for app discovery. It resolves the CLI
through PATH, then `~/.local/bin/faravan`.

## Behavior

Three silhouettes distinguish lending on, off or paused, and needs you. They are
Faravan's mark, drawn at any size from `#mark` in `ui/v1/src/icons.svg`
(`internal/brandmark`); after an edit to `#mark`, run `go run ./cmd/brandgen`,
which also redraws the favicons, web app icons and the macOS app icon. The tooltip
uses the menu's actual headline, including any running or finishing job. The
menu shows the app's ordered blockers, its first fix and waiting rows.

Pause new jobs leaves the current job and app running. Quit asks before
stopping a job and uses the app's graceful shutdown endpoint; it never kills
the process. Stop acts only on the job named in its confirmation.

Malformed discovery or an unreachable live app never authorizes a duplicate
start. A missing or stale record offers Start Faravan; a malformed or
unreachable-but-live one offers only Open Faravan.
Status polling never opens a browser. Open Faravan is an explicit click
that opens the app through a one-time browser handoff; keep that session secret private.
API calls use a header token and reject redirects.

When the app does not answer and a valid saved startup failure is present,
the status line says "Faravan could not start." A live status takes precedence.
No raw saved error text is shown. During managed startup backoff, Quit closes
the icon and the launcher stops retrying. An unreachable live app still uses
the existing guarded shutdown flow.

Job, lending and account actions open the corresponding app pages.
Native GUI, real process startup and browser integration require separate
manual validation. Unit tests inject HTTP, process-liveness, launch and browser
boundaries and use temporary discovery files. They never launch a real app.

## Linux caveat

On GNOME 45/46, a StatusNotifierItem icon requires an AppIndicator or Tray Icons
Reloaded extension. Modern KDE supports it out of the box.
