import ActivityKit
import Foundation

/// Owns the Live Activity lifecycle on the app side: starts it on the first
/// trackChanged bridge message, applies local updates for instant feedback,
/// and registers the activity's APNs push token with the server (which then
/// drives updates while the app is backgrounded).
@MainActor
final class ActivityManager {
    static let shared = ActivityManager()

    private var activity: Activity<NowPlayingAttributes>?
    private var pushTokenObserver: Task<Void, Never>?
    /// Push token seen before the device API token existed; registered as
    /// soon as the bearer token lands in the Keychain.
    private var pendingPushToken: String?

    private init() {}

    // MARK: bridge message handlers

    func handleTrackChanged(track: [String: Any], rating: Int?, isPlaying: Bool) {
        guard let uri = track["uri"] as? String,
              let title = track["name"] as? String,
              let artists = track["artists"] as? String
        else { return }
        let artworkUrl = track["albumArtUrl"] as? String
        let state = NowPlayingAttributes.ContentState(
            trackUri: uri,
            title: title,
            artists: artists,
            artworkUrl: artworkUrl,
            rating: rating,
            isPlaying: isPlaying)

        // Pre-cache artwork so the widget can render it from the App Group.
        Task { await ArtworkCache.ensureCached(artworkUrl: artworkUrl) }

        if let activity {
            Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
        } else {
            start(with: state)
        }
    }

    func handleRatingChanged(uri: String?, rating: Int?) {
        guard let activity, let uri, activity.content.state.trackUri == uri else { return }
        var state = activity.content.state
        state.rating = rating
        Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
    }

    func deviceTokenBecameAvailable() {
        if let pending = pendingPushToken {
            pendingPushToken = nil
            Task { await registerPushToken(pending) }
        }
    }

    // MARK: activity lifecycle

    /// Re-attach to an activity that survived an app restart.
    func adoptExistingActivities() {
        guard activity == nil,
              let existing = Activity<NowPlayingAttributes>.activities.first
        else { return }
        activity = existing
        observePushToken(of: existing)
        observeStateTransitions(of: existing)
    }

    private func start(with state: NowPlayingAttributes.ContentState) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        do {
            let started = try Activity.request(
                attributes: NowPlayingAttributes(startedAt: .now),
                content: ActivityContent(state: state, staleDate: nil),
                pushType: .token)
            activity = started
            observePushToken(of: started)
            observeStateTransitions(of: started)
        } catch {
            // Activities disabled / 8h budget hit — web playback is unaffected.
        }
    }

    private func observePushToken(of activity: Activity<NowPlayingAttributes>) {
        pushTokenObserver?.cancel()
        pushTokenObserver = Task {
            for await tokenData in activity.pushTokenUpdates {
                let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                await registerPushToken(hex)
            }
        }
    }

    private func observeStateTransitions(of activity: Activity<NowPlayingAttributes>) {
        Task {
            for await state in activity.activityStateUpdates {
                if state == .dismissed || state == .ended {
                    if self.activity?.id == activity.id { self.activity = nil }
                    await self.unregisterOnServer()
                }
            }
        }
    }

    // MARK: server registration

    private func registerPushToken(_ token: String) async {
        guard let bearer = KeychainHelper.readToken() else {
            pendingPushToken = token
            return
        }
        var request = URLRequest(
            url: DiscoveryConfig.baseURL.appendingPathComponent("api/ios/activity"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["apnsPushToken": token])
        _ = try? await URLSession.shared.data(for: request)
    }

    private func unregisterOnServer() async {
        guard let bearer = KeychainHelper.readToken() else { return }
        var request = URLRequest(
            url: DiscoveryConfig.baseURL.appendingPathComponent("api/ios/activity"))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        _ = try? await URLSession.shared.data(for: request)
    }
}
