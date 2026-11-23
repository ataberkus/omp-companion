import SwiftUI

public enum DashboardSessionFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case active
    case inPanel
    case archived

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .all: return String(localized: "All", bundle: .main)
        case .active: return String(localized: "Active", bundle: .main)
        case .inPanel: return String(localized: "In panel", bundle: .main)
        case .archived: return String(localized: "Archived", bundle: .main)
        }
    }
}
