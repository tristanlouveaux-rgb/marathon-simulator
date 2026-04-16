import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import type { CueEvent } from './engine';

/**
 * Adapter for device vibration.
 * - Native (Capacitor): uses `@capacitor/haptics` Taptic Engine via `Haptics.impact()`.
 *   Patterns (number arrays) are emulated by chaining `impact` calls on setTimeout.
 * - Browser: uses `navigator.vibrate`. iOS Safari/WKWebView silently ignores vibrate —
 *   the native adapter above is what makes haptics work on iPhone.
 * Tests inject a mock via `setAdapter()`.
 */
export interface HapticAdapter {
  vibrate(pattern: number | number[]): void;
}

const navigatorAdapter: HapticAdapter = {
  vibrate(pattern) {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  },
};

const capacitorAdapter: HapticAdapter = {
  vibrate(pattern) {
    const list = Array.isArray(pattern) ? pattern : [pattern];
    let delay = 0;
    // Pattern format: [vibrate_ms, pause_ms, vibrate_ms, pause_ms, ...]. Only even indices fire.
    for (let i = 0; i < list.length; i += 2) {
      const ms = list[i];
      const style = ms >= 80 ? ImpactStyle.Medium : ImpactStyle.Light;
      setTimeout(() => {
        void Haptics.impact({ style }).catch(() => {});
      }, delay);
      delay += ms + (list[i + 1] ?? 0);
    }
  },
};

function defaultAdapter(): HapticAdapter {
  try {
    if (Capacitor.isNativePlatform()) return capacitorAdapter;
  } catch {
    // Capacitor not available (e.g. SSR). Fall through.
  }
  return navigatorAdapter;
}

export class HapticsCoach {
  private adapter: HapticAdapter = defaultAdapter();
  private enabled = true;
  private cueHandler = (event: CueEvent) => this.onCue(event);

  setAdapter(adapter: HapticAdapter): void {
    this.adapter = adapter;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  attach(engine: { onCue: (cb: (e: CueEvent) => void) => void }): void {
    engine.onCue(this.cueHandler);
  }

  detach(engine: { offCue: (cb: (e: CueEvent) => void) => void }): void {
    engine.offCue(this.cueHandler);
  }

  private onCue(event: CueEvent): void {
    if (!this.enabled) return;
    switch (event.type) {
      case 'stepStart':
        if (event.step.type === 'work') this.adapter.vibrate([80, 60, 80]);
        else this.adapter.vibrate([60, 60, 60]);
        break;
      case 'stepCountdown':
        this.adapter.vibrate(40);
        break;
      case 'stepEnd':
        this.adapter.vibrate([80, 60, 80, 60, 80]);
        break;
      case 'timelineComplete':
        this.adapter.vibrate([120, 80, 120, 80, 200]);
        break;
      default:
        break;
    }
  }
}
