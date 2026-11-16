// The storage and backup overview: decoding the server's answer (server/storage.go), tolerant of missing fields, and
// the wording (web/src/storage.ts).
import Foundation
import Testing
@testable import CipherfilmCore

@Suite struct StorageOverviewTests {
  typealias S = StorageOverview
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  let day: Int64 = 86400

  func account(_ json: String) throws -> S.Account { try JSONDecoder().decode(S.Account.self, from: Data(json.utf8)) }

  @Test func decodesTheServersAnswer() throws {
    let a = try account("""
    {"id":"u1","email":"a@x.org","role":"admin","status":"active","quota_bytes":10000000000,"unlimited":false,"used_bytes":2500000000,
     "item_count":12,"split":{"photos":2000000000,"videos":400000000,"other":0,"thumbs":90000000,"index":10000000},
     "devices":[{"id":"d1","device":"Pixel (Android app)","last_seen":1799990000,"last_upload_at":1799000000,"auto_backup":true,"backup_stale":true},
                {"id":"d2","device":"Mac","last_seen":1800000000,"last_upload_at":0,"auto_backup":false,"backup_stale":false,"current":true}]}
    """)
    #expect(a.email == "a@x.org" && a.quota_bytes == 10_000_000_000 && !a.unlimited && a.item_count == 12)
    #expect(a.split.thumbs == 90_000_000 && a.split.index == 10_000_000)
    #expect(a.devices.count == 2 && a.devices[0].backup_stale && !a.devices[0].current && a.devices[1].current)
    #expect(!a.devices_hidden)
  }

  @Test func missingFieldsAreEmpty() throws {
    let a = try account(#"{"id":"u1","email":"d@x.org","devices_hidden":true,"devices":[{"id":"d","device":"x"}]}"#)
    #expect(a.unlimited && a.used_bytes == 0 && a.split == S.Split() && a.devices_hidden)
    #expect(a.devices[0].last_upload_at == 0 && !a.devices[0].backup_stale && !a.devices[0].current)
    let s = try JSONDecoder().decode(S.Server.self, from: Data(#"{"accounts":[{"id":"u","used_bytes":5,"item_count":2}]}"#.utf8))
    #expect(s.used_bytes == 5 && s.item_count == 2 && s.stale_devices == 0 && s.disk_total_bytes == 0)
  }

  @Test func splitShowsOnlyWhatIsThere() {
    let p = S.parts(S.Split(photos: 700, videos: 0, other: 0, thumbs: 299, index: 1))
    #expect(p.map(\.key) == ["photos", "thumbs", "index"])
    #expect(p.map(\.pct) == [70, 30, 1])
    #expect(p.map(\.label) == ["Photos", "Thumbnails and previews", "Search index and settings"])
    #expect(S.parts(S.Split()).isEmpty)
  }

  @Test func fillAndUsed() throws {
    let limited = try account(#"{"quota_bytes":10000000000,"unlimited":false,"used_bytes":2500000000}"#)
    #expect(S.fill(limited) == 0.25)
    #expect(S.usedText(limited) == "2.5 GB of 10.0 GB")
    let over = try account(#"{"quota_bytes":1000000000,"unlimited":false,"used_bytes":3000000000}"#)
    #expect(S.fill(over) == 1)
    let free = try account(#"{"quota_bytes":0,"unlimited":true,"used_bytes":2500000000}"#)
    #expect(S.fill(free) == nil)
    #expect(S.usedText(free) == "2.5 GB used, no limit")
    #expect(S.items(1) == "1 item" && S.items(3) == "3 items")
  }

  @Test func lastUploadAndSeen() {
    let t = Int64(now.timeIntervalSince1970)
    func d(seen: Int64 = 0, upload: Int64, stale: Bool = false, current: Bool = false) -> S.Device {
      S.Device(id: "d", device: "", last_seen: seen, last_upload_at: upload, auto_backup: true, backup_stale: stale, current: current)
    }
    #expect(S.lastUpload(d(upload: 0), now: now) == "Last upload: none recorded yet")
    #expect(S.lastUpload(d(upload: t - 3600), now: now) == "Last upload today")
    #expect(S.lastUpload(d(upload: t - day - 5), now: now) == "Last upload yesterday")
    #expect(S.lastUpload(d(upload: t - 9 * day), now: now) == "Last upload 9 days ago")
    #expect(S.lastUpload(d(upload: t + 100), now: now) == "Last upload today")  // a clock ahead is not "-1 days"
    #expect(S.lastSeen(d(seen: t - 2 * day, upload: 0), now: now) == "Last seen 2 days ago")
    #expect(S.lastSeen(d(seen: t - 2 * day, upload: 0, current: true), now: now) == "Active now")
    #expect(S.daysSince(t - 10 * day + 1, now: now) == 9)
    #expect(S.stale(d(upload: t - 12 * day), now: now) == nil)
    #expect(S.stale(d(upload: t - 12 * day, stale: true), now: now)?.hasPrefix("No uploads for 12 days although this phone is in use. Automatic backup may be off or stuck") == true)
    #expect(d(upload: 0).name == "Unknown device")
  }

  @Test func serverSummary() throws {
    let s = try JSONDecoder().decode(S.Server.self, from: Data("""
    {"accounts":[{"id":"a","devices":[{"id":"x","backup_stale":true}]},{"id":"b"}],"used_bytes":12300000000,"item_count":812,"stale_devices":1,
     "disk_free_bytes":50000000000,"disk_total_bytes":100000000000}
    """.utf8))
    #expect(S.summary(s) == "2 people · 12.3 GB stored · 812 items")
    #expect(S.staleCount(s.accounts) == 1)
    #expect(S.staleSummary(s.stale_devices) == "1 phone seems to have stopped backing up. Details below.")
    #expect(S.staleSummary(0) == nil)
  }

  /** Numbers no server should send are shown oddly at worst, never end the app. */
  @Test func extremeNumbersDontTrap() throws {
    let max = Int64.max, min = Int64.min
    let a = try account(#"{"split":{"photos":\#(max),"videos":\#(max),"thumbs":\#(min)}}"#)
    #expect(S.parts(a.split).map(\.key) == ["photos", "videos"])
    let devices = [
      S.Device(id: "a", device: "", last_seen: min, last_upload_at: min), S.Device(id: "b", device: "", last_seen: max, last_upload_at: 5),
      S.Device(id: "c", device: "", last_seen: 1, last_upload_at: max), S.Device(id: "d", device: "", last_seen: min, last_upload_at: 0),
    ]
    #expect(S.fold(devices, open: false).shown.map(\.id) == ["b", "c", "d"]) // newest uploads first, then the rest
    let s = try JSONDecoder().decode(S.Server.self, from: Data(#"{"accounts":[{"used_bytes":\#(max),"item_count":\#(max)},{"used_bytes":\#(max),"item_count":1}]}"#.utf8))
    #expect(s.used_bytes == max && s.item_count == max)
    #expect(Admin.diskUsed(total: 100, free: min) == 100)
    #expect(Admin.diskUsed(total: 100, free: 30) == 70)
    #expect(Admin.diskUsed(total: 100, free: max) == 0)
    #expect(Saturating.sub(min, 1) == min && Saturating.add(max, 1) == max && Saturating.sum([max, max, min]) == -1)
  }
}
