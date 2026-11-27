# Installed CLI/daemon update evidence

Captured from the installed preview CLI's own sandbox environment on 2026-10-29. No repair, reset, login or daemon-stop command was run. Account paths, account names and emails were redacted before these fixtures were written.

- `doctor.json`: installed preview CLI `doctor --json` (exit 1).
- `version.json`: `sbx version` (exit 0); reports only CLI 0.50.1.
- `diagnose.json`: `sbx diagnose` (exit 0); reports CLI 0.50.1 / daemon 0.50.0 and the real version-match warning.
- `policy-ls.json`: `sbx policy ls` (exit 1); includes the version pair and the exact non-interactive restart warning.

Each JSON file preserves the command's exit code and redacted stdout/stderr. The doctor's outer JSON whitespace is normalized during redaction. Version alone contains no daemon version, so its regression test pairs it with the captured diagnose response. The doctor test uses its captured management diagnostics. A separate test removes the policy version pair to check the policy-listing warning as the third trusted detection source. Guest streams never enter these detection paths.
