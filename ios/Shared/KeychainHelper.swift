import Foundation
import Security

/// Minimal Keychain wrapper for the device API token. The token is minted by
/// the web layer (cookie session) and handed over via the JS bridge; the app
/// and the widget's RateTrackIntent (which runs in the app process) read it
/// to authenticate `Authorization: Bearer` API calls.
enum KeychainHelper {
    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: DiscoveryConfig.keychainService,
            kSecAttrAccount as String: DiscoveryConfig.keychainTokenAccount,
        ]
    }

    static func saveToken(_ token: String) {
        let data = Data(token.utf8)
        var query = baseQuery
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        // Available after first unlock so background pushes / intents work.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(query as CFDictionary, nil)
    }

    static func readToken() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func deleteToken() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}
