import ActivityKit
import SwiftUI
import WidgetKit

/// Discovery brand green — matches `--color-spotify-green` / Star.svelte (#1DB954).
private let discoveryGreen = Color(red: 0x1D / 255.0, green: 0xB9 / 255.0, blue: 0x54 / 255.0)

struct NowPlayingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NowPlayingAttributes.self) { context in
            // Lock screen / notification banner.
            LockScreenView(state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.8))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "discovery://now-playing"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 8) {
                        (Text(context.state.title).fontWeight(.semibold) + Text("  \(context.state.artists)"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        StarRow(state: context.state, starSize: 32)
                    }
                    .padding(.top, 4)
                }
            } compactLeading: {
                Image(systemName: "star.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(discoveryGreen)
            } compactTrailing: {
                if let rating = context.state.rating {
                    Text("\(rating)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(discoveryGreen)
                }
            } minimal: {
                Image(systemName: context.state.rating != nil ? "star.fill" : "star")
                    .font(.system(size: 11))
                    .foregroundStyle(discoveryGreen)
            }
            .widgetURL(URL(string: "discovery://now-playing"))
        }
    }
}

/// Lock screen: big tappable green stars are the focus, with a small dim
/// "title - artist" label tucked in the top-right corner.
private struct LockScreenView: View {
    let state: NowPlayingAttributes.ContentState

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 4) {
                if !state.isPlaying {
                    Image(systemName: "pause.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(.white.opacity(0.4))
                }
                (Text(state.title).fontWeight(.semibold) + Text("  \(state.artists)"))
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.5))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            StarRow(state: state, starSize: 44)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
    }
}

/// Five tappable stars. Buttons run RateTrackIntent in the app process —
/// instant local update plus a PUT /api/ratings with the Keychain token.
private struct StarRow: View {
    let state: NowPlayingAttributes.ContentState
    let starSize: CGFloat

    var body: some View {
        HStack(spacing: starSize * 0.28) {
            ForEach(1...5, id: \.self) { star in
                Button(intent: RateTrackIntent(rating: star, trackUri: state.trackUri ?? "")) {
                    Image(systemName: star <= (state.rating ?? 0) ? "star.fill" : "star")
                        .font(.system(size: starSize * 0.82))
                        .foregroundStyle(star <= (state.rating ?? 0) ? discoveryGreen : Color.white.opacity(0.28))
                        .contentTransition(.identity) // no cross-fade — flip instantly
                        .frame(width: starSize, height: starSize)
                }
                .buttonStyle(.plain)
            }
        }
    }
}
