package faravantray

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Entry is one line of the native menu. The tray library draws plain text
// items only: no icons, no custom views, no per-item colors (EXPERIENCE 5.1).
type Entry struct {
	ID string
	Label string
	Disabled bool
	Separator bool
	Children []Entry // a submenu
}

// Menu is the whole menu: the glyph, the tooltip and the lines, from one state.
type Menu struct {
	State VisualState
	Status string
	Entries []Entry
}

// Labels lists the text of the non-separator lines, for tests and logs.
func (m Menu) Labels() []string {
	var labels []string
	for _, e := range m.Entries { if !e.Separator { labels = append(labels, e.Label) } }
	return labels
}

// Signature changes exactly when the drawn menu must be rebuilt.
func (m Menu) Signature() string {
	var b strings.Builder
	var write func(entries []Entry)
	write = func(entries []Entry) {
		for _, e := range entries {
			fmt.Fprintf(&b, "%s|%s|%t|%t", e.ID, e.Label, e.Disabled, e.Separator)
			if len(e.Children) > 0 { b.WriteString("["); write(e.Children); b.WriteString("]") }
			b.WriteString(";")
		}
	}
	write(m.Entries)
	return b.String()
}

type MenuInput struct {
	Status AppStatus
	Cards []ApprovalCard
	Circles map[string]string
	Now time.Time
	Loc *time.Location
	GOOS string
}

var agentNames = map[string]string{"claude": "Claude Code", "claude-code-subscription": "Claude Code", "claude-code-api-key": "Claude Code (API key)", "codex": "Codex"}

// The server's older labels differ from the web product names. Change display
// names only, keeping the ordered facts and the caller's model intact.
func normalizeBlockerLabels(model *BlockerModel) *BlockerModel {
	if model == nil { return nil }
	rename := func(item BlockerItem) BlockerItem {
		if name := agentNames[item.Agent]; item.Key == "agent" && name != "" && item.Label != "" && name != item.Label {
			item.Action = strings.ReplaceAll(item.Action, item.Label, name)
			item.Label = name
		}
		return item
	}
	copy := *model
	copy.Items = make([]BlockerItem, len(model.Items))
	for i, item := range model.Items { copy.Items[i] = rename(item) }
	if model.First != nil {
		first := rename(*model.First)
		if first.Label != model.First.Label { copy.Headline = strings.ReplaceAll(model.Headline, model.First.Label, first.Label) }
		copy.First = &first
	}
	return &copy
}

// normalize lets an app that predates the effective state (iconState only) draw the same menu.
func normalize(status AppStatus) AppStatus {
	if status.LendingBlockers == nil && len(status.Blockers) > 0 && status.Blockers[0] == '{' {
		var model BlockerModel
		if json.Unmarshal(status.Blockers, &model) == nil { status.LendingBlockers = &model }
	}
	status.LendingBlockers = normalizeBlockerLabels(status.LendingBlockers)
	if status.Intent != nil {
		status.State, status.Until = status.Intent.State, status.Intent.Until
	}
	if status.State != "" {
		// A v3 app sends execution; one that predates S1.1b only has the single state.
		if status.Execution.State == "" {
			status.Execution.State = "idle"
			if status.State == stateRunning { status.Execution.State = "running" }
		}
		return status
	}
	busy := len(status.CurrentJob) != 0 && string(status.CurrentJob) != "null"
	switch status.IconState {
	case "Lending on":
		status.State = stateReady
		if busy { status.Execution.State = "running" }
	case "Paused": status.State = statePaused
	default: status.State = stateBlocked
	}
	if busy { status.Execution.State = "running" }
	return status
}

