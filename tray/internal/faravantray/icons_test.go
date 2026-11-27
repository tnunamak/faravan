package faravantray

import (
	"image/color"
	"math"
	"testing"

	"github.com/tnunamak/faravan/tray/internal/brandmark"
)

var allVisualStates = []VisualState{VisualActive, VisualIdle, VisualAttention, VisualPaused, VisualError}

// The tray shows Faravan's mark, the open horizon: each glyph is the state drawn from #mark, at every size.
func TestTrayGlyphsAreTheMarkStates(t *testing.T) {
	mark := brandmark.Default()
	want := map[VisualState]brandmark.State{VisualActive: brandmark.On, VisualIdle: brandmark.Off,
		VisualAttention: brandmark.NeedsYou, VisualPaused: brandmark.Paused, VisualError: brandmark.Error}
	for _, state := range allVisualStates {
		for _, size := range []int{16, 22, 32, 44, 64} {
			cover := mark.TrayMask(want[state], size)
			for y, row := range GlyphMask(state, size) {
				for x, v := range row {
					if v != float64(cover[y*size+x])/255 {
						t.Fatalf("%s %dpx (%d,%d): %v is not the %s glyph of the mark", state, size, x, y, v, want[state])
					}
				}
			}
		}
	}
}

// The mark sits on a 4-unit grid of its 64-unit box, so at 16 and 32 px the horizon's straight run is
// whole pixels: two solid rows at 16 px, four at 32 px, with no blurred edge.
func TestTrayHorizonLandsOnWholePixels(t *testing.T) {
	for _, size := range []int{16, 32} {
		mask := GlyphMask(VisualActive, size)
		unit := float64(size) / 64
		top, bottom := int(44*unit), int(52*unit) // the line at y 48, stroke 8
		for x := int(8 * unit); x < int(56*unit); x++ {
			for y := top - 1; y <= bottom; y++ {
				want := 0.0
				if y >= top && y < bottom {
					want = 1
				}
				if mask[y][x] != want {
					t.Fatalf("%dpx: horizon pixel (%d,%d) is %v, want %v", size, x, y, mask[y][x], want)
				}
			}
		}
	}
}

// The badge reads as its own dot: at every tray size no badge pixel of half coverage or more touches,
// even diagonally, a pixel of the mark of half coverage or more.
func TestTrayBadgeStaysClearOfTheArch(t *testing.T) {
	for _, state := range []VisualState{VisualAttention, VisualError, VisualPaused} {
		base := VisualActive
		if state != VisualAttention {
			base = VisualIdle
		}
		for _, size := range []int{16, 22, 32, 44, 64} {
			with, without := GlyphMask(state, size), GlyphMask(base, size)
			badge := 0
			for y := range with {
				for x := range with[y] {
					if with[y][x] < .5 || without[y][x] > 0 {
						continue
					}
					badge++
					for dy := -1; dy <= 1; dy++ {
						for dx := -1; dx <= 1; dx++ {
							ny, nx := y+dy, x+dx
							if ny >= 0 && ny < size && nx >= 0 && nx < size && without[ny][nx] >= .5 {
								t.Fatalf("%s %dpx: badge pixel (%d,%d) touches the mark at (%d,%d)", state, size, x, y, nx, ny)
							}
						}
					}
				}
			}
			if badge == 0 {
				t.Fatalf("%s %dpx: no badge", state, size)
			}
		}
	}
}

// Brand amber is intentionally the same on both panels. The gray modifiers
// must remain visible against both; report the delivered PNG's core contrast.
func TestBrandTrayContrastOnLightAndDarkPanels(t *testing.T) {
	linear := func(v float64) float64 {
		v /= 255
		if v <= 0.04045 {
			return v / 12.92
		}
		return math.Pow((v+0.055)/1.055, 2.4)
	}
	luminance := func(c color.NRGBA) float64 {
		return .2126*linear(float64(c.R)) + .7152*linear(float64(c.G)) + .0722*linear(float64(c.B))
	}
	ratio := func(a, b color.NRGBA) float64 {
		x, y := luminance(a), luminance(b)
		return (math.Max(x, y) + .05) / (math.Min(x, y) + .05)
	}
	for _, platform := range []string{"linux", "windows"} {
		image := mustDecode(t, IconPNGFor(VisualAttention, platform, 32))
		body := color.NRGBAModel.Convert(image.At(16, 24)).(color.NRGBA)
		badge := color.NRGBAModel.Convert(image.At(27, 5)).(color.NRGBA)
		for _, level := range []uint8{32, 255} {
			panel := color.NRGBA{R: level, G: level, B: level, A: 255}
			bodyContrast, badgeContrast := ratio(body, panel), ratio(badge, panel)
			t.Logf("%s panel=%d amber=%.2f:1 modifier=%.2f:1", platform, level, bodyContrast, badgeContrast)
			minimum := 1.6
			if level == 32 {
				minimum = 8
			}
			if bodyContrast < minimum || badgeContrast < 3 {
				t.Errorf("%s panel=%d: amber %.2f or modifier %.2f lost contrast", platform, level, bodyContrast, badgeContrast)
			}
		}
	}
}
