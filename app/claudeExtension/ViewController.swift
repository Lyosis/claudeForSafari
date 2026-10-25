//
//  ViewController.swift
//  claudeExtension
//
//  Created by wilfrid on 06/06/2026.
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "com.wilfrid.B.claudeExtension.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

        self.webView.configuration.userContentController.add(self, name: "controller")

        guard let page = Bundle.main.url(forResource: "Main", withExtension: "html"),
              let resources = Bundle.main.resourceURL else { return }
        self.webView.loadFileURL(page, allowingReadAccessTo: resources)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Runs on the main actor, like the view controller: no dispatch needed.
        Task {
            guard let state = try? await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: extensionBundleIdentifier) else {
                // Insert code to inform the user that something went wrong.
                return
            }
            // macOS 13 and later (the deployment target) call it "Safari Settings".
            _ = try? await webView.evaluateJavaScript("show(\(state.isEnabled), true)")
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.body as? String == "open-preferences" else { return }

        Task {
            try? await SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier)
            NSApplication.shared.terminate(nil)
        }
    }

}
