# iOS Setup

How to build and run Mosaic on iOS, and how the native audio/haptics plugin is structured.

## Prerequisites

- **macOS + Xcode 15 or later.** Check: `xcodebuild -version`.
- **CocoaPods is not required.** The iOS project uses Swift Package Manager. If you already have Pods installed, it is harmless.
- **Node + npm** (the repo root tools).
- An Apple ID signed in to Xcode if you plan to run on a physical device.

## First-time setup

```bash
npm install
npm run build               # tsc + vite build, outputs dist/
npx cap sync ios            # copies dist → ios/App/App/public, refreshes Package.swift
npx cap open ios            # opens Xcode on the App.xcworkspace equivalent
```

In Xcode:

1. Select the **App** target.
2. **Signing & Capabilities** → pick a Team.
3. Pick a device (simulator or a connected iPhone) and press Run.

If Xcode complains about "Failed to register bundle identifier", the signing team needs to own `com.mosaic.training`. Change `PRODUCT_BUNDLE_IDENTIFIER` to a unique dev-only ID and re-run.

## What `npx cap sync ios` does

- Copies the web bundle (`dist/`) into `ios/App/App/public/`.
- Regenerates `ios/App/App/capacitor.config.json` from root `capacitor.config.ts` and the installed plugin list.
- Regenerates `ios/App/CapApp-SPM/Package.swift` with the current plugin set.

Any manual edits to those two files are lost on the next sync. Config changes must flow through `capacitor.config.ts`, and plugin registration must flow through the npm plugin list.

## Known caveats

- **Silent switch.** The silent switch mutes all audio by default in WKWebView. The `GuidedVoice` plugin activates `AVAudioSession(.playback, …)` around each utterance, which overrides the silent switch. If a user reports "voice not audible", confirm the device isn't on Do Not Disturb and the app isn't running the browser fallback (which uses Web Speech and *is* silenced by the switch).
- **Background audio.** `UIBackgroundModes: audio` must stay in `ios/App/App/Info.plist`. Without it, the OS pauses `AVSpeechSynthesizer` when the screen locks.
- **Background location.** `UIBackgroundModes: location` is already set. The user must accept "Always" on the location permission prompt for the lock-screen run to keep tracking.
- **Music ducking.** `.duckOthers` only ducks apps that use `AVAudioSession.Category.ambient` or `.soloAmbient` and respect ducking. Spotify and Apple Music do. Some podcast apps won't — they'll continue at full volume.
- **Live Activity.** Not shipped (FUTURE-03).

## How to modify the `GuidedVoice` plugin

The plugin is a **local npm package** at `ios-plugins/guided-voice/`, wired into the root `package.json` as `@mosaic/guided-voice`. Editing the plugin does not require an npm publish — just edit and re-sync.

Layout:

```
ios-plugins/guided-voice/
├── package.json                              # name: @mosaic/guided-voice
├── Package.swift                             # SPM manifest, target name: GuidedVoicePlugin
├── dist/esm/                                 # Stub — JS side is inlined in src/guided/voice.ts
└── ios/
    └── Sources/
        └── GuidedVoicePlugin/
            └── GuidedVoicePlugin.swift       # AVSpeechSynthesizer + AVAudioSession wrapper
```

To change the audio session behaviour, edit `GuidedVoicePlugin.swift`. After edits:

```bash
npx cap sync ios            # re-resolves SPM, picks up new Swift code
```

Open Xcode and Cmd-B — no extra clean/derived-data step is usually needed.

## How the JS side connects

`src/guided/voice.ts` calls `registerPlugin<GuidedVoicePlugin>('GuidedVoice')` at module load. `speak()`/`cancel()` branch on `Capacitor.isNativePlatform()` — native routes through the plugin, browser falls back to Web Speech. Unit tests hit only `composePhrase` (pure), so plugin wiring doesn't affect the test suite.

`src/guided/haptics.ts` is similarly shaped: the `HapticAdapter` interface is preserved so tests can inject a mock. The default adapter is picked at runtime — `@capacitor/haptics` on native, `navigator.vibrate` in browsers.

## Remaining work (as of 2026-04-27)

The iOS platform scaffold is in place but several items remain before shipping on device:

1. **On-device verification.** Open Xcode, sign with a Team, build to a physical iPhone. Test: voice cues with silent switch on, lock screen mid-run, Spotify/Apple Music ducking. ISSUE-134 and ISSUE-136 are marked fixed pending this step.
2. **Wire keep-awake into Record tab.** `src/guided/keep-awake.ts` exports `enableScreenAwake()` / `disableScreenAwake()` but nothing calls them yet. They should be invoked in `startTracking` / `stopTracking` inside `src/ui/gps-events.ts` when a guided run is active (ISSUE-135 scope).
3. **Wire BackgroundGeolocation config.** `src/guided/background-location.ts` exports `GUIDED_RUN_LOCATION_CONFIG` but the Transistorsoft plugin has no call site in `src/` yet. Needs a `BackgroundGeolocation.ready(GUIDED_RUN_LOCATION_CONFIG)` call in the tracker bootstrap, with a web fallback to `navigator.geolocation`.
4. **Xcode Signing & Capabilities.** The `com.mosaic.training` bundle ID is set but no provisioning profile or Team is configured. First Xcode build requires selecting a development Team manually.
5. **App icon + launch screen.** Currently uses the Capacitor default placeholder assets in `ios/App/App/Assets.xcassets/`.

## Adding a new native capability

1. Install or create the Capacitor plugin (`npm i …` or `ios-plugins/<name>` + `npm i file:./…`).
2. `npx cap sync ios`. Verify the new plugin name appears in the "Found N Capacitor plugins" list.
3. Verify `packageClassList` in `ios/App/App/capacitor.config.json` now includes the new plugin class.
4. In TypeScript, use `registerPlugin<T>('YourPluginName')` with the `jsName` you declared in Swift.
5. Wrap every call behind `if (Capacitor.isNativePlatform())` and keep a browser fallback — tests and `vite dev` run in a browser context.
