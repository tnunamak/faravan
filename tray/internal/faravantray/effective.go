package faravantray

import (
	"strings"
	"time"
)


// A clock without a date or zone cannot be converted honestly. Keep its cause,
// and show contact times only when the app also supplies an absolute instant.
func localBlockerDetail(status AppStatus, item BlockerItem, now time.Time, loc *time.Location) string {
	detail := item.Detail
	switch item.Key {
	case "lending": return localHeadline(status, detail, now, loc)
	case "docker_signin":
		if strings.HasPrefix(detail, "Expired at ") { return "Expired." }
	case "circle":
		if before, _, found := strings.Cut(detail, " Last reached "); found {
			if status.Host != nil {
				if at, err := time.Parse(time.RFC3339Nano, status.Host.LastReachedAt); err == nil { return before + " Last reached " + clockText(float64(at.UnixMilli()), now, loc) + "." }
			}
			return before
		}
	}
	return detail
}

// The effective states the app reports (lib/v1/lending-state.mjs, S1.1). The tray
// reads them; it does not derive its own.
const (
	stateOff, statePaused, stateBlocked, stateUpdate = "off", "paused", "blocked", "update"
	stateRunning, stateOutside, stateResting, stateReady, stateStarting = "running", "outside", "resting", "ready", "starting"
)

// VisualForEffective is the tray glyph (tray.glyphs): needs-you is its own axis
// and wins; otherwise off and paused show the outline, everything else the solid mark.
func VisualForEffective(state string, needsYou int) VisualState {
	if needsYou > 0 { return VisualAttention }
	switch state {
	case stateOff: return VisualIdle
	case statePaused: return VisualPaused
	case stateBlocked, stateUpdate: return VisualError
	case stateRunning, stateOutside, stateResting, stateReady, stateStarting: return VisualActive
	}
	return VisualError // a state this tray does not know is never shown as fine
}

// clockText writes a local time the way the mockups do: "3:00 PM".
func clockText(ms float64, now time.Time, loc *time.Location) string {
	if loc == nil { loc = time.Local }
	t := time.UnixMilli(int64(ms)).In(loc)
	text := t.Format("3:04 PM")
	if t.Year() != now.In(loc).Year() || t.YearDay() != now.In(loc).YearDay() {
		if t.Sub(now) > 20*time.Hour { text = t.Format("Mon 3:04 PM") }
	}
	return text
}

// The app's human headline may use the saved lending-hours zone. Epoch facts
// remain authoritative for the tray on this computer.
func localHeadline(status AppStatus, text string, now time.Time, loc *time.Location) string {
	if status.Until != nil {
		prefix := map[string]string{statePaused:"Paused until", stateOutside:"Lending starts at", stateResting:"Resting until"}[status.State]
		if prefix != "" {
			clause := ""
			if _, tail, found := strings.Cut(text, " · "); found && ExecutionState(status) != "idle" {
				if status.State == stateOutside && strings.HasPrefix(tail, "starts at ") { _, tail, _ = strings.Cut(tail, " · ") }
				if tail != "" { clause = " · " + tail }
			}
			text = prefix + " " + clockText(*status.Until, now, loc) + clause
		}
	}
	if status.Execution.StopsBy != nil {
		if i := strings.LastIndex(text, "stops by "); i >= 0 { text = text[:i] + "stops by " + clockText(*status.Execution.StopsBy, now, loc) }
	}
	return text
}

var blockedReasons = map[string]string{
	// The ordered blockers (lib/v1/blockers.mjs): the app writes the headline itself, these are the fallback.
	"docker_not_installed": "Lending needs Docker Sandboxes",
	"docker_not_running": "Lending stopped: Docker Sandboxes isn’t running",
	"docker_signed_out": "Lending stopped: sign in to Docker",
	"isolation_check_failed": "Lending paused: sandbox isolation check failed",
	"circle_unreachable": "Lending waits: can’t reach the computer that hosts your circle",
	"circle_update_needed": "Lending waits: your circle needs an update",
}

