// faravan-launch: the executable Finder and the login LaunchAgent start (Faravan.app/Contents/MacOS/faravan-launch).
// NOT RUN YET: written on Linux. Build on macOS:  swiftc -O -o Faravan.app/Contents/MacOS/faravan-launch main.swift
//
//   faravan-launch               Finder: start or reuse Faravan, then open it in the browser
//   faravan-launch --background  login: start or reuse Faravan without a browser tab
//
// launchd owns the session launcher; it restarts the bundled supervisor
//   Contents/Resources/faravan/runtime/bin/node Contents/Resources/faravan/lib/v1/macos-launch.mjs ... --tray Contents/MacOS/faravan-tray
// with a pipe as standard input and keeps the only write end. Closing that end is the one way it asks the supervisor
// to stop; the kernel closes it too if this process is force-quit, so the backend and tray never outlive it by
// accident. It never signals or kills any process. The supervisor drains the app it owns, leaves a reused app
// running, and decides what a duplicate launch does (lib/v1/macos-launch.mjs).
// The Node supervisor owns its bounded, redacted launcher.log. Raw child output is not appended to it:
// doing so would bypass redaction and rotation. Startup failures are recorded by that logger.
import AppKit
import Foundation
import Darwin

let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
let resources = contents.appendingPathComponent("Resources/faravan")
let node = resources.appendingPathComponent("runtime/bin/node")
let supervisor = resources.appendingPathComponent("lib/v1/macos-launch.mjs")
let tray = contents.appendingPathComponent("MacOS/faravan-tray")
// How long a quit (logout, a Quit Apple event) waits for the app to drain before replying.
let drainSeconds = 25.0

func supervisorEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    // Finder and launchd do not inherit a terminal PATH; sbx, git and agent CLIs live in Homebrew.
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
    return env
}

final class Launcher: NSObject, NSApplicationDelegate {
    let background = CommandLine.arguments.dropFirst().contains("--background")
    let managed = CommandLine.arguments.dropFirst().contains("--managed")
    var child: Process?
    var owner: FileHandle? // the only write end of the supervisor's standard input
    var quitPending = false
    var stopping = false
    var failures = 0
    var recentFailures: [TimeInterval] = []
    var startupFailureShown = false
    var reopenFailureShowing = false
    var reopenProcess: Process? // retained until the main-queue completion handles its result
    var signals: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // LSUIElement: no Dock icon; the tray is the visible app
        // launchd sends SIGTERM at logout and on bootout. Treat it like a quit: close the pipe, wait, exit.
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in self?.stopSupervisor(exitAfter: drainSeconds) }
            source.resume()
            signals.append(source)
        }
        startSupervisor()
    }

    func startSupervisor() {
        guard !stopping else { return }
        let process = Process()
        process.executableURL = node
        process.arguments = [supervisor.path] + (background ? ["--background"] : []) + (managed ? ["--managed"] : []) + ["--tray", tray.path]
        process.environment = supervisorEnvironment()
        let input = Pipe()
        // The supervisor must never inherit the owner's write end: EOF must survive Force Quit.
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETFD, FD_CLOEXEC) != -1 else {
            showStartupFailure()
            exit(1)
        }
        process.standardInput = input
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { finished in
            DispatchQueue.main.async { self.supervisorExited(finished.terminationStatus) }
        }
        do { try process.run() } catch {
            showStartupFailure()
            exit(1)
        }
        try? input.fileHandleForReading.close() // only the child reads; this process keeps the write end alone
        owner = input.fileHandleForWriting
        child = process
    }

    // End of input tells the supervisor to stop. Idempotent.
    func stopSupervisor(exitAfter seconds: Double?) {
        stopping = true
        try? owner?.close()
        owner = nil
        guard let seconds else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(0) }
    }

    func showStartupFailure() {
        guard !background else { return }
        let alert = NSAlert()
        alert.messageText = "Faravan could not start"
        alert.informativeText = "Quit any other copy of Faravan and open this app again from Applications. If it still fails, reinstall the complete app from the release download or contact the release owner."
        alert.addButton(withTitle: "Close")
        alert.runModal()
    }

    func showRepeatedStartupFailure() {
        guard !startupFailureShown else { return }
        startupFailureShown = true
        let alert = NSAlert()
        alert.messageText = "Faravan could not start. Details are in the Faravan log."
        alert.informativeText = "Log location: v1/logs/launcher.log in the Faravan data folder."
        alert.addButton(withTitle: "Keep retrying")
        alert.addButton(withTitle: "Quit")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertSecondButtonReturn {
            stopSupervisor(exitAfter: nil)
            NSApp.terminate(nil)
        }
    }

    func supervisorExited(_ status: Int32) {
        if quitPending { quitPending = false; NSApp.reply(toApplicationShouldTerminate: true); return }
        if status != 0 && !stopping {
            try? owner?.close()
            owner = nil
            failures += 1
            let now = ProcessInfo.processInfo.systemUptime
            recentFailures = recentFailures.filter { now - $0 <= 120.0 }
            recentFailures.append(now)
            // Never block recovery on a modal alert. In particular a background
            // launchd owner has no window to dismiss and must remain stoppable.
            // The supervisor persists only fixed failure codes in its data home.
            if recentFailures.count >= 3 {
                NSLog("Faravan could not start. Run faravan status get for the startup failure code.")
            }
            guard !stopping else { return }
            let delay = min(300.0, 5.0 * pow(2.0, Double(min(failures - 1, 6))))
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.startSupervisor() }
            return
        }
        recentFailures.removeAll()
        exit(status == 0 ? 0 : 1)
    }

    // Logout, restart, or a Quit Apple event: let the owned app drain, bounded, before saying yes.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let child, child.isRunning else { return .terminateNow }
        quitPending = true
        try? owner?.write(contentsOf: Data("quit\n".utf8))
        stopSupervisor(exitAfter: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + drainSeconds) {
            if self.quitPending { self.quitPending = false; NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    // Only fixed text is shown: opener errors/output may contain a one-use sign-in link.
    // Both failure paths arrive here on the main queue; the modal loop can receive more reopen events.
    func showReopenFailure() {
        guard !reopenFailureShowing else { return }
        reopenFailureShowing = true
        defer { reopenFailureShowing = false }
        let alert = NSAlert()
        alert.messageText = "Faravan could not open its page."
        alert.informativeText = "Close this message and try opening Faravan again. If it still fails, contact the release owner."
        alert.addButton(withTitle: "Close")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // Finder opened Faravan again while it runs: open it in the browser. A short --open-only run asks the running
    // app for a one-time handoff link; it never starts or stops anything.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Coalesce repeated Finder opens while this run or its failure alert is pending.
        guard !stopping, reopenProcess == nil, !reopenFailureShowing else { return false }
        let opener = Process()
        opener.executableURL = node
        opener.arguments = [supervisor.path, "--open-only"]
        opener.environment = supervisorEnvironment()
        opener.standardInput = FileHandle.nullDevice
        opener.standardOutput = FileHandle.nullDevice
        opener.standardError = FileHandle.nullDevice
        opener.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async { [weak self] in
                guard let self, self.reopenProcess === finished else { return }
                self.reopenProcess = nil
                if finished.terminationStatus != 0 && !self.stopping { self.showReopenFailure() }
            }
        }
        // Set before run(): even an immediate exit must find its retained owner.
        reopenProcess = opener
        do { try opener.run() } catch {
            reopenProcess = nil
            showReopenFailure()
        }
        return false
    }
}

let app = NSApplication.shared
let launcher = Launcher()
app.delegate = launcher
app.run()
