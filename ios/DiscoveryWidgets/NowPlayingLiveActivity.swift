import ActivityKit
import SwiftUI
import WidgetKit
import os

private let log = Logger(subsystem: "tech.simmerman.discovery", category: "LiveActivity")

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
                    StarRow(state: context.state, starSize: 34)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 6)
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
                    .foregroundStyle(discoveryGreen)
                } else {
                    Image(systemName: "star")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
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

/// Lock screen: artwork for context + big tappable green stars as the hero.
/// Title/artist are intentionally omitted — Spotify's own media Live Activity
/// already shows them directly above this one.
private struct LockScreenView: View {
    let state: NowPlayingAttributes.ContentState

    var body: some View {
        HStack(spacing: 14) {
            ArtworkView(artworkUrl: state.artworkUrl, size: 56)
            StarRow(state: state, starSize: 40)
                .frame(maxWidth: .infinity)
            if !state.isPlaying {
                Image(systemName: "pause.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.5))
            }
        }
        .padding(.horizontal, 16)
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

/// Artwork from the App Group cache (the app pre-downloads on track change;
/// widget extensions can't fetch over the network). Placeholder otherwise.
private struct ArtworkView: View {
    let artworkUrl: String?
    let size: CGFloat

    var body: some View {
        Group {
            if let uiImage = loadArtwork() {
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

    /// Loads the cached art and logs the exact reason on miss, so a persistent
    /// gray square is diagnosable from the widget side.
    private func loadArtwork() -> UIImage? {
        guard let artworkUrl else { return nil } // no art for this track — fine
        guard let fileURL = ArtworkCache.fileURL(forArtworkUrl: artworkUrl) else {
            log.error("ArtworkView: App Group container unavailable — capability/provisioning missing on the widget target")
            return nil
        }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            log.error("ArtworkView: not cached (app didn't download it — e.g. a background track change)")
            return nil
        }
        guard let uiImage = UIImage(contentsOfFile: fileURL.path) else {
            log.error("ArtworkView: file present but unreadable — likely data protection while the screen is locked")
            return nil
        }
        return uiImage
    }
}
