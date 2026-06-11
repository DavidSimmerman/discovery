import Foundation

/// Shared constants for the app + widget extension.
enum DiscoveryConfig {
    /// The deployed discovery web app the wrapper loads and the API base for
    /// bearer-token requests (ratings from the widget intent, activity
    /// registration).
    static let baseURL = URL(string: "https://discovery.simmerman.tech")!

    /// App Group shared between app and widget extension — used for the
    /// artwork file cache the Live Activity reads.
    static let appGroupId = "group.tech.simmerman.discovery"

    /// Keychain account name for the device API token minted by the web layer.
    static let keychainService = "tech.simmerman.discovery"
    static let keychainTokenAccount = "device-api-token"
}
