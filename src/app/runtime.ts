/**
 * App runtime coordination — a LEAF module.
 *
 * It deliberately imports nothing from the heavy UI / data graph, so importing
 * one of these helpers never transitively drags in `main.ts` and its top-level
 * `bootstrap()` call.
 *
 * Why this exists (2026-06-15): `isSimulatorMode` and `awaitStartupSyncs` used
 * to live in `main.ts`. Six views and the onboarding `review` step import them.
 * Because `main.ts` also imports the wizard controller (`initWizard`) and runs
 * `bootstrap()` at module load, that formed a cycle:
 *
 *   controller → renderer → review → main.ts → bootstrap() → launchApp()
 *     → initWizard() → reads STEP_ORDER
 *
 * When a wizard module was the evaluation entry point (e.g. a unit test that
 * imports a single step), `main.ts` evaluated for the first time *mid-way*
 * through `controller.ts`, auto-fired `bootstrap()` (jsdom reports
 * `readyState === 'complete'`), and called `initWizard()` before `controller.ts`
 * had reached its `STEP_ORDER` const — a temporal-dead-zone crash
 * (`Cannot access 'STEP_ORDER' before initialization`).
 *
 * Extracting these two utilities into a leaf module breaks the back-edge: no
 * module in the render graph imports `main.ts` any more, so `main.ts` is a pure
 * entry point that boots exactly once, from the real app entry.
 */

/** True when running in local simulator mode (no auth required) */
export function isSimulatorMode(): boolean {
  return localStorage.getItem('mosaic_simulator_mode') === '1';
}

/**
 * Startup-sync coordination. `launchApp` fires several fire-and-forget
 * background tasks (Strava backfill, history restore, DB cleanup, etc.) that
 * write to the activity DB. Some surfaces. Most importantly the onboarding
 * review screen's `loadActivitiesFromDB` query. Read that DB and need to
 * see settled data, otherwise their derived values (FTP, CSS, weekly volume)
 * come and go between reloads as the syncs race the read.
 *
 * Pattern:
 *   1. `launchApp` calls `trackStartupTask(asyncFn())` for each fire-and-forget.
 *   2. After `launchApp` completes it calls `signalLaunchAppComplete()`, then
 *      callers can `await awaitStartupSyncs()` to block until those tasks have
 *      all settled (or a timeout fires).
 *   3. The review pipeline awaits this before its own `loadActivitiesFromDB`.
 *
 * Bootstrap completion is signalled separately (`signalLaunchAppComplete`) so a
 * caller awaiting before launchApp finishes doesn't snapshot an empty task array.
 */
const _startupSyncTasks: Promise<unknown>[] = [];
let _launchAppResolve: (() => void) | null = null;
const _launchAppPromise = new Promise<void>((resolve) => { _launchAppResolve = resolve; });

/** Register a fire-and-forget startup task so `awaitStartupSyncs` can block on it. */
export function trackStartupTask<T>(p: Promise<T>): Promise<T> {
  _startupSyncTasks.push(p);
  return p;
}

/** Called by `launchApp` once it has finished registering its startup tasks. */
export function signalLaunchAppComplete(): void {
  _launchAppResolve?.();
}

/**
 * Wait until all background startup tasks (registered via `trackStartupTask`
 * in `launchApp`) have settled, or until `timeoutMs` elapses. Whichever
 * comes first. Resolves regardless; never rejects.
 *
 * Defaults to 20 s. Plenty of time for a typical first-run Strava backfill,
 * but capped so a stuck task can't lock the wizard indefinitely.
 */
export async function awaitStartupSyncs(timeoutMs: number = 20000): Promise<void> {
  await _launchAppPromise;
  await Promise.race([
    Promise.allSettled(_startupSyncTasks).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
