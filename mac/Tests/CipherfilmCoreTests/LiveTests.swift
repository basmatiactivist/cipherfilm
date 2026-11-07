// Live updates: the stream's parser (however the bytes arrive), what each event means, merging pings, the backoff.
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct LiveTests {
  private let text = "retry: 3000\nevent: ready\ndata: {\"v\":1}\n\n:\n\nevent: changed\r\ndata: {\"v\":2,\r\ndata: \"what\":[\"items\",\"bogus\"]}\r\n\r\nevent: bye\ndata: {}\n\n"

  @Test func parsesEventsByteByByte() {
    var p = SSEParser()
    let got = p.feed(Array(text.utf8))
    #expect(got == [
      SSEvent(event: "ready", data: "{\"v\":1}"),
      SSEvent(event: ":", data: ""),
      SSEvent(event: "changed", data: "{\"v\":2,\n\"what\":[\"items\",\"bogus\"]}"),
      SSEvent(event: "bye", data: "{}"),
    ])
  }

  @Test func signals() {
    var p = SSEParser()
    let s = p.feed(Array(text.utf8)).compactMap(LiveSignal.init)
    #expect(s == [.ready(v: 1), .heartbeat, .changed(v: 2, what: [.items]), .bye])
    // a ping that names nothing known: everything loads
    #expect(LiveSignal(SSEvent(event: "changed", data: "{\"v\":3,\"what\":[]}")) == .changed(v: 3, what: Set(LiveTopic.allCases)))
    #expect(LiveSignal(SSEvent(event: "message", data: "x")) == nil)
  }

  @Test func batchMergesUntilTaken() {
    var b = LiveBatch()
    b.add([.items]); b.add([.albums, .items])
    #expect(b.take() == [.items, .albums])
    #expect(b.take().isEmpty)
  }

  @Test func backoffGrowsToAMinute() {
    #expect(liveBackoff(0, jitter: 1) == 1)
    #expect(liveBackoff(3, jitter: 1) == 8)
    #expect(liveBackoff(20, jitter: 1) == 60)
    #expect((0.8...1.2).contains(liveBackoff(0)))
  }
}
