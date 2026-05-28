// Native plugin — no JS runtime. The TS bridge in src/data/screenshotOcr.ts
// uses Capacitor.registerPlugin('ScreenshotOCR') which talks to the Swift
// implementation directly. This file exists so the package resolves cleanly
// at build time on web (where the plugin is a no-op).
export {};
