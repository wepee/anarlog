import SwiftUI

// Background of the floating bar. The Live Assist panel uses the system
// Liquid Glass material where the SDK and the OS provide it (macOS 26+),
// and the existing translucent fill everywhere else.
struct FloatingBarSurface: ViewModifier {
  let shape: RoundedRectangle
  let fill: Color
  let usesGlass: Bool
  let glassTint: Color

  #if compiler(>=6.2)
    @ViewBuilder
    func body(content: Content) -> some View {
      if usesGlass {
        if #available(macOS 26.0, *) {
          content.glassEffect(.regular.tint(glassTint), in: shape)
        } else {
          content.background(shape.fill(fill))
        }
      } else {
        content.background(shape.fill(fill))
      }
    }
  #else
    func body(content: Content) -> some View {
      content.background(shape.fill(fill))
    }
  #endif
}

private enum FloatingAssistTab: Hashable {
  case questions
  case todo
  case summary
  case live
}

private enum FloatingAssistPeriod: Hashable {
  case recent
  case all
}

// The Live Assist content of the expanded floating bar on macOS. The webview
// overlay draws the same panel for Windows and Linux in
// apps/desktop/src/meeting-float/overlay/assist-panel.tsx.
struct FloatingAssistPanelView<Live: View>: View {
  let assist: FloatingAssistPayload
  let primary: Color
  let secondary: Color
  let isDark: Bool
  let onAction: (String, String?) -> Void
  let live: () -> Live

  init(
    assist: FloatingAssistPayload,
    primary: Color,
    secondary: Color,
    isDark: Bool,
    onAction: @escaping (String, String?) -> Void,
    @ViewBuilder live: @escaping () -> Live
  ) {
    self.assist = assist
    self.primary = primary
    self.secondary = secondary
    self.isDark = isDark
    self.onAction = onAction
    self.live = live
  }

  @State private var tab: FloatingAssistTab = .questions
  @State private var period: FloatingAssistPeriod = .recent

  private let amber = Color(red: 1, green: 0.82, blue: 0.48)
  private let green = Color(red: 0.55, green: 0.88, blue: 0.67)
  private let red = Color(red: 1, green: 0.27, blue: 0.36)

  var body: some View {
    VStack(spacing: 8) {
      header
        .padding(.horizontal, 12)
        .padding(.top, 12)
      Group {
        switch tab {
        case .questions: scrolling { questionsTab }
        case .todo: scrolling { todoTab }
        case .summary: scrolling { summaryTab }
        case .live: live()
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
    .foregroundStyle(primary)
    .onAppear(perform: markSeenIfNeeded)
    .onChange(of: assist.newQuestions) { _, _ in markSeenIfNeeded() }
    .onChange(of: tab) { _, _ in markSeenIfNeeded() }
  }

  private func markSeenIfNeeded() {
    if tab == .questions, assist.newQuestions > 0 {
      onAction("seenQuestions", nil)
    }
  }

  private var header: some View {
    VStack(spacing: 10) {
      HStack {
        Spacer(minLength: 0)
        templateMenu
      }
      HStack(spacing: 2) {
        tabButton(.questions, assist.labels.questions, count: assist.newQuestions)
        tabButton(.todo, assist.labels.todo)
        tabButton(.summary, assist.labels.summary)
        tabButton(.live, assist.labels.live)
      }
      .padding(3)
      .background(Capsule().fill(Color.black.opacity(isDark ? 0.18 : 0.07)))
    }
  }

  private var templateMenu: some View {
    Menu {
      Section(assist.labels.templateMenu) {
        ForEach(Array(assist.templates.enumerated()), id: \.offset) { _, option in
          Button {
            onAction("selectTemplate", option.id)
          } label: {
            if option.id == assist.template.id {
              Label(option.title, systemImage: "checkmark")
            } else {
              Text(option.title)
            }
          }
        }
      }
      Divider()
      Text(assist.labels.templateFooter)
    } label: {
      HStack(spacing: 4) {
        Text(assist.template.title)
        if assist.template.auto {
          Text("· \(assist.labels.auto)").foregroundStyle(secondary)
        }
        Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
      }
      .font(.system(size: 11.5, weight: .medium))
      .padding(.horizontal, 9)
      .padding(.vertical, 3)
      .background(Capsule().fill(primary.opacity(0.13)))
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
  }

  private func tabButton(_ value: FloatingAssistTab, _ title: String, count: Int = 0)
    -> some View
  {
    let selected = tab == value
    return Button {
      tab = value
    } label: {
      HStack(spacing: 4) {
        Text(title)
        if count > 0 {
          Text("\(count)").font(.system(size: 10.5, design: .monospaced)).opacity(0.75)
        }
      }
      .font(.system(size: 12.5, weight: .medium))
      .foregroundStyle(selected ? primary : secondary)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 6)
      .background(
        Capsule()
          .fill(selected ? Color.white.opacity(isDark ? 0.22 : 0.85) : Color.clear)
          .shadow(color: .black.opacity(selected ? 0.18 : 0), radius: 4, y: 2)
      )
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .animation(.easeOut(duration: 0.2), value: selected)
  }

  private func scrolling<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    ScrollView(.vertical, showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        content()
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 16)
      .padding(.bottom, 16)
    }
  }

  private func sectionTitle(_ text: String) -> some View {
    Text(text.uppercased())
      .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
      .tracking(0.8)
      .foregroundStyle(secondary)
      .padding(.top, 12)
      .padding(.bottom, 6)
  }

  private func emptyText(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 13))
      .foregroundStyle(secondary)
      .padding(.vertical, 8)
  }