// BuildMenu is the content of tray.mac-request, mac-running, mac-off, win-flyout and
// linux, within what a plain native menu can draw. The three desktops differ a little:
// Windows puts Open first, and Linux keeps the short list.
func BuildMenu(in MenuInput) Menu {
	status := normalize(in.Status)
	loc := in.Loc
	if loc == nil { loc = time.Local }
	state := status.State
	firstFixIsLending := status.LendingBlockers != nil && status.LendingBlockers.First != nil && status.LendingBlockers.First.Key == "lending"
	exec := ExecutionState(status) // what runs now: shown whatever the intent says (S1.1b)
	person := JobPerson(status)
	var e []Entry
	sep := func() { if len(e) > 0 && !e[len(e)-1].Separator { e = append(e, Entry{Separator: true}) } }
	add := func(id, label string) { e = append(e, Entry{ID: id, Label: label}) }
	statusLines := map[string]bool{}
	note := func(label string) {
		if statusLines[label] { return }
		statusLines[label] = true
		e = append(e, Entry{ID: "note", Label: label, Disabled: true})
	}

	// Who needs the lender, first: that is why the icon has a dot.
	if len(in.Cards) == 1 {
		name := cardName(in.Cards[0])
		if in.Cards[0].Kind == ChatgptKind { note("ChatGPT needs your approval") } else { note(name + " asked for help") }
		add("review:"+in.Cards[0].ID, reviewLabel(in.Cards[0]))
	} else if len(in.Cards) > 1 {
		note(fmt.Sprintf("%d requests need you", len(in.Cards)))
		for i, card := range in.Cards {
			if i == 5 { break }
			add("review:"+card.ID, reviewLabel(card))
		}
	}
	for _, need := range status.NeedsYou {
		if status.LendingBlockers != nil { break }
		switch need.Kind {
		case "agent_signed_out": note(firstNonEmpty(agentNames[need.Agent], "This agent") + " is signed out")
		}
	}
	// Setup that was waiting for a restart or log-out and is ready to continue (D8).
	setupBack := status.Setup.Resume != nil && status.Setup.Resume.State == "returned"
	if setupBack {
		note("Setup is ready to continue")
		add("setup", "Finish setting up Faravan…")
	}
	sep()

	headline := Headline(status, in.Now, loc)
	today := ""
	if t := status.Today; t != nil && state != stateOff {
		today = fmt.Sprintf("Today: %d of %d jobs · %d of %d min", t.Jobs, t.JobLimit, t.Minutes, t.MinuteLimit)
		if in.GOOS == "windows" { today = fmt.Sprintf("Today: %d of %d jobs", t.Jobs, t.JobLimit) }
	}
	controls := func() {
		// Admission controls follow intent; execution only changes whether there is a job to finish.
		lendingOn := state == stateReady || state == stateOutside || state == stateResting || state == stateStarting || state == stateRunning
		waitingLending := 0
		for _, card := range in.Cards { if card.Kind != ChatgptKind { waitingLending++ } }
		if lendingOn && waitingLending > 0 {
			count := waitingLending; label := fmt.Sprintf("Pausing declines the %d waiting requests.", count)
			if count == 1 { label = "Pausing declines the 1 waiting request." }
			if exec == "running" || exec == "finishing" { label += " The running job continues." } else { label += " No new jobs will start." }
			note(label)
		}
		if lendingOn && (exec == "running" || exec == "finishing") { add("pause-after-job", "Finish current job, then pause") }
		if lendingOn { e = append(e, Entry{ID:"pause-menu", Label:"Pause lending", Children: []Entry{{ID:"pause-30m",Label:"For 30 minutes"},{ID:"pause-1h",Label:"For 1 hour"},{ID:"pause-tomorrow",Label:"Until tomorrow, 7 AM"},{ID:"pause-after",Label:"Until I resume"}}}) }
		switch {
		case lendingOn:
			add("off", "Turn lending off")
		case exec != "idle": // show one way back for the off or paused intent, even while a job finishes
			if state == statePaused && !firstFixIsLending { add("resume", "Resume lending") }
			if state == stateOff && !firstFixIsLending { add("on", "Turn lending on") }
		case state == statePaused:
			if !firstFixIsLending { add("resume", "Resume lending") }
			add("off", "Turn lending off")
		case state == stateOff:
			if !firstFixIsLending { add("on", "Turn lending on") }
		}
	}
	status1 := func() {
		note(headline)
		if model := status.LendingBlockers; model != nil {
			if model.First != nil && model.First.Action != "" {
				id := "fix"
				if firstFixIsLending && state == stateOff { id = "on" }
				if firstFixIsLending && state == statePaused { id = "resume" }
				add(id, model.First.Action + "…")
			}
			for _, item := range model.Items {
				detail := localBlockerDetail(status, item, in.Now, loc)
				// The headline already states these causes. Keep rows that add
				// evidence, such as the failed test or the required version.
				switch item.Key {
				case "lending":
					if (detail == "Turned off." && strings.HasPrefix(headline, "Lending is off")) || (detail != "" && strings.HasPrefix(headline, strings.TrimSuffix(detail, "."))) { continue }
				case "docker_running":
					if detail == "Not running." && strings.Contains(headline, item.Label + " isn’t running") { continue }
				case "docker_signin":
					if detail == "Not signed in." && strings.Contains(headline, "sign in to Docker") { continue }
				case "agent":
					if detail == "Signed out." && strings.Contains(headline, item.Label + " is signed out") { continue }
				}
				if item.Status != "ok" || item.Key == "agent" { note(item.Label + " · " + strings.TrimSuffix(detail, ".")) }
			}
		}
		for _, item := range status.Cleanup.Items {
			if item.Message != "" {
				e = append(e, Entry{ID: "cleanup", Label: item.Message, Children: []Entry{{ID: "cleanup-retry", Label: "Clean up now"}}})
			}
		}
		if exec != "idle" {
			if attempt := attemptID(status); attempt != "" { add("watch:"+attempt, "Watch it…") } else { add("jobs", "View jobs…") }
			if exec != "stopping" { add("stop", "Stop "+possessive(person)+" job…") }
		}
	}
	nav := func(withOpen bool) {
		if withOpen { add("open", "Open Faravan") }
		add("new", "New job…")
		if exec == "idle" { add("jobs", "Jobs…") }
	}
	tail := func() {
		add("settings", "Lending settings…")
		add("updates", updateMenuLabel(status.UpdateStatus))
		if in.GOOS != "windows" { add("account", "You…") }
	}
	if in.GOOS == "windows" {
		status1(); add("open", "Open Faravan"); nav(false)
		sep(); controls(); sep()
		if today != "" { note(today) }
		tail()
	} else {
		status1()
		if today != "" { note(today) }
		sep(); controls(); sep()
		nav(true); tail()
	}
	sep()
	// With lending off, quitting changes nothing worth a question. Otherwise it asks first (tray.mac-quit).
	e = append(e, Entry{ID:"quit-note",Label:"Quitting stops Faravan on this computer.",Disabled:true})
	if state == stateOff && exec == "idle" { add("quit", "Quit Faravan") } else { add("quit", "Quit Faravan…") }
	return Menu{State: VisualFor(status, len(status.NeedsYou)+len(in.Cards)+boolInt(setupBack)), Status: headline, Entries: e}
}

