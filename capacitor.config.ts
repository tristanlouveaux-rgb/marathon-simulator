import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mosaic.training',
  appName: 'Mosaic',
  webDir: 'dist',
  ios: {
    // 'never' — body already handles safe-area insets via `env(safe-area-inset-*)`
    // padding and `viewport-fit=cover`. 'automatic' makes WKWebView's scrollView
    // ALSO inset for safe areas, producing a double inset at the top and a
    // visible content shift on the first scroll (read as "glitching at the top").
    // 'never' lets the CSS be the single source of truth.
    // NOTE: there is NO native rubber-band bounce on device — Capacitor hardcodes
    // scrollView.bounces = false (CAPBridgeViewController.swift). The top bounce
    // comes from the JS spring in src/ui/web-overscroll-bounce.ts on all platforms.
    contentInset: 'never',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
