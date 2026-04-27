import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mosaic.training',
  appName: 'Mosaic',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
