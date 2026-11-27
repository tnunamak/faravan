# Windows packaging status

This folder is a WinGet manifest skeleton, not a Windows installer. Windows
is not supported. Lending needs Windows 11 with the Hypervisor Platform
feature enabled; borrowing does not require that feature or Docker Sandboxes.
For lending setup only, an administrator runs this command in elevated PowerShell
and restarts when prompted:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
```

For lending, install Docker Sandboxes before completing Faravan's lending setup:

```powershell
winget install Docker.sbx
```

## Native verification pack

[acceptance.md](acceptance.md) specifies the Windows 11 installation, lifecycle,
CLI, upgrade and keep-data uninstall checks. Run [verify.ps1](verify.ps1) with a
reviewed candidate JSON and signed MSIX bytes to retain records across reboot
and upgrade. [native-probes.mjs](native-probes.mjs) uses the installed Node runtime
and app modules. A named person signs off the manual observations. The pack does not change the packaging status above.

## Installer work still required

1. Build or bundle the Windows tray executable and the Node 22 runtime.
2. Produce a signed x64 installer (the current manifest assumes Inno Setup).
3. Include the Faravan Node files. Allowance readings use the signed-in sandbox.
4. Add per-user PATH, Start menu, and tray autostart behavior to the installer.
5. Replace each `0.0.0`, release URL, and all-zero SHA256 in `winget/`.
6. Run `winget validate` and install/uninstall the local manifest on Windows 11.

Do not submit the skeleton to `microsoft/winget-pkgs`; its URL and SHA256 are
intentional placeholders.

## Toasts and the pin prompt

Request toasts use the application identity (AUMID) `Faravan.Desktop`. The
tray writes its display name and icon under
`HKCU\Software\Classes\AppUserModelId\Faravan.Desktop` when it starts, which is
enough for an unpackaged install. An MSIX package would declare the same AUMID in
its manifest; no MSIX is built yet. After lending turns on, the app reports
`desktop.pinPrompt` once so the setup screen can explain the `^` flyout
(`setup.win-pin`); `ms-settings:taskbar` opens the matching Windows settings page.

## Uninstall

`faravan uninstall` removes the Run entry, the toast identity and the `faravan://` and legacy `faravan://`
handler (all under HKCU), the Startup shortcut, and the tray process. The uninstaller
hook, once a signed installer exists, should run `faravan uninstall --yes --keep-data`
before it removes files: an installer cannot ask questions, so it must never delete the
device key by default. A person who wants the data gone runs `faravan uninstall` or
uses "Uninstall from this computer" in the app. No installer is built yet, so this hook
is described here and not wired.
