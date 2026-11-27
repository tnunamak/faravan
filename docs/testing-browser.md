# Browser verification lane (V1)

`npm run test:browser` runs headless Chromium against the real app and checks every merged U slice for the things a
render-to-string test cannot see: keyboard use, focus, history, reflow, text size, motion, offline and a phone keyboard.
It is separate from `npm test` and `npm run test:e2e`. It opens no window and uses no display (`DISPLAY` and
`WAYLAND_DISPLAY` are cleared; Playwright's headless shell has no GUI), and it never uses `playwright-me`.

## What runs

`tests/e2e-browser/v1-harness.mjs` starts the real app three times (owner, lender, guest) on temporary homes with a fake
sandbox and an in-process queue. A screen that needs a particular state (lending on, a request waiting, a failing readiness check, a jobs list,
`update.ready`) gets it from `page.route` fixtures that patch the real API answer, never from a mocked app.

| File | Role |
|---|---|
| `playwright.verify.config.mjs` | Config: one worker, headless, JSON results in `test-artifacts/browser-verify/results.json` |
| `tests/browser-verify/slices.mjs` | The slices: route, fixtures, the main task done with the keyboard, the dialog, known failures |
| `tests/browser-verify/lib.mjs` | The harness helper and one function per check |
| `tests/browser-verify/verify.spec.mjs` | One test per slice and check |
| `scripts/browser-verify.mjs`, `scripts/browser-verify-report.mjs` | Build the UI, run, print the table |

Needs `npx playwright install chromium` once. It takes about 2 minutes (slices U2b, U3, U3b, U4, U9, U14, U16, U20, U21).

## The checks

| Check | Passes when |
|---|---|
| keyboard | The slice's main task completes with the keyboard only (no pointer event), and every control has a name, with one `h1` and one `main` |
| dialog | Focus moves into the dialog, 14 Tab and 14 Shift+Tab never leave it (a native modal `<dialog>` may pass focus to the browser's own bar and back), Escape closes it and focus returns to the opener. `n/a` when the screen has no dialog |
| history | Back returns to the same screen, Forward to the next, and a dialog does not outlive navigation |
| narrow320 | At 320 px nothing scrolls sideways and no control is cut off (rows that scroll on purpose are fine) |
| zoom200 | The same at 640 px with text clipping checked. Headless Chromium has no zoom control, so 200% of a 1280 px window is a 640 px viewport |
| text130 | With the root font at 130%, at 1280 and 390 px: no sideways scroll, no clipped or spilling text |
| motion | With `prefers-reduced-motion: reduce`, no animation, transition or smooth scroll remains |
| offline | Offline the page says so and network actions are held; after a reload while offline the screen still opens and a draft is kept |
| phone | With a 336 px virtual keyboard (a shorter viewport), the focused field is not covered and fully visible, and a fixed bar does not eat the rest. `n/a` without a text field |

## Reading the table

`pass`, `FAIL`, `exp:U2c` or `exp:DEFECT-n`, and `n/a` (the screen has no such thing).

A known failure is named in `expect` in `slices.mjs` as `{id, match, why}`: `match` picks one problem out of the check's
list. A cell is `exp:` only while **every** listed problem is still there and **no other** problem appears. A new problem
next to a known one is `FAIL` (`NEW: ...`), so a known failure cannot hide a new one. When a known problem is fixed the
cell is `FIXED?` (a failing test) until its entry is deleted. A known failure is never a skip.
Screenshots of failing cells are in `test-artifacts/browser-verify/` (git-ignored).

## Known failures today

| ID | What | Where |
|---|---|---|
| DEFECT-1 | Nothing caches the app: a reload while offline shows the browser's error page, so a draft is lost | no service worker (`public/v1`) |

## Not covered here

Passkeys, Home Screen install, push and Face ID need a real device: the lead's iPhone (iOS 26) and Pixel checklist before a
release. WebKit and Firefox are not run; the lane uses Chromium only.

## Two fresh installations (CYCLE2 rollout gate)

Run `node scripts/test-two-computer.mjs --repeat-each=3` on Linux. The runner builds
once, then runs each journey three consecutive times in headless Chromium. Each
app is a separate process with separate synthetic `FARAVAN_HOME`, `HOME`,
`CODEX_HOME` and `CLAUDE_CONFIG_DIR`; the hosted coordinator is another process.
The tests compare the child-reported paths and start with no circle.

The five specs cover invitation through branch creation (J1/A), actual daily-minute
admission and UTC/Chicago deadlines (B), finished-summary failure and Retry (C),
pause versus confirmed stop (J3), and host outage/return (J4). The fake executor
supplies deterministic records and one file change through the normal transcript,
relay and artifact paths. The J1 hold lasts at least 60 seconds; its assertions
measure each marker's delivery to both pages within five seconds. A separate
preparation barrier checks that the borrower sees approval before execution starts.

All person actions use the UI. IPC controls execution, synthetic availability,
usage setup, signed deadline inputs and server read faults. Successful asserted
responses come from the real app and coordinator. J1 adds transport latency with
`route.continue`; no scenario fulfils successful browser data from a route fixture.
Separate JSON reports are written under `test-artifacts/browser-verify/rollout/`.

J4 proves an already-open reviewed result survives the outage and reloads after
return. It does not prove cold result navigation while the host is offline.
Invitation expiry has no controllable installed-host clock seam. These tests use
no external providers and do not certify a real sandbox or sign-in.
