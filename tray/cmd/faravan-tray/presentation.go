package main

import (
	"bytes"
	"time"

	"github.com/tnunamak/faravan/tray/internal/faravantray"
)

// Three missed polls are transient. The next missed poll publishes unavailable;
// a proven process exit or a successful new state never waits for this grace.
const statusFailureGrace = 6 * time.Second

type presentationState struct {
	lastGood                          faravantray.Connection
	failureSince                      time.Time
	icon                              []byte
	tooltip                           string
	iconDrawn, tooltipDrawn, template bool
}

func (p *presentationState) stable(next faravantray.Connection, now time.Time) faravantray.Connection {
	if next.Status != nil {
		p.lastGood, p.failureSince = next, time.Time{}
		return next
	}
	if next.AppGone || next.App != nil && p.lastGood.App != nil &&
		(next.App.PID != p.lastGood.App.PID || next.App.StartedAt != p.lastGood.App.StartedAt) {
		p.lastGood, p.failureSince = faravantray.Connection{}, time.Time{}
		return next
	}
	if p.lastGood.Status == nil {
		return next
	}
	if p.failureSince.IsZero() {
		p.failureSince = now
	}
	if now.Sub(p.failureSince) < statusFailureGrace {
		// Keep visual presentation only. Current status and approval evidence remain
		// unknown, so notification trackers cannot infer a job appeared or vanished.
		next.Menu = p.lastGood.Menu
	}
	return next
}

func (p *presentationState) publish(icon []byte, tooltip string, template bool) {
	if !p.iconDrawn || p.template != template || !bytes.Equal(p.icon, icon) {
		if template {
			setTrayTemplateIcon(icon, icon)
		} else {
			setTrayIcon(icon)
		}
		p.icon = append(p.icon[:0], icon...)
		p.iconDrawn, p.template = true, template
	}
	if !p.tooltipDrawn || p.tooltip != tooltip {
		setTrayTooltip(tooltip)
		p.tooltip, p.tooltipDrawn = tooltip, true
	}
}
