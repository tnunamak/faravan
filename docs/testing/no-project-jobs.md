# Jobs that start without a project

Choose **No project** in the composer. Use it for
writing, analysis, questions, images, data, or new work. The agent starts with
only the prompt. It returns its final message and any output files automatically.

The job page renders the agent's final message as Markdown, with its returned
files below it. Copy the message, download Markdown, preview files, or download
one file or all files. The agent must save attachments under `faravan-output/`.
No particular report file is required.

For scripts, send `noSource:true,result:{kind:"message"}` to `jobs.submit`.
The CLI equivalent is:

```sh
faravan job submit --no-source --result message --prompt 'Explain this idea and make a checklist.' --yes
```

Exactly one source is required. The signed empty-folder source is
`{kind:"none"}`. Code-change jobs retain the legacy encoding; an absent signed
`result` means `branch`. New message/files jobs require `results_v1`. An older
host refuses them with `host_too_old`; an older lender does not claim them.
An older client can still submit legacy code-change jobs. If its circle also
contains newer message/files jobs, the coordinator leaves those jobs out of the
list it returns to that client (see "Job list negotiation" in
`docs/protocol/v1.md`), so every legacy job stays visible and paging works. It
cannot see the newer jobs until it is updated.

## Live check on 2026-10-20

A disposable local app and loopback coordinator ran Claude Code through the
real Docker Sandboxes backend. The job requested a short rain-garden research
answer and a checklist CSV, with no project supplied.

- Signed source: `{kind:"none"}`; requested result: `{kind:"message"}`.
- Job digest: `sha256:26b189d042d932f764c58e9713ca3edc5a5a204f66879e269e6ea00dd8099ad2`.
- The accepted result contained a 2,874-character Markdown final message and
  `faravan-output/checklist.csv` (1,667 bytes). The receipt recorded
  `claude-code-subscription`, a tree candidate, and 107,761 ms of execution.
- The real job page rendered the answer. A headless browser copied the same
  Markdown and downloaded it as `message.md`.
- `faravan doctor --json` reported `test_workspace.ok:true`. The disposable
  app's sandbox safety test also passed before the job ran.

The transcript records web search and fetch calls. The answer distinguishes a
university page it read from EPA material obtained through search excerpts
after direct fetch errors. This check proves delivery and review of one real
job; it does not establish factual accuracy, cross-device behavior, or support
on other operating systems. The app, coordinator and sandboxes used for the
check were closed without changing the friend's running services.

Automated coverage is in `tests/protocol-results.test.mjs`,
`tests/v1-cli-results.test.mjs`, `tests/v1-lender-results.test.mjs`,
`tests/v1-app-reports.test.mjs`, `tests/result-output.test.mjs`,
`ui/v1/src/empty-project-compose.test.mjs`, `ui/v1/src/result-reader.test.mjs`,
and `tests/browser-verify/reports.spec.mjs`.

## Result review limits

Typed result archives must contain only `faravan-output/` entries. Extraction
and whole-result downloads validate every entry before writing any file. The
CLI saves the final message as `message.md` only after that validation passes.

An attachment above the preview size limit does not hide the final answer.
The reader keeps the verified Markdown and offers files for download. If ZIP
conversion exceeds its limits, a validated original `.tar.gz` is returned.

Image previews load when requested and retain at most two images. Raster
headers must fit both the 4,096-pixel edge limit and the 4,000,000-pixel budget.
GIF frames share that budget; APNG and animated WebP remain download-only.
Closing a preview or leaving the page releases its object URL.

Regression checks cover hidden root files, a compressible 20 MiB CSV, more than
2,000 archive entries, a 12000×12000 PNG, and image eviction and URL release.
The old-client fixture at `tests/fixtures/pre-results-client.json.gz` freezes
the client and schemas from before typed results. Its mixed-list checks prove
that all legacy signed jobs remain intact across pagination while modern
clients can still read every job.

Follow-up integration uses the verified parent source kind. A no-project
follow-up starts in an empty folder, carries the scanned summary as untrusted
context, and requests the final message plus returned files. It does not turn
the parent's attachments into source code. Code follow-ups retain the saved
result snapshot and source-file filtering; they do not require the original
local folder to remain present. Tests in `v1-followup.test.mjs`,
`v1-app-reports.test.mjs`, the UI job-thread tests, and
`browser-verify/reports.spec.mjs` cover both paths.
