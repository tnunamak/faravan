package brandmark

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"strconv"
)

// samples is the supersampling per pixel side: 64 coverage levels per pixel.
const samples = 8

// Coverage draws a glyph whose viewBox square spans box pixels from (ox, oy) on a size x size frame.
// Each value is the glyph's coverage of a pixel, 0 to 255.
func Coverage(g Glyph, side float64, size int, ox, oy, box float64) []uint8 {
	out := make([]uint8, size*size)
	n := samples * samples
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			count := 0
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					x := (float64(px) + float64(2*sx+1)/(2*samples) - ox) * side / box
					y := (float64(py) + float64(2*sy+1)/(2*samples) - oy) * side / box
					if g.Inside(x, y) {
						count++
					}
				}
			}
			out[py*size+px] = uint8((count*255 + n/2) / n)
		}
	}
	return out
}

// TrayMask is a state's glyph on a size x size frame, the full viewBox: coverage 0 to 255.
func (m Mark) TrayMask(s State, size int) []uint8 {
	return Coverage(m.StateGlyph(s), m.Side, size, 0, 0, float64(size))
}

// HexColor reads #rrggbb.
func HexColor(hex string) (color.NRGBA, error) {
	if len(hex) != 7 || hex[0] != '#' {
		return color.NRGBA{}, fmt.Errorf("brandmark: colour %q is not #rrggbb", hex)
	}
	v, err := strconv.ParseUint(hex[1:], 16, 32)
	if err != nil {
		return color.NRGBA{}, fmt.Errorf("brandmark: colour %q is not #rrggbb", hex)
	}
	return color.NRGBA{R: uint8(v >> 16), G: uint8(v >> 8), B: uint8(v), A: 255}, nil
}

// canvas composites layers with integer arithmetic, so every host makes the same pixels.
type canvas struct {
	size int
	img  *image.NRGBA
}

func newCanvas(size int) canvas { return canvas{size, image.NewNRGBA(image.Rect(0, 0, size, size))} }

// paint lays colour c over the canvas at each pixel's coverage (0 to 255) scaled by alpha (0 to 255).
func (c canvas) paint(cover []uint8, ink color.NRGBA, alpha int) {
	for i, cv := range cover {
		sa := (int(cv)*alpha + 127) / 255
		if sa == 0 {
			continue
		}
		p := c.img.Pix[i*4 : i*4+4]
		da := int(p[3])
		a := sa*255 + da*(255-sa) // out alpha, scaled by 255
		mix := func(src uint8, dst uint8) uint8 {
			return uint8((int(src)*sa*255 + int(dst)*da*(255-sa) + a/2) / a)
		}
		p[0], p[1], p[2] = mix(ink.R, p[0]), mix(ink.G, p[1]), mix(ink.B, p[2])
		p[3] = uint8((a + 127) / 255)
	}
}

func (c canvas) png() []byte {
	var out bytes.Buffer
	if err := png.Encode(&out, c.img); err != nil {
		panic(err) // encoding an in-memory NRGBA image does not fail
	}
	return out.Bytes()
}

// TrayPNG preserves the glyph's coverage. An optional modifier ink colours only
// the badge or pause bars; the mark itself stays in ink, including its outline.
func (m Mark) TrayPNG(s State, size int, ink color.NRGBA, modifier ...color.NRGBA) []byte {
	c := newCanvas(size)
	cover := m.TrayMask(s, size)
	if len(modifier) == 0 {
		c.paint(cover, ink, int(ink.A))
		return c.png()
	}
	baseState := s
	switch s {
	case NeedsYou:
		baseState = On
	case Paused, Error:
		baseState = Off
	}
	base := m.TrayMask(baseState, size)
	for i, coverage := range cover {
		colour := ink
		if coverage > base[i] {
			colour = modifier[0]
		}
		pixel := c.img.Pix[i*4 : i*4+4]
		pixel[0], pixel[1], pixel[2] = colour.R, colour.G, colour.B
		pixel[3] = uint8((int(coverage)*int(colour.A) + 127) / 255)
	}
	return c.png()
}

// tile draws the mark on a square background: the viewBox spans box pixels, centred.
func (m Mark) tile(size int, box float64, background color.NRGBA) (canvas, error) {
	ink, err := HexColor(m.Color)
	if err != nil {
		return canvas{}, err
	}
	c := newCanvas(size)
	full := make([]uint8, size*size)
	for i := range full {
		full[i] = 255
	}
	c.paint(full, background, 255)
	offset := (float64(size) - box) / 2
	c.paint(Coverage(m.Glyph, m.Side, size, offset, offset, box), ink, 255)
	return c, nil
}

// roundRect is the coverage of a rounded square: the points within radius of the square [lo+radius, hi-radius].
func roundRect(size int, scale, lo, hi, radius, inner float64) []uint8 {
	out := make([]uint8, size*size)
	n := samples * samples
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			count := 0
			for sy := 0; sy < samples; sy++ {
				for sx := 0; sx < samples; sx++ {
					x := (float64(px) + float64(2*sx+1)/(2*samples)) / scale
					y := (float64(py) + float64(2*sy+1)/(2*samples)) / scale
					d2 := sq(math.Max(math.Max(lo+radius-x, x-(hi-radius)), 0)) + sq(math.Max(math.Max(lo+radius-y, y-(hi-radius)), 0))
					if d2 <= sq(radius) && (inner <= 0 || d2 >= sq(inner)) {
						count++
					}
				}
			}
			out[py*size+px] = uint8((count*255 + n/2) / n)
		}
	}
	return out
}

