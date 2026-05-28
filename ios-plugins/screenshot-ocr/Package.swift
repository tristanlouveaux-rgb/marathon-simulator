// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MosaicScreenshotOCR",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "MosaicScreenshotOCR",
            targets: ["ScreenshotOCRPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "ScreenshotOCRPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/ScreenshotOCRPlugin",
            resources: [
                // App-target Privacy Manifest. The plugin reads a base64 image
                // handed to it by the app, runs on-device Vision OCR, and
                // returns text. No data collection, no network, no Required
                // Reason API access.
                .process("PrivacyInfo.xcprivacy")
            ])
    ]
)
