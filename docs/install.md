# Install Faravan

Use the [Faravan downloads](https://github.com/tnunamak/faravan-updates/releases) or the release link your inviter sent. Download files from that GitHub repository over HTTPS. You do not need a GitHub account, Terminal, Docker, or an AI provider account to install and borrow.

Choose the release your inviter named. An early build is marked **Pre-release**. If its Mac ZIP or Linux `.deb` is missing, ask your inviter for the matching download. Do not substitute a different release. The older public preview may have only a Linux archive; ask for the `.deb` to install without Terminal.

## Mac

Use an Apple silicon Mac with macOS 14 or later. Download the Mac ZIP for your release. A ZIP labeled `universal` also supports Intel Macs when your inviter offers that build.

1. In Finder, open **Downloads** and double-click the ZIP to extract **Faravan.app**.
2. Drag **Faravan.app** to **Applications**, then open the app from its new location.
3. This preview has no Apple Developer ID signature or notarization. If macOS says **Apple cannot check** the app for malicious software, dismiss the alert with **Done** (or **OK** on older macOS). Open **Apple menu → System Settings → Privacy & Security**. Scroll to **Security** and choose **Open Anyway** beside Faravan.
4. Authenticate if asked. In the confirmation dialog, choose **Open**. Faravan opens its local page in your browser and adds a menu bar icon.
5. If macOS asks to find devices on your local network, choose **Allow**. This lets Faravan reach friends’ computers on your network.

The wording varies by macOS version. Do not turn off Gatekeeper or remove quarantine attributes.

These approval steps follow [Apple’s guide to safely opening apps](https://support.apple.com/en-us/102445).

If **Open Anyway** is missing, or macOS reports damage or malware, ask your inviter for help with the exact warning and filename. A managed Mac may block this preview; ask your administrator about approval and keep macOS security settings enabled.

## Linux

Use a Debian-based desktop, such as Ubuntu or KDE with Discover, on a 64-bit Intel or AMD computer. The package needs GNU C library 2.28 or newer and Python 3; your software installer handles the Python dependency.

1. Download the `.deb` for your release. Choose the app package, not a file labeled `transition` or a `.tar.gz` archive.
2. Open the `.deb` from **Downloads**. Your desktop opens its software installer, such as **Discover** or **App Center**, where you choose **Install** and approve the normal administrator password prompt if asked.
3. Open **Faravan** from the applications menu to show its local page in your browser.

If your desktop has no installer for `.deb` files, or installation fails, send your inviter the step, Linux version, filename, and error message.

## After opening

Follow [Join the circle](team-onboarding.md#join-the-circle), then send a small job without completing lending setup. Keep invitations and sign-in links private.

If **Setup** offers **Get early builds**, turn it on to try candidate updates, then restart Faravan after your jobs finish. To restart, choose **Quit** from the Faravan menu bar icon, then reopen **Faravan** from Applications or your applications menu. Turn it off and restart to return to the regular feed. This does not downgrade the installed app. Updates managed by your Linux software installer still come through that installer.

Faravan checks the release signature and download hash before applying an automatic update. First downloads use GitHub's HTTPS connection.
