import SwiftUI

@main
struct DiscoveryApp: App {
    init() {
        ArtworkCache.pruneOldFiles()
        Task { @MainActor in
            // A previous session's activity may still be on the lock screen
            // (e.g. the app was killed) — re-attach so updates keep flowing.
            ActivityManager.shared.adoptExistingActivities()
        }
    }

    var body: some Scene {
        WindowGroup {
            WebViewContainer()
                .ignoresSafeArea()
                .onOpenURL { url in
                    // Live Activity taps deliver discovery://now-playing here;
                    // the webview is the whole UI, so just surface that view.
                    if url.host == "now-playing" {
                        WebViewContainer.navigate(to: "/now-playing")
                    }
                }
        }
    }
}
