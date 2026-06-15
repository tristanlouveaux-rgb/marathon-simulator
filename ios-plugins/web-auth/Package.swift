// swift-tools-version: 5.9
import PackageDescription

// NOTE: the package + library name MUST match Capacitor's PascalCase derivation
// of the npm name `@mosaic/web-auth` → `MosaicWebAuth` (each hyphen segment gets
// only its first letter capitalised: web→Web, auth→Auth). A mismatch here is a
// latent archive blocker that only surfaces on the next `cap sync` — see the
// screenshot-ocr (OCR→Ocr) incident.
let package = Package(
    name: "MosaicWebAuth",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "MosaicWebAuth",
            targets: ["WebAuthPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "WebAuthPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/WebAuthPlugin")
    ]
)
