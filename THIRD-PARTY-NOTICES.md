# Third-party notices

Faravan source is licensed under LICENSE.md. Third-party components retain their own licenses.

## Vendored Gozar SDK

`vendor/tnunamak-gozar-0.5.1.tgz` redistributes `@tnunamak/gozar` 0.5.1 under Apache-2.0.
The archive contains `package/LICENSE`, `package/THIRD-PARTY-NOTICES.md`, and the individual
Rust dependency licenses under `package/third-party/rust/`. Keep those files with any redistribution.
Extract the archive to read the complete notices; this document does not replace them.

## Dependencies and packaged runtimes

The root, UI and pi-payload package manifests and lockfiles identify npm dependencies.
The tray's `go.mod` and `go.sum` identify Go dependencies: fyne.io/systray,
github.com/MatthiasKunnen/go-wayland/wayland, github.com/godbus/dbus/v5,
github.com/pkg/browser, and golang.org/x/sys. Their license files must remain
with redistributed dependency trees. Linux and macOS packages also bundle Node.js and
its LICENSE through `packaging/bundle-node.sh`; guest runtime inputs are pinned in
`packaging/node-runtime.env`. Consult each upstream distribution's licenses before redistribution.

## Browser dependencies bundled in `public/v1/app.mjs`

The web app is built from `ui/` with Vite. The bundle contains these production dependencies.
Their license texts are in [`licenses/`](licenses/), copied from the published packages.

| Package | Version | License | Text |
|---|---|---|---|
| preact | 10.29.7 | MIT | [`licenses/preact-LICENSE.txt`](licenses/preact-LICENSE.txt) |
| marked | 18.1.1 | MIT | [`licenses/marked-LICENSE.txt`](licenses/marked-LICENSE.txt) |
| posthog-js, with `@posthog/core`, `@posthog/types` and `@posthog/browser-common` | 1.447.3 | MIT and Apache-2.0 (includes Mixpanel code) | [`licenses/posthog-js-LICENSE.txt`](licenses/posthog-js-LICENSE.txt) |
| dompurify (bundled by posthog-js) | 3.4.17 | Apache-2.0 or MPL-2.0 | [`licenses/dompurify-LICENSE.txt`](licenses/dompurify-LICENSE.txt), [`licenses/dompurify-LICENSE-MPL.txt`](licenses/dompurify-LICENSE-MPL.txt) |

## Visual assets

- **Fonts.** Instrument Sans, JetBrains Mono, Source Sans 3 and Young Serif are SIL Open Font
  License 1.1 fonts. The woff2 files in `ui/v1/src/fonts/` and `public/phone/fonts/` are
  byte-identical to the files in the npm packages `@fontsource-variable/instrument-sans` 5.3.0,
  `@fontsource-variable/jetbrains-mono` 5.3.0, `@fontsource-variable/source-sans-3` 5.3.1 and
  `@fontsource/young-serif` 5.3.0 (SHA-256 compared). Each font's license text sits next to it as
  `*-OFL.txt`.
- **Product icons.** The mark, wordmark, tray glyphs, favicon, web app icons and macOS iconset
  were drawn for Faravan and are covered by `LICENSE.md`. `#mark` in `ui/v1/src/icons.svg` is the
  one source. `tray/cmd/brandgen` writes every derived file from it, and `TestGeneratedFilesMatchTheMark`
  in `tray/internal/brandmark` fails when a committed file differs from what the generator makes.
  The wordmark outlines are set in Instrument Sans (see Fonts).
- **Interface icons.** The remaining symbols in `ui/v1/src/icons.svg` were drawn for Faravan on a
  24-unit grid and are covered by `LICENSE.md`.
- **Test image.** `ui/v1/src/fixtures/mandelbrot.png` is drawn by `scripts/gen-mandelbrot-fixture.mjs`
  from the Mandelbrot formula. `tests/mandelbrot-fixture.test.mjs` fails when the file differs from
  the generator's output.