// The macOS app icon follows Apple's 1024-point icon grid: an 824-point tile 100 points from each edge
// with corner radius 185, a 29.4-point inner line of white at 8%, and the grid's soft shadow (blur 12,
// 10 down, black at 28%). The mark's viewBox spans 576 points in the middle.
const (
	appGrid, appTileLo, appTileHi, appRadius, appLine = 1024.0, 100.0, 924.0, 185.0, 29.4
	appShadowBlur, appShadowDrop, appShadowAlpha      = 12.0, 10.0, 0.28
	appMarkBox                                        = 576.0
)

// AppIcon is the macOS app icon at size x size pixels, on a tile of the given colour.
func (m Mark) AppIcon(size int, tileColor color.NRGBA) ([]byte, error) {
	ink, err := HexColor(m.Color)
	if err != nil {
		return nil, err
	}
	scale := float64(size) / appGrid
	c := newCanvas(size)
	// The shadow is the tile blurred: for a straight edge that is the normal distribution of the
	// distance to the edge, which is close enough at the corners for a 12-point blur.
	shadow := make([]uint8, size*size)
	sigma := appShadowBlur * scale
	inner := (appTileHi - appTileLo) / 2 * scale
	centre := appGrid / 2 * scale
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			x := math.Abs(float64(px)+0.5-centre) - (inner - appRadius*scale)
			y := math.Abs(float64(py)+0.5-centre-appShadowDrop*scale) - (inner - appRadius*scale)
			outside := math.Sqrt(sq(math.Max(x, 0))+sq(math.Max(y, 0))) + math.Min(math.Max(x, y), 0) - appRadius*scale
			shadow[py*size+px] = uint8(math.Round(255 * appShadowAlpha * 0.5 * math.Erfc(outside/(sigma*math.Sqrt2))))
		}
	}
	c.paint(shadow, color.NRGBA{A: 255}, 255)
	c.paint(roundRect(size, scale, appTileLo, appTileHi, appRadius, 0), tileColor, 255)
	c.paint(roundRect(size, scale, appTileLo, appTileHi, appRadius, appRadius-appLine), color.NRGBA{R: 255, G: 255, B: 255, A: 255}, 20)
	offset := (appGrid - appMarkBox) / 2 * scale
	c.paint(Coverage(m.Glyph, m.Side, size, offset, offset, appMarkBox*scale), ink, 255)
	return c.png(), nil
}

// AppIconSVG is the vector master of AppIcon, for design tools.
func (m Mark) AppIconSVG(tileColor string) string {
	n := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	edge := appTileHi - appTileLo
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <!-- Generated by tray/cmd/brandgen from #mark in ui/v1/src/icons.svg: do not edit. The mark on Apple's macOS
       icon grid: an 824-point tile, 100 points from each edge, with the grid's soft drop shadow. -->
  <defs>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="` + n(appShadowBlur) + `"/>
      <feOffset dy="` + n(appShadowDrop) + `" result="blur"/>
      <feFlood flood-color="#000" flood-opacity="` + n(appShadowAlpha) + `"/>
      <feComposite in2="blur" operator="in"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect x="` + n(appTileLo) + `" y="` + n(appTileLo) + `" width="` + n(edge) + `" height="` + n(edge) + `" rx="` + n(appRadius) + `" fill="` + tileColor + `" filter="url(#shadow)"/>
  <rect x="` + n(appTileLo+appLine/2) + `" y="` + n(appTileLo+appLine/2) + `" width="` + n(edge-appLine) + `" height="` + n(edge-appLine) + `" rx="` + n(appRadius-appLine/2) + `" fill="none" stroke="#fff" stroke-width="` + n(appLine) + `" stroke-opacity="0.08"/>
  <svg x="` + n((appGrid-appMarkBox)/2) + `" y="` + n((appGrid-appMarkBox)/2) + `" width="` + n(appMarkBox) + `" height="` + n(appMarkBox) + `" viewBox="0 0 ` + n(m.Side) + ` ` + n(m.Side) + `">` + m.Inner + `</svg>
</svg>
`
}

// ICO wraps one 32-bit frame as a Windows icon: a BITMAPINFOHEADER, bottom-up BGRA rows and an empty AND mask.
func ICO(png []byte) ([]byte, error) {
	img, err := decodeNRGBA(png)
	if err != nil {
		return nil, err
	}
	size := img.Bounds().Dx()
	maskRow := (size + 31) / 32 * 4
	payload := new(bytes.Buffer)
	le := func(v any) { _ = binary.Write(payload, binary.LittleEndian, v) }
	le(uint32(40))
	le(int32(size))
	le(int32(2 * size))
	le(uint16(1))
	le(uint16(32))
	le(uint32(0))
	le(uint32(size*size*4 + maskRow*size))
	le([4]int32{})
	for y := size - 1; y >= 0; y-- {
		for x := 0; x < size; x++ {
			p := img.NRGBAAt(x, y)
			payload.Write([]byte{p.B, p.G, p.R, p.A})
		}
	}
	payload.Write(make([]byte, maskRow*size))
	out := new(bytes.Buffer)
	w := func(v any) { _ = binary.Write(out, binary.LittleEndian, v) }
	w([3]uint16{0, 1, 1})
	w([4]uint8{uint8(size), uint8(size), 0, 0})
	w([2]uint16{1, 32})
	w([2]uint32{uint32(payload.Len()), 22})
	out.Write(payload.Bytes())
	return out.Bytes(), nil
}

func decodeNRGBA(data []byte) (*image.NRGBA, error) {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if n, ok := img.(*image.NRGBA); ok {
		return n, nil
	}
	b := img.Bounds()
	n := image.NewNRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			n.Set(x, y, img.At(x, y))
		}
	}
	return n, nil
}
