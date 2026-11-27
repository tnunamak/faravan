# Unpublished Faravan tap preparation

Do not publish this directory to a public tap before the release owner approves.
There is no anonymous release URL or universal zip yet, so no installable
cask with invented release bytes is checked in.

The inspected `tnunamak/homebrew-clawmeter` convention is a version/hash-pinned
formula with an LSUIElement app and `keep_alive false` service. This preparation
uses the same fixed-release and quit lifecycle, with a prebuilt cask instead of
requiring Go on the user's computer. Its minimum macOS is Sonoma (14).

Once a public universal zip exists:

```sh
node packaging/homebrew-tap/render.mjs 0.1.0 \
  path/to/Faravan-0.1.0-universal-unsigned.zip \
  https://PUBLIC-DOWNLOAD-ORIGIN/Faravan-0.1.0-universal-unsigned.zip \
  https://PUBLIC-HELP-ORIGIN/faravan ~/.tmp/homebrew-faravan-prepared
```

Use actual approved HTTPS addresses, not those illustrative origins. The renderer
writes `Casks/faravan.rb` with a fixed version and the archive's SHA-256, plus the
tap's Mac workflow. It rejects private faravan GitHub downloads, credentials,
query strings and Ruby interpolation. It does not upload, create a repository or
publish a tap. Check anonymous download and hash equality before the lead approves
publication to `tnunamak/homebrew-faravan`.

In that prepared tap on a Mac, run `brew style Casks/faravan.rb`,
`brew tap --custom-remote tnunamak/faravan "$PWD"`,
`brew trust --tap tnunamak/faravan`, then
`brew audit --cask --online tnunamak/faravan/faravan`, then local cask install, CLI
`--help`, explicit app launch and uninstall. Record Gatekeeper behavior with the
normal quarantine attribute intact. The eventual public command is
`brew install --cask tnunamak/faravan/faravan`; it is not available yet.

The cask exposes the CLI and installs `Faravan.app`. Before ordinary removal,
run `faravan uninstall --keep-data` to leave circles and remove its LaunchAgent,
then `brew uninstall --cask faravan`. Homebrew runs uninstall directives during
upgrades too, so launchctl/delete cleanup belongs to explicit zap rather than
an uninstall stanza. This preserves the login choice through upgrades. Zap also
deletes the default data directory; do not use it to keep data. No automatic
startup, quarantine removal, build dependencies or `auto_updates` declaration.
App-owned replacement is not enabled for cask installs; use
`brew upgrade --cask faravan`.
