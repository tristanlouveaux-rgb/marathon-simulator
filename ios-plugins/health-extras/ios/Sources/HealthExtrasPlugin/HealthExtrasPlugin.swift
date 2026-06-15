import Foundation
import HealthKit
import CoreLocation
import Capacitor
import UIKit

/**
 * HealthExtrasPlugin — exposes HealthKit fields that @capgo/capacitor-health
 * doesn't surface: VO2max, running power (iOS 16+), cycling power & FTP
 * (iOS 17+), workout GPS routes (HKWorkoutRoute), running form metrics
 * (stride length, ground contact time, vertical oscillation, running speed),
 * wrist temperature (iOS 16+), and walking heart rate average.
 *
 * Designed as a thin reader — no caching, no aggregation. The TypeScript
 * layer in `src/data/appleHealthSync.ts` orchestrates how the data is
 * spliced into our shared activity row format.
 *
 * Permission strategy: a single `requestPermissions(read: [String])` call
 * presents the standard HealthKit modal. Identifiers must match the strings
 * in the `quantityType(for:)` switch below; pass `"workoutRoute"` to also
 * request the route series type.
 *
 * iOS version gating: any identifier added in iOS 16 or 17 is wrapped in
 * `#available` checks and silently dropped on older OSes (returns nil from
 * `quantityType(for:)`). The TS side filters its request list against
 * `Capacitor.platform === 'ios'` and the iOS version is checked here.
 */
