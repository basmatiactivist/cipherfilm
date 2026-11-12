// swift-tools-version: 6.2
// Cipherfilm for macOS. CipherfilmCore holds everything that must match the other clients byte for byte (crypto,
// API, search index, vision); Cipherfilm is the SwiftUI app. Run scripts/fetch-onnxruntime.sh once before building.
import PackageDescription

let package = Package(
  name: "Cipherfilm",
  platforms: [.macOS(.v15)],
  products: [
    .library(name: "CipherfilmCore", targets: ["CipherfilmCore"]),
    .executable(name: "Cipherfilm", targets: ["Cipherfilm"]),
  ],
  dependencies: [
    .package(url: "https://github.com/jedisct1/swift-sodium.git", exact: "0.11.0"),
  ],
  targets: [
    .binaryTarget(name: "onnxruntime", path: "Vendor/onnxruntime.xcframework"),
    .target(
      name: "CipherfilmCore",
      dependencies: [.product(name: "Clibsodium", package: "swift-sodium"), "onnxruntime"],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
    .executableTarget(
      name: "Cipherfilm",
      dependencies: ["CipherfilmCore"],
      exclude: ["Info.plist", "Cipherfilm.entitlements", "Resources"],
      swiftSettings: [.swiftLanguageMode(.v6)],
      linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
    ),
    .testTarget(
      name: "CipherfilmCoreTests",
      dependencies: ["CipherfilmCore"]
    ),
    // the app's own logic that holds decrypted state (what a lock must let go of)
    .testTarget(
      name: "CipherfilmAppTests",
      dependencies: ["Cipherfilm", "CipherfilmCore"],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
  ]
)
