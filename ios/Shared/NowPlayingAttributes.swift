import ActivityKit
import Foundation

/// Live Activity model for the currently playing track.
///
/// `ContentState` is decoded straight from the server's APNs `content-state`
/// payload (see `computeContentState` in src/lib/server/liveActivityPoller.ts)
/// — the property names below MUST match those JSON keys exactly.
struct NowPlayingAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var trackUri: String?
        var title: String
        var artists: String
        var artworkUrl: String?
        var rating: Int?
        var isPlaying: Bool
    }

    /// Static for the lifetime of one activity.
    var startedAt: Date
}
