package brandmark

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The red test for one Faravan mark: every committed icon, favicon, tray symbol and the tray's copy of
// the mark is exactly what the generator draws from #mark. PNGs are compared as decoded pixels, so a
// different PNG encoder version cannot fail it; the pixels themselves come from integer compositing.
func TestGeneratedFilesMatchTheMark(t *testing.T) {
	root := filepath.Join("..", "..", "..")
	files, err := Generate(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		committed, err := os.ReadFile(filepath.Join(root, f.Path))
		if err != nil {
			t.Errorf("%s: %v (run: cd tray && go run ./cmd/brandgen)", f.Path, err)
			continue
		}
		if strings.HasSuffix(f.Path, ".png") {
			want, err1 := decodeNRGBA(f.Data)
			got, err2 := decodeNRGBA(committed)
			if err1 != nil || err2 != nil {
				t.Errorf("%s: %v %v", f.Path, err1, err2)
				continue
			}
			if got.Bounds() != want.Bounds() || !bytes.Equal(got.Pix, want.Pix) {
				t.Errorf("%s differs from the mark (run: cd tray && go run ./cmd/brandgen)", f.Path)
			}
			continue
		}
		if !bytes.Equal(committed, f.Data) {
			t.Errorf("%s differs from the mark (run: cd tray && go run ./cmd/brandgen)", f.Path)
		}
	}
}

// No hand-drawn copy of the old "give and receive" mark survives in shipped sources.
func TestNoOldMarkRemains(t *testing.T) {
	root := filepath.Join("..", "..", "..")
	for _, path := range []string{Sprite, "ui/v1/src/bootstrap.mjs", "public/v1/index.html", "public/v1/app.mjs",
		"packaging/macos/icon/Faravan.svg", "docs/design/experience/mockups/src/icons.svg", "tray/internal/faravantray/icons.go"} {
		data, err := os.ReadFile(filepath.Join(root, path))
		if err != nil {
			t.Fatal(err)
		}
		for _, old := range []string{"9.75 3A7.5", "14.25 7.5A6", "8.65 4.1", "mark-mono"} {
			if strings.Contains(string(data), old) {
				t.Errorf("%s still draws the old mark (%s)", path, old)
			}
		}
	}
}

func TestParseMarkReadsTheOpenHorizon(t *testing.T) {
	m, err := ParseMark(`<svg><symbol id="mark" viewBox="0 0 64 64"><g fill="none" stroke="#ffb800" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 32a16 16 0 0 1 32 0"/><path d="M8 48h48"/></g></symbol></svg>`)
	if err != nil {
		t.Fatal(err)
	}
	want := []Seg{{X0: 16, Y0: 32, X1: 48, Y1: 32, Width: 8, Arc: true, Sweep: true}, {X0: 8, Y0: 48, X1: 56, Y1: 48, Width: 8}}
	if m.Side != 64 || m.Width != 8 || m.Color != "#ffb800" || len(m.Glyph.Segs) != 2 || m.Glyph.Segs[0] != want[0] || m.Glyph.Segs[1] != want[1] {
		t.Fatalf("%+v", m)
	}
	// The arch rises above its chord: its top is ink, the centre below the chord is not.
	if !m.Glyph.Inside(32, 16) || m.Glyph.Inside(32, 40) || m.Glyph.Inside(32, 32) {
		t.Fatal("the arch is not the upper half circle")
	}
	for _, bad := range []string{`<symbol id="mark" viewBox="0 0 64 64"><g fill="none" stroke="#ffb800" stroke-width="8" stroke-linecap="round"><path d="M16 32a10 10 0 0 1 32 0"/></g></symbol>`,
		`<symbol id="mark" viewBox="0 0 64 64"><g fill="none" stroke="#ffb800" stroke-width="8" stroke-linecap="butt"><path d="M8 48h48"/></g></symbol>`,
		`<symbol id="mark" viewBox="0 0 64 64"><g fill="none" stroke="#ffb800" stroke-width="8" stroke-linecap="round"><path d="M8 48c1 1 2 2 3 3"/></g></symbol>`} {
		if _, err := ParseMark(bad); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}
