// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MosaicHealthExtras",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "MosaicHealthExtras",
            targets: ["HealthExtrasPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "HealthExtrasPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/HealthExtrasPlugin",
            resources: [
                // ISSUE-237 — App-target Privacy Manifest. Plugin reads from
                // HealthKit only (declared via NSHealthShareUsageDescription
                // in the host app's Info.plist), no data collection beyond
                // what is surfaced to the host, no Required Reason API access.
                .process("PrivacyInfo.xcprivacy")
            ])
    ]
)
