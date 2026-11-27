package faravantray

import (
	"image/color"

	"github.com/tnunamak/faravan/tray/internal/brandmark"
)

// The tray glyphs are Faravan's mark, the open horizon. They are drawn at any size from the
// #mark symbol (brandmark), never by hand, and differ in silhouette so they read without colour:
//
//	active     on: the mark
//	idle       off: the arch as an outline over a broken horizon
//	attention  needs you: the mark and a badge dot in the top-right corner
//	paused     off, with pause bars where the badge goes
//	error      off, with the badge dot
func markState(state VisualState) brandmark.State {
	switch state {
	case VisualIdle:
		return brandmark.Off
	case VisualAttention:
		return brandmark.NeedsYou
	case VisualPaused:
		return brandmark.Paused
	case VisualError:
		return brandmark.Error
	}
	return brandmark.On
}

// GlyphMask is the glyph's coverage on a size x size grid, 0 to 1: the silhouette without colour.
func GlyphMask(state VisualState, size int) [][]float64 {
	if size <= 0 {
		return nil
	}
	cover := brandmark.Default().TrayMask(markState(state), size)
	mask := make([][]float64, size)
	for y := range mask {
		mask[y] = make([]float64, size)
		for x := range mask[y] {
			mask[y][x] = float64(cover[y*size+x]) / 255
		}
	}
	return mask
}

// IconPNG is the brand-coloured Linux panel glyph, 32 px.
func IconPNG(state VisualState) []byte { return IconPNGFor(state, "linux", 32) }

// IconPNGFor keeps macOS's black template. Linux and Windows use the parsed
// brand amber, with neutral #757575 badge dots and pause bars: distinct from
// amber, with contrast on both light and dark panels. Theme never changes shape.
func IconPNGFor(state VisualState, goos string, size int, lightTaskbar ...bool) []byte {
	mark := brandmark.Default()
	if goos == "darwin" {
		return mark.TrayPNG(markState(state), size, color.NRGBA{A: 255})
	}
	if goos != "linux" && goos != "windows" {
		return mark.TrayPNG(markState(state), size, color.NRGBA{R: 242, G: 242, B: 239, A: 255})
	}
	ink, err := brandmark.HexColor(mark.Color)
	if err != nil {
		panic(err)
	} // the compiled mark is parsed and checked by the generator
	return mark.TrayPNG(markState(state), size, ink, color.NRGBA{R: 117, G: 117, B: 117, A: 255})
}
