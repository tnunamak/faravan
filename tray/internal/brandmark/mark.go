// Package brandmark draws Faravan's mark, the open horizon, from its one source: the #mark symbol in
// ui/v1/src/icons.svg (a marigold arch over a line, both stroked with round caps).
//
// Everything else is derived here and never drawn by hand: the tray state glyphs, the tray-* symbols
// next to #mark, the favicons, the web app and Linux icons, and the macOS app icon. Run the generator
// after an edit to #mark:
//
//	cd tray && go run ./cmd/brandgen
//
// TestGeneratedFilesMatchTheMark fails when a committed file differs from what the generator makes.
package brandmark

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Seg is one stroked piece of the mark, with round caps: a line, or a half circle from (X0,Y0) to (X1,Y1).
type Seg struct {
	X0, Y0, X1, Y1 float64
	Width          float64
	Arc            bool
	Sweep          bool // the SVG sweep flag: true turns clockwise on the screen
}

// Dot is a filled circle.
type Dot struct{ X, Y, R float64 }

// Glyph is a drawing on the mark's square viewBox.
type Glyph struct {
	Segs []Seg
	Dots []Dot
}

// Mark is the parsed #mark symbol.
type Mark struct {
	Symbol string  // the <symbol id="mark"> element as written
	Inner  string  // its content
	Side   float64 // the viewBox side
	Width  float64 // the stroke width
	Color  string  // the stroke colour, #rrggbb
	Glyph  Glyph
}

var (
	symbolPattern = regexp.MustCompile(`<symbol id="mark" viewBox="0 0 ([\d.]+) ([\d.]+)">([\s\S]*?)</symbol>`)
	attrPattern   = regexp.MustCompile(`([a-z-]+)="([^"]*)"`)
	pathPattern   = regexp.MustCompile(`<path d="([^"]+)"/>`)
	tokenPattern  = regexp.MustCompile(`[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?`)
)

// ParseMark reads the #mark symbol from an SVG sprite. It accepts what the mark uses: one <g> with the
// stroke attributes and plain <path d> children made of lines and half circles.
func ParseMark(sprite string) (Mark, error) {
	found := symbolPattern.FindStringSubmatch(sprite)
	if found == nil {
		return Mark{}, fmt.Errorf("brandmark: no <symbol id=\"mark\" viewBox=\"0 0 N N\"> in the sprite")
	}
	if found[1] != found[2] {
		return Mark{}, fmt.Errorf("brandmark: the #mark viewBox is not square")
	}
	m := Mark{Symbol: found[0], Inner: found[3]}
	m.Side, _ = strconv.ParseFloat(found[1], 64)
	group := regexp.MustCompile(`<g ([^>]*)>`).FindStringSubmatch(m.Inner)
	if group == nil {
		return Mark{}, fmt.Errorf("brandmark: #mark has no <g> with stroke attributes")
	}
	attrs := map[string]string{}
	for _, a := range attrPattern.FindAllStringSubmatch(group[1], -1) {
		attrs[a[1]] = a[2]
	}
	if attrs["stroke-linecap"] != "round" || attrs["fill"] != "none" || !regexp.MustCompile(`^#[0-9a-f]{6}$`).MatchString(attrs["stroke"]) {
		return Mark{}, fmt.Errorf("brandmark: #mark must be fill=none, a #rrggbb stroke and round caps")
	}
	m.Color = attrs["stroke"]
	var err error
	if m.Width, err = strconv.ParseFloat(attrs["stroke-width"], 64); err != nil || m.Width <= 0 {
		return Mark{}, fmt.Errorf("brandmark: #mark stroke-width %q", attrs["stroke-width"])
	}
	paths := pathPattern.FindAllStringSubmatch(m.Inner, -1)
	if len(paths) == 0 {
		return Mark{}, fmt.Errorf("brandmark: #mark has no paths")
	}
	for _, p := range paths {
		segs, err := parsePath(p[1], m.Width)
		if err != nil {
			return Mark{}, err
		}
		m.Glyph.Segs = append(m.Glyph.Segs, segs...)
	}
	return m, nil
}

