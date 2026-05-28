// Native plugin — no JS runtime. The TS bridge in src/data/healthExtras.ts
// uses Capacitor.registerPlugin('HealthExtras') which talks to the Swift
// implementation directly. This file exists so the package resolves cleanly
// at build time on web (where the plugin is a no-op).
export {};