// Headline is the status line of the menu, from the effective state (EXPERIENCE 1.1).
func Headline(status AppStatus, now time.Time, loc *time.Location) string {
	// The server writes one headline for both axes ("Paused · Sam’s job is finishing, stops by 3:01 PM"). Use it.
	status = normalize(status)
	if strings.Contains(strings.ToLower(status.Headline), "a safety check failed") { status.Headline = "" }
	if model := status.LendingBlockers; model != nil {
		if ExecutionState(status) != "idle" && strings.TrimSpace(status.Headline) != "" { return localHeadline(status, status.Headline, now, loc) }
		switch status.State {
		case stateOff: return "Lending is off"
		case statePaused:
			if status.Until != nil { return "Paused until " + clockText(*status.Until, now, loc) }
			return "Paused"
		}
		nonModelHold := model.First == nil && (status.State == stateUpdate || status.State == stateBlocked || status.State == stateStarting)
		if !nonModelHold {
			if model.CanLend && status.State == stateReady { return "Lending is on · Ready for requests" }
			if h := strings.TrimSpace(model.Headline); h != "" { return localHeadline(status, h, now, loc) }
		}
	}
	if h := strings.TrimSpace(status.Headline); h != "" && h != "Lending stopped" { return localHeadline(status, h, now, loc) }
	until := func(prefix string) string {
		if status.Until != nil { return prefix + " " + clockText(*status.Until, now, loc) }
		return ""
	}
	switch status.State {
	case stateOff: return "Lending is off"
	case statePaused:
		if s := until("Paused until"); s != "" { return s }
		return "Paused"
	case stateBlocked:
		if s, ok := blockedReasons[status.Reason]; ok { return s }
		return "Status unavailable"
	case stateUpdate: return "Update Faravan to keep lending"
	case stateRunning:
		if j := status.RunningJob; j != nil && strings.TrimSpace(j.Requester) != "" {
			return "Running " + j.Requester + "’s job"
		}
		return "Running a job"
	case stateOutside:
		if s := until("Lending starts at"); s != "" { return s }
		return "Outside lending hours"
	case stateResting:
		if s := until("Resting until"); s != "" { return s }
		return "Resting"
	case stateReady: return "Lending is on"
	case stateStarting: return "Checking this computer…"
	}
	return "Status unavailable"
}

// VisualFor uses the app's icon projection plus ordered actionable blockers.
// Older apps without iconState fall back to the execution and intent axes.
func VisualFor(status AppStatus, needsYou int) VisualState {
	if needsYou > 0 || len(status.NeedsYou) > 0 { return VisualAttention }
	status = normalize(status)
	if hasActionableAttention(status) { return VisualAttention }
	if model := status.LendingBlockers; model != nil {
		// Turning lending off or pausing it is a choice, not an attention fault.
		for _, item := range model.NeedsYou { if item.Key != "lending" { return VisualAttention } }
		for _, item := range model.Items { if item.Status == "unknown" { return VisualAttention } }
		for _, item := range model.Items { if item.Key != "lending" && item.Status == "blocked" { return VisualError } }
	}
	// A fault or future state remains visible even while the current job runs.
	switch status.State {
	case stateBlocked, stateUpdate:
		return VisualError
	case stateOff, statePaused, stateRunning, stateOutside, stateResting, stateReady, stateStarting:
	default:
		return VisualError
	}
	switch ExecutionState(status) {
	case "running", "finishing", "stopping": return VisualActive
	}
	if status.State != "" { return VisualForEffective(status.State, 0) }
	if status.IconState != "" {
		return VisualStateForAppState(status.IconState)
	}
	return VisualForEffective(normalize(status).State, 0)
}

// The app already leaves expected rests (daily limit, quota reserve) out of iconState, so an attention item
// counts only when the app itself says the lender is needed. Matching rest labels here would drift from the app's copy.
func hasActionableAttention(status AppStatus) bool {
	return status.IconState == "Needs attention" && len(status.Attention) > 0
}
