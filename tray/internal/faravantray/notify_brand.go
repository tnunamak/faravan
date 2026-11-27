package faravantray

import (
	"image"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
)

// Branding names what a desktop notification is tied to: the app name, the launcher entry the shell
// takes its name from, and the icon it shows. A zero Branding is the .deb's: the system-wide faravan
// launcher and its themed icon.
type Branding struct {
	AppName string // app_name; empty means defaultAppName
	DesktopEntry string // launcher id without ".desktop"
	Icon string // app_icon: an absolute image path, or a themed icon name
	ImagePath string // absolute path of the shipped icon; empty when the icon theme already has the icon
}

const (
	defaultAppName = "Faravan"
	debDesktopEntry = "faravan"
)

func (b Branding) name() string { if b.AppName != "" { return b.AppName }; return defaultAppName }
func (b Branding) entry() string { if b.DesktopEntry != "" { return b.DesktopEntry }; return debDesktopEntry }
func (b Branding) icon() string { if b.Icon != "" { return b.Icon }; return debDesktopEntry }

// ShippedIcon is where an install carries its own icon, found from the tray's executable.
func ShippedIcon(goos, exe string) string {
	dir := filepath.Dir(exe)
	switch goos {
	case "linux": return filepath.Join(dir, "public", "v1", "icon-512.png") // usr/lib/faravan/{faravan-tray,public}
	case "windows": return filepath.Join(dir, "app", "public", "v1", "icon-512.png") // <layout>\{faravan-tray.exe,app\public}
	}
	return ""
}

// devIcon is a checkout's icon: a tray built into tray/ finds the repo's public/ one level up.
func devIcon(exe string) string { return filepath.Join(filepath.Dir(exe), "..", "public", "v1", "icon-512.png") }

// ResolveBranding picks the launcher id and icon for the install that holds exe.
// The stable channel's launcher is faravan.desktop (the .deb and the tarball installer both write it); another
// channel's is <linuxPrefix>.desktop. The install's own icon wins. Without one, the icon is the themed name,
// which the stable .deb's icon theme provides.
func ResolveBranding(exe, channelID, linuxPrefix string, usable func(string) bool) Branding {
	entry := debDesktopEntry
	if channelID != "" && channelID != "stable" && linuxPrefix != "" { entry = linuxPrefix }
	for _, icon := range []string{ShippedIcon("linux", exe), devIcon(exe)} {
		if usable(icon) { return Branding{DesktopEntry: entry, Icon: icon, ImagePath: icon} }
	}
	return Branding{DesktopEntry: entry, Icon: debDesktopEntry}
}

// fromLauncher applies the install's launcher file: its Name= is the notification app name, and an absolute
// Icon= that is a usable image replaces the icon. A themed Icon= name does not replace the install's own icon.
func fromLauncher(b Branding, name, icon string, usable func(string) bool) Branding {
	if name != "" { b.AppName = name }
	if filepath.IsAbs(icon) && usable(icon) { b.Icon, b.ImagePath = icon, icon }
	return b
}

// launcherKeys reads Name= and Icon= from the launcher file for entry, searched in the XDG application directories.
func launcherKeys(entry string) (name, icon string) {
	for _, dir := range applicationDirs() {
		if data, err := os.ReadFile(filepath.Join(dir, entry+".desktop")); err == nil { return parseDesktopEntry(string(data)) }
	}
	return "", ""
}

func applicationDirs() []string {
	var dirs []string
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" { if home, err := os.UserHomeDir(); err == nil { data = filepath.Join(home, ".local", "share") } }
	if data != "" { dirs = append(dirs, filepath.Join(data, "applications")) }
	system := os.Getenv("XDG_DATA_DIRS")
	if system == "" { system = "/usr/local/share:/usr/share" }
	for _, d := range filepath.SplitList(system) { if d != "" { dirs = append(dirs, filepath.Join(d, "applications")) } }
	return dirs
}

// parseDesktopEntry reads Name and Icon from the [Desktop Entry] group only.
func parseDesktopEntry(text string) (name, icon string) {
	inEntry := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") { inEntry = line == "[Desktop Entry]"; continue }
		key, value, ok := strings.Cut(line, "=")
		if !inEntry || !ok { continue }
		switch key {
		case "Name": name = value
		case "Icon": icon = value
		}
	}
	return name, icon
}

// InstalledBranding is ResolveBranding for the running tray, with the launcher file applied.
func InstalledBranding() Branding {
	exe, err := os.Executable()
	if err != nil { return Branding{} }
	ch, _ := installedChannel()
	b := ResolveBranding(exe, ch.ID, ch.LinuxPrefix, usableIcon)
	name, icon := launcherKeys(b.entry())
	return fromLauncher(b, name, icon, usableIcon)
}

// usableIcon is a regular file the notification daemon can decode as an image.
func usableIcon(path string) bool {
	f, err := os.Open(path)
	if err != nil { return false }
	defer f.Close()
	if info, err := f.Stat(); err != nil || info.IsDir() { return false }
	_, _, err = image.DecodeConfig(f)
	return err == nil
}
