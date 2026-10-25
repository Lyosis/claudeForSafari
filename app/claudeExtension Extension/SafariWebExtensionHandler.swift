//
//  SafariWebExtensionHandler.swift
//  claudeExtension Extension
//
//  Created by wilfrid on 06/06/2026.
//

import SafariServices

// Native messaging is not used: the extension declares no `nativeMessaging`
// permission, so Safari never sends it a message. The class has to exist —
// Info.plist names it as NSExtensionPrincipalClass — and answers with nothing.
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: [], completionHandler: nil)
    }

}
