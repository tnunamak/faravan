package faravantray

// StatusNotifierWatcher is the session-bus name that a Linux desktop owns when
// it can show tray icons (KDE, Ubuntu's GNOME, or GNOME with the AppIndicator
// extension). Stock GNOME and some tiling setups do not own it.
const StatusNotifierWatcher = "org.kde.StatusNotifierWatcher"

// LinuxTrayAvailable asks whether anything owns the watcher name. A session
// bus that cannot be reached means no desktop session, so there is no tray either.
// hasOwner is injected: tests never touch a real bus.
func LinuxTrayAvailable(hasOwner func(name string) (bool, error)) bool {
	owned, err := hasOwner(StatusNotifierWatcher)
	return err == nil && owned
}

// TrayReporter reports the tray state once per app start, so a restarted app
// learns it again, and a tray that appears later (the user installs the
// extension) is reported when the state changes.
type TrayReporter struct {
	startedAt string
	last *bool
}

// Due returns the value to report, or false when the app already has it.
func (r *TrayReporter) Due(info AppInfo, available bool) (bool, bool) {
	if r.last != nil && *r.last == available && r.startedAt == info.StartedAt { return false, false }
	return available, true
}
func (r *TrayReporter) Done(info AppInfo, available bool) { r.startedAt, r.last = info.StartedAt, &available }
