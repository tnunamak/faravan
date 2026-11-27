// faravan-notify: shows one Faravan request notification with the action
// Review, waits for the answer and prints "review" or
// nothing (a dismissal or timeout). Borrower body clicks print "review" when
// --open-on-click is present. The tray runs it and
// acts on the answer. It must run from inside the signed Faravan.app bundle:
// UNUserNotificationCenter refuses an unsigned process with no bundle identifier.
import Foundation
import UserNotifications

func argument(_ name: String) -> String? {
    guard let i = CommandLine.arguments.firstIndex(of: name), i + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[i + 1]
}

final class Delegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        switch response.actionIdentifier {
        case "review", "decline": print(response.actionIdentifier)
        case UNNotificationDefaultActionIdentifier:
            if CommandLine.arguments.contains("--open-on-click") { print("review") }
        default: break
        }
        completionHandler()
        exit(0)
    }
}

let center = UNUserNotificationCenter.current()
let delegate = Delegate()
center.delegate = delegate

let review = UNNotificationAction(identifier: "review", title: argument("--review") ?? "Review", options: [.foreground])
center.setNotificationCategories([UNNotificationCategory(identifier: "request", actions: [review],
                                                         intentIdentifiers: [], options: [])])

center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
    guard granted else { exit(0) }
    let content = UNMutableNotificationContent()
    content.title = argument("--title") ?? "Faravan"
    content.body = argument("--body") ?? ""
    content.categoryIdentifier = "request"
    let request = UNNotificationRequest(identifier: argument("--id") ?? UUID().uuidString, content: content, trigger: nil)
    center.add(request) { error in if error != nil { exit(1) } }
}
// The tray kills this process at its own deadline.
RunLoop.main.run()