  @ViewBuilder
  private var questionsTab: some View {
    if assist.questions.isEmpty {
      emptyText(assist.labels.emptyQuestions)
    } else {
      ForEach(Array(assist.questions.enumerated()), id: \.element.id) { index, question in
        if index > 0 {
          Divider().opacity(0.6)
        }
        questionRow(question)
      }
    }
    if !assist.coverage.isEmpty {
      sectionTitle("\(assist.labels.toCover) · \(assist.template.title)")
      LazyVGrid(
        columns: [GridItem(.adaptive(minimum: 96), spacing: 6, alignment: .leading)],
        alignment: .leading,
        spacing: 6
      ) {
        ForEach(Array(assist.coverage.enumerated()), id: \.offset) { _, point in
          coverageChip(point)
        }
      }
    }
  }

  private func questionRow(_ question: FloatingAssistPayload.Question) -> some View {
    HStack(alignment: .top, spacing: 6) {
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          if question.isNew {
            Circle().fill(amber).frame(width: 7, height: 7)
          }
          Text(question.text)
            .font(.system(size: 14.5, weight: .medium))
            .fixedSize(horizontal: false, vertical: true)
        }
        if !question.why.isEmpty {
          Text(question.why)
            .font(.system(size: 12.5))
            .foregroundStyle(secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
      Button {
        onAction("dismissQuestion", question.id)
      } label: {
        Image(systemName: "xmark")
          .font(.system(size: 9, weight: .bold))
          .frame(width: 22, height: 22)
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(secondary)
      .help(assist.labels.dismiss)
      .accessibilityLabel(assist.labels.dismiss)
    }
    .padding(.vertical, 10)
  }

  private func coverageChip(_ point: FloatingAssistPayload.Coverage) -> some View {
    HStack(spacing: 6) {
      coverageDot(point.status)
      Text(point.label)
        .font(.system(size: 12))
        .lineLimit(1)
    }
    .padding(.leading, 8)
    .padding(.trailing, 10)
    .padding(.vertical, 3)
    .background(Capsule().fill(primary.opacity(0.1)))
    .help(point.evidence ?? "")
  }

  @ViewBuilder
  private func coverageDot(_ status: String) -> some View {
    switch status {
    case "covered":
      Circle().fill(green).frame(width: 9, height: 9)
    case "partial":
      Circle()
        .strokeBorder(amber, lineWidth: 1.5)
        .background(
          Circle().trim(from: 0.25, to: 0.75).fill(amber).rotationEffect(.degrees(180))
        )
        .frame(width: 9, height: 9)
    default:
      Circle().strokeBorder(secondary, lineWidth: 1.5).frame(width: 9, height: 9)
    }
  }

  @ViewBuilder
  private var todoTab: some View {
    if assist.todoGroups.isEmpty {
      emptyText(assist.labels.emptyTodo)
    } else {
      ForEach(Array(assist.todoGroups.enumerated()), id: \.offset) { _, group in
        sectionTitle(group.owner)
        ForEach(Array(group.items.enumerated()), id: \.offset) { _, item in
          VStack(alignment: .leading, spacing: 2) {
            Text(item.text)
              .font(.system(size: 13.5))
              .fixedSize(horizontal: false, vertical: true)
            if item.due != nil || item.needsDetail {
              HStack(spacing: 8) {
                if let due = item.due {
                  Text("\(assist.labels.due) \(due)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(secondary)
                }
                if item.needsDetail {
                  Text(assist.labels.toClarify)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(amber)
                    .padding(.horizontal, 6)
                    .background(Capsule().fill(amber.opacity(0.2)))
                }
              }
            }
          }
          .padding(.bottom, 8)
        }
      }
    }
  }

  @ViewBuilder
  private var summaryTab: some View {
    HStack(spacing: 2) {
      periodButton(.recent, assist.labels.lastMinutes)
      periodButton(.all, assist.labels.sinceStart)
    }
    .padding(3)
    .background(Capsule().fill(Color.black.opacity(isDark ? 0.18 : 0.07)))
    .padding(.top, 4)
    .padding(.bottom, 10)

    if assist.recent.isEmpty && assist.topics.isEmpty {
      emptyText(assist.labels.emptySummary)
    } else if period == .recent {
      Text(assist.recent)
        .font(.system(size: 14.5))
        .lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
    } else {
      if !assist.decisions.isEmpty {
        sectionTitle(assist.labels.decisions)
        ForEach(Array(assist.decisions.enumerated()), id: \.offset) { _, decision in
          HStack(alignment: .top, spacing: 8) {
            Rectangle().fill(green).frame(width: 2)
            Text(decision)
              .font(.system(size: 13))
              .fixedSize(horizontal: false, vertical: true)
          }
          .padding(.bottom, 6)
        }
      }
      ForEach(Array(assist.topics.enumerated()), id: \.offset) { _, topic in
        HStack(alignment: .top, spacing: 10) {
          Text(topic.start ?? "")
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(secondary)
            .frame(width: 40, alignment: .leading)
          VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
              Text(topic.title).font(.system(size: 13, weight: .semibold))
              if topic.live {
                Circle().fill(red).frame(width: 6, height: 6)
              }
            }
            ForEach(Array(topic.bullets.enumerated()), id: \.offset) { _, bullet in
              Text("• \(bullet)")
                .font(.system(size: 12.5))
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
        .padding(.top, 10)
      }
    }
  }

  private func periodButton(_ value: FloatingAssistPeriod, _ title: String) -> some View {
    Button {
      period = value
    } label: {
      Text(title)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(period == value ? primary : secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(Capsule().fill(period == value ? Color.white.opacity(0.2) : Color.clear))
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
  }
}
