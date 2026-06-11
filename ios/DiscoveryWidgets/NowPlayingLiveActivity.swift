import ActivityKit
import SwiftUI
import WidgetKit

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
                DynamicIslandExpandedRegion(.leading) {
                    ArtworkView(artworkUrl: context.state.artworkUrl, size: 52)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        Text(context.state.artists)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    StarRow(state: context.state, starSize: 28)
                        .padding(.top, 4)
                }
            } compactLeading: {
                ArtworkView(artworkUrl: context.state.artworkUrl, size: 22)
            } compactTrailing: {
                if let rating = context.state.rating {
                    HStack(spacing: 1) {
                        Text("\(rating)")
                            .font(.caption2.weight(.bold))
                        Image(systemName: "star.fill")
                            .font(.system(size: 9))
                    }
                    .foregroundStyle(.yellow)
                } else {
                    Image(systemName: "star")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            } minimal: {
                Image(systemName: context.state.rating != nil ? "star.fill" : "star")
                    .font(.system(size: 11))
                    .foregroundStyle(.yellow)
            }
            .widgetURL(URL(string: "discovery://now-playing"))
        }
    }
}

private struct LockScreenView: View {
    let state: NowPlayingAttributes.ContentState

    var body: some View {
        HStack(spacing: 12) {
            ArtworkView(artworkUrl: state.artworkUrl, size: 56)
            VStack(alignment: .leading, spacing: 6) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(state.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        if !state.isPlaying {
                            Image(systemName: "pause.fill")
                                .font(.system(size: 10))
                                .foregroundStyle(.white.opacity(0.5))
                        }
                    }
                    Text(state.artists)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.6))
                        .lineLimit(1)
                }
                StarRow(state: state, starSize: 24)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
    }
}

/// Five tappable stars. Buttons run RateTrackIntent in the app process —
/// instant local update plus a PUT /api/ratings with the Keychain token.
private struct StarRow: View {
    let state: NowPlayingAttributes.ContentState
    let starSize: CGFloat

    var body: some View {
        HStack(spacing: 8) {
            ForEach(1...5, id: \.self) { star in
                Button(intent: RateTrackIntent(rating: star, trackUri: state.trackUri ?? "")) {
                    Image(systemName: star <= (state.rating ?? 0) ? "star.fill" : "star")
                        .font(.system(size: starSize * 0.8))
                        .foregroundStyle(star <= (state.rating ?? 0) ? .yellow : .white.opacity(0.4))
                        .frame(width: starSize, height: starSize)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Artwork from the App Group cache (the app pre-downloads on track change;
/// widget extensions can't fetch over the network). Placeholder otherwise.
private struct ArtworkView: View {
    let artworkUrl: String?
    let size: CGFloat

    var body: some View {
        Group {
            if let artworkUrl,
               let fileURL = ArtworkCache.fileURL(forArtworkUrl: artworkUrl),
               let uiImage = UIImage(contentsOfFile: fileURL.path) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFill()
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: size * 0.18)
                        .fill(.white.opacity(0.1))
                    Image(systemName: "music.note")
                        .font(.system(size: size * 0.45))
                        .foregroundStyle(.white.opacity(0.5))
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.18))
    }
}
