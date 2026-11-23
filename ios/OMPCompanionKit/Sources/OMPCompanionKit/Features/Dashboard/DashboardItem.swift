import SwiftUI

struct DashboardItem: Identifiable {
    let rowID: String
    let key: String
    let title: String
    let cwd: String
    let normCwd: String
    let folder: String
    let color: String
    let hiddenWs: Bool
    let isPanel: Bool
    let isWorking: Bool
    let needsReview: Bool
    let isReviewish: Bool
    let isUnseen: Bool
    let needsYou: Bool
    let isPinned: Bool
    let isArchived: Bool
    let updatedAt: String
    let sortTime: Double
    let status: SessionStatus?
    let taskText: String?
    let modelLabel: String?
    let branch: String?
    let isolated: Bool
    let forkTip: String?
    let overlaps: [String]
    let workDuration: String?
    let preview: String?
    let session: SessionSummary?
    let nativeSummary: NativeSessionSummary?

    var id: String { rowID }

    func withRowPrefix(_ prefix: String) -> DashboardItem {
        DashboardItem(
            rowID: "\(prefix):\(key)",
            key: key,
            title: title,
            cwd: cwd,
            normCwd: normCwd,
            folder: folder,
            color: color,
            hiddenWs: hiddenWs,
            isPanel: isPanel,
            isWorking: isWorking,
            needsReview: needsReview,
            isReviewish: isReviewish,
            isUnseen: isUnseen,
            needsYou: needsYou,
            isPinned: isPinned,
            isArchived: isArchived,
            updatedAt: updatedAt,
            sortTime: sortTime,
            status: status,
            taskText: taskText,
            modelLabel: modelLabel,
            branch: branch,
            isolated: isolated,
            forkTip: forkTip,
            overlaps: overlaps,
            workDuration: workDuration,
            preview: preview,
            session: session,
            nativeSummary: nativeSummary
        )
    }
}

struct ProjectGroup: Identifiable {
    let key: String
    let normKey: String
    let label: String
    let color: String
    let project: WorkspaceProject?
    let items: [DashboardItem]

    var id: String { normKey }
}

struct TimeGroup: Identifiable {
    let bucket: SidebarTimeBucket
    let items: [DashboardItem]

    var id: String { bucket.id }
}
