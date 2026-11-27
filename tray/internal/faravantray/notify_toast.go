package faravantray

import (
	"context"
	"encoding/base64"
	"html"
	"strings"
	"unicode/utf16"
)

// AUMID is the Windows application identity of Faravan toasts. The shell
// shows the name and icon registered for it, and groups the toasts under it.
const AUMID = "Faravan.Desktop"

// ToastNotifier shows a Windows toast with Review buttons
// through PowerShell and the WinRT toast API, and prints the chosen action.
type ToastNotifier struct{ Run Runner }

// ToastXML is the toast template. Text is escaped, so a name cannot add markup.
func ToastXML(n Notification) string {
	e := func(s string) string { return html.EscapeString(s) }
	launch := "open"
	if n.OpenOnClick { launch = "review" }
	return `<toast launch="` + launch + `"><visual><binding template="ToastGeneric"><text>` + e(n.Title) + `</text><text>` + e(n.Body) +
		`</text></binding></visual><actions><action content="Review" arguments="review" activationType="foreground"/>` +
		`</actions></toast>`
}

// ToastScript waits for a button, a dismissal or the caller's timeout, and prints the button's argument.
func ToastScript(n Notification) string {
	xml := strings.ReplaceAll(ToastXML(n), "'", "''")
	return strings.Join([]string{
		"$ErrorActionPreference='Stop'",
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
		"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
		"$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
		"$doc.LoadXml('" + xml + "')",
		"$toast = New-Object Windows.UI.Notifications.ToastNotification $doc",
		"Register-ObjectEvent -InputObject $toast -EventName Activated -SourceIdentifier FaravanActivated | Out-Null",
		"Register-ObjectEvent -InputObject $toast -EventName Dismissed -SourceIdentifier FaravanDismissed | Out-Null",
		"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + AUMID + "').Show($toast)",
		"$e = Wait-Event -Timeout 600",
		"if ($e -and $e.SourceIdentifier -eq 'FaravanActivated') { Write-Output $e.SourceEventArgs.Arguments }",
	}, "\n")
}

// PowerShellArgs passes the script as an encoded command, so no quoting layer touches it.
func PowerShellArgs(script string) []string {
	units := utf16.Encode([]rune(script))
	raw := make([]byte, 0, len(units)*2)
	for _, u := range units { raw = append(raw, byte(u), byte(u>>8)) }
	return []string{"-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", base64.StdEncoding.EncodeToString(raw)}
}

// ToastRegistration lists the `reg add` calls that give the AUMID a display
// name and icon for an install that is not an MSIX package. They are
// idempotent and write only under HKCU.
func ToastRegistration(iconPath string) [][]string {
	key := `HKCU\Software\Classes\AppUserModelId\` + AUMID
	calls := [][]string{{"add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", "Faravan", "/f"}}
	if iconPath != "" { calls = append(calls, []string{"add", key, "/v", "IconUri", "/t", "REG_SZ", "/d", iconPath, "/f"}) }
	return calls
}

func (t ToastNotifier) Notify(ctx context.Context, n Notification) (Action, error) {
	out, err := t.Run(ctx, "powershell.exe", PowerShellArgs(ToastScript(n))...)
	if err != nil { return ActionNone, err }
	return ParseAction(out), nil
}