// parsePath reads M, L, H, V and A commands (absolute or relative). Arcs must be circular half circles.
func parsePath(d string, width float64) ([]Seg, error) {
	tokens := tokenPattern.FindAllString(d, -1)
	var segs []Seg
	var x, y float64
	cmd := ""
	num := func(i *int) (float64, error) {
		if *i >= len(tokens) {
			return 0, fmt.Errorf("brandmark: path %q ends early", d)
		}
		v, err := strconv.ParseFloat(tokens[*i], 64)
		*i++
		if err != nil {
			return 0, fmt.Errorf("brandmark: path %q: %v", d, err)
		}
		return v, nil
	}
	for i := 0; i < len(tokens); {
		if _, err := strconv.ParseFloat(tokens[i], 64); err != nil {
			cmd = tokens[i]
			i++
		} else if cmd == "" {
			return nil, fmt.Errorf("brandmark: path %q starts with a number", d)
		}
		rel := strings.ToLower(cmd) == cmd
		ox, oy := 0.0, 0.0
		if rel {
			ox, oy = x, y
		}
		switch strings.ToLower(cmd) {
		case "m", "l":
			nx, err := num(&i)
			if err != nil {
				return nil, err
			}
			ny, err := num(&i)
			if err != nil {
				return nil, err
			}
			if strings.ToLower(cmd) == "l" {
				segs = append(segs, Seg{X0: x, Y0: y, X1: ox + nx, Y1: oy + ny, Width: width})
			} else if rel {
				cmd = "l" // further pairs after a moveto are linetos
			} else {
				cmd = "L"
			}
			x, y = ox+nx, oy+ny
		case "h", "v":
			v, err := num(&i)
			if err != nil {
				return nil, err
			}
			nx, ny := x, y
			if strings.ToLower(cmd) == "h" {
				nx = ox + v
				if !rel {
					nx = v
				}
			} else {
				ny = oy + v
				if !rel {
					ny = v
				}
			}
			segs = append(segs, Seg{X0: x, Y0: y, X1: nx, Y1: ny, Width: width})
			x, y = nx, ny
		case "a":
			var v [7]float64
			for k := range v {
				var err error
				if v[k], err = num(&i); err != nil {
					return nil, err
				}
			}
			nx, ny := ox+v[5], oy+v[6]
			chord := math.Hypot(nx-x, ny-y)
			if v[0] != v[1] || math.Abs(chord-2*v[0]) > 1e-9 {
				return nil, fmt.Errorf("brandmark: path %q: only circular half circles are supported", d)
			}
			segs = append(segs, Seg{X0: x, Y0: y, X1: nx, Y1: ny, Width: width, Arc: true, Sweep: v[4] != 0})
			x, y = nx, ny
		default:
			return nil, fmt.Errorf("brandmark: path %q: command %q is not supported", d, cmd)
		}
	}
	return segs, nil
}

// State is a tray state. The glyphs differ in silhouette, so they read without colour.
type State int

const (
	On       State = iota // the mark
	Off                   // the outline arch over a broken horizon
	NeedsYou              // the mark and a badge dot
	Paused                // off, with pause bars where the badge goes
	Error                 // off, with the badge dot
)

// States lists every state in a fixed order.
var States = []State{On, Off, NeedsYou, Paused, Error}

func (s State) String() string {
	return [...]string{"on", "off", "need", "paused", "error"}[s]
}

// StateGlyph derives a state's glyph from the mark. Every size is a multiple of the stroke width w:
//
//	off        each arc keeps its outer edge and thins to w/2, so it reads as an outline;
//	           each line breaks at its middle, with a gap of w between the round caps
//	badge      a dot of radius 5w/8 at (side - 5w/4, 5w/4): the top-right corner, clear of the arch
//	pause      two bars of width w/2, w apart, centred on the badge; their run is w/2, so the caps stay clear of the arch
func (m Mark) StateGlyph(s State) Glyph {
	w := m.Width
	bx, by := m.Side-1.25*w, 1.25*w
	off := Glyph{}
	for _, seg := range m.Glyph.Segs {
		off.Segs = append(off.Segs, outline(seg)...)
	}
	badge := Dot{X: bx, Y: by, R: 0.625 * w}
	switch s {
	case Off:
		return off
	case NeedsYou:
		return Glyph{Segs: m.Glyph.Segs, Dots: []Dot{badge}}
	case Paused:
		bar := func(x float64) Seg { return Seg{X0: x, Y0: by - w/4, X1: x, Y1: by + w/4, Width: w / 2} }
		return Glyph{Segs: append(append([]Seg{}, off.Segs...), bar(bx-w/2), bar(bx+w/2))}
	case Error:
		return Glyph{Segs: off.Segs, Dots: []Dot{badge}}
	}
	return m.Glyph
}

