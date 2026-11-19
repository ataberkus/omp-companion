import SwiftUI
import Charts

public struct SpendChartsView: View {
    @Environment(\.ompPalette) private var palette
    @Bindable var store: AppStore

    private enum SpendRange: String, CaseIterable, Identifiable {
        case sevenDays = "7D"
        case thirtyDays = "30D"
        case thisMonth = "Month"
        case allTime = "All"

        var id: String { rawValue }
    }

    private struct ParsedRow: Identifiable {
        let id: String
        let date: Date
        let dayStart: Date
        let model: String
        let cost: Double
    }

    private struct DailyModelPoint: Identifiable {
        let id: String
        let day: Date
        let modelGroup: String
        let cost: Double
    }

    private struct ModelTotal: Identifiable {
        var id: String { model }
        let model: String
        var today: Double = 0
        var month: Double = 0
        var rangeTotal: Double = 0
        var allTime: Double = 0
    }

    private struct DayBreakdown: Identifiable {
        var id: Date { day }
        let day: Date
        let total: Double
        let models: [(model: String, cost: Double)]
    }

    @State private var spendData: SpendResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var selectedRange: SpendRange = .thirtyDays
    @State private var pollTask: Task<Void, Never>?

    public init(store: AppStore) {
        self.store = store
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                statusBanners

                if isLoading && spendData == nil {
                    SkeletonListPlaceholder(count: 5)
                } else if let spendData, spendData.rows.isEmpty {
                    OMPEmptyStateView(
                        systemImage: "chart.bar.xaxis",
                        title: "No Usage Recorded Yet",
                        message: "Run OMP sessions to record token and cost rollups in stats.db, or tap Sync Stats to ingest recent transcripts.",
                        actionTitle: store.canPerformMutatingActions ? "Sync Usage Stats" : nil
                    ) {
                        Task { await loadSpend(sync: true) }
                    }
                    .ompCard(palette)
                } else if spendData != nil {
                    summaryCards
                    rangePicker
                    dailyChartCard
                    modelChartCard
                    modelBreakdownCard
                    dailyBreakdownCard
                }
            }
            .padding(12)
        }
        .background(palette.background)
        .navigationTitle("Spend & Usage")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await loadSpend(sync: true) }
                } label: {
                    if spendData?.syncing == true || isLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Sync", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(!store.canPerformMutatingActions || isLoading)
                .accessibilityLabel("Sync OMP usage stats")
            }
        }
        .refreshable {
            await loadSpend(sync: true)
        }
        .task {
            await loadSpend(sync: true)
        }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    // MARK: - Banners & Summary

    @ViewBuilder
    private var statusBanners: some View {
        if let err = errorMessage ?? spendData?.syncError, !err.isEmpty {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(palette.red)
                Text(errorMessage ?? "OMP usage stats did not sync: \(err)")
                    .font(.caption)
                    .foregroundStyle(palette.foreground)
                Spacer()
            }
            .padding(12)
            .background(palette.redSoft, in: RoundedRectangle(cornerRadius: 12))
        } else if spendData?.syncing == true {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Syncing new sessions into OMP's usage stats… Figures update automatically when finished.")
                    .font(.caption)
                    .foregroundStyle(palette.amber)
                Spacer()
            }
            .padding(12)
            .background(palette.amberSoft, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var summaryCards: some View {
        let totals = computeSummaryTotals()
        let monthTitle = Date().formatted(.dateTime.month(.abbreviated).year())
        return HStack(spacing: 10) {
            statCard(title: "Today", value: formatUSD(totals.today), tint: palette.accent)
            statCard(title: monthTitle, value: formatUSD(totals.month), tint: palette.green)
            statCard(title: "All Time", value: formatUSD(totals.allTime), tint: palette.violet)
        }
    }

    @ViewBuilder
    private func statCard(title: String, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(palette.muted)
                .lineLimit(1)
            Text(value)
                .font(.headline.monospacedDigit().weight(.bold))
                .foregroundStyle(tint)
                .minimumScaleFactor(0.75)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .ompCard(palette)
    }

    private var rangePicker: some View {
        Picker("Timeframe", selection: $selectedRange) {
            ForEach(SpendRange.allCases) { r in
                Text(r.rawValue).tag(r)
            }
        }
        .pickerStyle(.segmented)
    }

    // MARK: - Charts

    private var dailyChartCard: some View {
        let points = computeDailyPoints()
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Daily Spend by Model")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.foreground)
                Spacer()
                Text(formatUSD(points.reduce(0) { $0 + $1.cost }))
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(palette.accent)
            }

            if points.isEmpty {
                Text("No spend in this timeframe.")
                    .font(.caption)
                    .foregroundStyle(palette.muted)
                    .padding(.vertical, 20)
                    .frame(maxWidth: .infinity)
            } else {
                Chart(points) { pt in
                    BarMark(
                        x: .value("Day", pt.day, unit: .day),
                        y: .value("USD", pt.cost)
                    )
                    .foregroundStyle(by: .value("Model", pt.modelGroup))
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { val in
                        AxisGridLine()
                        AxisValueLabel {
                            if let d = val.as(Double.self) {
                                Text(formatCompactUSD(d))
                                    .font(.caption2.monospacedDigit())
                            }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 5)) { _ in
                        AxisGridLine()
                        AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                    }
                }
                .chartLegend(position: .bottom, alignment: .leading, spacing: 8)
                .frame(height: 210)
            }
        }
        .ompCard(palette)
    }

    private var modelChartCard: some View {
        let topModels = Array(computeModelTotals().filter { $0.rangeTotal > 0 }.prefix(8))
        let totalRange = max(0.000001, topModels.reduce(0) { $0 + $1.rangeTotal })

        return VStack(alignment: .leading, spacing: 10) {
            Text("Top Models (\(selectedRange.rawValue))")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.foreground)

            if topModels.isEmpty {
                Text("No model spend in this timeframe.")
                    .font(.caption)
                    .foregroundStyle(palette.muted)
            } else {
                Chart(topModels) { item in
                    BarMark(
                        x: .value("Cost", item.rangeTotal),
                        y: .value("Model", shortModelName(item.model))
                    )
                    .foregroundStyle(palette.accent.gradient)
                    .annotation(position: .trailing, alignment: .leading) {
                        let pct = Int(round((item.rangeTotal / totalRange) * 100))
                        Text("\(formatUSD(item.rangeTotal)) (\(pct)%)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(palette.muted)
                    }
                }
                .chartXAxis(.hidden)
                .frame(height: CGFloat(max(120, topModels.count * 34)))
            }
        }
        .ompCard(palette)
    }

    // MARK: - Tabular Breakdowns

    private var modelBreakdownCard: some View {
        let models = computeModelTotals().filter { $0.allTime > 0 }
        return VStack(alignment: .leading, spacing: 10) {
            Text("By Model")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.foreground)

            if models.isEmpty {
                Text("No usage recorded yet.")
                    .font(.caption)
                    .foregroundStyle(palette.muted)
            } else {
                ForEach(models) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.model)
                            .font(.caption.monospaced().weight(.semibold))
                            .foregroundStyle(palette.foreground)
                            .lineLimit(1)
                        HStack(spacing: 12) {
                            Text("Today: \(formatUSD(item.today))")
                            Text("Month: \(formatUSD(item.month))")
                            Spacer()
                            Text("All: \(formatUSD(item.allTime))")
                                .fontWeight(.semibold)
                                .foregroundStyle(palette.foreground)
                        }
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(palette.muted)
                    }
                    .padding(.vertical, 4)
                    if item.id != models.last?.id {
                        Divider().overlay(palette.border)
                    }
                }
            }
        }
        .ompCard(palette)
    }

    private var dailyBreakdownCard: some View {
        let days = computeDailyBreakdowns()
        return VStack(alignment: .leading, spacing: 10) {
            Text("Daily Log (\(selectedRange.rawValue))")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.foreground)

            if days.isEmpty {
                Text("No spend in this timeframe.")
                    .font(.caption)
                    .foregroundStyle(palette.muted)
            } else {
                ForEach(days.prefix(31)) { day in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(day.day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.foreground)
                            Spacer()
                            Text(formatUSD(day.total))
                                .font(.caption.monospacedDigit().weight(.bold))
                                .foregroundStyle(palette.green)
                        }
                        Text(day.models.map { "\(shortModelName($0.model)) \(formatUSD($0.cost))" }.joined(separator: " · "))
                            .font(.caption2.monospaced())
                            .foregroundStyle(palette.muted)
                            .lineLimit(3)
                    }
                    .padding(.vertical, 4)
                    if day.id != days.prefix(31).last?.id {
                        Divider().overlay(palette.border)
                    }
                }
            }
        }
        .ompCard(palette)
    }

    // MARK: - Aggregation & Data Loading

    private var parsedRows: [ParsedRow] {
        guard let rows = spendData?.rows else { return [] }
        let cal = Calendar.current
        return rows.compactMap { row in
            guard let date = Self.parseBucketDate(row.at) else { return nil }
            return ParsedRow(
                id: row.id,
                date: date,
                dayStart: cal.startOfDay(for: date),
                model: row.model,
                cost: row.cost
            )
        }
    }

    private func isInRange(_ date: Date, dayStart: Date) -> Bool {
        let cal = Calendar.current
        let todayStart = cal.startOfDay(for: Date())
        switch selectedRange {
        case .sevenDays:
            guard let start = cal.date(byAdding: .day, value: -6, to: todayStart) else { return true }
            return dayStart >= start
        case .thirtyDays:
            guard let start = cal.date(byAdding: .day, value: -29, to: todayStart) else { return true }
            return dayStart >= start
        case .thisMonth:
            return cal.isDate(dayStart, equalTo: todayStart, toGranularity: .month)
        case .allTime:
            return true
        }
    }

    private func computeSummaryTotals() -> (today: Double, month: Double, allTime: Double) {
        let cal = Calendar.current
        let now = Date()
        var today = 0.0
        var month = 0.0
        var all = 0.0
        for row in parsedRows {
            all += row.cost
            if cal.isDate(row.dayStart, equalTo: now, toGranularity: .month) {
                month += row.cost
            }
            if cal.isDateInToday(row.dayStart) {
                today += row.cost
            }
        }
        return (today, month, all)
    }

    private func computeModelTotals() -> [ModelTotal] {
        let cal = Calendar.current
        let now = Date()
        var map: [String: ModelTotal] = [:]
        for row in parsedRows {
            var entry = map[row.model] ?? ModelTotal(model: row.model)
            entry.allTime += row.cost
            if cal.isDate(row.dayStart, equalTo: now, toGranularity: .month) {
                entry.month += row.cost
            }
            if cal.isDateInToday(row.dayStart) {
                entry.today += row.cost
            }
            if isInRange(row.date, dayStart: row.dayStart) {
                entry.rangeTotal += row.cost
            }
            map[row.model] = entry
        }
        return map.values.sorted {
            if $0.rangeTotal != $1.rangeTotal { return $0.rangeTotal > $1.rangeTotal }
            return $0.allTime > $1.allTime
        }
    }

    private func computeDailyPoints() -> [DailyModelPoint] {
        let totals = computeModelTotals()
        let topNames = Set(totals.prefix(4).map { shortModelName($0.model) })
        var buckets: [Date: [String: Double]] = [:]

        for row in parsedRows where isInRange(row.date, dayStart: row.dayStart) {
            let short = shortModelName(row.model)
            let group = topNames.contains(short) ? short : "Other"
            buckets[row.dayStart, default: [:]][group, default: 0] += row.cost
        }

        var points: [DailyModelPoint] = []
        for day in buckets.keys.sorted() {
            for (group, cost) in buckets[day] ?? [:] where cost > 0 {
                points.append(DailyModelPoint(
                    id: "\(day.timeIntervalSince1970):\(group)",
                    day: day,
                    modelGroup: group,
                    cost: cost
                ))
            }
        }
        return points
    }

    private func computeDailyBreakdowns() -> [DayBreakdown] {
        var buckets: [Date: [String: Double]] = [:]
        for row in parsedRows where isInRange(row.date, dayStart: row.dayStart) {
            buckets[row.dayStart, default: [:]][row.model, default: 0] += row.cost
        }
        return buckets.keys.sorted(by: >).map { day in
            let modelMap = buckets[day] ?? [:]
            let sortedModels = modelMap
                .filter { $0.value > 0 }
                .sorted { $0.value > $1.value }
                .map { (model: $0.key, cost: $0.value) }
            let total = modelMap.values.reduce(0, +)
            return DayBreakdown(day: day, total: total, models: sortedModels)
        }
    }

    private func loadSpend(sync: Bool) async {
        guard let client = store.activeClient else { return }
        if spendData == nil { isLoading = true }
        defer { isLoading = false }
        do {
            let res = try await client.fetchSpend(sync: sync)
            spendData = res
            errorMessage = nil
            schedulePollIfSyncing(res.syncing)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func schedulePollIfSyncing(_ syncing: Bool) {
        pollTask?.cancel()
        pollTask = nil
        guard syncing else { return }
        pollTask = Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            await loadSpend(sync: false)
        }
    }

    private func shortModelName(_ full: String) -> String {
        full.split(separator: "/").last.map(String.init) ?? full
    }

    private func formatUSD(_ value: Double) -> String {
        if value > 0 && value < 1 {
            return String(format: "$%.4f", value)
        }
        return String(format: "$%.2f", value)
    }

    private func formatCompactUSD(_ value: Double) -> String {
        if value == 0 { return "$0" }
        if value < 1 { return String(format: "$%.2f", value) }
        return String(format: "$%.0f", value)
    }

    static func parseBucketDate(_ raw: String) -> Date? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }

        let isoFrac = ISO8601DateFormatter()
        isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = isoFrac.date(from: trimmed) { return d }

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: trimmed) { return d }

        let df1 = DateFormatter()
        df1.locale = Locale(identifier: "en_US_POSIX")
        df1.timeZone = TimeZone(secondsFromGMT: 0)
        df1.dateFormat = "yyyy-MM-dd HH:mm:ss"
        if let d = df1.date(from: trimmed) { return d }

        let df2 = DateFormatter()
        df2.locale = Locale(identifier: "en_US_POSIX")
        df2.timeZone = TimeZone(secondsFromGMT: 0)
        df2.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        if let d = df2.date(from: trimmed) { return d }

        let df3 = DateFormatter()
        df3.locale = Locale(identifier: "en_US_POSIX")
        df3.timeZone = TimeZone(secondsFromGMT: 0)
        df3.dateFormat = "yyyy-MM-dd"
        if let d = df3.date(from: trimmed) { return d }

        if let num = Double(trimmed) {
            return num > 10_000_000_000 ? Date(timeIntervalSince1970: num / 1000) : Date(timeIntervalSince1970: num)
        }
        return nil
    }
}
