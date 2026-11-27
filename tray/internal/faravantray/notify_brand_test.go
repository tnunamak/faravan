package faravantray

import (
	"image"
	"image/png"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// writePNG writes a decodable 1x1 PNG at path, creating its directory.
func writePNG(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil { t.Fatal(err) }
	f, err := os.Create(path)
	if err != nil { t.Fatal(err) }
	defer f.Close()
	if err := png.Encode(f, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil { t.Fatal(err) }
}

// installTree makes a Linux install tree (usr/lib/faravan) with the shipped icon and returns the tray path.
func installTree(t *testing.T) (exe, icon string) {
	t.Helper()
	lib := filepath.Join(t.TempDir(), "usr", "lib", "faravan")
	icon = filepath.Join(lib, "public", "v1", "icon-512.png")
	writePNG(t, icon)
	return filepath.Join(lib, "faravan-tray"), icon
}

// A tarball's own icon must win over a system .deb icon that happens to be on the same machine.
func TestStableTarballWithItsOwnIconIgnoresTheSystemThemedIcon(t *testing.T) {
	exe, icon := installTree(t)
	everything := func(string) bool { return true }
	b := ResolveBranding(exe, "stable", "faravan", everything)
	if b.Icon != icon || b.ImagePath != icon { t.Fatalf("the install's own icon %q must win, got %+v", icon, b) }
}

// A checkout runs the tray from tray/ with its icon in the repo's public/ beside it.
func TestDevCheckoutFindsThePublicIconBesideTheTray(t *testing.T) {
	repo := t.TempDir()
	icon := filepath.Join(repo, "public", "v1", "icon-512.png")
	writePNG(t, icon)
	b := ResolveBranding(filepath.Join(repo, "tray", "faravan-tray"), "stable", "faravan", usableIcon)
	if b.Icon != icon || b.ImagePath != icon { t.Fatalf("dev checkout icon %q, want %q (%+v)", b.Icon, icon, b) }
}

// An icon the notification daemon cannot decode must not be sent as app_icon; the named fallback is used instead.
func TestUnreadableShippedIconFallsBackToTheNamedOne(t *testing.T) {
	lib := filepath.Join(t.TempDir(), "usr", "lib", "faravan")
	icon := filepath.Join(lib, "public", "v1", "icon-512.png")
	if err := os.MkdirAll(filepath.Dir(icon), 0o755); err != nil { t.Fatal(err) }
	if err := os.WriteFile(icon, []byte("png"), 0o644); err != nil { t.Fatal(err) }
	b := ResolveBranding(filepath.Join(lib, "faravan-tray"), "stable", "faravan", usableIcon)
	if b.Icon != "faravan" || b.ImagePath != "" { t.Fatalf("a non-image icon must not be used: %+v", b) }
}

func TestPreviewInstallNotifiesWithItsOwnLauncherAndIcon(t *testing.T) {
	exe, icon := installTree(t)
	b := ResolveBranding(exe, "preview-20261026", "faravan-preview-20261026", usableIcon)
	if b.DesktopEntry != "faravan-preview-20261026" { t.Fatalf("launcher %q", b.DesktopEntry) }
	if b.Icon != icon || b.ImagePath != icon { t.Fatalf("icon %q image %q, want %q", b.Icon, b.ImagePath, icon) }
	if !filepath.IsAbs(b.Icon) || !usableIcon(b.Icon) { t.Fatalf("icon must be an existing absolute path: %q", b.Icon) }

	// Even when the .deb's themed icon is on the machine, a preview must not borrow the stable launcher.
	b = ResolveBranding(exe, "preview-20261026", "faravan-preview-20261026", usableIcon)
	if b.DesktopEntry != "faravan-preview-20261026" || b.Icon != icon { t.Fatalf("%+v", b) }
}

func TestStableTarballInstallUsesTheShippedIcon(t *testing.T) {
	exe, icon := installTree(t)
	for _, id := range []string{"", "stable"} {
		b := ResolveBranding(exe, id, "faravan", usableIcon)
		if b.DesktopEntry != "faravan" || b.Icon != icon || b.ImagePath != icon { t.Fatalf("%q: %+v", id, b) }
	}
}

func TestDebInstallKeepsTheFaravanEntry(t *testing.T) {
	exe, icon := installTree(t)
	b := ResolveBranding(exe, "stable", "faravan", usableIcon)
	if b.DesktopEntry != "faravan" || b.Icon != icon || b.ImagePath != icon { t.Fatalf("%+v", b) }
}

func TestInstallWithoutAnIconFallsBackToTheNamedOne(t *testing.T) {
	b := ResolveBranding(filepath.Join(t.TempDir(), "faravan-tray"), "stable", "faravan", usableIcon)
	if b.DesktopEntry != "faravan" || b.Icon != "faravan" || b.ImagePath != "" { t.Fatalf("%+v", b) }
}

func TestShippedIconPerPlatform(t *testing.T) {
	cases := map[string]string{
		"linux": filepath.Join("/opt", "faravan", "public", "v1", "icon-512.png"),
		"windows": filepath.Join("/opt", "faravan", "app", "public", "v1", "icon-512.png"),
		"darwin": "",
	}
	for goos, want := range cases {
		if got := ShippedIcon(goos, filepath.Join("/opt", "faravan", "faravan-tray")); got != want { t.Fatalf("%s: %q want %q", goos, got, want) }
	}
}

func TestPreviewDBusNotificationCarriesItsIconAndLauncher(t *testing.T) {
	exe, icon := installTree(t)
	b := ResolveBranding(exe, "preview-20261026", "faravan-preview-20261026", usableIcon)
	if got := b.icon(); got != icon { t.Fatalf("app_icon %q", got) }
	hints := DBusHints(b)
	if hints["desktop-entry"].Value() != "faravan-preview-20261026" { t.Fatalf("%v", hints) }
	if hints["image-path"].Value() != icon { t.Fatalf("image-path hint missing: %v", hints) }
	deb := DBusHints(Branding{})
	if deb["desktop-entry"].Value() != "faravan" { t.Fatalf("%v", deb) }
	if _, has := deb["image-path"]; has { t.Fatal("a .deb install names its icon through the theme") }
}

func TestPreviewNotifySendCarriesItsIconAndLauncher(t *testing.T) {
	exe, icon := installTree(t)
	b := ResolveBranding(exe, "preview-20261026", "faravan-preview-20261026", usableIcon)
	args := strings.Join(NotifySendArgs(Notification{Title: "t", Body: "b"}, b), "\n")
	for _, want := range []string{"--icon=" + icon, "--hint=string:desktop-entry:faravan-preview-20261026", "--hint=string:image-path:" + icon} {
		if !strings.Contains(args, want) { t.Fatalf("missing %q in\n%s", want, args) }
	}
	deb := NotifySendArgs(Notification{Title: "t", Body: "b"}, Branding{})
	if !reflect.DeepEqual(deb[:3], []string{"--app-name=Faravan", "--icon=faravan", "--hint=string:desktop-entry:faravan"}) { t.Fatal(deb) }
}

func TestNewNotifierKeepsTheInstallBranding(t *testing.T) {
	b := Branding{DesktopEntry: "faravan-preview-1", Icon: "/x/icon.png", ImagePath: "/x/icon.png"}
	have := func(string) bool { return true }
	n, _ := NewNotifier("linux", nil, have, "", b)
	if n.(DBusNotifier).Brand != b { t.Fatal("session bus notifier lost its branding") }
	n, _ = NewNotifier("linux", nil, func(name string) bool { return name == "notify-send" }, "", b)
	if n.(NotifySend).Brand != b { t.Fatal("notify-send lost its branding") }
}

// A launcher file names the app and may give its own icon; a dated preview must not show as plain Faravan.
// Red on the commit before this one: launcherKeys and fromLauncher did not exist, and the tray never read a launcher file.
func TestLauncherFileSuppliesTheAppNameAndIcon(t *testing.T) {
	data := t.TempDir()
	t.Setenv("XDG_DATA_HOME", data)
	t.Setenv("XDG_DATA_DIRS", t.TempDir())
	entry := "faravan-preview-20261026"
	icon := filepath.Join(t.TempDir(), "preview.png")
	writePNG(t, icon)
	apps := filepath.Join(data, "applications")
	if err := os.MkdirAll(apps, 0o755); err != nil { t.Fatal(err) }
	desktop := "[Desktop Entry]\nName=Faravan Preview 20261026\nIcon=" + icon + "\n[Desktop Action review]\nName=Ignored\n"
	if err := os.WriteFile(filepath.Join(apps, entry+".desktop"), []byte(desktop), 0o644); err != nil { t.Fatal(err) }

	name, launcherIcon := launcherKeys(entry)
	b := fromLauncher(ResolveBranding(filepath.Join(t.TempDir(), "faravan-tray"), "preview-20261026", entry, usableIcon), name, launcherIcon, usableIcon)
	if b.name() != "Faravan Preview 20261026" || b.Icon != icon || b.ImagePath != icon { t.Fatalf("%+v", b) }
	args := strings.Join(NotifySendArgs(Notification{Title: "t", Body: "b"}, b), "\n")
	if !strings.Contains(args, "--app-name=Faravan Preview 20261026") || !strings.Contains(args, "--icon="+icon) { t.Fatalf("%s", args) }

	// A launcher icon that is not a usable image leaves the install's own icon in place.
	kept := fromLauncher(Branding{Icon: "faravan"}, "", filepath.Join(t.TempDir(), "missing.png"), usableIcon)
	if kept.Icon != "faravan" || kept.ImagePath != "" || kept.name() != "Faravan" { t.Fatalf("%+v", kept) }
}