// outline is the off form of one segment.
func outline(s Seg) []Seg {
	if s.Arc {
		// Grow the radius by w/4 and halve the stroke: the outer edge stays where it was.
		cx, cy := (s.X0+s.X1)/2, (s.Y0+s.Y1)/2
		r := math.Hypot(s.X1-s.X0, s.Y1-s.Y0) / 2
		k := (r + s.Width/4) / r
		return []Seg{{X0: cx + (s.X0-cx)*k, Y0: cy + (s.Y0-cy)*k, X1: cx + (s.X1-cx)*k, Y1: cy + (s.Y1-cy)*k,
			Width: s.Width / 2, Arc: true, Sweep: s.Sweep}}
	}
	mx, my := (s.X0+s.X1)/2, (s.Y0+s.Y1)/2
	length := math.Hypot(s.X1-s.X0, s.Y1-s.Y0)
	if length <= 2*s.Width {
		return []Seg{s}
	}
	ux, uy := (s.X1-s.X0)/length, (s.Y1-s.Y0)/length
	return []Seg{
		{X0: s.X0, Y0: s.Y0, X1: mx - ux*s.Width, Y1: my - uy*s.Width, Width: s.Width},
		{X0: mx + ux*s.Width, Y0: my + uy*s.Width, X1: s.X1, Y1: s.Y1, Width: s.Width},
	}
}

// Inside reports whether the point (x, y), in viewBox units, is ink.
func (g Glyph) Inside(x, y float64) bool {
	for _, d := range g.Dots {
		if sq(x-d.X)+sq(y-d.Y) <= d.R*d.R {
			return true
		}
	}
	for _, s := range g.Segs {
		if s.inside(x, y) {
			return true
		}
	}
	return false
}

// Products are wrapped in float64() so the compiler cannot fuse them into multiply-adds, which some
// processors round differently. With that, a sample lands on the same side of an edge on every host.
func sq(v float64) float64 { return float64(v * v) }

func (s Seg) inside(x, y float64) bool {
	h2 := sq(s.Width / 2)
	dx, dy := s.X1-s.X0, s.Y1-s.Y0
	px, py := x-s.X0, y-s.Y0
	if s.Arc {
		cx, cy := (s.X0+s.X1)/2, (s.Y0+s.Y1)/2
		// The half circle is the side of its chord that the sweep turns to.
		side := float64(dx*(y-cy)) - float64(dy*(x-cx))
		if (s.Sweep && side < 0) || (!s.Sweep && side > 0) {
			r := math.Sqrt(sq(dx)+sq(dy)) / 2
			d2 := sq(x-cx) + sq(y-cy)
			h := s.Width / 2
			return d2 >= sq(math.Max(r-h, 0)) && d2 <= sq(r+h)
		}
		return sq(px)+sq(py) <= h2 || sq(x-s.X1)+sq(y-s.Y1) <= h2
	}
	l2 := sq(dx) + sq(dy)
	t := float64(px*dx) + float64(py*dy)
	switch {
	case t <= 0:
		return sq(px)+sq(py) <= h2
	case t >= l2:
		return sq(x-s.X1)+sq(y-s.Y1) <= h2
	}
	cross := float64(dx*py) - float64(dy*px)
	return sq(cross) <= float64(h2*l2)
}

// SVG writes the glyph as SVG elements in currentColor.
func (g Glyph) SVG() string {
	var b strings.Builder
	n := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	widths := []float64{}
	for _, s := range g.Segs {
		seen := false
		for _, w := range widths {
			seen = seen || w == s.Width
		}
		if !seen {
			widths = append(widths, s.Width)
		}
	}
	for _, w := range widths {
		var d strings.Builder
		for _, s := range g.Segs {
			if s.Width != w {
				continue
			}
			fmt.Fprintf(&d, "M%s %s", n(s.X0), n(s.Y0))
			if s.Arc {
				r := math.Hypot(s.X1-s.X0, s.Y1-s.Y0) / 2
				sweep := 0
				if s.Sweep {
					sweep = 1
				}
				fmt.Fprintf(&d, "A%s %s 0 0 %d %s %s", n(r), n(r), sweep, n(s.X1), n(s.Y1))
			} else {
				fmt.Fprintf(&d, "L%s %s", n(s.X1), n(s.Y1))
			}
		}
		fmt.Fprintf(&b, `<path d="%s" stroke-width="%s"/>`, d.String(), n(w))
	}
	for _, dot := range g.Dots {
		fmt.Fprintf(&b, `<circle cx="%s" cy="%s" r="%s" fill="currentColor" stroke="none"/>`, n(dot.X), n(dot.Y), n(dot.R))
	}
	return `<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">` + b.String() + `</g>`
}
