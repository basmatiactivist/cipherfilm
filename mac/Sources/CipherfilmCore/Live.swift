// Live updates: the server tells this Mac (GET /api/events, Server-Sent Events) when something in the account changed on
// another device, and the app loads again what changed, within a second or two instead of at its next refresh. A
// ping says only which lists changed (never what is in them); the lists come through the usual API.
import Foundation

public enum LiveTopic: String, Sendable, CaseIterable {
  case items, trash, albums, people, index
  /** a notice for this account's devices (a new sign-in; server/notices.go) */
  case notices
}

/** One event of the stream; a heartbeat (a comment line) has the name ":". */
public struct SSEvent: Equatable, Sendable {
  public let event: String
  public let data: String
  public init(event: String, data: String) { self.event = event; self.data = data }
}

/** Splits the stream into events, byte by byte as they arrive (URLSession's line sequence drops the empty lines that
 *  end an event). A line or an event longer than `limit` bytes sets `overflowed`, drops what was read and reads no more:
 *  the pings are tiny, so the stream is not one to keep reading. */
public struct SSEParser: Sendable {
  public static let defaultLimit = 1 << 20
  private let limit: Int
  private var line: [UInt8] = []
  private var event = ""
  private var data: [String] = []
  private var dataBytes = 0
  private var comment = false
  private var lastCR = false
  public private(set) var overflowed = false

  public init(limit: Int = SSEParser.defaultLimit) { self.limit = limit }

  public mutating func feed(_ b: UInt8) -> SSEvent? {
    if overflowed { return nil }
    if b == 0x0A && lastCR { lastCR = false; return nil } // the "\n" of a "\r\n"
    lastCR = b == 0x0D
    guard b == 0x0A || b == 0x0D else {
      guard line.count < limit else { overflow(); return nil }
      line.append(b); return nil
    }
    let text = String(decoding: line, as: UTF8.self)
    line.removeAll(keepingCapacity: true)
    if text.isEmpty {
      defer { event = ""; data = []; dataBytes = 0; comment = false }
      if !data.isEmpty || !event.isEmpty { return SSEvent(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n")) }
      return comment ? SSEvent(event: ":", data: "") : nil
    }
    if text.hasPrefix(":") { comment = true; return nil }
    let parts = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    var value = parts.count > 1 ? String(parts[1]) : ""
    if value.hasPrefix(" ") { value.removeFirst() }
    switch parts[0] {
    case "event": event = value
    case "data":
      dataBytes += value.utf8.count + 1
      guard dataBytes <= limit else { overflow(); return nil }
      data.append(value)
    default: break
    }
    return nil
  }

  private mutating func overflow() {
    overflowed = true
    line = []; event = ""; data = []; dataBytes = 0; comment = false
  }

  public mutating func feed<S: Sequence>(_ bytes: S) -> [SSEvent] where S.Element == UInt8 {
    bytes.compactMap { feed($0) }
  }
}

/** What an event means for the app. */
public enum LiveSignal: Equatable, Sendable {
  /** the stream is open; v: the account's counter (a different one after a gap means something changed meanwhile) */
  case ready(v: Int?)
  case changed(v: Int?, what: Set<LiveTopic>)
  /** the session ended: the stream closes, and the next request tells the app */
  case bye
  case heartbeat

  public init?(_ e: SSEvent) {
    let obj = (try? JSONSerialization.jsonObject(with: Data(e.data.utf8))) as? [String: Any]
    let v = obj?["v"] as? Int
    switch e.event {
    case "ready": self = .ready(v: v)
    case "changed":
      let names = (obj?["what"] as? [String] ?? []).compactMap(LiveTopic.init(rawValue:))
      self = .changed(v: v, what: names.isEmpty ? Set(LiveTopic.allCases) : Set(names))
    case "bye": self = .bye
    case ":": self = .heartbeat
    default: return nil
    }
  }
}

/** Merges the topics of pings that come close together, so a burst (an import on the phone) is loaded once. Not
 *  thread-safe: used from one actor. */
public struct LiveBatch: Sendable {
  public private(set) var pending: Set<LiveTopic> = []
  public init() {}
  public mutating func add(_ t: Set<LiveTopic>) { pending.formUnion(t) }
  public mutating func take() -> Set<LiveTopic> { defer { pending = [] }; return pending }
}

/** How long to wait before reconnecting after `tries` failures in a row: 1, 2, 4 … 60 seconds, ± 20 %. */
public func liveBackoff(_ tries: Int, jitter: Double = Double.random(in: 0.8...1.2)) -> TimeInterval {
  min(60, pow(2, Double(min(tries, 6)))) * jitter
}
