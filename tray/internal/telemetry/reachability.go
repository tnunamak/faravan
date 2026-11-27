package telemetry

import "time"

// Unreachable decides when the tray reports that the app has not answered. It reports only after the app has been
// unreachable for more than ten minutes, and then once per UTC hour. health.state is one record per install-hour per
// check (docs/design/TELEMETRY.md §3.4), so a silent app does not write a record on every poll.
type Unreachable struct {
	since    time.Time
	reported string
}

// Observe takes the answer to one poll and reports whether to write the record now.
func (u *Unreachable) Observe(now time.Time, reachable bool) bool {
	if reachable {
		u.since = time.Time{}
		return false
	}
	if u.since.IsZero() {
		u.since = now
	}
	if now.Sub(u.since) <= unreachableAfter {
		return false
	}
	hour := hourOf(now)
	if hour == u.reported {
		return false
	}
	u.reported = hour
	return true
}