@objc(HealthExtrasPlugin)
public class HealthExtrasPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthExtrasPlugin"
    public let jsName = "HealthExtras"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkAvailability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readQuantitySamples", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readLatestQuantity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readWorkoutRouteLocations", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startWorkoutObserver", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopWorkoutObserver", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addListener", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "removeAllListeners", returnType: CAPPluginReturnNone)
    ]

    private let healthStore = HKHealthStore()
    private var workoutObserverQuery: HKObserverQuery?
    private let workoutAnchorKey = "MosaicHealthExtras.workoutAnchor"
    private let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private let isoFormatterNoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    // MARK: - Public methods

    /// Returns which of the requested data types are usable on this OS version
    /// without prompting. Caller can hide UI for unavailable types.
    @objc public func checkAvailability(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["available": [], "unavailable": []])
            return
        }
        let identifiers = call.getArray("dataTypes", String.self) ?? []
        var available: [String] = []
        var unavailable: [String] = []
        for id in identifiers {
            if id == "workoutRoute" {
                available.append(id)
            } else if quantityType(for: id) != nil {
                available.append(id)
            } else {
                unavailable.append(id)
            }
        }
        call.resolve(["available": available, "unavailable": unavailable])
    }

    /// Open iOS Settings to Mosaic's app page. The only recovery path once the
    /// HealthKit permission sheet has been answered: iOS will not re-present the
    /// sheet via requestAuthorization, so a denied user must toggle access in
    /// Settings. (HealthKit toggles live under Privacy & Security → Health →
    /// Mosaic; the app page is the closest deep-link iOS exposes.)
    @objc public func openAppSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString),
                  UIApplication.shared.canOpenURL(url) else {
                call.resolve(["opened": false])
                return
            }
            UIApplication.shared.open(url, options: [:]) { success in
                call.resolve(["opened": success])
            }
        }
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("HealthKit is not available on this device")
            return
        }
        let identifiers = call.getArray("read", String.self) ?? []

        var readTypes: Set<HKObjectType> = []
        for id in identifiers {
            if id == "workoutRoute" {
                readTypes.insert(HKSeriesType.workoutRoute())
            } else if let qt = quantityType(for: id) {
                readTypes.insert(qt)
            }
        }
        guard !readTypes.isEmpty else {
            call.resolve(["granted": [], "denied": identifiers])
            return
        }

        healthStore.requestAuthorization(toShare: nil, read: readTypes) { [weak self] success, error in
            guard let self = self else { return }
            if let error = error {
                call.reject("HealthKit auth error: \(error.localizedDescription)")
                return
            }

            // HealthKit explicitly does not tell you which read permissions were granted
            // (Apple's privacy model). We approximate by scanning each requested type's
            // current authorization status; for read-only requests this returns
            // .notDetermined when the user has never been prompted, and
            // .sharingAuthorized/.sharingDenied after they responded. In practice the
            // status often stays .notDetermined for reads even after the prompt — in
            // which case we report the type as "granted" (best effort) since a
            // subsequent query will succeed if access was given and silently return
            // empty otherwise.
            var granted: [String] = []
            var denied: [String] = []
            for id in identifiers {
                let type: HKObjectType?
                if id == "workoutRoute" {
                    type = HKSeriesType.workoutRoute()
                } else {
                    type = self.quantityType(for: id)
                }
                guard let resolved = type else {
                    denied.append(id)
                    continue
                }
                let status = self.healthStore.authorizationStatus(for: resolved)
                if status == .sharingDenied {
                    denied.append(id)
                } else {
                    granted.append(id)
                }
            }
            call.resolve(["granted": granted, "denied": denied, "success": success])
        }
    }

    /// Generic quantity-sample reader. Returns ISO-8601 dates and numeric values
    /// in the type's default unit (see `defaultUnit(for:)`).
    @objc public func readQuantitySamples(_ call: CAPPluginCall) {
        guard let id = call.getString("dataType") else {
            call.reject("dataType is required")
            return
        }
        guard let type = quantityType(for: id) else {
            call.reject("Unknown or unavailable dataType for this iOS version: \(id)")
            return
        }
        let limit = call.getInt("limit") ?? HKObjectQueryNoLimit
        let ascending = call.getBool("ascending") ?? true

        let endDate = parseISO(call.getString("endDate")) ?? Date()
        let startDate = parseISO(call.getString("startDate")) ?? Calendar.current.date(byAdding: .day, value: -28, to: endDate)!

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
        let sortDesc = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: ascending)
        let unit = defaultUnit(for: id)
        let unitName = unitIdentifier(for: id)

        let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: limit, sortDescriptors: [sortDesc]) { [weak self] _, samples, error in
            guard let self = self else { return }
            if let error = error {
                call.reject("Query error: \(error.localizedDescription)")
                return
            }
            var out: [[String: Any]] = []
            for s in (samples ?? []) {
                guard let qs = s as? HKQuantitySample else { continue }
                let value = qs.quantity.doubleValue(for: unit)
                out.append([
                    "value": value,
                    "unit": unitName,
                    "startDate": self.isoFormatter.string(from: qs.startDate),
                    "endDate": self.isoFormatter.string(from: qs.endDate),
                    "sourceName": qs.sourceRevision.source.name
                ])
            }
            call.resolve(["samples": out])
        }
        healthStore.execute(query)
    }

    /// Convenience reader for "give me the most recent value of X" — used for
    /// VO2max, cycling FTP, walking HR average, where we typically only care
    /// about the latest reading rather than a time series.
    @objc public func readLatestQuantity(_ call: CAPPluginCall) {
        guard let id = call.getString("dataType") else {
            call.reject("dataType is required")
            return
        }
        guard let type = quantityType(for: id) else {
            call.reject("Unknown or unavailable dataType for this iOS version: \(id)")
            return
        }

        let predicate: NSPredicate?
        if let startStr = call.getString("startDate"), let start = parseISO(startStr) {
            let end = parseISO(call.getString("endDate")) ?? Date()
            predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        } else {
            predicate = nil
        }

        let sortDesc = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
        let unit = defaultUnit(for: id)
        let unitName = unitIdentifier(for: id)

        let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: 1, sortDescriptors: [sortDesc]) { [weak self] _, samples, error in
            guard let self = self else { return }
            if let error = error {
                call.reject("Query error: \(error.localizedDescription)")
                return
            }
            guard let qs = samples?.first as? HKQuantitySample else {
                call.resolve(["value": NSNull(), "asOf": NSNull()])
                return
            }
            call.resolve([
                "value": qs.quantity.doubleValue(for: unit),
                "unit": unitName,
                "asOf": self.isoFormatter.string(from: qs.startDate),
                "sourceName": qs.sourceRevision.source.name
            ])
        }
        healthStore.execute(query)
    }

    /// Read all GPS locations recorded for workouts that overlap [startDate,
    /// endDate]. Returns an array of locations with lat/lng/altitude/speed/
    /// timestamp. Caller is expected to bucket these by their workout's time
    /// window when re-attaching to activity rows.
    ///
    /// Two-stage query: first finds HKWorkoutRoute series samples in the
    /// window, then for each route runs an HKWorkoutRouteQuery to stream the
    /// CLLocation array. The route query delivers locations across multiple
    /// callbacks until `done == true`, which we accumulate.
    @objc public func readWorkoutRouteLocations(_ call: CAPPluginCall) {
        let endDate = parseISO(call.getString("endDate")) ?? Date()
        let startDate = parseISO(call.getString("startDate")) ?? Calendar.current.date(byAdding: .day, value: -28, to: endDate)!

        let routeType = HKSeriesType.workoutRoute()
        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
        let sortDesc = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

        let routeQuery = HKSampleQuery(sampleType: routeType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sortDesc]) { [weak self] _, samples, error in
            guard let self = self else { return }
            if let error = error {
                call.reject("Workout route query error: \(error.localizedDescription)")
                return
            }
            let routes = (samples ?? []).compactMap { $0 as? HKWorkoutRoute }
            if routes.isEmpty {
                call.resolve(["routes": []])
                return
            }
            self.collectRoutes(routes, accumulator: [], call: call)
        }
        healthStore.execute(routeQuery)
    }

    // MARK: - Route accumulation

    /// Recursively drains route queries one-at-a-time so the result array order
    /// matches the workout-start order from the first query. Each route may
    /// fire multiple delegate callbacks; we only resolve the per-route promise
    /// when `done == true`.
    private func collectRoutes(_ routes: [HKWorkoutRoute], accumulator: [[String: Any]], call: CAPPluginCall) {
        guard let first = routes.first else {
            call.resolve(["routes": accumulator])
            return
        }
        let rest = Array(routes.dropFirst())

        var locations: [[String: Any]] = []
        let routeQuery = HKWorkoutRouteQuery(route: first) { [weak self] _, locsBatch, done, error in
            guard let self = self else { return }
            if let error = error {
                CAPLog.print("HealthExtras: workout-route streaming error: \(error.localizedDescription)")
                // Skip this route; continue with the rest.
                self.collectRoutes(rest, accumulator: accumulator, call: call)
                return
            }
            if let batch = locsBatch {
                for loc in batch {
                    locations.append([
                        "lat": loc.coordinate.latitude,
                        "lng": loc.coordinate.longitude,
                        "altitude": loc.altitude,
                        "speed": loc.speed,
                        "course": loc.course,
                        "horizontalAccuracy": loc.horizontalAccuracy,
                        "verticalAccuracy": loc.verticalAccuracy,
                        "timestamp": self.isoFormatter.string(from: loc.timestamp)
                    ])
                }
            }
            if done {
                let entry: [String: Any] = [
                    "startDate": self.isoFormatter.string(from: first.startDate),
                    "endDate": self.isoFormatter.string(from: first.endDate),
                    "locations": locations
                ]
                self.collectRoutes(rest, accumulator: accumulator + [entry], call: call)
            }
        }
        healthStore.execute(routeQuery)
    }

    // MARK: - Workout observer (background delivery)

    /// Registers an HKObserverQuery for HKWorkoutType and enables background
    /// delivery. iOS wakes the app when any HKWorkout sample is written to
    /// HealthKit (by Apple Watch, Strava, Garmin Connect, etc.), the observer
    /// fires, and the plugin emits a `workoutDidArrive` event to JS.
    ///
    /// To avoid emitting an event for the entire workout history on first
    /// install, the very first call primes an HKQueryAnchor with the current
    /// state of HealthKit, then registers the observer. Subsequent fires use
    /// the saved anchor and only deliver genuinely new samples.
    ///
    /// Idempotent — if already running, returns success without re-registering.
    @objc public func startWorkoutObserver(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("HealthKit not available")
            return
        }

        if workoutObserverQuery != nil {
            call.resolve(["started": true, "alreadyRunning": true])
            return
        }

        let workoutType = HKObjectType.workoutType()

        if loadWorkoutAnchor() == nil {
            // First-ever start. Prime the anchor so the first real observer
            // fire doesn't dump every existing workout into the "new" bucket.
            // The existing syncAppleHealth() backfill already covers history.
            primeWorkoutAnchor(workoutType: workoutType) { [weak self] in
                guard let self = self else { return }
                self.registerWorkoutObserver(workoutType: workoutType)
                call.resolve(["started": true, "alreadyRunning": false, "primed": true])
            }
        } else {
            registerWorkoutObserver(workoutType: workoutType)
            call.resolve(["started": true, "alreadyRunning": false, "primed": false])
        }
    }

    @objc public func stopWorkoutObserver(_ call: CAPPluginCall) {
        if let observer = workoutObserverQuery {
            healthStore.stop(observer)
            workoutObserverQuery = nil
        }

        healthStore.disableBackgroundDelivery(for: HKObjectType.workoutType()) { _, _ in
            // Best effort — nothing to do on success or failure.
        }

        call.resolve(["stopped": true])
    }

    private func registerWorkoutObserver(workoutType: HKSampleType) {
        let observer = HKObserverQuery(sampleType: workoutType, predicate: nil) { [weak self] _, completionHandler, error in
            if let error = error {
                print("[HealthExtras] Observer error: \(error.localizedDescription)")
                completionHandler()
                return
            }
            self?.handleWorkoutObserverFire(workoutType: workoutType, completionHandler: completionHandler)
        }

        healthStore.execute(observer)
        workoutObserverQuery = observer

        healthStore.enableBackgroundDelivery(for: workoutType, frequency: .immediate) { success, error in
            if let error = error {
                print("[HealthExtras] enableBackgroundDelivery error: \(error.localizedDescription)")
            } else {
                print("[HealthExtras] Background delivery \(success ? "enabled" : "failed") for workouts")
            }
        }
    }

    /// Runs an anchored query against the saved anchor, persists the new
    /// anchor, and emits `workoutDidArrive` if any new samples arrived. The
    /// observer's `completionHandler` MUST be called before this function
    /// returns or iOS throttles future deliveries.
    private func handleWorkoutObserverFire(workoutType: HKSampleType, completionHandler: @escaping HKObserverQueryCompletionHandler) {
        let anchor = loadWorkoutAnchor()

        let anchored = HKAnchoredObjectQuery(
            type: workoutType,
            predicate: nil,
            anchor: anchor,
            limit: HKObjectQueryNoLimit
        ) { [weak self] _, newSamples, _, newAnchor, error in
            guard let self = self else {
                completionHandler()
                return
            }

            if let error = error {
                print("[HealthExtras] Anchored query error: \(error.localizedDescription)")
                completionHandler()
                return
            }

            if let newAnchor = newAnchor {
                self.saveWorkoutAnchor(newAnchor)
            }

            let count = newSamples?.count ?? 0
            if count > 0 {
                // notifyListeners must run on the main thread for Capacitor's
                // JS bridge. The anchored query callback runs on a background
                // queue.
                DispatchQueue.main.async {
                    self.notifyListeners("workoutDidArrive", data: ["count": count])
                }
            }

            completionHandler()
        }

        healthStore.execute(anchored)
    }

    private func primeWorkoutAnchor(workoutType: HKSampleType, completion: @escaping () -> Void) {
        let primer = HKAnchoredObjectQuery(
            type: workoutType,
            predicate: nil,
            anchor: nil,
            limit: HKObjectQueryNoLimit
        ) { [weak self] _, _, _, newAnchor, error in
            if let error = error {
                print("[HealthExtras] Anchor primer error: \(error.localizedDescription)")
            }
            if let newAnchor = newAnchor {
                self?.saveWorkoutAnchor(newAnchor)
            }
            completion()
        }
        healthStore.execute(primer)
    }

    private func loadWorkoutAnchor() -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: workoutAnchorKey) else { return nil }
        do {
            return try NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
        } catch {
            print("[HealthExtras] Failed to decode anchor: \(error.localizedDescription)")
            return nil
        }
    }

    private func saveWorkoutAnchor(_ anchor: HKQueryAnchor) {
        do {
            let data = try NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
            UserDefaults.standard.set(data, forKey: workoutAnchorKey)
        } catch {
            print("[HealthExtras] Failed to encode anchor: \(error.localizedDescription)")
        }
    }

    // MARK: - Date parsing

    private func parseISO(_ s: String?) -> Date? {
        guard let s = s, !s.isEmpty else { return nil }
        return isoFormatter.date(from: s) ?? isoFormatterNoFraction.date(from: s)
    }

    // MARK: - Type resolution

    /// Map our string identifier to a HealthKit quantity type. Returns nil for
    /// types that aren't available on this iOS version — caller should drop
    /// those from the request rather than failing the whole batch.
    private func quantityType(for identifier: String) -> HKQuantityType? {
        switch identifier {
        case "vo2Max":
            return HKQuantityType.quantityType(forIdentifier: .vo2Max)
        case "walkingHeartRateAverage":
            return HKQuantityType.quantityType(forIdentifier: .walkingHeartRateAverage)
        case "appleSleepingWristTemperature":
            if #available(iOS 16, *) {
                return HKQuantityType.quantityType(forIdentifier: .appleSleepingWristTemperature)
            }
            return nil
        case "runningPower":
            if #available(iOS 16, *) {
                return HKQuantityType.quantityType(forIdentifier: .runningPower)
            }
            return nil
        case "runningSpeed":
            if #available(iOS 16, *) {
                return HKQuantityType.quantityType(forIdentifier: .runningSpeed)
            }
            return nil
        case "runningStrideLength":
            if #available(iOS 16, *) {
                return HKQuantityType.quantityType(forIdentifier: .runningStrideLength)
            }
            return nil
        case "runningGroundContactTime":
            if #available(iOS 16, *) {
                return HKQuantityType.quantityType(forIdentifier: .runningGroundContactTime)
            }
            return nil
        case "runningVerticalOscillation":
            if #available(iOS 16, *) {
                return HKQuantityType.quantityType(forIdentifier: .runningVerticalOscillation)
            }
            return nil
        case "cyclingPower":
            if #available(iOS 17, *) {
                return HKQuantityType.quantityType(forIdentifier: .cyclingPower)
            }
            return nil
        case "cyclingCadence":
            if #available(iOS 17, *) {
                return HKQuantityType.quantityType(forIdentifier: .cyclingCadence)
            }
            return nil
        case "cyclingSpeed":
            if #available(iOS 17, *) {
                return HKQuantityType.quantityType(forIdentifier: .cyclingSpeed)
            }
            return nil
        case "cyclingFunctionalThresholdPower":
            if #available(iOS 17, *) {
                return HKQuantityType.quantityType(forIdentifier: .cyclingFunctionalThresholdPower)
            }
            return nil
        default:
            return nil
        }
    }

    /// Default HKUnit per identifier. Matches Apple's documented unit for each type.
    private func defaultUnit(for identifier: String) -> HKUnit {
        switch identifier {
        case "vo2Max":
            // mL/(kg·min) — Apple's standard VO2max unit. Constructed from mL/kg/min.
            return HKUnit(from: "ml/kg*min")
        case "walkingHeartRateAverage":
            return HKUnit.count().unitDivided(by: HKUnit.minute())
        case "appleSleepingWristTemperature":
            return HKUnit.degreeCelsius()
        case "runningPower", "cyclingPower", "cyclingFunctionalThresholdPower":
            // Watt unit. `HKUnit.watt()` is iOS 16+, but constructing from the
            // unit string works on all iOS versions (matches the app's iOS 15
            // minimum deployment, same approach as the vo2Max case above).
            return HKUnit(from: "W")
        case "runningSpeed", "cyclingSpeed":
            return HKUnit.meter().unitDivided(by: HKUnit.second())
        case "runningStrideLength":
            return HKUnit.meter()
        case "runningGroundContactTime":
            return HKUnit.secondUnit(with: .milli)
        case "runningVerticalOscillation":
            return HKUnit.meterUnit(with: .centi)
        case "cyclingCadence":
            // Revolutions per minute — HealthKit uses count/min as the canonical RPM unit.
            return HKUnit.count().unitDivided(by: HKUnit.minute())
        default:
            return HKUnit.count()
        }
    }

    /// String name for the unit, returned to JS so it can format consistently.
    private func unitIdentifier(for identifier: String) -> String {
        switch identifier {
        case "vo2Max":                                      return "ml/kg/min"
        case "walkingHeartRateAverage":                     return "bpm"
        case "appleSleepingWristTemperature":               return "celsius"
        case "runningPower", "cyclingPower",
             "cyclingFunctionalThresholdPower":              return "watt"
        case "runningSpeed", "cyclingSpeed":                return "m/s"
        case "runningStrideLength":                         return "meter"
        case "runningGroundContactTime":                    return "millisecond"
        case "runningVerticalOscillation":                  return "centimeter"
        case "cyclingCadence":                              return "rpm"
        default:                                            return "count"
        }
    }
}
