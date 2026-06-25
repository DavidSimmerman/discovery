import CryptoKit
import Foundation
import os

private let log = Logger(subsystem: "tech.simmerman.discovery", category: "LiveActivity")

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
        guard let urlString, let remote = URL(string: urlString) else { return false }
        guard let dir = directory, let target = fileURL(forArtworkUrl: urlString) else {
            log.error("ArtworkCache: App Group container unavailable — enable the App Groups capability (group.tech.simmerman.discovery) on BOTH targets in the provisioning profile")
            return false
        }
        let fm = FileManager.default
        if fm.fileExists(atPath: target.path) {
            // Re-apply relaxed protection: anything cached before this shipped
            // still has the strict default and stays gray on the locked screen.
            try? fm.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: target.path)
            return true
        }
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            // Bounded so a stalled download can't block the activity from rendering.
            let (data, response) = try await URLSession.shared.data(
                for: URLRequest(url: remote, timeoutInterval: 8))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                log.error("ArtworkCache: fetch non-200 for \(remote, privacy: .public)")
                return false
            }
            // The Live Activity renders on the LOCKED lock screen; a file with the
            // default "complete" protection is unreadable there, so the widget
            // would show the gray placeholder. Album art is public/non-sensitive,
            // so relax protection enough for the locked widget to read it.
            try data.write(to: target, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return true
        } catch {
            log.error("ArtworkCache: fetch failed — \(error.localizedDescription, privacy: .public)")
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
