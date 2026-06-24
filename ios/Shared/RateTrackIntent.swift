import ActivityKit
import AppIntents
import Foundation
import os

private let log = Logger(subsystem: "tech.simmerman.discovery", category: "LiveActivity")

/// Tapping a star on the Live Activity. `LiveActivityIntent` guarantees
/// `perform()` runs in the MAIN APP process (never the extension), so it can
/// update the activity for instant feedback and call the API with the
/// Keychain bearer token. The type itself must compile into both targets so
/// the widget can reference `Button(intent:)`.
struct RateTrackIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Rate Track"
    static let isDiscoverable = false

    @Parameter(title: "Rating")
    var rating: Int

    @Parameter(title: "Track URI")
    var trackUri: String

    init() {}

    init(rating: Int, trackUri: String) {
        self.rating = rating
        self.trackUri = trackUri
    }

    func perform() async throws -> some IntentResult {
        // 1. Instant lock-screen feedback — no server round-trip.
        let activities = Activity<NowPlayingAttributes>.activities
        var matched = false
        for activity in activities {
            guard activity.content.state.trackUri == trackUri else { continue }
            matched = true
            var state = activity.content.state
            state.rating = rating
            await activity.update(ActivityContent(state: state, staleDate: nil))
        }
        log.info("RateTrackIntent rating=\(rating) uri=\(trackUri, privacy: .public) activities=\(activities.count) matched=\(matched)")

        // 2. Persist through the same API the web UI uses. Best-effort: the
        // server's poller re-pushes truth within seconds either way.
        if let token = KeychainHelper.readToken() {
            var request = URLRequest(
                url: DiscoveryConfig.baseURL.appendingPathComponent("api/ratings"))
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "spotifyTrackUri": trackUri,
                "ratingStars": rating,
            ])
            if let (_, response) = try? await URLSession.shared.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 401 {
                // Revoked/stale token — drop it so the app re-mints on next open.
                KeychainHelper.deleteToken()
            }
        }

        return .result()
    }
}
