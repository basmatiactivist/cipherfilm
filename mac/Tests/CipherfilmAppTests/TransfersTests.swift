// The status card's amounts and speeds (Transfers.swift).
import Foundation
import Testing
@testable import Cipherfilm

@MainActor @Suite struct TransfersTests {
  @Test func theSpeedIsTheBytesOverTheLastSeconds() {
    let s = SpeedSampler()
    let t0 = Date(timeIntervalSince1970: 1000)
    #expect(s.rate(0, now: t0) == 0)
    #expect(s.rate(1_000_000, now: t0.addingTimeInterval(1)) == 1_000_000)
    for i in 2...10 { _ = s.rate(Int64(i) * 1_000_000, now: t0.addingTimeInterval(Double(i))) }
    // steady 1 MB/s: still 1 MB/s with old samples dropped
    #expect(abs(s.rate(11_000_000, now: t0.addingTimeInterval(11)) - 1_000_000) < 1)
    // a stall shows as a falling rate, not the old one
    #expect(s.rate(11_000_000, now: t0.addingTimeInterval(16)) < 500_000)
  }

  @Test func aNewPassStartsTheSpeedOver() {
    let s = SpeedSampler()
    let t0 = Date(timeIntervalSince1970: 1000)
    _ = s.rate(50_000_000, now: t0)
    _ = s.rate(60_000_000, now: t0.addingTimeInterval(1))
    #expect(s.rate(0, now: t0.addingTimeInterval(2)) == 0)
  }

  @Test func theAmountReadsDoneOfTotalAndSpeed() {
    let a = amount(500_000_000, of: 2_000_000_000, speed: 8_000_000)
    #expect(a.contains(" of ") && a.hasSuffix("/s"))
    #expect(!amount(1, of: 2, speed: 0).contains("/s"))
  }

  @Test func theUploadQueueCountsItsBytes() {
    let m = AppModel.shared
    let saved = m.uploads
    defer { m.uploads = saved }
    m.uploads = [UploadJob(url: URL(fileURLWithPath: "/a.jpg"), done: 0, total: 100, state: .done),
                 UploadJob(url: URL(fileURLWithPath: "/b.jpg"), done: 30, total: 200, state: .running),
                 UploadJob(url: URL(fileURLWithPath: "/c.jpg"), total: 300)]
    #expect(m.uploadBytes.done == 130)
    #expect(m.uploadBytes.total == 600)
  }
}
