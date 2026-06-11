import SwiftUI
import WebKit

/// Full-screen WKWebView hosting the deployed discovery web app. All UI lives
/// on the web side; this shell only relays bridge messages (see
/// src/lib/playback/nativeBridge.ts) to ActivityManager / the Keychain.
struct WebViewContainer: UIViewRepresentable {
    /// The active webview, for deep-link navigation from onOpenURL.
    private static weak var activeWebView: WKWebView?

    static func navigate(to path: String) {
        let url = DiscoveryConfig.baseURL.appendingPathComponent(path)
        activeWebView?.load(URLRequest(url: url))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.userContentController.add(context.coordinator, name: "discovery")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .black
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.load(URLRequest(url: DiscoveryConfig.baseURL))
        Self.activeWebView = webView
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        /// UserDefaults key recording which account the Keychain token belongs
        /// to — lets us discard the token after a logout/account switch instead
        /// of writing ratings to the wrong user.
        private static let boundUserKey = "deviceTokenUserId"

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "discovery",
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String
            else { return }
            let webView = message.webView

            Task { @MainActor in
                switch type {
                case "trackChanged":
                    ActivityManager.shared.handleTrackChanged(
                        track: body["track"] as? [String: Any] ?? [:],
                        rating: body["rating"] as? Int,
                        isPlaying: body["isPlaying"] as? Bool ?? true)
                case "ratingChanged":
                    ActivityManager.shared.handleRatingChanged(
                        uri: body["uri"] as? String,
                        rating: body["rating"] as? Int)
                case "playbackStopped":
                    // Deliberate no-op: the server ends the activity after the
                    // stop window so a brief pause doesn't kill the lock screen.
                    break
                case "sessionUser":
                    self.handleSessionUser(body["userId"] as? String, webView: webView)
                case "deviceToken":
                    if let token = body["token"] as? String {
                        KeychainHelper.saveToken(token)
                        if let userId = body["userId"] as? String {
                            UserDefaults.standard.set(userId, forKey: Self.boundUserKey)
                        }
                        ActivityManager.shared.deviceTokenBecameAvailable()
                    }
                case "deviceTokenError":
                    // Not logged in yet — retried on the next page load.
                    break
                default:
                    break
                }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            reportSessionWithRetry(webView, attempt: 0)
        }

        /// Ask the web layer who's logged in. It installs
        /// window.__discoveryNative asynchronously after hydration, so retry
        /// a few times before giving up until the next navigation.
        private func reportSessionWithRetry(_ webView: WKWebView, attempt: Int) {
            guard attempt < 5 else { return }
            let js = "window.__discoveryNative ? (window.__discoveryNative.reportSession(), true) : false"
            webView.evaluateJavaScript(js) { [weak webView] result, _ in
                guard (result as? Bool) != true else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    guard let webView else { return }
                    self.reportSessionWithRetry(webView, attempt: attempt + 1)
                }
            }
        }

        /// Mint when we have no token; discard + re-mint when the session
        /// belongs to a different account than the token does.
        private func handleSessionUser(_ userId: String?, webView: WKWebView?) {
            guard let userId else { return } // logged out — nothing to mint
            let bound = UserDefaults.standard.string(forKey: Self.boundUserKey)
            let hasToken = KeychainHelper.readToken() != nil
            if hasToken && bound == userId { return }
            if hasToken && bound != userId {
                KeychainHelper.deleteToken()
                UserDefaults.standard.removeObject(forKey: Self.boundUserKey)
            }
            webView?.evaluateJavaScript(
                "window.__discoveryNative && window.__discoveryNative.requestDeviceToken('iOS wrapper')")
        }
    }
}
