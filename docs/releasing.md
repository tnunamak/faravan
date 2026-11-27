# Build a candidate

## Refresh the public source repository

From the source checkout, run `node scripts/publish-public.mjs FULL_TRUNK_SHA /path/to/public-clone` with a full 40-character commit SHA. The public clone must be on `main`, have its own Git history, and contain no local changes or ignored files. Set its Git `user.name` and `user.email` before running the command.

The default dry run creates a local commit in the public clone but does not contact its remote. It installs the source dependencies in a disposable worktree, applies and checks the product rename, then exports only the allowlisted committed files. The worktree is removed on success or failure. The public clone receives one new commit with only its own previous `main` as a parent; an empty clone receives a root commit.

The command prints the export directory, commit SHA, file count and manifest path. The adjacent `manifest.json` records omissions from the renamed source commit and SHA-256 hashes of exported Git blob bytes, including symlink target bytes. Rename and install logs stay beside it. In the export directory, run `npm ci` and `npm --prefix ui ci`, then `npm test` before publishing. Keep the manifest and review the omissions.

Add `--push` only when ready to send that refresh to `origin/main`. The command refuses a remote main that is not an ancestor of the new commit, and Git rejects a concurrent non-fast-forward update. It never forces a push. Rename tooling and its `full-rename.test.mjs` test are deliberately excluded from the public tree.

## Build packages

Run from a Linux x64 checkout with Go, Node, `dpkg-deb`, `unzip`, and GitHub CLI installed. Prime the production npm cache as described in [packaging](../packaging/README.md). The build uses a clean export of the requested commit; uncommitted changes do not enter the packages.

```sh
node scripts/release-candidate.mjs --commit COMMIT_SHA --version 0.2.0-preview.20261126.1 --dry-run --linux-only
```

A dated preview currently needs a separately built Mac ZIP: the workflow accepts only plain release versions and uses the stable install identity. For both platforms, replace `--linux-only` with `--mac-zip /path/to/Faravan.zip`, or omit both options to download a successful `release-macos.yml` run's `unsigned-universal-preview` artifact for that commit. The ZIP must embed the same version, source SHA, channel, and bundle ID as the Linux portable package. Build it on a Mac using [the Mac packaging instructions](../packaging/macos/README.md).

The command verifies the package metadata, signs the manifest with `packaging/sign-update.mjs`, and checks the signature with the app's pinned key. The signed `sourceSha` field records the full 40-character commit. Promotion refuses a candidate without that field and preserves it by copying the signed pair byte for byte. Set `FARAVAN_UPDATE_KEY` to the existing private key's path if it is outside the default release configuration folder. Keep the key in place and private.

A dry run prints the verified manifest and planned publication, then removes its scratch files. Without `--dry-run`, the command creates a prerelease in `tnunamak/faravan-updates`, uploads the packages and signed pair, and commits that exact pair to `candidate/` on the Pages branch. The live feed and Latest release stay unchanged. The target feed must have a lower version and no later release date. The uploaded release must contain every signed asset at its signed size, with a matching digest when GitHub supplies one. A duplicate release tag refuses instead of replacing its files. If the Pages commit fails after upload, the command prints the exact release deletion command before you retry.

After candidate acceptance, the release owner can run `node scripts/release-candidate.mjs --promote VERSION`. Add `--dry-run` to check promotion without publishing. Promotion verifies the candidate pair, checks the target version and confirms the published assets before copying its exact bytes to `preview/` and marking that version Latest. Feed publication and the Latest change are separate GitHub operations; if the latter fails, use the printed `gh release edit` recovery command before announcing the release. Repeating promotion refuses an equal version.

## Legacy bootstrap

The older offline staging tool, `packaging/release-feed.mjs`, reads these URLs. Its staged metadata is separate from the signed app update manifest. The Linux bootstrap uses the [public signed release list](https://tnunamak.github.io/faravan-updates/preview/update.json):

```sh
curl -fsSL https://tnunamak.github.io/faravan-updates/install.sh | sh
```

For a teammate's desktop installation, use [Install Faravan](install.md).
