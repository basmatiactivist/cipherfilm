import Testing
@testable import CipherfilmCore

@Suite struct MapHostsTests {
  @Test func onlyTheExactDefaultIsOpenFreeMap() {
    #expect(Me.MapStyles(light: Me.MapStyles.defaultLight, dark: Me.MapStyles.defaultDark).provider == "OpenFreeMap")
    let mixed = Me.MapStyles(light: Me.MapStyles.defaultLight, dark: ["https://dark.example.org/s.json"])
    #expect(mixed.provider == "tiles.openfreemap.org, tiles.versatiles.org, dark.example.org")
  }

  @Test func namesEveryHostOnce() {
    let own = Me.MapStyles(light: ["https://maps.example.org/l.json"], dark: ["https://Other.example.net:8443/d.json", "https://maps.example.org/d.json"])
    #expect(own.hosts == ["maps.example.org", "other.example.net:8443"])
  }
}
