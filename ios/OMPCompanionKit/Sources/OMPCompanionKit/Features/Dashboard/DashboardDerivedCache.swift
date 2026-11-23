import SwiftUI

/// Memoizes the dashboard's derived lists. Building them walks every panel and history session (the history can hold
/// thousands) and the body, headers, toolbar and filter chips read them several times per render, on every poll; rebuilding
/// each time made the app stutter and freeze. Keys compare the inputs (unchanged arrays compare by storage, so cheaply).
final class DashboardDerivedCache {
    struct ItemsKey: Equatable {
        let snapshot: StoreSnapshot
        let native: [NativeSessionSummary]
        let models: [ModelEntry]
        let unseen: Set<String>
        let selected: String?
        /// Work durations and relative times move with the clock.
        let tick: Int
    }

    struct ViewKey: Equatable {
        let itemsGeneration: Int
        let filter: DashboardSessionFilter
        let search: String
        let focus: String
        let groupOrder: [String]
    }

    /// Inputs of the history-only rows; panel streaming leaves them unchanged.
    struct NativeKey: Equatable {
        let native: [NativeSessionSummary]
        let projects: [WorkspaceProject]
        let archived: [String]
        let pinned: [String]
        let models: [ModelEntry]
        let matchedFiles: Set<String>
    }

    var itemsKey: ItemsKey?
    var items: [DashboardItem] = []
    var itemsGeneration = 0
    var filteredKey: ViewKey?
    var filtered: [DashboardItem] = []
    var groupsKey: ViewKey?
    var groups: [ProjectGroup] = []
    var nativeKey: NativeKey?
    var nativeItems: [DashboardItem] = []
}