func cardName(card ApprovalCard) string {
	if card.Kind == ChatgptKind { return "ChatGPT" }
	return firstNonEmpty(card.LocalName, card.RequesterName, "A circle member")
}
func reviewLabel(card ApprovalCard) string {
	if card.Kind == ChatgptKind { return "Review ChatGPT request…" }
	return "Review " + cardName(card) + "’s request…"
}

// PauseTomorrow is "Pause until tomorrow, 7 AM": 7:00 AM local time on the next day.
func PauseTomorrow(now time.Time, loc *time.Location) time.Time {
	if loc == nil { loc = time.Local }
	n := now.In(loc)
	return time.Date(n.Year(), n.Month(), n.Day()+1, 7, 0, 0, 0, loc)
}

// ExecutionState is idle, running, finishing or stopping. An app from before S1.1b only has the
// single state, where "running" means the job runs under an intent of on.
func ExecutionState(status AppStatus) string {
	status = normalize(status)
	switch status.Execution.State {
	case "running", "finishing", "stopping": return status.Execution.State
	}
	return "idle"
}

// JobPerson is who the running job is for: the S1.1b field, else the older runningJob field, else "".
func JobPerson(status AppStatus) string {
	if p := strings.TrimSpace(status.Execution.Person); p != "" { return p }
	if j := status.RunningJob; j != nil { return strings.TrimSpace(j.Requester) }
	return ""
}

// possessive writes "Sam’s job" or, without a name, "this job"; callers append " job".
func possessive(person string) string {
	if person == "" { return "this" }
	return person + "’s"
}

func boolInt(b bool) int { if b { return 1 }; return 0 }

// Only cached, well-formed availability changes this existing navigation item.
func updateMenuLabel(raw json.RawMessage) string {
	neutral := "Updates…"
	var update struct {
		State string `json:"state"`
		Candidate string `json:"candidate"`
		CurrentVersion string `json:"currentVersion"`
	}
	if json.Unmarshal(raw, &update) != nil { return neutral }
	valid := func(value string) bool {
		if len(value) == 0 || len(value) > 128 || strings.TrimSpace(value) != value { return false }
		for _, r := range value { if r < 32 || r == 127 { return false } }
		return true
	}
	if !valid(update.Candidate) || !valid(update.CurrentVersion) || update.Candidate == update.CurrentVersion { return neutral }
	switch update.State {
	case "available": return "Update available…"
	case "staged": return "Update waiting to install…"
	default: return neutral
	}
}
