import Foundation
import AVFoundation
import Capacitor

/**
 * GuidedVoice — native voice + audio-session wrapper for guided runs.
 *
 * Wraps AVSpeechSynthesizer. Before each utterance the audio session is
 * activated with category .playback and option .duckOthers so:
 *   - Speech plays over the silent switch (.playback overrides the mute toggle).
 *   - Background music (Spotify / Apple Music) ducks while the voice speaks.
 * The session is deactivated once speech finishes (via delegate) so music
 * volume returns to full.
 *
 * Exposed JS API (see src/guided/native-voice.ts):
 *   speak({ text: string, rate: number }) -> Promise<void>
 *   cancel() -> Promise<void>
 */
@objc(GuidedVoicePlugin)
public class GuidedVoicePlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "GuidedVoicePlugin"
    public let jsName = "GuidedVoice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private let synthesizer = AVSpeechSynthesizer()
    private var sessionActive = false

    override public func load() {
        synthesizer.delegate = self
    }

    @objc public func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else {
            call.reject("text is required")
            return
        }
        let rate = Float(call.getDouble("rate") ?? 1.0)

        activateAudioSession()

        let utterance = AVSpeechUtterance(string: text)
        // AVSpeechUtteranceDefaultSpeechRate ≈ 0.5. Scale around it so JS rate=1.0 feels normal.
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * max(0.8, min(1.4, rate))
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
            ?? AVSpeechSynthesisVoice(language: "en-US")

        synthesizer.speak(utterance)
        call.resolve()
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        synthesizer.stopSpeaking(at: .immediate)
        deactivateAudioSession()
        call.resolve()
    }

    // MARK: - AVSpeechSynthesizerDelegate

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        if !synthesizer.isSpeaking {
            deactivateAudioSession()
        }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        if !synthesizer.isSpeaking {
            deactivateAudioSession()
        }
    }

    // MARK: - Audio session

    private func activateAudioSession() {
        if sessionActive { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .mixWithOthers])
            try session.setActive(true, options: [])
            sessionActive = true
        } catch {
            CAPLog.print("GuidedVoice: failed to activate audio session: \(error)")
        }
    }

    private func deactivateAudioSession() {
        if !sessionActive { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setActive(false, options: [.notifyOthersOnDeactivation])
            sessionActive = false
        } catch {
            CAPLog.print("GuidedVoice: failed to deactivate audio session: \(error)")
        }
    }
}
