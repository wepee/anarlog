import Combine
import Foundation

final class FloatingBarViewModel: ObservableObject {
  @Published var dictation: FloatingDictationPayload?
  @Published var amplitude: Double = 0
  @Published var status: FloatingBarStatus = .recording
  @Published var colorScheme: FloatingBarColorScheme = .dark
  @Published var isExpanded: Bool = false
  @Published var liveCaptionToggleVisible: Bool = false
  @Published var title: String = "Live transcript"
  @Published var transcriptBubbles: [FloatingTranscriptBubblePayload] = []
  @Published var transcriptNotice: String?
  @Published var placement: FloatingControlPlacement.Layout?
  @Published var sessionId: String?
  @Published var assist: FloatingAssistPayload?
  // The latest suggested answer, shown under the collapsed bar so it is read
  // without opening anything.
  @Published private(set) var peek: FloatingAssistPayload.Spotlight?

  private let peekDuration: TimeInterval
  private var hiddenPeekId: String?
  private var peekTimer: DispatchWorkItem?

  init(peekDuration: TimeInterval = 20) {
    self.peekDuration = peekDuration
  }

  // An answer shows once: after it timed out, was closed or was seen in the
  // open panel, it does not come back under the bar.
  func offerPeek(_ spotlight: FloatingAssistPayload.Spotlight?) {
    guard let spotlight, dictation == nil else {
      clearPeek()
      return
    }
    if isExpanded {
      hidePeek(spotlight.id)
      return
    }
    guard spotlight.id != hiddenPeekId, spotlight != peek else { return }
    peek = spotlight
    peekTimer?.cancel()
    let timer = DispatchWorkItem { [weak self] in self?.hidePeek(spotlight.id) }
    peekTimer = timer
    DispatchQueue.main.asyncAfter(deadline: .now() + peekDuration, execute: timer)
  }

  func hidePeek(_ id: String? = nil) {
    hiddenPeekId = id ?? peek?.id ?? hiddenPeekId
    clearPeek()
  }

  private func clearPeek() {
    peekTimer?.cancel()
    peekTimer = nil
    if peek != nil { peek = nil }
  }
}
