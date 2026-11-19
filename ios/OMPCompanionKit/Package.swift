// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OMPCompanionKit",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .library(
            name: "OMPCompanionKit",
            targets: ["OMPCompanionKit"]
        )
    ],
    targets: [
        .target(
            name: "OMPCompanionKit",
            path: "Sources/OMPCompanionKit"
        ),
        .testTarget(
            name: "OMPCompanionKitTests",
            dependencies: ["OMPCompanionKit"],
            path: "Tests/OMPCompanionKitTests"
        )
    ]
)
