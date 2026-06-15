import Foundation
import Capacitor
import AuthenticationServices
import UIKit

/**
 * WebAuthPlugin — thin wrapper around `ASWebAuthenticationSession`, iOS's
 * purpose-built OAuth presentation. Used for Strava/Garmin connect.
 *
 * Why not @capacitor/browser (SFSafariViewController)? Two walls:
 *   1. SFSafariViewController refuses to follow an HTTP 302 whose Location is a
 *      custom scheme (mosaic://oauth) — it shows "Safari cannot open the page
 *      because the address is invalid".
 *   2. The Supabase edge gateway force-rewrites every response Content-Type to
 *      text/plain, so the JS-redirect HTML workaround renders as raw source.
 *
 * `ASWebAuthenticationSession` sidesteps both: you hand it the authorize URL and
 * a `callbackURLScheme` ("mosaic"); it monitors navigation (including 302
 * redirects), intercepts the FIRST URL whose scheme matches, cancels the load,
 * dismisses itself, and hands the full callback URL back to JS. No deep-link
 * round-trip, no appUrlOpen, no HTML page needed.
 *
 * One method: `start({ url, callbackScheme, prefersEphemeralWebBrowserSession? })`
 * resolves `{ url: "mosaic://oauth?strava=connected&..." }` or rejects with code
 * "cancelled" when the user dismisses the sheet.
 */
@objc(WebAuthPlugin)
public class WebAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WebAuthPlugin"
    public let jsName = "WebAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise)
    ]

    // Held for the lifetime of the session so ARC doesn't release them mid-flow.
    private var session: ASWebAuthenticationSession?
    private var contextProvider: WebAuthPresentationContextProvider?

    @objc func start(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("A valid 'url' is required")
            return
        }
        guard let scheme = call.getString("callbackScheme"), !scheme.isEmpty else {
            call.reject("A 'callbackScheme' is required")
            return
        }
        let prefersEphemeral = call.getBool("prefersEphemeralWebBrowserSession") ?? false

        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callbackURL, error in
                self?.session = nil
                self?.contextProvider = nil

                if let error = error {
                    let nsErr = error as NSError
                    if nsErr.domain == ASWebAuthenticationSessionErrorDomain
                        && nsErr.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        call.reject("User cancelled the sign-in", "cancelled")
                        return
                    }
                    call.reject(error.localizedDescription)
                    return
                }

                guard let callbackURL = callbackURL else {
                    call.reject("No callback URL returned")
                    return
                }
                call.resolve(["url": callbackURL.absoluteString])
            }

            let provider = WebAuthPresentationContextProvider(plugin: self)
            self.contextProvider = provider
            session.presentationContextProvider = provider
            if #available(iOS 13.0, *) {
                session.prefersEphemeralWebBrowserSession = prefersEphemeral
            }
            self.session = session
            session.start()
        }
    }
}

/// ASWebAuthenticationSession (iOS 13+) requires an anchor window to present
/// from. We return the host WKWebView's window; an empty UIWindow is a safe
/// fallback that never crashes.
final class WebAuthPresentationContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    weak var plugin: CAPPlugin?
    init(plugin: CAPPlugin) { self.plugin = plugin }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return plugin?.bridge?.viewController?.view.window ?? UIWindow()
    }
}
