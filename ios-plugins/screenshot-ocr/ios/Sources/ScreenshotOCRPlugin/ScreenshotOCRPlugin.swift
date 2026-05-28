import Foundation
import Vision
import Capacitor
#if canImport(UIKit)
import UIKit
#endif

/**
 * ScreenshotOCRPlugin — on-device text recognition for run-summary screenshots.
 *
 * The first engine of the hybrid screenshot-import path (the AI-vision edge
 * function is the fallback). A user screenshots their Strava / Garmin / Nike
 * run summary; this plugin runs Apple's Vision framework (VNRecognizeTextRequest,
 * `.accurate`, on-device, free, private) and returns the recognised text as an
 * array of visual lines, top-to-bottom.
 *
 * Table reconstruction: Vision returns each cell of a splits table as its own
 * observation. To make a row like "1  5:30  7  131" parseable by the TS layer
 * (`parseScreenshotText` matches multi-column split rows), observations are
 * grouped into visual rows by their vertical position and joined left-to-right
 * with single spaces. One emitted line == one visual row.
 *
 * Thin reader — no parsing, no interpretation. The TS bridge in
 * `src/data/screenshotOcr.ts` feeds the lines into the verified parser core in
 * `src/data/screenshotImport.ts`.
 *
 * iOS-only. `usesLanguageCorrection` is off because the content is times and
 * numbers, not prose, and autocorrect mangles paces like "5:30".
 */
@objc(ScreenshotOCRPlugin)
public class ScreenshotOCRPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenshotOCRPlugin"
    public let jsName = "ScreenshotOCR"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recognizeText", returnType: CAPPluginReturnPromise)
    ]

    /// Vision text recognition needs iOS 13+. The app's deployment target is
    /// iOS 15, so this is always true in practice, but the check keeps the
    /// contract honest and mirrors the availability gating in HealthExtras.
    @objc public func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 13.0, *) {
            call.resolve(["available": true])
        } else {
            call.resolve(["available": false])
        }
    }

    /// Recognise text in a base64-encoded image. Accepts a raw base64 string or
    /// a `data:` URL (the prefix is stripped). Returns `{ lines: [String] }` in
    /// top-to-bottom reading order, with table cells joined into single rows.
    @objc public func recognizeText(_ call: CAPPluginCall) {
        guard #available(iOS 13.0, *) else {
            call.reject("On-device OCR requires iOS 13 or later")
            return
        }
        guard let b64 = call.getString("imageBase64") else {
            call.reject("imageBase64 is required")
            return
        }
        let cleaned = Self.stripDataUrlPrefix(b64)
        guard let data = Data(base64Encoded: cleaned, options: .ignoreUnknownCharacters),
              let image = UIImage(data: data),
              let cgImage = image.cgImage else {
            call.reject("Could not decode the supplied image")
            return
        }

        let request = VNRecognizeTextRequest { request, error in
            if let error = error {
                call.reject("Text recognition failed: \(error.localizedDescription)")
                return
            }
            let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
            let lines = Self.groupIntoRows(observations)
            call.resolve(["lines": lines])
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        // Vision is CPU-heavy; keep it off the main thread.
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try handler.perform([request])
            } catch {
                call.reject("Text recognition could not run: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Helpers

    /// Group recognised observations into visual rows and join each row's cells
    /// left-to-right. Vision's bounding-box coordinate space is normalised with
    /// the origin at the bottom-left and y increasing upward, so a larger midY
    /// means higher on the screen. Rows are emitted top-to-bottom.
    @available(iOS 13.0, *)
    private static func groupIntoRows(_ observations: [VNRecognizedTextObservation]) -> [String] {
        // Vertical tolerance for "same row", as a fraction of image height.
        // Tuned so a multi-column splits table row stays together without
        // pulling in the line above or below.
        let rowTolerance: CGFloat = 0.018

        var rows: [(y: CGFloat, items: [(x: CGFloat, text: String)])] = []
        for obs in observations {
            guard let text = obs.topCandidates(1).first?.string else { continue }
            let y = obs.boundingBox.midY
            let x = obs.boundingBox.minX
            if let idx = rows.firstIndex(where: { abs($0.y - y) < rowTolerance }) {
                rows[idx].items.append((x, text))
            } else {
                rows.append((y, [(x, text)]))
            }
        }

        rows.sort { $0.y > $1.y } // top-to-bottom
        return rows.map { row in
            row.items.sorted { $0.x < $1.x }.map { $0.text }.joined(separator: " ")
        }
    }

    /// Strip a leading `data:image/...;base64,` prefix if present.
    private static func stripDataUrlPrefix(_ s: String) -> String {
        if let range = s.range(of: ";base64,") {
            return String(s[range.upperBound...])
        }
        return s
    }
}
