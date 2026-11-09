// Place names on the Mac read the same file as the web and Android apps (web/src/places/places-v1.bin) and give the
// same answers (the cases of web/src/places/places.test.ts).
import Foundation
import Testing
@testable import CipherfilmCore

private let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../..").standardized
private let places: Places = try! Places(contentsOf: repo.appendingPathComponent("web/src/places/places-v1.bin"))

@Suite struct PlacesTests {
  @Test func readsTheWholeFile() {
    #expect(places.count > 150_000)
    #expect(places.countries.first { $0.code == "CH" }?.name == "Switzerland")
  }

  @Test func findsTheNearestPlace() {
    #expect(places.nearest(47.3769, 8.5417)?.label == "Zürich, Switzerland")
    #expect(places.nearest(48.8584, 2.2945)?.label.hasSuffix(", France") == true) // the Eiffel Tower: Paris or a neighbour
    #expect(places.nearest(48.8566, 2.3522)?.place?.name == "Paris")
    #expect(places.nearest(40.7128, -74.006)?.label.hasSuffix("United States") == true)
    #expect(places.nearest(-33.8688, 151.2093)?.label.hasSuffix("Australia") == true)
    // across the antimeridian it still works
    #expect(places.nearest(-18.14, 178.44)?.countryCode == "FJ")
  }

  @Test func nothingAtSeaOrForBadCoordinates() {
    #expect(places.nearest(0, -30) == nil) // mid-Atlantic
    #expect(places.nearest(.nan, 1) == nil)
    #expect(places.nearest(91, 0) == nil)
    #expect(places.nearest(0, 181) == nil)
  }

  @Test func matchesWhatIsTypedWithOrWithoutAccents() {
    let zurich = places.nearest(47.3769, 8.5417)!.index
    #expect(zurich >= 0)
    #expect(places.match("zurich").places.contains(zurich))
    #expect(places.match("Zürich").places.contains(zurich))
    #expect(places.match("zür").places.contains(zurich))
    #expect(places.match("switzerland").countries.contains(places.countryOf(zurich)))
    #expect(places.match("ch").countries.contains(places.countryOf(zurich)))
    #expect(places.match("z").places.isEmpty)
  }

  @Test func searchWordsCarryTownRegionCountryAndCode() {
    let w = places.nearest(47.3769, 8.5417)!.words
    for s in ["Zürich", "zurich", "Switzerland", "switzerland", "CH", "ch"] { #expect(w.split(separator: " ").contains { $0 == s }, "\(s) in \(w)") }
    #expect(Places.fold("  Zürich ") == "zurich")
    #expect(Places.fold("Ōsaka") == "osaka")
  }

  @Test func itemLocationsAreOnlyRealCoordinates() {
    func item(_ g: GPS?, broken: Bool = false) -> Item {
      Item(id: String(repeating: "a", count: 32), kind: .image, size: 1, segmentCount: 1, createdAt: 0, hasThumb: true, hasPreview: true, favorite: false,
           trashedAt: nil, purgeAt: nil, meta: ItemMeta(name: "x.jpg", mime: "image/jpeg", size: 1, lastModified: 0, capture_ts: 0, gps: g), itemKey: nil, broken: broken)
    }
    #expect(item(GPS(lat: 47.4, lon: 8.5)).location == GPS(lat: 47.4, lon: 8.5))
    #expect(item(GPS(lat: 0, lon: 0)).location == nil)
    #expect(item(GPS(lat: 95, lon: 0)).location == nil)
    #expect(item(GPS(lat: 47.4, lon: 8.5), broken: true).location == nil)
    #expect(item(nil).location == nil)
  }

  @Test func readsTheServersMapStylesAndTheirHosts() throws {
    let j = #"{"light":["https://tiles.openfreemap.org/styles/positron","https://tiles.versatiles.org/assets/styles/muted/style.json"],"dark":["https://tiles.openfreemap.org/styles/dark","http://insecure.example/x","https://a;b.example/c"]}"#
    let s = try JSONDecoder().decode(Me.MapStyles.self, from: Data(j.utf8))
    #expect(s.light.count == 2)
    #expect(s.dark == ["https://tiles.openfreemap.org/styles/dark"]) // only https with a plain host name
    #expect(s.origins == ["https://tiles.openfreemap.org", "https://tiles.versatiles.org"])
  }

  @Test func fastEnoughForALibrary() {
    let t = Date()
    for i in 0..<10_000 { _ = places.nearest(-60 + Double(i % 120), -170 + Double((i * 7) % 340)) }
    #expect(Date().timeIntervalSince(t) < 1.5)
  }
}
