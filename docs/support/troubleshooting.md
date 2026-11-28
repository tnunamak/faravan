# Save a support export

In **You → Your data → Get help**, choose **Preview support export**. Read the
shown `support.json`, then choose **Save support archive**. Your browser downloads
`faravan-support.tar.gz`. This archive is never uploaded. Usage telemetry follows
your telemetry setting, including preview usage and failures. Send the archive
yourself to someone you trust.

The command line works even when Faravan cannot start or a circle is offline:

```sh
faravan diagnostics export --output ./faravan-support.tar.gz
```

It shows the exact contents and asks before saving. To inspect without saving, use
`faravan diagnostics export --preview`. Scripts can use `--output <path> --yes`;
the contents are still printed before the write. An existing output file is never
overwritten. The CLI creates the archive with owner-only permissions on Unix.
Browser downloads use the browser's destination and file permissions.

The archive has one file, `support.json`. Its allowlist includes:

- Faravan and Node versions, OS, architecture, numeric OS release, install kind and
  release channel. An unavailable version, including the tray version, is `null`.
- Saved lending choices, selected agents, numeric limits, provider plan categories
  and consent booleans. Unknown fields and invalid values are excluded or `null`.
- The last cached backend checks and sandbox test results, with their observation
  dates. These are past observations; the export runs no checks or agent jobs.
- Up to 50 recent structured events, 50 error codes and 30 recent job aliases and
  states from local event history. No coordinator request is made.

Raw job IDs are excluded. A fresh random alias connects the same job's events,
errors and state within this archive. Aliases change with every export and cannot
be used to look up coordinator records. Support can follow a job's local sequence
without its stable ID.

Ordinary readiness checks keep sanitized observations in memory. The app writes
them to its diagnostic cache only when you preview an export or close the app,
after lending has drained. This keeps diagnostic disk work out of lending.

Prompts, titles, code, transcripts, results, job filenames, credentials, cookies,
emails, hostnames, circle and member identities, invitation links, environment
variables and raw errors are excluded. The collector never walks your profile,
reads job metadata, opens account stores or dumps a database. There is no option
to include raw logs.

The collector reads only these fixed paths: `v1/app-settings.json`,
`v1/history/events.jsonl`, `v1/lending-errors.jsonl`, and
the installation's `VERSION` and `.installed-via` files. It rejects symlinked
inputs and non-regular files. Each profile read is at most 256 KiB; log reads
use a bounded tail. Metadata reads are at most 256 bytes. Missing, oversized,
unsafe or unreadable inputs have fixed status codes under `sources`; a damaged
log line is skipped. The JSON is at most 120 KiB and the archive at most 128 KiB.

The [JSON schema](diagnostics.schema.json) is generated from
`lib/v1/diagnostics-schema.mjs`, which also controls the serializer. Adding a
settings field does not add it to the export. Any allowlist change needs a privacy
review and planted-content tests. Regenerate the schema with
`node scripts/gen-support-schema.mjs` and check it with the same command plus
`--check`.

If the UI cannot prepare the preview, use the command line. If a save fails, choose
a new filename in a writable folder. A `null` readiness result means no usable
cached observation was found; use Setup or `faravan doctor` to run fresh checks.
