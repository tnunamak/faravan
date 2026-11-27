# Local job source file rules

Local project and folder submissions exclude credential-shaped filenames before the source artifact is signed or uploaded. The same policy covers the composer, `run`, `job submit --source`, `jobs.submit` with a local repo, and file uploads. It also checks saved pending source artifacts before a retry uploads them.

Credential rules and source selection have different purposes:

- Credential files are excluded even when committed. Rules cover real `.env` files, private-key filenames and extensions, package-manager login files (including `.yarnrc` and `.yarnrc.yml`), `_netrc`, PuTTY `.ppk` keys, and `.ssh`, `.aws` and `.kube` directories. The reason is **looked like credentials**.
- `.env.example`, `.env.sample` and `.env.template` are retained. The exception does not exempt files inside credential directories.
- Untracked `build`, `dist` and `node_modules` files, and those directories in plain folders or uploads, are excluded as **not source**. Committed files in these directories remain source. Git metadata is always excluded.
- Symlinks, hardlinks, special files and invalid archives refuse the send. Working-tree paths through symlinked parent directories are also refused. Repository reads disable project-defined fsmonitor and clean/smudge/process filters. Bare repositories and metadata-shaped source roots are refused using filesystem names before Git or plain packaging. The shared archive filter also refuses nested metadata and standard Git object files in the bytes selected for sending, including committed and working-tree archives. Uploads always use plain-file packaging after this check.

The composer shows counts and an expandable list for the selected HEAD or working-tree mode. The send checks the actual archive again. CLI text prints the omission counts; JSON results expose `sourceOmissions` with a path and either `credentials` or `not_source` for each omitted file. An existing signed pending artifact is never silently changed and signed as a different job.

These are filename rules, **not a secret content scan**. A template or ordinary source file can contain a secret. This change does not scan prompts, returned results, history, or repository URLs fetched directly by a lender. It does not protect against a process concurrently replacing local files while they are packaged. Git LFS and other smudge filters do not run during packaging, so committed pointer files stay pointers. There is no “safe to send” claim.

## Verification, 2026-10-20

Before implementation, a disposable repository committed a dummy `.env`, an example file and ordinary source. Seven received artifacts contained the dummy credential: composer HEAD and working tree, ops repo, CLI `--source`, CLI `run` HEAD and working tree, and a non-git folder. After the fix, all seven excluded the dummy credential and retained the example. The live check used the real local app, real HTTP coordinator and SQLite artifact storage. It did not run a sandbox or contact a model provider.

Automated coverage is in `source-filter.test.mjs`, `v1-source-disclosure.test.mjs`, `v1-app-upload-safety.test.mjs`, the composer component test and `browser-verify/source-disclosure.spec.mjs`. The tests check received bytes, template/source preservation, distinct noise reasons, PAX paths, executable bits, invalid archives, links, saved retries, and repository-defined commands. Browser checks cover desktop and phone in light and dark mode.
