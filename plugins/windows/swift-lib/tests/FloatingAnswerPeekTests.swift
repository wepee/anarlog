import XCTest

@testable import swift_lib

final class FloatingAnswerPeekTests: XCTestCase {
  func testNewAnswerShowsUnderCollapsedBarOnceAndHidesItself() {
    let model = FloatingBarViewModel(peekDuration: 0.05)
    let answer = FloatingAssistPayload.Spotlight(
      id: "a1", question: "Vous facturez combien ?", answer: "490 € par audit.")

    model.offerPeek(answer)
    XCTAssertEqual(model.peek, answer)

    let hidden = expectation(description: "peek hides after its duration")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
      XCTAssertNil(model.peek)
      model.offerPeek(answer)
      XCTAssertNil(model.peek)

      let next = FloatingAssistPayload.Spotlight(
        id: "a2", question: "Et le délai ?", answer: "Deux semaines.")
      model.isExpanded = true
      model.offerPeek(next)
      XCTAssertNil(model.peek)
      model.isExpanded = false
      model.offerPeek(next)
      XCTAssertNil(model.peek)
      hidden.fulfill()
    }
    wait(for: [hidden], timeout: 2)
  }
}
