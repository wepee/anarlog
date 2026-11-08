import Foundation

enum FloatingBarStatus: String, Codable, Equatable {
  case recording
  case reconnecting
  case error
}

enum FloatingBarColorScheme: String, Codable, Equatable {
  case light
  case dark
}

struct FloatingTranscriptBubblePayload: Codable, Identifiable, Equatable {
  let id: String
  let speakerLabel: String
  let text: String
  let isSelf: Bool
  let isFinal: Bool
  let startMs: Double
  let endMs: Double
  let overlapsPrevious: Bool
  let overlapsNext: Bool
}

struct FloatingDictationPayload: Codable, Equatable {
  let sessionId: String
  let phase: String
  let microphone: String
  let text: String
  let partial: String
  let previewEnabled: Bool
  let previewUnavailable: Bool
}

struct FloatingBarStatePayload: Codable {
  let dictation: FloatingDictationPayload?
  let amplitude: Double
  let title: String
  let status: FloatingBarStatus
  let colorScheme: FloatingBarColorScheme
  let opacity: Double
  let liveCaptionOpacity: Double
  let liveCaptionWidth: Double
  let liveCaptionLineCount: Int
  let liveCaptionPosition: LiveCaptionPosition
  let liveCaptionMinimized: Bool
  let liveCaptionToggleVisible: Bool
  let transcriptBubbles: [FloatingTranscriptBubblePayload]?
  var transcriptNotice: String? = nil
  var sessionId: String? = nil
  var assistJson: String? = nil

  var assist: FloatingAssistPayload? {
    guard dictation == nil, let data = assistJson?.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(FloatingAssistPayload.self, from: data)
  }
}

// Mirrors `FloatingAssist` in apps/desktop/src/meeting-float/assist.ts.
struct FloatingAssistPayload: Codable, Equatable {
  struct Labels: Codable, Equatable {
    let questions, todo, summary, live: String
    let lastMinutes, sinceStart, toCover, decisions: String
    let due, toClarify, dismiss, templateMenu, templateFooter, auto: String
    let emptyQuestions, emptyTodo, emptySummary: String
    let answers, askPlaceholder, answering, noAnswer, emptyAnswers, youAsked: String
    let projectMenu, projectFooter, suggestedAnswer: String
  }

  struct Spotlight: Codable, Equatable {
    let id: String
    let question: String
    let answer: String
  }

  struct Template: Codable, Equatable {
    let id: String?
    let title: String
    let auto: Bool
  }

  struct TemplateOption: Codable, Equatable {
    let id: String?
    let title: String
  }

  struct Project: Codable, Equatable {
    let title: String
  }

  struct ProjectOption: Codable, Equatable {
    // nil for Auto: the projects command finds the project.
    let id: String?
    let title: String
    let selected: Bool
  }

  struct Question: Codable, Equatable, Identifiable {
    let id: String
    let text: String
    let why: String
    let isNew: Bool
  }

  struct Coverage: Codable, Equatable {
    let label: String
    let status: String
    let evidence: String?
  }

  struct AnswerSource: Codable, Equatable {
    // "web" or "project"
    let kind: String
    let label: String
    let url: String?
  }

  struct Answer: Codable, Equatable, Identifiable {
    let id: String
    let question: String
    let origin: String
    let status: String
    let answer: String
    let sources: [AnswerSource]
    let isNew: Bool
  }

  struct TodoItem: Codable, Equatable {
    let text: String
    let due: String?
    let needsDetail: Bool
  }

  struct TodoGroup: Codable, Equatable {
    let owner: String
    let items: [TodoItem]
  }

  struct Topic: Codable, Equatable {
    let start: String?
    let title: String
    let live: Bool
    let bullets: [String]
  }

  let labels: Labels
  let notice: String?
  let spotlight: Spotlight?
  let template: Template
  let templates: [TemplateOption]
  let project: Project?
  let projectOptions: [ProjectOption]
  let questions: [Question]
  let coverage: [Coverage]
  let todoGroups: [TodoGroup]
  let recent: String
  let decisions: [String]
  let topics: [Topic]
  let newQuestions: Int
  let answers: [Answer]
  let newAnswers: Int
}
