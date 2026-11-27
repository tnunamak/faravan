package faravantray

// LendingStopped is a local service incident retained by the app even if it
// recovers between tray polls. It contains fixed product copy, never diagnostics.
type LendingStopped struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

type HealthNoticeTracker struct{ seen, blocked string }

func (t *HealthNoticeTracker) Update(status AppStatus) *Notification {
	key := ""
	if status.Intent != nil && status.Intent.On && status.State == stateBlocked {
		if status.Reason == "docker_not_running" || status.Reason == "docker_signed_out" || status.Reason == "isolation_check_failed" {
			key = status.Reason
		}
	} else if status.State != "" {
		t.blocked = ""
	}
	notice := status.LendingStopped
	if notice != nil && notice.ID != "" && notice.Reason != "" && notice.ID != t.seen {
		t.seen = notice.ID
		t.blocked = key
		return &Notification{ID: notice.ID, Title: "Lending stopped", Body: notice.Reason}
	}
	if key == "" || key == t.blocked {
		return nil
	}
	t.blocked = key
	return &Notification{ID: "lending:" + key, Title: "Lending stopped", Body: blockedReasons[key]}
}

// A failed display must not consume the event forever. A later poll retries it.
func (t *HealthNoticeTracker) Retry(id string) {
	if id == t.seen {
		t.seen = ""
	}
	if id == "lending:"+t.blocked {
		t.blocked = ""
	}
}
