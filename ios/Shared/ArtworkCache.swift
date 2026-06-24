import CryptoKit
import Foundation

/// Album-art file cache in the App Group container. APNs payloads can't carry
/// images and widget extensions can't fetch over the network, so the APP
/// downloads artwork on track change and the WIDGET reads it back by deriving
/// the same filename from the artwork URL in the pushed content state.
enum ArtworkCache {
    static var directory: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: DiscoveryConfig.appGroupId)?
            .appendingPathComponent("artwork", isDirectory: true)
    }

    /// Deterministic filename both sides agree on.
    static func filename(forArtworkUrl urlString: String) -> String {
        let digest = SHA256.hash(data: Data(urlString.utf8))
        return digest.map { String(format: "%02x", $0) }.joined() + ".img"
    }

    static func fileURL(forArtworkUrl urlString: String) -> URL? {
        directory?.appendingPathComponent(filename(forArtworkUrl: urlString))
    }

    /// Download-if-missing. Called by the app on every track change.
    /// Returns true only when it *newly* wrote the file, so the caller can
    /// nudge the Live Activity to re-read it (a pre-existing file already
    /// rendered, and failures fall back to the placeholder).
    @discardableResult
    static func ensureCached(artworkUrl urlString: String?) async -> Bool {
        guard let urlString, let remote = URL(string: urlString),
              let dir = directory,
              let target = fileURL(forArtworkUrl: urlString)
        else { return false }
        let fm = FileManager.default
        if fm.fileExists(atPath: target.path) { return false }
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let (data, response) = try await URLSession.shared.data(from: remote)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            try data.write(to: target, options: .atomic)
            return true
        } catch {
            // Artwork is cosmetic — the widget falls back to a placeholder.
            return false
        }
    }

    /// Drop files older than 24h; called on app launch.
    static func pruneOldFiles(maxAge: TimeInterval = 24 * 3600) {
        guard let dir = directory,
              let files = try? FileManager.default.contentsOfDirectory(
                  at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
        else { return }
        let cutoff = Date().addingTimeInterval(-maxAge)
        for file in files {
            let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate
            if let modified, modified < cutoff {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }
}
