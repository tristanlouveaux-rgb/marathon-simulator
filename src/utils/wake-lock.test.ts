import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Sentinel and listener tracking state across tests.
interface FakeSentinel {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
}

let currentSentinel: FakeSentinel | null;
let requestMock: ReturnType<typeof vi.fn>;
let visibilityListeners: Array<() => void>;

function makeSentinel(): FakeSentinel {
  const s: FakeSentinel = {
    released: false,
    release: vi.fn(async () => {
      s.released = true;
    }),
  };
  return s;
}

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  });
}

function installWakeLockApi(): void {
  requestMock = vi.fn(async () => {
    currentSentinel = makeSentinel();
    return currentSentinel;
  });
  setNavigator({ wakeLock: { request: requestMock } });
}

function installDocument(initialState: 'visible' | 'hidden' = 'visible'): void {
  visibilityListeners = [];
  let state = initialState;
  (globalThis as any).document = {
    get visibilityState() {
      return state;
    },
    set visibilityState(v: 'visible' | 'hidden') {
      state = v;
    },
    addEventListener: (event: string, cb: () => void) => {
      if (event === 'visibilitychange') visibilityListeners.push(cb);
    },
    removeEventListener: (event: string, cb: () => void) => {
      if (event !== 'visibilitychange') return;
      const idx = visibilityListeners.indexOf(cb);
      if (idx >= 0) visibilityListeners.splice(idx, 1);
    },
  };
}

function fireVisibilityChange(state: 'visible' | 'hidden'): void {
  (globalThis as any).document.visibilityState = state;
  // Iterate a copy so listeners that detach during their callback don't skip.
  [...visibilityListeners].forEach((cb) => cb());
}

async function importFresh(): Promise<typeof import('./wake-lock')> {
  vi.resetModules();
  return await import('./wake-lock');
}

beforeEach(() => {
  currentSentinel = null;
  visibilityListeners = [];
  installDocument();
  installWakeLockApi();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setNavigator(undefined);
  delete (globalThis as any).document;
  vi.restoreAllMocks();
});

describe('wake-lock', () => {
  it('isWakeLockSupported returns true when navigator.wakeLock is present', async () => {
    const mod = await importFresh();
    expect(mod.isWakeLockSupported()).toBe(true);
  });

  it('isWakeLockSupported returns false when navigator.wakeLock is undefined', async () => {
    setNavigator({});
    const mod = await importFresh();
    expect(mod.isWakeLockSupported()).toBe(false);
  });

  it('acquireWakeLock requests a screen sentinel on supported browsers', async () => {
    const mod = await importFresh();
    await mod.acquireWakeLock();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith('screen');
    expect(currentSentinel).not.toBeNull();
    expect(currentSentinel!.released).toBe(false);
  });

  it('acquireWakeLock is idempotent — double call only requests once', async () => {
    const mod = await importFresh();
    await mod.acquireWakeLock();
    await mod.acquireWakeLock();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('releaseWakeLock releases the sentinel', async () => {
    const mod = await importFresh();
    await mod.acquireWakeLock();
    const sentinel = currentSentinel!;
    await mod.releaseWakeLock();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(sentinel.released).toBe(true);
  });

  it('releaseWakeLock is a no-op when no lock is held', async () => {
    const mod = await importFresh();
    await expect(mod.releaseWakeLock()).resolves.toBeUndefined();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('re-acquires the lock when the document becomes visible again', async () => {
    const mod = await importFresh();
    await mod.acquireWakeLock();
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Simulate browser-side release on tab hide.
    const firstSentinel = currentSentinel!;
    firstSentinel.released = true;
    fireVisibilityChange('hidden');

    // Now become visible again: should re-acquire.
    fireVisibilityChange('visible');
    // requestMock is async — wait a microtask tick.
    await Promise.resolve();
    await Promise.resolve();

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(currentSentinel).not.toBe(firstSentinel);
  });

  it('does not re-acquire after releaseWakeLock is called', async () => {
    const mod = await importFresh();
    await mod.acquireWakeLock();
    await mod.releaseWakeLock();
    fireVisibilityChange('hidden');
    fireVisibilityChange('visible');
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('acquireWakeLock on unsupported browser does not throw and does not attach listeners', async () => {
    setNavigator({});
    const mod = await importFresh();
    await expect(mod.acquireWakeLock()).resolves.toBeUndefined();
    expect(visibilityListeners.length).toBe(0);
  });

  it('swallows request failures without throwing', async () => {
    const failingRequest = vi.fn(async () => {
      throw new DOMException('NotAllowedError');
    });
    setNavigator({ wakeLock: { request: failingRequest } });
    const mod = await importFresh();
    await expect(mod.acquireWakeLock()).resolves.toBeUndefined();
    expect(failingRequest).toHaveBeenCalledTimes(1);
  });

  it('swallows release failures without throwing', async () => {
    const mod = await importFresh();
    await mod.acquireWakeLock();
    currentSentinel!.release = vi.fn(async () => {
      throw new DOMException('InvalidStateError');
    });
    await expect(mod.releaseWakeLock()).resolves.toBeUndefined();
  });
});
